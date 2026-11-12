// DuoPulse — кнопка «⬇» + панель «Скачать» (карточка duopulse-118): видео
// (качество), музыка (m4a/mp3), субтитры выбранным языком и фрагменты
// «с … по …» с активной страницы. Кнопка в навбаре видна на http(s)-вкладках
// (yt-dlp поддерживает не только YouTube); панель — child-webview «download»
// (паттерн duo-панели 090: initDownloadButton в хроме открывает окно,
// openDownloadPanelContent наполняет его в панельном режиме).
//
// Данные: download.status (инструменты/каталог/задания), tabs.list (адрес
// активной вкладки), subtitles.list_tracks (языки для выгрузки; обновление —
// событием subtitles:tracks_ready). Прогресс — события download:progress /
// download:finished; панель закрыли — загрузки живут в Core, при следующем
// открытии панель покажет их в download.status.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import type {
  BaseTrackInfo,
  DownloadFinished,
  DownloadJobInfo,
  DownloadProgress,
  SubtitlesTracksReady,
  TranslationLangInfo,
} from "../bridge/gen/types";
import { anchorPanel, closePanel as closePanelWindow, currentPanel, openPanel } from "../chrome/panel-window";
import { onTabsChanged } from "../chrome/tabbar";
import {
  AUDIO_FORMAT_OPTIONS,
  QUALITY_OPTIONS,
  modeLabel,
  parseTimeInput,
  phaseLabel,
  rangeValid,
  subsLangOptions,
} from "./options";

const err = (e: unknown): void => console.error("download-panel:", e);

/** Состояние панели. */
interface DlState {
  mode: "video" | "audio" | "subs";
  url: string;
  base: BaseTrackInfo[];
  translations: TranslationLangInfo[];
  dir: string;
  activeJobId: number | null;
}

const state: DlState = {
  mode: "video",
  url: "",
  base: [],
  translations: [],
  dir: "",
  activeJobId: null,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`download-panel: нет #${id}`);
  return el as T;
};

// --- хром: кнопка --------------------------------------------------------------

/** Кнопка «⬇» в навбаре (режим хрома): видна на http(s)-вкладках, клик —
 *  панель-окно (паттерн duo). Идемпотентна. */
export function initDownloadButton(): void {
  const btn = $("dlBtn") as HTMLButtonElement | null;
  if (!btn || btn.dataset.dlInit === "1") return;
  btn.dataset.dlInit = "1";
  // адрес активной вкладки — кнопка видна только на сетевых страницах
  onTabsChanged((tabs) => {
    const active = tabs.find((t) => t.active);
    btn.hidden = !(active?.url ?? "").startsWith("http");
  });
  btn.addEventListener("click", () => {
    if (currentPanel() === "download") {
      closePanelWindow();
      return;
    }
    const { x, y, w, h } = anchorPanel("download", btn, "right");
    openPanel("download", x, y, w, h);
  });
}

// --- панель: контент -----------------------------------------------------------

let wired = false;

/** Наполнить панель данными (панельный режим bootPanel; в хроме её нет). */
export function openDownloadPanelContent(): void {
  wireControls();
  void refreshAll();
}

