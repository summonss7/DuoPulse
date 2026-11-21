// DuoPulse — поканальный баланс звука 5.1/7.1 в воспроизведении (duopulse-204,
// требование F-11). Настройки → раздел «Звук»: усиление каждого канала
// (0–200%, 100 — без изменения) и тумблер «применять к видео». Значения
// приходят init-скриптом window.__DUOPULSE_DEFAULTS__.audio (новые вкладки)
// и живым событием duopulse-audio-set (settings.apply → Core eval по вкладкам).
// applyToPlayback=false — звук страниц не трогаем вовсе (путь бит-точный);
// true — <video>/<audio> с безопасным src заводятся в WebAudio: стерео
// распределяется на все колонки (центр/саб/тыл — базовые коэффициенты ×
// усиление пользователя), родные многоканальные дорожки идут поканально с
// усилением. Порядок каналов WebAudio: 5.1 = FL FR C LFE SL SR; 7.1
// добавляет BL BR (задние) — тот же порядок у тест-кнопок страницы настроек.
//
// Здесь чистые функции (матрица, нормализация, безопасность src — тесты без
// DOM), DOM-обвязка — installAudioBalance: хук на событии «play» (capture,
// новые и пересозданные элементы), один AudioContext и один merger8 →
// destination на документ; смена настроек — перестройка рёбер без
// перезагрузки страницы. Отладочный снапшот для e2e/диагностики —
// window.__duopulseAudio {enabled, outChannels, hooked, srcChannels, edges}.

/** Усиление каналов, % (0–200; 100 — без изменения). */
export interface AudioGains {
  frontLeft: number;
  frontRight: number;
  center: number;
  lfe: number;
  sideLeft: number;
  sideRight: number;
  backLeft: number;
  backRight: number;
}

export interface AudioPlaybackConfig {
  applyToPlayback: boolean;
  gains: AudioGains;
}

export const DEFAULT_AUDIO_GAINS: AudioGains = {
  frontLeft: 100,
  frontRight: 100,
  center: 100,
  lfe: 100,
  sideLeft: 100,
  sideRight: 100,
  backLeft: 100,
  backRight: 100,
};

export const DEFAULT_AUDIO_CONFIG: AudioPlaybackConfig = {
  applyToPlayback: false,
  gains: { ...DEFAULT_AUDIO_GAINS },
};

/** Ключи усиления в порядке каналов WebAudio (индекс = вход merger). */
export const SPEAKER_LAYOUT = [
  "frontLeft",
  "frontRight",
  "center",
  "lfe",
  "sideLeft",
  "sideRight",
  "backLeft",
  "backRight",
] as const;

/** Базовые коэффициенты апмикса стерео→объёмный (до усиления пользователя):
 * фронты — 1 (бит-точно), центр — 0.7 от суммы (по 0.35 на ребро), саб —
 * 0.8 суммы (через lowpass, по 0.4 на ребро), тыл/зад — 0.35 от своего
 * фронта: старт «передние мощнее», ползунки двигают дальше в любую сторону. */
export const UPMIX_BASE: readonly number[] = [1, 1, 0.7, 0.8, 0.35, 0.35, 0.35, 0.35];

const clampGain = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(200, Math.max(0, v)) : 100;

/** Усиление из сырого JSON (настройки/e-событие): мусор и пропуски — дефолт
 * 100, значения — кламп 0–200. */
export function normalizeGains(raw: unknown): AudioGains {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const gains = { ...DEFAULT_AUDIO_GAINS };
  for (const key of Object.keys(gains) as (keyof AudioGains)[]) {
    gains[key] = clampGain(src[key]);
  }
  return gains;
}

/** Конфиг применения к видео из сырого JSON. */
export function normalizeAudioConfig(raw: unknown): AudioPlaybackConfig {
  const src = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    applyToPlayback: src.applyToPlayback === true,
    gains: normalizeGains(src.gains),
  };
}

/** Множители усиления в порядке SPEAKER_LAYOUT (1 — без изменения). */
export function gainMultipliers(gains: AudioGains): number[] {
  return SPEAKER_LAYOUT.map((key) => gains[key] / 100);
}

