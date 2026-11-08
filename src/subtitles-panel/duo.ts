// DuoPulse — кнопка «duo» + панель настроек набора субтитров (задача 3.7,
// docs/03 §8; docs/05 §1 src/subtitles-panel/). Кнопка в навбаре рядом с
// адресной строкой: состояние показа активной вкладки — выкл / одна дорожка /
// дуо / три (docs/03 §8 п.1), видна только когда на странице есть видео с
// дорожками (платформенными или файловыми). Клик — включить показ, если выключен (карточка duopulse-079: как у Alt+D —
// дефолт «оригинал + перевод» или прошлый набор), и открыть нативное меню
// (карточка duopulse-087: «в кнопочки duo не могу найти, где настроить языки
// и формат плашки» — HTML-панель на контентных вкладках уходит под страницу,
// спайк duopulse-086; меню — popup muda поверх webview: показ набора, языки
// видео, перевод по умолчанию, позиция/размер/вид плашки, синхронизация,
// свои субтитры, ASR, вход на страницу настроек; payload — duo-menu.ts,
// сборка — chrome_menu.rs build_duo_menu, транспорт overlay-menu.ts).
// Alt+D — вкл/выкл показа (docs/03 §8 п.2, сценарий docs/01 §5.1); источник
// Alt+D приходит полем via события subtitles:set_applied — из страницы его
// ловит content-слой, из хрома этот модуль (IPC subtitles.toggle).
//
// HTML-панель (гайд 06) — полный редактор набора: состав 1–3 дорожек — языки,
// источники (платформа/файл/перевод), порядок строк (↑/↓, fast-path без
// перезагрузки); пресеты быстрого переключения; «Свои субтитры…» (нативный
// выбор файла → subtitles.load_file, плагин dialog); слайдер синхронизации
// ±10 с (тот же offset, что HUD); размер/позиция/цвета плашки
// (subtitles.set_style). После 087 пользовательского входа в неё нет (видна
// только нативным меню) — открытие событием «duo:open-panel» (e2e-стенды;
// вернуть панель над webview — карточка duopulse-090). Данные — снапшот
// subtitles.list_tracks + события subtitles:{tracks_ready, set_applied} и
// page:video_detected сервис состояния Core (только активная вкладка:
// события фильтруются по tabId).
//
// Задача 4.2: «+ перевод в… (облако)» — запуск subtitles.translate_track
// (конвейер Core: кэш SQLite → пачки ≤ 2 КБ → провайдер), статус — событие
// subtitles:translate_progress (duoTranslateMeta: прогресс/кэш/ошибка).
// Задача 4.3 (docs/01 §5.4): офлайн/нет провайдера — бейдж «перевод
// недоступен» (subtitles:translate_unavailable), при willRetry Core повторяет
// сам и бейдж живёт до финального translate_progress.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import type {
  AppliedTrackInfo,
  BaseTrackInfo,
  SubtitlesStyleInfo,
  SubtitlesTranslateProgress,
  SubtitlesAsrProgress,
  SubtitlesTranslateUnavailable,
  TranslationLangInfo,
} from "../bridge/gen/types";
import { onOverlayMenuAction, openOverlayMenu } from "../chrome/overlay-menu";
import { presetSets, normalizeTrackId } from "./presets";
import {
  fromChange,
  fromOptions,
  langRowState,
  toChange,
  toOptions,
  type LangAction,
} from "./langs-row";
import { buildDuoMenuPayload, menuFromId, menuToValue, type DuoMenuPayload } from "./duo-menu";
import { cloudLangOptions, translateProgressText, translateUnavailableText } from "./cloud-langs";
import { asrProgressText } from "./asr-status";
import { LOOK_PRESETS, matchLookPreset } from "./look-presets";

const err = (e: unknown): void => console.error("duo:", e);
const btn = document.getElementById("duoBtn") as HTMLButtonElement;
const panel = document.getElementById("duoPanel") as HTMLDivElement;

const SOURCE_LABEL: Record<string, string> = {
  youtube: "платформа",
  file: "файл",
  translate: "перевод",
  test: "тест",
};

/** Состояние активной вкладки (снапшот Core + события). */
interface DuoState {
  tabId: string | null;
  videoKey: string | null;
  canTracks: boolean;
  enabled: boolean;
  tracks: AppliedTrackInfo[];
  base: BaseTrackInfo[];
  translations: TranslationLangInfo[];
  offsetMs: number;
  /** Стиль плашки целиком (карточка 059: цвета/обводка — в придачу к размеру). */
  style: SubtitlesStyleInfo;
}

