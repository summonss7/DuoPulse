// DuoPulse — кнопка «duo» + панель настроек набора субтитров (задача 3.7,
// docs/03 §8; docs/05 §1 src/subtitles-panel/). Кнопка в навбаре рядом с
// адресной строкой: состояние показа активной вкладки — выкл / одна дорожка /
// дуо / три (docs/03 §8 п.1), видна только когда на странице есть видео с
// дорожками (платформенными или файловыми). Клик — панель; Alt+D — вкл/выкл
// показа (docs/03 §8 п.2, сценарий docs/01 §5.1) и вместе с ним показать/
// скрыть панель (карточка duopulse-028): источник Alt+D приходит полем via
// события subtitles:set_applied — из страницы его ловит content-слой, из
// хрома этот модуль (IPC subtitles.toggle).
//
// Панель (гайд 06): состав набора 1–3 дорожек — языки, источники (платформа/
// файл/перевод), порядок строк (↑/↓, fast-path без перезагрузки); пресеты
// быстрого переключения; «Свои субтитры…» (нативный выбор файла →
// subtitles.load_file, плагин dialog); слайдер синхронизации ±10 с (тот же
// offset, что HUD); размер/позиция плашки (subtitles.set_style). Данные —
// снапшот subtitles.list_tracks + события subtitles:{tracks_ready,
// set_applied} и page:video_detected сервис состояния Core (только активная
// вкладка: события фильтруются по tabId).
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import type {
  AppliedTrackInfo,
  BaseTrackInfo,
  TranslationLangInfo,
} from "../bridge/gen/types";
import { presetSets, normalizeTrackId } from "./presets";

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
  fontScalePct: number;
  position: string;
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
  fontScalePct: 100,
  position: "bottom",
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
  // Кнопка видна только при видео с дорожками: список адаптера или файловые
  // (docs/03 §8 п.1; сценарий §5.3 — кнопка появляется после дропа .srt).
  const visible = !!state.videoKey && (state.canTracks || state.tracks.length > 0);
  btn.hidden = !visible;
  btn.dataset.count = String(state.enabled ? state.tracks.length : 0);
  btn.setAttribute("aria-pressed", String(state.enabled));
}

function renderPanel(): void {
  (document.getElementById("duoEnabled") as HTMLInputElement).checked = state.enabled;
  (document.getElementById("duoMeta") as HTMLElement).textContent = setSummary();
  renderPresets();
  renderSet();
  renderAdd();
  renderOffset();
  renderStyle();
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
    const movable = t.source !== "file"; // файловая часть — после платформенной (3.6)
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
      down.disabled = i === state.tracks.length - 1 || state.tracks[i + 1]?.source === "file";
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
  if (!state.base.length && !state.translations.length) return;
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
  slider.value = String(state.fontScalePct);
  val.textContent = `${state.fontScalePct}%`;
  for (const b of (document.getElementById("duoPosition") as HTMLElement).children) {
    (b as HTMLElement).dataset.on = String((b as HTMLElement).dataset.pos === state.position);
  }
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
    state.fontScalePct = st.style.fontScalePct;
    state.position = st.style.position;
    render();
  } catch (e) {
    err(e);
  }
}

// --- панель -----------------------------------------------------------------

function openPanel(): void {
  closeOtherPanels();
  panel.style.left = `${btn.offsetLeft}px`;
  panel.hidden = false;
  void refresh();
}

function closePanel(): void {
  panel.hidden = true;
}

function togglePanel(): void {
  if (panel.hidden) openPanel();
  else closePanel();
}

/** Прочие всплывающие панели хрома — открытие одного закрывает остальные. */
function closeOtherPanels(): void {
  for (const id of ["tabMenu", "mainMenu", "proxyMenu"]) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
}

// --- инициализация ----------------------------------------------------------

export function initDuo(): void {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });

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
      const ids = state.tracks.filter((t) => t.source !== "file").map((t) => t.id);
      const from = idx;
      const to = act.dataset.act === "up" ? idx - 1 : idx + 1;
      if (to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      void bridge.subtitles.setTracks({ ids }).catch(err);
    }
  });

  // Добавление дорожки: выбор в селекте сразу применяет (набор ≤ 3).
  (document.getElementById("duoAdd") as HTMLElement).addEventListener("change", (e) => {
    const select = e.target as HTMLSelectElement;
    if (!select.value) return;
    const ids = state.tracks.filter((t) => t.source !== "file").map((t) => t.id);
    if (ids.length >= 3) return;
    ids.push(select.value);
    void bridge.subtitles.setTracks({ ids }).catch(err);
    select.value = ""; // обратно к подсказке; панель перерисует set_applied
  });

  // «Свои субтитры…»: нативный выбор файла → subtitles.load_file (3.6).
  document.getElementById("duoFileBtn")?.addEventListener("click", () => {
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
  });

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
  (document.getElementById("duoPosition") as HTMLElement).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]");
    if (b?.dataset.pos) void bridge.subtitles.setStyle({ style: { position: b.dataset.pos } }).catch(err);
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
      state.fontScalePct = ev.payload.style.fontScalePct;
      state.position = ev.payload.style.position;
      render();
      // Alt+D «показать/скрыть панель» (карточка duopulse-028): вслед за
      // переключением показа — панель открывается/закрывается.
      if (ev.payload.via === "alt-d") {
        if (ev.payload.enabled) openPanel();
        else closePanel();
      }
    },
  );

  void refresh();
}