/** Ребро графа: выход сплиттера from → gain-узел → вход merger to. */
export interface MatrixEdge {
  from: number;
  to: number;
  gain: number;
}

const diag = (n: number, gain: (i: number) => number): MatrixEdge[] =>
  Array.from({ length: n }, (_, i) => ({ from: i, to: i, gain: gain(i) }));

/** Матрица для элемента: srcCh каналов источника → outCh выходов (каналы
 * устройства). enabled=false — бит-точный passthrough (элемент уже в графе,
 * возвращаем «как без хука»: стерео — фронты, объёмная дорожка — диагональ).
 * Стерео-источник (≤2) — апмикс: сумма в центр/саб по два ребра (merger
 * суммирует входы), lowpass саба ставит обвязка. Объёмный (≥6) — поканальное
 * усиление. Ребра за пределами outCh не строятся (иначе даунмикс устройства
 * подмешает тыл во фронты). */
export function matrixEdges(
  srcCh: number,
  gains: AudioGains,
  enabled: boolean,
  outCh: number,
): MatrixEdge[] {
  const m = gainMultipliers(gains);
  const out = Math.max(2, Math.min(outCh, 8));
  if (!enabled) {
    const n = Math.min(Math.max(2, Math.min(srcCh, 6)), out);
    return diag(n, () => 1);
  }
  if (srcCh >= 6) {
    const n = Math.min(srcCh, 8);
    return diag(Math.min(n, out), (i) => m[i] ?? 1);
  }
  const edges: MatrixEdge[] = [
    { from: 0, to: 0, gain: m[0] },
    { from: 1, to: 1, gain: m[1] },
  ];
  if (out > 2) {
    // центр и саб: (L+R)·база·усиление — по 0.5 на ребро (сумма входов)
    edges.push({ from: 0, to: 2, gain: 0.5 * UPMIX_BASE[2] * m[2] });
    edges.push({ from: 1, to: 2, gain: 0.5 * UPMIX_BASE[2] * m[2] });
    edges.push({ from: 0, to: 3, gain: 0.5 * UPMIX_BASE[3] * m[3] });
    edges.push({ from: 1, to: 3, gain: 0.5 * UPMIX_BASE[3] * m[3] });
    for (let to = 4; to < out; to++) {
      edges.push({ from: to % 2 === 0 ? 0 : 1, to, gain: UPMIX_BASE[to] * m[to] });
    }
  }
  return edges;
}

/** Сабвуферное ребро (lowpass перед усилением — только синтезированный из
 * стерео саб; родная дорожка LFE идёт как есть). */
export function edgeNeedsLowpass(srcCh: number, edge: MatrixEdge): boolean {
  return srcCh < 6 && edge.to === 3;
}

/** Безопасен ли элемент для WebAudio-хука: cross-origin медиа без CORS после
 * createMediaElementSource замолкает навсегда — берём только blob:/data:
 * (MSE YouTube), same-origin или явный crossOrigin. */