const state: DuoState = {
  tabId: null,
  videoKey: null,
  canTracks: false,
  enabled: true,
  tracks: [],
  base: [],
  translations: [],
  offsetMs: 0,
  style: {
    fontScalePct: 100,
    fontFamily: "Inter",
    position: "bottom",
    marginPct: 6,
    plateOpacity: 0.78,
    originalColor: "#ffffff",
    translationColor: "#bdfe4f",
    mutedColor: "#ffffff",
    plateColor: "#0a0e17",
    textStroke: true,
  },
};

/** Нормализованный id для сравнения наборов: перевод «yt:en+ru» ≡ «ru». */
const normalizeId = normalizeTrackId;

// --- подписи ----------------------------------------------------------------

const fmtOffset = (ms: number): string => {
  const s = ms / 1000;
  return `${s > 0 ? "+" : s < 0 ? "−" : ""}${Math.abs(s).toFixed(1).replace(".", ",")} с`;
};

const setSummary = (): string => {
  const n = state.enabled ? state.tracks.length : 0;
  if (!state.videoKey) return "Видео на странице не найдено";
  const key = state.videoKey.length > 42 ? state.videoKey.slice(0, 42) + "…" : state.videoKey;
  const tail = !state.enabled ? "показ выключен" : n === 0 ? "набор пуст" : `${n} ${n === 1 ? "дорожка" : n < 5 ? "дорожки" : "дорожек"}`;
  return `${key} · ${tail}`;
};

const el = <T extends HTMLElement>(tag: string, cls?: string, text?: string): T => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node as T;
};

// --- рендер -----------------------------------------------------------------

function renderButton(): void {
  // Кнопка видна на любом найденном видео (карточка duopulse-057: на видео
  // без дорожек платформы панель нужна не меньше — свои файлы .srt/.vtt,
  // облачный перевод, стиль плашки; пустой набор честно показан в панели).
  // Прежний фильтр «только с дорожками» прятал вход в субтитры целиком.
  const visible = !!state.videoKey;
  btn.hidden = !visible;
  btn.dataset.count = String(state.enabled ? state.tracks.length : 0);
  btn.setAttribute("aria-pressed", String(state.enabled));
}

function renderPanel(): void {
  (document.getElementById("duoEnabled") as HTMLInputElement).checked = state.enabled;
  (document.getElementById("duoMeta") as HTMLElement).textContent = setSummary();
  renderLangs();
  renderPresets();
  renderSet();
  renderAdd();
  renderOffset();
  renderStyle();
}

/** Строка «Языки: с какого → на какой» (карточка duopulse-079): селект
 * оригинала (базовые дорожки) и селект перевода (нет / tlang платформы /
 * облако) — выбор применяется сразу, рендер восстанавливается по набору. */
function renderLangs(): void {
  const fromSel = document.getElementById("duoLangFrom") as HTMLSelectElement;
  const toSel = document.getElementById("duoLangTo") as HTMLSelectElement;
  const row = langRowState(state.tracks);
  fromSel.replaceChildren();
  const fos = fromOptions(state.base);
  for (const o of fos) {
    const opt = document.createElement("option");
    opt.value = o.id;
    opt.textContent = o.name;
    fromSel.append(opt);
  }
  fromSel.disabled = fos.length === 0;
  if (row.fromId) fromSel.value = row.fromId;

  const fromTrack = state.base.find((b) => b.id === row.fromId) ?? null;
  toSel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = state.base.length ? "Нет (только оригинал)" : "—";
  toSel.append(none);
  const opts = toOptions(
    state.translations,
    fromTrack ? { lang: fromTrack.lang, translatable: fromTrack.translatable } : null,
  );
  const groups: [("platform" | "cloud"), string][] = [
    ["platform", "Перевод платформы"],
    ["cloud", "Облачный перевод"],
  ];
  for (const [key, label] of groups) {
    const items = opts.filter((o) => o.group === key);
    if (!items.length) continue;
    const og = document.createElement("optgroup");
    og.label = label;
    for (const o of items) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.name;
      og.append(opt);
    }
    toSel.append(og);
  }
  const want = row.to.kind === "none" ? "" : row.to.kind === "platform" ? row.to.lang : `cloud:${row.to.lang}`;
  toSel.value = want;
  if (want && toSel.value !== want) {
    // применённый перевод вне списка вариантов (например, tlang с подтегом) —
    // добавляем его, чтобы селект показывал фактическое состояние
    const opt = document.createElement("option");
    opt.value = want;
    opt.textContent =
      row.to.kind === "cloud" ? `${row.to.lang} — облако` : row.to.kind === "platform" ? row.to.lang : want;
    toSel.append(opt);
    toSel.value = want;
  }
  toSel.disabled = opts.length === 0 && !want;
}