/** Одноразовая подвязка контролов и событий. */
function wireControls(): void {
  if (wired) return;
  wired = true;

  // режим: сегмент из трёх кнопок
  $("dlModes").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (!b) return;
    state.mode = b.dataset.mode as DlState["mode"];
    renderMode();
  });
  // селекты качеств/форматов — статичные опции
  const q = $("dlQuality");
  for (const o of QUALITY_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    q.append(opt);
  }
  const af = $("dlAudioFormat");
  for (const o of AUDIO_FORMAT_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    af.append(opt);
  }
  // каталог: нативный выбор папки → настройка downloads.dir
  $("dlDirBtn").addEventListener("click", () => {
    void (async () => {
      try {
        const path = await invoke<string | null>("plugin:dialog|open", {
          options: {
            title: "Каталог загрузок",
            directory: true,
            multiple: false,
          },
        });
        if (!path) return;
        await bridge.settings.apply({ downloads: { dir: path } });
        state.dir = path;
        $("dlDir").textContent = path;
        $("dlDir").title = path;
      } catch (e) {
        err(e);
      }
    })();
  });
  // запуск
  $("dlGo").addEventListener("click", startDownload);
  $("dlCancel").addEventListener("click", () => {
    if (state.activeJobId !== null) {
      void bridge.download.cancel({ jobId: state.activeJobId }).catch(err);
    }
  });
  // живые события ядра
  void listen<DownloadProgress>(bridge.events.downloadProgress, (ev) => {
    if (ev.payload.jobId === state.activeJobId) renderProgress(ev.payload);
  });
  void listen<DownloadFinished>(bridge.events.downloadFinished, (ev) => {
    if (ev.payload.jobId === state.activeJobId) renderFinished(ev.payload);
    void refreshJobs();
  });
  // свежий список дорожек (панель открыта до детекта видео)
  void listen<SubtitlesTracksReady>(bridge.events.subtitlesTracksReady, () => {
    void refreshTracks();
  });
}

/** Полное обновление: адрес, инструменты/каталог, дорожки, задания. */
async function refreshAll(): Promise<void> {
  try {
    const [tabs, status] = await Promise.all([bridge.tabs.list(), bridge.download.status()]);
    const active = tabs.tabs.find((t) => t.active);
    state.url = active?.url ?? "";
    state.dir = status.defaultDir;
    $("dlUrl").textContent = shortUrl(state.url);
    $("dlUrl").title = state.url;
    $("dlDir").textContent = status.defaultDir;
    $("dlDir").title = status.defaultDir;
    $("dlToolsHint").hidden = status.ytdlpReady && status.denoReady && status.ffmpegReady;
    renderJobs(status.jobs);
  } catch (e) {
    err(e);
  }
  await refreshTracks();
  renderMode();
}

/** Языки субтитров активной вкладки (снапшот сервиса Core). */
async function refreshTracks(): Promise<void> {
  try {
    const st = await bridge.subtitles.listTracks();
    state.base = st.base;
    state.translations = st.translations;
  } catch (e) {
    err(e);
    return;
  }
  const sel = $("dlLang");
  const opts = subsLangOptions(state.base, state.translations);
  sel.textContent = "";
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.append(opt);
  }
  $("dlNoTracks").hidden = opts.length > 0;
  $("dlLangField").hidden = opts.length === 0;
}

/** Видимость полей по режиму. */
function renderMode(): void {
  $("dlModes")
    .querySelectorAll<HTMLButtonElement>("button[data-mode]")
    .forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
  $("dlQualityField").hidden = state.mode !== "video";
  $("dlAudioField").hidden = state.mode !== "audio";
  $("dlLangField").hidden = state.mode !== "subs" || (state.base.length === 0 && state.translations.length === 0);
  $("dlPlainField").hidden = $("dlLangField").hidden;
  $("dlNoTracks").hidden = state.mode !== "subs" || (state.base.length + state.translations.length) > 0;
  $("dlRange").hidden = state.mode === "subs";
}