export function safeSrcForHook(
  el: { currentSrc?: string; src?: string; crossOrigin?: string | null },
  origin: string,
): boolean {
  if (el.crossOrigin) return true;
  const url = el.currentSrc || el.src || "";
  if (!url) return false; // без src не цепляем: источник появится позже —
  // проверка пройдёт на следующем «play»
  if (url.startsWith("blob:") || url.startsWith("data:")) return true;
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

/** Конфиг из window.__DUOPULSE_DEFAULTS__.audio (init-скрипт Core). */
export function readAudioDefaults(
  holder: { __DUOPULSE_DEFAULTS__?: unknown } = window as unknown as {
    __DUOPULSE_DEFAULTS__?: unknown;
  },
): AudioPlaybackConfig {
  const root = holder.__DUOPULSE_DEFAULTS__;
  const audio =
    typeof root === "object" && root !== null
      ? (root as { audio?: unknown }).audio
      : undefined;
  return normalizeAudioConfig(audio);
}

/** Отладочный снапшот для e2e/диагностики (window.__duopulseAudio). */
export interface AudioBalanceDebug {
  enabled: boolean;
  outChannels: number;
  hooked: number;
  srcChannels: number;
  edges: MatrixEdge[];
}

interface HookedGraph {
  src: MediaElementAudioSourceNode;
  splitter: ChannelSplitterNode;
  edgeNodes: AudioNode[];
  srcChannels: number;
}

/** Включить модуль в документе: слушает play и duopulse-audio-set. */
export function installAudioBalance(
  doc: Document = document,
  win: Window = window,
): void {
  let config = readAudioDefaults(win as unknown as { __DUOPULSE_DEFAULTS__?: unknown });
  let ctx: AudioContext | null = null;
  let merger: ChannelMergerNode | null = null;
  let outChannels = 0;
  const graphs = new Map<HTMLMediaElement, HookedGraph>();
  const skipped = new WeakSet<HTMLMediaElement>();

  const debug: AudioBalanceDebug = {
    enabled: config.applyToPlayback,
    outChannels: 0,
    hooked: 0,
    srcChannels: 0,
    edges: [],
  };
  (win as unknown as { __duopulseAudio?: AudioBalanceDebug }).__duopulseAudio = debug;

  const ensureGraphBase = (): boolean => {
    if (!ctx) {
      const Ctor = (win as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
      if (!Ctor) return false;
      try {
        ctx = new Ctor();
      } catch {
        return false;
      }
      merger = ctx.createChannelMerger(8);
      merger.connect(ctx.destination);
      outChannels = Math.max(2, Math.min(ctx.destination.maxChannelCount || 2, 8));
    }
    return merger !== null;
  };

  const rebuild = (): void => {
    debug.enabled = config.applyToPlayback;
    debug.outChannels = outChannels;
    debug.hooked = graphs.size;
    if (!ctx || !merger) return;
    for (const graph of graphs.values()) {
      for (const node of graph.edgeNodes) node.disconnect();
      graph.edgeNodes = [];
      const srcCh = Math.max(2, Math.min(graph.src.channelCount || 2, 8));
      graph.srcChannels = srcCh;
      const edges = matrixEdges(srcCh, config.gains, config.applyToPlayback, outChannels);
      debug.srcChannels = srcCh;
      debug.edges = edges;
      for (const edge of edges) {
        const gainNode = ctx.createGain();
        gainNode.gain.value = edge.gain;
        if (edgeNeedsLowpass(srcCh, edge)) {
          const lp = ctx.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = 120;
          graph.splitter.connect(lp, edge.from);
          lp.connect(gainNode);
          graph.edgeNodes.push(lp);
        } else {
          graph.splitter.connect(gainNode, edge.from);
        }
        gainNode.connect(merger, 0, edge.to);
        graph.edgeNodes.push(gainNode);
      }
    }
  };

  const tryHook = (el: HTMLMediaElement): void => {
    if (graphs.has(el) || skipped.has(el)) return;
    // DRM (EME): защищённое содержимое через WebAudio молчит — не трогаем.
    if (el.mediaKeys) {
      skipped.add(el);
      return;
    }
    if (!safeSrcForHook(el, win.location.origin)) return;
    if (!ensureGraphBase()) return;
    try {
      const src = ctx!.createMediaElementSource(el);
      const splitter = ctx!.createChannelSplitter(8);
      src.connect(splitter);
      graphs.set(el, { src, splitter, edgeNodes: [], srcChannels: 2 });
      rebuild();
      void ctx!.resume();
    } catch {
      // чужой createMediaElementSource (сайт сам строит граф) — не мешаем
      skipped.add(el);
    }
  };

  doc.addEventListener(
    "play",
    (e) => {
      if (!config.applyToPlayback) return;
      if (e.target instanceof HTMLMediaElement) tryHook(e.target);
    },
    true,
  );

  doc.addEventListener("duopulse-audio-set", (e) => {
    const detail = (e as CustomEvent<unknown>).detail;
    config = normalizeAudioConfig(detail);
    if (config.applyToPlayback) {
      for (const el of doc.querySelectorAll("video, audio")) {
        if (el instanceof HTMLMediaElement && !el.paused) tryHook(el);
      }
    }
    rebuild();
  });

  // Уже играющие элементы (настройку включили после старта видео).
  if (config.applyToPlayback) {
    for (const el of doc.querySelectorAll("video, audio")) {
      if (el instanceof HTMLMediaElement && !el.paused) tryHook(el);
    }
  }
  debug.outChannels = outChannels;
}