function renderPresets(): void {
  const box = document.getElementById("duoPresets") as HTMLElement;
  box.replaceChildren();
  const presets = presetSets(state.base, state.translations);
  if (!presets.length) return;
  const current = state.tracks.filter((t) => t.source !== "file").map((t) => normalizeId(t.id));
  for (const p of presets) {
    const chip = el<HTMLButtonElement>("button", "duo-chip", p.label);
    chip.type = "button";
    chip.dataset.ids = p.ids.join("\u0000");
    chip.dataset.on = String(
      p.ids.length === current.length && p.ids.every((id, i) => id === current[i]),
    );
    chip.title = p.ids.join(" + ");
    box.append(chip);
  }
}

function renderSet(): void {
  const box = document.getElementById("duoSet") as HTMLElement;
  box.replaceChildren();
  if (!state.tracks.length) {
    const empty = el("div", "duo-empty");
    empty.textContent = state.base.length
      ? "Выберите дорожки пресетом или добавьте ниже"
      : "Дорожки платформы недоступны — можно наложить свой файл";
    box.append(empty);
    return;
  }
  state.tracks.forEach((t, i) => {
    const row = el("div", "duo-row");
    row.dataset.kind = t.source;
    // Файловая часть — после платформенной (3.6), облачные переводы — тоже
    // фиксированы: их составом управляет конвейер (4.2), не set_tracks.
    const movable = t.source !== "file" && t.source !== "translate" && t.source !== "asr";
    if (movable) {
      const up = el<HTMLButtonElement>("button", "duo-move", "↑");
      up.type = "button";
      up.title = "Выше";
      up.disabled = i === 0;
      up.dataset.act = "up";
      up.dataset.idx = String(i);
      const down = el<HTMLButtonElement>("button", "duo-move", "↓");
      down.type = "button";
      down.title = "Ниже";
      const lockedBelow = ["file", "translate"].includes(state.tracks[i + 1]?.source ?? "");
      down.disabled = i === state.tracks.length - 1 || lockedBelow;
      down.dataset.act = "down";
      down.dataset.idx = String(i);
      row.append(up, down);
    } else {
      row.append(el("span", "duo-move-spacer"));
    }
    const badge = el("span", "duo-lang", t.lang);
    const name = el("span", "duo-name", t.name || t.id);
    name.title = `${t.id} · ${t.role}`;
    const src = el("span", "duo-src", SOURCE_LABEL[t.source] ?? t.source);
    const remove = el<HTMLButtonElement>("button", "duo-x", "×");
    remove.type = "button";
    remove.title = "Убрать из набора";
    remove.dataset.act = "remove";
    remove.dataset.idx = String(i);
    row.append(badge, name, src, remove);
    box.append(row);
  });
}

function renderAdd(): void {
  const box = document.getElementById("duoAdd") as HTMLElement;
  box.replaceChildren();
  if (state.tracks.length >= 3) {
    box.append(el("div", "duo-empty", "Набор полон (3 дорожки)"));
    return;
  }
  const current = new Set(state.tracks.map((t) => normalizeId(t.id)));
  const mk = (kind: string, label: string, options: { id: string; name: string }[]): void => {
    if (!options.length) return;
    const select = document.createElement("select");
    select.className = "duo-select";
    select.dataset.kind = kind;
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = label;
    placeholder.selected = true;
    select.append(placeholder);
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.name;
      select.append(opt);
    }
    box.append(select);
  };
  mk(
    "base",
    "+ дорожка платформы…",
    state.base
      .filter((b) => !current.has(normalizeId(b.id)))
      .map((b) => ({
        id: b.id,
        name: `${b.name}${b.original ? " · оригинал" : ""}${b.kind === "asr" ? " · авто" : ""}`,
      })),
  );
  mk(
    "translation",
    "+ перевод…",
    state.translations
      .filter((t) => !current.has(t.lang))
      .map((t) => ({ id: t.lang, name: `${t.name} (${t.lang})` })),
  );
  // Облачный перевод (задача 4.2): языки, которых нет у платформы и в наборе;
  // источник — первая непереводная строка набора (предпочтение оригиналу).
  mk(
    "cloud",
    "+ перевод в… (облако)",
    cloudLangOptions(
      state.translations,
      state.tracks.map((t) => t.lang),
      state.tracks.some((t) => t.source !== "translate"),
    ).map((l) => ({ id: l.code, name: `${l.name} (${l.code})` })),
  );
}