/** «Скачать»: сбор параметров и download.begin. */
function startDownload(): void {
  void (async () => {
    hideResult();
    const params: Parameters<typeof bridge.download.begin>[0] = {
      mode: state.mode,
      url: state.url,
      trackId: state.mode === "subs" ? (($("dlLang") as HTMLSelectElement).value ?? "") : "",
      quality: state.mode === "video" ? (($("dlQuality") as HTMLSelectElement).value || "best") : "",
      audioMp3: state.mode === "audio" && ($("dlAudioFormat") as HTMLSelectElement).value === "mp3",
      subsPlain: state.mode === "subs" && ($("dlPlain") as HTMLInputElement).checked,
      rangeStartSec: null,
      rangeEndSec: null,
      dir: null,
    };
    if (state.mode !== "subs") {
      if (!state.url.startsWith("http")) {
        showError("Адрес страницы не похож на ссылку — откройте страницу с видео");
        return;
      }
      const rangeOn = ($("dlRangeOn") as HTMLInputElement).checked;
      if (rangeOn) {
        const start = ($("dlRangeStart") as HTMLInputElement).value;
        const end = ($("dlRangeEnd") as HTMLInputElement).value;
        if (!rangeValid(start, end)) {
          showError("Диапазон: укажите начало (и конец позже начала) в формате мм:сс, например 1:23 — 5:40");
          return;
        }
        params.rangeStartSec = parseTimeInput(start);
        params.rangeEndSec = end.trim() ? parseTimeInput(end) : null;
      }
    } else if (!params.trackId) {
      showError("Выберите язык субтитров (список появляется на YouTube-видео)");
      return;
    }
    try {
      const res = await bridge.download.begin(params);
      state.activeJobId = res.jobId;
      $("dlProgress").hidden = false;
      $("dlBarFill").style.width = "0%";
      $("dlProgressText").textContent = "подготовка…";
      $("dlCancel").hidden = false;
      $<HTMLButtonElement>("dlGo").disabled = true;
      void refreshJobs();
    } catch (e) {
      showError(String(e));
    }
  })();
}

function renderProgress(p: DownloadProgress): void {
  $("dlProgress").hidden = false;
  $("dlBarFill").style.width = `${Math.round(p.percent)}%`;
  const bits = [phaseLabel(p.phase)];
  if (p.percent > 0 && p.phase !== "convert") bits.push(`${Math.round(p.percent)}%`);
  if (p.speed) bits.push(p.speed);
  if (p.eta) bits.push(`осталось ${p.eta}`);
  $("dlProgressText").textContent = bits.join(" · ");
  $("dlCancel").hidden = !(p.phase === "tools" || p.phase === "download" || p.phase === "subs");
}

function renderFinished(f: DownloadFinished): void {
  $("dlProgress").hidden = true;
  $<HTMLButtonElement>("dlGo").disabled = false;
  state.activeJobId = null;
  if (f.ok && f.path) {
    const done = $("dlDone");
    done.hidden = false;
    done.textContent = `Готово: ${f.path}`;
  } else if (f.canceled) {
    showError("Загрузка отменена");
  } else {
    showError(f.error ?? "загрузка не удалась");
  }
}

/** Компактный список заданий (живые и последние). */
async function refreshJobs(): Promise<void> {
  try {
    const status = await bridge.download.status();
    renderJobs(status.jobs);
  } catch (e) {
    err(e);
  }
}

function renderJobs(jobs: DownloadJobInfo[]): void {
  const host = $("dlJobs");
  host.textContent = "";
  const ACTIVE = new Set(["prepare", "tools", "download", "convert", "subs"]);
  for (const j of jobs.filter((x) => ACTIVE.has(x.phase) || x.phase === "done" || x.error).slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "dl-job";
    let text = `#${j.jobId} ${modeLabel(j.mode)} — ${phaseLabel(j.phase)}`;
    if (ACTIVE.has(j.phase) && j.percent > 0) text += ` ${Math.round(j.percent)}%`;
    if (j.phase === "done" && j.outPath) text += ` · ${shortUrl(j.outPath)}`;
    if (j.error) text += ` · ${j.error}`;
    row.textContent = text;
    row.title = j.outPath ?? j.error ?? "";
    host.append(row);
  }
}

function showError(text: string): void {
  const el = $("dlError");
  el.hidden = false;
  el.textContent = text;
}

function hideResult(): void {
  $("dlError").hidden = true;
  $("dlDone").hidden = true;
}

/** Короткая подпись адреса/пути: хост для URL, хвост для пути. */
function shortUrl(value: string): string {
  if (!value) return "";
  try {
    const u = new URL(value);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname}${path.length > 24 ? path.slice(0, 24) + "…" : path}`;
  } catch {
    return value.length > 42 ? "…" + value.slice(-41) : value;
  }
}