function renderOffset(): void {
  const slider = document.getElementById("duoOffset") as HTMLInputElement;
  const val = document.getElementById("duoOffsetVal") as HTMLElement;
  slider.value = String(state.offsetMs);
  val.textContent = fmtOffset(state.offsetMs);
}

function renderStyle(): void {
  const slider = document.getElementById("duoScale") as HTMLInputElement;
  const val = document.getElementById("duoScaleVal") as HTMLElement;
  slider.value = String(state.style.fontScalePct);
  val.textContent = `${state.style.fontScalePct}%`;
  const fontSel = document.getElementById("duoFontFamily") as HTMLSelectElement;
  if (state.style.fontFamily) fontSel.value = state.style.fontFamily;
  for (const b of (document.getElementById("duoPosition") as HTMLElement).children) {
    (b as HTMLElement).dataset.on = String((b as HTMLElement).dataset.pos === state.style.position);
  }
  renderLook();
}

/** Пресеты вида + точные цвета (карточка 059): чипы с подсветкой активного
 *  (несовпадение — «Свои»), input[type=color] и тумблер обводки. */
function renderLook(): void {
  const box = document.getElementById("duoLookPresets") as HTMLElement;
  box.replaceChildren();
  const active = matchLookPreset(state.style);
  for (const p of LOOK_PRESETS) {
    const chip = el<HTMLButtonElement>("button", "duo-chip", p.label);
    chip.type = "button";
    chip.dataset.look = p.id;
    chip.dataset.on = String(active?.id === p.id);
    box.append(chip);
  }
  const custom = el<HTMLButtonElement>("button", "duo-chip", "Свои");
  custom.type = "button";
  custom.dataset.look = "custom";
  custom.dataset.on = String(active === null);
  custom.title = "Текущие цвета не совпадают с пресетами";
  box.append(custom);
  (document.getElementById("duoColorOriginal") as HTMLInputElement).value = state.style.originalColor;
  (document.getElementById("duoColorTranslation") as HTMLInputElement).value = state.style.translationColor;
  (document.getElementById("duoColorMuted") as HTMLInputElement).value = state.style.mutedColor;
  (document.getElementById("duoColorPlate") as HTMLInputElement).value = state.style.plateColor;
  (document.getElementById("duoStroke") as HTMLInputElement).checked = state.style.textStroke;
}

function render(): void {
  renderButton();
  renderPanel();
}

// --- данные -----------------------------------------------------------------

/** Полный снапшот: активная вкладка + её субтитры (открытие панели, смена
 * вкладки — events ниже обновляют точечно). */
async function refresh(): Promise<void> {
  try {
    const [tabs, st] = await Promise.all([bridge.tabs.list(), bridge.subtitles.listTracks()]);
    state.tabId = tabs.tabs.find((t) => t.active)?.id ?? null;
    state.videoKey = st.videoKey ?? null;
    state.canTracks = st.canTracks;
    state.enabled = st.enabled;
    state.tracks = st.tracks;
    state.base = st.base;
    state.translations = st.translations;
    state.offsetMs = st.offsetMs;
    state.style = st.style;
    render();
  } catch (e) {
    err(e);
  }
}

// --- панель -----------------------------------------------------------------

/** Payload последнего открытого меню (индексы пунктов «Язык видео»/«Перевод»
 * валидны только для него — храним, пока меню не открыто заново). */
let menuPayload: DuoMenuPayload | null = null;

/** Нативное меню кнопки (карточка 087): над webview на любой вкладке.
 * Свежий снапшот вкладки + дефолтный язык настроек → payload → popup. */
async function openMenu(): Promise<void> {
  await refresh();
  let defLang = "ru";
  try {
    defLang = (await bridge.settings.getAll()).subtitles?.defaultTranslationLang ?? "ru";
  } catch {
    /* настройки недоступны — дефолт списка */
  }
  menuPayload = buildDuoMenuPayload(state, defLang);
  const r = btn.getBoundingClientRect();
  openOverlayMenu("duo", r.left, r.bottom + 6, menuPayload);
}

function openPanel(): void {
  closeOtherPanels();
  panel.style.left = `${btn.offsetLeft}px`;
  panel.hidden = false;
  void refresh();
}

function closePanel(): void {
  panel.hidden = true;
}

/** Прочие всплывающие панели хрома — открытие одного закрывает остальные. */
function closeOtherPanels(): void {
  for (const id of ["mainMenu", "proxyMenu", "vpnPanel"]) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
}

// --- инициализация ----------------------------------------------------------

/** Действие строки «Языки» (langs-row): set/remove/translate — в порядке. */
const runLangAction = (a: LangAction): void => {
  if (a.type === "set") {
    void bridge.subtitles.setTracks({ ids: a.ids }).catch(err);
  } else if (a.type === "remove") {
    void bridge.subtitles.removeTrack({ id: a.id }).catch(err);
  } else {
    const meta = document.getElementById("duoTranslateMeta") as HTMLElement;
    meta.hidden = false;
    meta.dataset.phase = "translating";
    meta.textContent = `Перевод запрошен (${a.lang})…`;
    void bridge.subtitles.translateTrack({ targetLang: a.lang }).catch((ex) => err(ex));
  }
};

/** «Свои субтитры…» — нативный выбор файла → subtitles.load_file (панель и
 * пункт нативного меню 087). */
const pickSubtitlesFile = (): void => {
  void (async () => {
    try {
      const path = await invoke<string | null>("plugin:dialog|open", {
        options: {
          title: "Свои субтитры (.srt / .vtt)",
          multiple: false,
          filters: [{ name: "Субтитры", extensions: ["srt", "vtt"] }],
        },
      });
      if (!path) return;
      const res = await bridge.subtitles.loadFile({ path });
      const meta = document.getElementById("duoFileMeta") as HTMLElement;
      meta.hidden = false;
      meta.textContent =
        `${res.name} — ${res.cueCount} реплик` +
        (res.warnings.length ? ` (предупреждений: ${res.warnings.length})` : "");
    } catch (e) {
      err(e);
    }
  })();
};

/** «Распознать речь» (карточка duopulse-060): кнопка панели/пункт меню →
 * subtitles.asr_start → Core eval → content добудет URL аудио → конвейер
 * Core; прогресс/итог — событием subtitles:asr_progress. */
const requestAsr = (): void => {
  const meta = document.getElementById("duoAsrMeta") as HTMLElement;
  meta.hidden = false;
  meta.dataset.phase = "transcribing";
  meta.textContent = "Распознавание запущено…";
  void bridge.subtitles.asrStart().catch((ex) => err(ex));
};

/** Выбор пункта нативного меню (карточка 087): тот же набор IPC, что у
 * контролов панели, — языки через langs-row, стиль/сдвиг — патчи set_style/
 * set_offset, дефолт — settings.apply, файл/ASR — те же функции. */
const runMenuAction = (a: Record<string, unknown>): void => {
  const act = String(a.act ?? "");
  if (act === "toggle") {
    void bridge.subtitles.setEnabled({ on: !state.enabled }).catch(err);
    return;
  }
  if (act === "from" && menuPayload) {
    const id = menuFromId(menuPayload, Number(a.index));
    if (id) for (const x of fromChange(state.tracks, state.base, id)) runLangAction(x);
    return;
  }
  if (act === "to" && menuPayload) {
    const value = menuToValue(menuPayload, Number(a.index));
    if (value !== null) for (const x of toChange(state.tracks, state.base, value)) runLangAction(x);
    return;
  }
  if (act === "deflang") {
    void bridge.settings
      .apply({ subtitles: { defaultTranslationLang: String(a.lang ?? "") } })
      .catch(err);
    return;
  }
  if (act === "pos") {
    void bridge.subtitles.setStyle({ style: { position: String(a.pos) } }).catch(err);
    return;
  }
  if (act === "scale") {
    void bridge.subtitles.setStyle({ style: { fontScalePct: Number(a.pct) } }).catch(err);
    return;
  }
  if (act === "look") {
    const preset = LOOK_PRESETS.find((p) => p.id === a.look);
    if (preset) void bridge.subtitles.setStyle({ style: { ...preset.patch } }).catch(err);
    return;
  }
  if (act === "offset") {
    // delta 0 — пункт «Сброс»: обнуляем сдвиг, а не переустанавливаем текущий
    const delta = Number(a.deltaMs);
    const next = delta === 0 ? 0 : Math.max(-10000, Math.min(10000, state.offsetMs + delta));
    void bridge.subtitles.setOffset({ offsetMs: next }).catch(err);
    return;
  }
  if (act === "file") {
    pickSubtitlesFile();
    return;
  }
  if (act === "asr") {
    requestAsr();
    return;
  }
  if (act === "settings") {
    void bridge.tabs.open({ url: "duopulse://settings" }).catch(err);
  }
};

export function initDuo(): void {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Клик = «включить субтитры» (карточка duopulse-079) + нативное меню
    // (карточка 087): показ выключен или набор пуст — включаем (content-слой
    // соберёт дефолт «оригинал + перевод» или восстановит прошлый набор),
    // меню открываем всегда — над webview на любой вкладке.
    if (!state.enabled || state.tracks.length === 0) {
      void bridge.subtitles.setEnabled({ on: true }).catch(err);
    }
    void openMenu();
  });

  // Действия нативного меню (popup muda — выбор приходит «menu-action»).
  onOverlayMenuAction((a) => {
    if (a.menu === "duo") runMenuAction(a);
  });

  // HTML-панель (087): пользовательского входа нет — над webview её не видно
  // (спайк 086); открытие событием для e2e-стендов, вернуть панель — 090.
  window.addEventListener("duo:open-panel", () => openPanel());

  // закрытие кликом мимо / Escape — как у прочих панелей хрома
  window.addEventListener(
    "mousedown",
    (e) => {
      if (!panel.hidden && !(e.target as HTMLElement).closest("#duoPanel, #duoBtn")) closePanel();
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) closePanel();
  });

  // Alt+D в хроме (в контентной вкладке клавишу ловит content-слой):
  // переключить показ набора; панель откроется/закроется по via=alt-d ниже.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code !== "KeyD") return;
      e.preventDefault();
      e.stopPropagation();
      void bridge.subtitles.toggle().catch(err);
    },
    true,
  );

  // Тумблер показа (docs/03 §8 п.2): состав помнят обе стороны.
  (document.getElementById("duoEnabled") as HTMLInputElement).addEventListener("change", (e) => {
    void bridge.subtitles
      .setEnabled({ on: (e.target as HTMLInputElement).checked })
      .catch(err);
  });

  // Строка «Языки: с какого → на какой» (карточка duopulse-079): выбор
  // применяется сразу (набор/облако), ссылка — страница настроек субтитров.
  (document.getElementById("duoLangFrom") as HTMLSelectElement).addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    for (const a of fromChange(state.tracks, state.base, sel.value)) runLangAction(a);
  });
  (document.getElementById("duoLangTo") as HTMLSelectElement).addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    for (const a of toChange(state.tracks, state.base, sel.value)) runLangAction(a);
  });
  document.getElementById("duoLangSettings")?.addEventListener("click", () => {
    void bridge.tabs.open({ url: "duopulse://settings" }).catch(err);
    closePanel();
  });

  // Пресеты и операции набора — делегирование (data-act/data-idx/data-ids).
  panel.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>(".duo-chip");
    if (chip?.dataset.ids) {
      void bridge.subtitles.setTracks({ ids: chip.dataset.ids.split("\u0000") }).catch(err);
      return;
    }
    const act = target.closest<HTMLElement>("[data-act]");
    if (!act) return;
    const idx = Number(act.dataset.idx);
    const track = state.tracks[idx];
    if (!track) return;
    if (act.dataset.act === "remove") {
      void bridge.subtitles.removeTrack({ id: track.id }).catch(err);
      return;
    }
    if (act.dataset.act === "up" || act.dataset.act === "down") {
      // Перестановка платформенной части: тот же состав в новом порядке —
      // content-слой применяет без перезагрузки (fast-path, задача 3.7).
      // Файловые и облачные строки фиксированы (set_tracks их не резолвит).
      const ids = state.tracks
        .filter((t) => t.source !== "file" && t.source !== "translate" && t.source !== "asr")
        .map((t) => t.id);
      const from = idx;
      const to = act.dataset.act === "up" ? idx - 1 : idx + 1;
      if (to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      void bridge.subtitles.setTracks({ ids }).catch(err);
    }
  });

  // Добавление дорожки: выбор в селекте сразу применяет (набор ≤ 3).
  // «+ перевод в… (облако)» — задача 4.2: не входит в набор сразу — конвейер
  // Core переводит дорожку-источник (кэш → пачки → провайдер), итог придёт
  // событием subtitles:translate_progress (статус — duoTranslateMeta).
  (document.getElementById("duoAdd") as HTMLElement).addEventListener("change", (e) => {
    const select = e.target as HTMLSelectElement;
    if (!select.value) return;
    if (select.dataset.kind === "cloud") {
      const meta = document.getElementById("duoTranslateMeta") as HTMLElement;
      meta.hidden = false;
      meta.dataset.phase = "translating";
      meta.textContent = `Перевод запрошен (${select.value})…`;
      void bridge.subtitles
        .translateTrack({ targetLang: select.value })
        .catch((ex) => err(ex));
      select.value = "";
      return;
    }
    const ids = state.tracks
      .filter((t) => t.source !== "file" && t.source !== "translate" && t.source !== "asr")
      .map((t) => t.id);
    if (ids.length >= 3) return;
    ids.push(select.value);
    void bridge.subtitles.setTracks({ ids }).catch(err);
    select.value = ""; // обратно к подсказке; панель перерисует set_applied
  });

  // Распознать речь (карточка duopulse-060): кнопка панели и пункт
  // нативного меню (087) → requestAsr → subtitles.asr_start → Core eval
  // duopulse-asr-request → content добудет URL аудио → конвейер Core.
  // Прогресс/итог/ошибки — событием subtitles:asr_progress (duoAsrMeta,
  // автоскрытие как у перевода).
  document.getElementById("duoAsrBtn")?.addEventListener("click", requestAsr);
  let asrStatusTimer = 0;
  void listen<SubtitlesAsrProgress>(bridge.events.subtitlesAsrProgress, (ev) => {
    if (ev.payload.tabId !== state.tabId) return;
    const text = asrProgressText(ev.payload);
    if (!text) return;
    const meta = document.getElementById("duoAsrMeta") as HTMLElement;
    meta.hidden = false;
    meta.dataset.phase = ev.payload.phase;
    meta.textContent = text;
    window.clearTimeout(asrStatusTimer);
    const busy = ev.payload.phase === "model" || ev.payload.phase === "audio" || ev.payload.phase === "transcribe";
    if (!busy) {
      asrStatusTimer = window.setTimeout(() => {
        meta.hidden = true;
      }, 6000);
    }
  });

  // Прогресс облачного перевода (subtitles:translate_progress, задача 4.2):
  // «Перевод… 12/40» по ходу, итог (кэш/сеть) и ошибки — с автоскрытием.
  // Снимает и бейдж 4.3: translating/done возвращают строке обычный статус.
  let translateStatusTimer = 0;
  void listen<SubtitlesTranslateProgress>(bridge.events.subtitlesTranslateProgress, (ev) => {
    if (ev.payload.tabId !== state.tabId) return;
    const text = translateProgressText(ev.payload);
    if (!text) return;
    const meta = document.getElementById("duoTranslateMeta") as HTMLElement;
    meta.hidden = false;
    meta.dataset.phase = ev.payload.phase;
    meta.textContent = text;
    window.clearTimeout(translateStatusTimer);
    if (ev.payload.phase !== "translating") {
      translateStatusTimer = window.setTimeout(() => {
        meta.hidden = true;
      }, 6000);
    }
  });

  // Бейдж «перевод недоступен» (задача 4.3, docs/01 §5.4): офлайн или нет
  // провайдера. willRetry=true — Core повторяет сам, бейдж держится до
  // финального translate_progress; иначе автоскрытие как у ошибок.
  void listen<SubtitlesTranslateUnavailable>(bridge.events.subtitlesTranslateUnavailable, (ev) => {
    if (ev.payload.tabId !== state.tabId) return;
    const meta = document.getElementById("duoTranslateMeta") as HTMLElement;
    meta.hidden = false;
    meta.dataset.phase = "unavailable";
    meta.textContent = translateUnavailableText(ev.payload);
    window.clearTimeout(translateStatusTimer);
    if (!ev.payload.willRetry) {
      translateStatusTimer = window.setTimeout(() => {
        meta.hidden = true;
      }, 6000);
    }
  });

  // «Свои субтитры…»: нативный выбор файла → subtitles.load_file (3.6);
  // тот же диалог — пункт «Свои субтитры…» нативного меню (087).
  document.getElementById("duoFileBtn")?.addEventListener("click", pickSubtitlesFile);

  // Синхронизация: слайдер панели задаёт тот же offset, что HUD (docs/03 §8 п.5).
  const offsetSlider = document.getElementById("duoOffset") as HTMLInputElement;
  const offsetVal = document.getElementById("duoOffsetVal") as HTMLElement;
  offsetSlider.addEventListener("input", () => {
    offsetVal.textContent = fmtOffset(Number(offsetSlider.value));
  });
  offsetSlider.addEventListener("change", () => {
    void bridge.subtitles.setOffset({ offsetMs: Number(offsetSlider.value) }).catch(err);
  });
  document.getElementById("duoOffsetReset")?.addEventListener("click", () => {
    void bridge.subtitles.setOffset({ offsetMs: 0 }).catch(err);
  });

  // Вид плашки: размер и позиция (subtitles.set_style, клампы — в оверлее).
  const scaleSlider = document.getElementById("duoScale") as HTMLInputElement;
  const scaleVal = document.getElementById("duoScaleVal") as HTMLElement;
  scaleSlider.addEventListener("input", () => {
    scaleVal.textContent = `${scaleSlider.value}%`;
  });
  scaleSlider.addEventListener("change", () => {
    void bridge.subtitles.setStyle({ style: { fontScalePct: Number(scaleSlider.value) } }).catch(err);
  });
  // Гарнитура (карточка 068): живая смена — set-style патчит fontFamily,
  // оверлей перекладывает font-family плашки на месте (строки наследуют).
  (document.getElementById("duoFontFamily") as HTMLSelectElement).addEventListener("change", (e) => {
    const family = (e.target as HTMLSelectElement).value;
    void bridge.subtitles.setStyle({ style: { fontFamily: family } }).catch(err);
  });
  (document.getElementById("duoPosition") as HTMLElement).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]");
    if (b?.dataset.pos) void bridge.subtitles.setStyle({ style: { position: b.dataset.pos } }).catch(err);
  });

  // Вид плашки (карточка 059): пресеты — одним патчем всех полей вида,
  // цвета строк/подложки и обводка — точечно; применение живое (set-style →
  // оверлей перекрашивает строки на месте, set_applied вернёт снапшот).
  (document.getElementById("duoLookPresets") as HTMLElement).addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-look]");
    if (!chip?.dataset.look || chip.dataset.look === "custom") return;
    const preset = LOOK_PRESETS.find((p) => p.id === chip.dataset.look);
    if (preset) void bridge.subtitles.setStyle({ style: { ...preset.patch } }).catch(err);
  });
  const colorField = (id: string, field: "originalColor" | "translationColor" | "mutedColor" | "plateColor"): void => {
    const input = document.getElementById(id) as HTMLInputElement;
    const apply = (): void => {
      const patch: Partial<Record<typeof field, string>> = { [field]: input.value };
      void bridge.subtitles.setStyle({ style: patch }).catch(err);
    };
    input.addEventListener("input", apply); // живой отклик пипетки WebView2
    input.addEventListener("change", apply);
  };
  colorField("duoColorOriginal", "originalColor");
  colorField("duoColorTranslation", "translationColor");
  colorField("duoColorMuted", "mutedColor");
  colorField("duoColorPlate", "plateColor");
  (document.getElementById("duoStroke") as HTMLInputElement).addEventListener("change", (e) => {
    void bridge.subtitles
      .setStyle({ style: { textStroke: (e.target as HTMLInputElement).checked } })
      .catch(err);
  });

  // События Core → UI: только активная вкладка (остальные фильтруем).
  void listen(bridge.events.tabsUpdated, () => void refresh());
  void listen<import("../bridge/gen/types").PageVideoDetected>(
    bridge.events.pageVideoDetected,
    (ev) => {
      if (ev.payload.tabId !== state.tabId) return;
      state.videoKey = ev.payload.videoKey;
      state.canTracks = ev.payload.canTracks;
      renderButton();
      if (!panel.hidden) void refresh();
    },
  );
  void listen<import("../bridge/gen/types").SubtitlesTracksReady>(
    bridge.events.subtitlesTracksReady,
    (ev) => {
      if (ev.payload.tabId !== state.tabId) return;
      state.base = ev.payload.base;
      state.translations = ev.payload.translations;
      state.canTracks = ev.payload.base.length > 0;
      if (!panel.hidden) renderPanel();
      renderButton();
    },
  );
  void listen<import("../bridge/gen/types").SubtitlesSetApplied>(
    bridge.events.subtitlesSetApplied,
    (ev) => {
      if (ev.payload.tabId !== state.tabId) return;
      state.videoKey = ev.payload.videoKey ?? null;
      state.enabled = ev.payload.enabled;
      state.tracks = ev.payload.tracks;
      state.offsetMs = ev.payload.offsetMs;
      state.style = ev.payload.style;
      render();
      // Alt+D раньше открывал/закрывал HTML-панель (карточка duopulse-028) —
      // с 087 показ переключается без панели (над webview её не видно, вход
      // в настройки — нативное меню кнопки duo).
    },
  );

  void refresh();
}
