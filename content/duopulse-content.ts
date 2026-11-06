// DuoPulse content-бандл — вход (задача 3.2, docs/05 §1: content/duopulse-content.ts).
// Собирается в один IIFE без зависимостей (scripts/build-content.mjs → esbuild →
// content/gen/duopulse-content.js) и инжектируется initialization_script'ом в
// каждый документ контентной вкладки (до скриптов страницы, docs/02 §4).
//
// M3: детектор <video> → событие page:video_detected в Core (WebMessage →
// bridge, docs/05 §2) → движок cue-таймлайна (часы video.currentTime) → оверлей.
// Задача 3.3: YouTube-адаптер — полный список дорожек из player-ответа (пути
// player-api → initial → texttrack, docs/03 §9) + загрузка выбранного набора
// 2–3 дорожек (оригинал + переводы tlang) в движок. На YouTube-страницах до
// скриптов страницы ставится перехват fetch/XHR: тела timedtext-ответов плеера
// (с PO-токеном) — источник данных адаптера; разбор тел — канонический в Core
// (WebMessage parse-subtitles, парсеры задачи 3.1).
//
// Выбор дорожек (до панели настроек 3.7): custom-событие
// duopulse-select-tracks {detail:{ids:[…]}} или окно
// __duopulseContent.selectTracks(ids) — id из tracksInfo() («yt:en»,
// «yt:en+ru», голый код перевода — база по умолчанию). Тест-хуки 3.2
// (duopulse-test-track/-offset) остаются для e2e-стенда не-YouTube страниц;
// оверлей 3.4 добавляет duopulse-test-style {detail:{position|fontScalePct|
// marginPct|plateOpacity}} и Shift+колесо (сдвиг).
//
// Синхронизация (задача 3.5, docs/03 §4 п.3, §8): сдвиг ±10 с шагом 100 мс —
// Shift+колесо по плашке, горячие клавиши Alt+[ (раньше) / Alt+] (позже),
// команда Core subtitles.set_offset (eval активной вкладки диспатчит
// duopulse-set-offset {detail:{offsetMs}}); каждое изменение применяет
// движок без перезагрузки дорожек и показывает HUD со слайдером. Набор
// дорожек привязан к videoKey: пересоздание <video> с тем же ключом (смена
// качества у ряда плееров) набор не теряет — реплика не пропадает.
//
// Ручные файлы (задача 3.6, docs/03 §3.2): drag&drop 1–3 файлов .srt/.vtt на
// страницу с <video> (content/adapters/file.ts; разбор — канонический в Core)
// и панельный путь subtitles.load_file (Core читает файл с диска и доставляет
// cue событием duopulse-file-track). Файловые дорожки — в общем наборе с
// дорожками платформы (docs/01 F-06): платформенные + файловые, до 3 строк.
//
// Панель настроек набора (задача 3.7, docs/03 §8): Core доставляет команды
// eval'ом активной вкладки (паттерн subtitles.set_offset) — duopulse-toggle
// {enabled} (без detail — переключение, Alt+D; на пустом наборе включение
// собирает дефолт «оригинал + предпочитаемый перевод», content/set-defaults),
// duopulse-set-style (частичный SubtitleStyle), duopulse-remove-track {id}
// (снять дорожку из любой части набора без перезагрузки остальных);
// duopulse-select-tracks получил fast-path: тот же состав в другом порядке —
// перестановка без повторной загрузки. Обратно в Core шлётся «set-state»
// (состав набора + enabled + offset + стиль, поле via — источник изменения):
// сервис состояния Core (subtitles.list_tracks) и события subtitles:* для
// кнопки «duo» и панели — Core-обвязка задачи 3.7. Alt+D в странице (e.code
// KeyD) переключает показ, поглощая клавишу, как Alt+[ / Alt+].
//
// Облачный перевод (задача 4.2, docs/03 §7): панель → subtitles.translate_track
// → Core eval'ит duopulse-translate-request {trackId, targetLang}; cues —
// здесь, конвейер (кэш SQLite, пачки ≤ 2 КБ с контекстом) — в Core
// (content/adapters/cloud.ts), переведённая дорожка (source "translate")
// входит в набор после платформенных строк; повторный просмотр отдаётся
// кэшем — сети нет (DoD 4.2).

import { VideoDetector, type DetectedVideo } from "./detector";
import { SubtitlesEngine, type ActiveRow } from "./engine/subtitles-engine";
import { SubtitlesOverlay } from "./overlay/overlay";
import type { SubtitleStyle } from "./overlay/style";
import { OffsetHud, stepOffset } from "./overlay/hud";
import { NativeCaptionsBlanker } from "./native-captions";
import { postToCore } from "./messaging";
import { createCoreParser } from "./messaging/parse";
import {
  YouTubeAdapter,
  installTimedtextCapture,
  isYouTubeHref,
  type PageWindow,
} from "./adapters/youtube";
import type { AdapterTrackList } from "./adapters/types";
import {
  FileDropZone,
  buildFileTracks,
  combinedTracks,
  fileTrackFrom,
  langOfFileName,
  type FileLoadResult,
} from "./adapters/file";
import { cloudTrackFrom, cloudTranslateStatus, requestCloudTranslation } from "./adapters/cloud";
import { asrStatus, asrTrackFrom, requestAsrTrack } from "./adapters/asr";
import { preferredLangs } from "./defaults";
import type { Cue, Track } from "./types";
import { defaultSetIds, decideToggle, sameMembers } from "./set-defaults";

(function (): void {
  "use strict";
  const w = window as unknown as { __DUOPULSE_SUBTITLES__?: boolean };
  if (w.__DUOPULSE_SUBTITLES__) return; // бандл исполняется один раз на документ
  w.__DUOPULSE_SUBTITLES__ = true;

  const pageWindow = window as unknown as PageWindow;
  // Внутренние страницы (app-origin: прод tauri.localhost, dev localhost:5173)
  // — не контент: видео там нет, а запросы шрифтов/состояния шумят в консоль
  // (карточка duopulse-076). Webview живёт с бандлом всю жизнь — внешний
  // документ в нём получит всё как раньше.
  if (
    location.hostname === "tauri.localhost" ||
    location.protocol === "duopulse:" ||
    (location.hostname === "localhost" && location.port === "5173")
  )
    return;
  let currentVideo: DetectedVideo | null = null;
  // Перехват тел timedtext: только на YouTube (initialization script до
  // скриптов страницы; кросс-доменная навигация = новый документ = новый бандл).
  const capture = isYouTubeHref(location.href) ? installTimedtextCapture(pageWindow) : undefined;
  const adapter = new YouTubeAdapter({
    win: pageWindow,
    getVideo: () => currentVideo?.el ?? null,
    capture,
  });

  const engine = new SubtitlesEngine({
    onRowsChange(rows: ActiveRow[]): void {
      if (rows.length > 0 && currentVideo) overlay.show(rows, currentVideo.el);
      else overlay.hide();
    },
  });

  const overlay = new SubtitlesOverlay({
    // Shift+колесо над плашкой — шаг сдвига синхронизации (docs/03 §8, 100 мс).
    onOffsetStep: (direction) => stepOffsetBy(direction),
    // Стиль изменился (колесо-размер, панель 3.7) — сообщить в Core (set-state),
    // чтобы панель показывала актуальные значения.
    onStyleChange: () => reportSetState("style"),
  });

  /** HUD синхронизации (задача 3.5): слайдер ±10 с/шаг 100 + индикация. */
  const hud = new OffsetHud({
    onSet: (offsetMs) => setOffset(offsetMs),
  });

  /** Единая точка применения сдвига (docs/03 §4: ко всему набору, без
   * перезагрузки дорожек): любой источник — клавиши, колесо, слайдер, IPC. */
  const setOffset = (offsetMs: number): void => {
    engine.setOffset(offsetMs);
    if (currentVideo) {
      // HUD — на свободном краю видео (противоположном плашке субтитров).
      const side = overlay.styleInfo().position === "top" ? "bottom" : "top";
      hud.show(engine.getOffset(), currentVideo.el, side);
    }
    reportSetState("offset");
  };

  const stepOffsetBy = (direction: number): void => {
    if (engine.state().trackCount === 0) return;
    setOffset(stepOffset(engine.getOffset(), direction));
  };

  // Гашение нативных субтитров платформы, пока активен наш показ (docs/03 §2).
  const blanker = new NativeCaptionsBlanker({ doc: document, href: () => location.href });

  /** Набор текущего видео из трёх частей (задачи 3.6+4.2): платформенная
   * (адаптер/тест-хук), облачные переводы (после платформенных), файловая
   * (drag&drop/subtitles.load_file). Итог — до 3 строк (docs/03 §1); дроп
   * замещает файловую часть целиком, перевод — свою. Переживает пересоздание
   * <video> с тем же ключом — смена качества: таймлайн тот же, дорожки те же,
   * docs/03 §4. Память — последние ключи (LRU): возврат к видео восстанавливает
   * все части. */
  let platformTracks: Track[] = [];
  let asrTracks: Track[] = [];
  let translateTracks: Track[] = [];
  let fileTracks: Track[] = [];
  const setMemory = new Map<
    string,
    { platform: Track[]; asr: Track[]; translate: Track[]; files: Track[]; enabled: boolean }
  >();
  const SET_MEMORY_LIMIT = 8;

  /** Запомнить текущее разбиение набора и состояние показа за текущим
   * видео (LRU): возврат к видео восстановит и состав, и «вкл/выкл» —
   * docs/03 §8 п.2 «последний набор». */
  const rememberSetState = (): void => {
    if (!currentVideo) return;
    const key = currentVideo.videoKey;
    setMemory.delete(key); // LRU: освежить порядок
    setMemory.set(key, {
      platform: platformTracks,
      asr: asrTracks,
      translate: translateTracks,
      files: fileTracks,
      enabled,
    });
    while (setMemory.size > SET_MEMORY_LIMIT) {
      setMemory.delete(setMemory.keys().next().value as string);
    }
  };

  /** Показ включён (задача 3.7, docs/03 §8 п.2: Alt+D — «выключить, помня
   * последний набор»): при false движок получает пустой набор, состав и
   * набор-память живут — включение восстанавливает показ без перезагрузки.
   * Инвариант duopulse-066: в покое true только при непустом наборе —
   * «вкл — 0 дорожек» не возникает, кнопка duo не врёт. */
  let enabled = true;

  /** В наборе есть хоть одна дорожка (любой части)? Видимое пользователю
   * «показано» = enabled && hasSetTracks() — решение Alt+D по нему
   * (duopulse-066), а не по флагу одному. */
  const hasSetTracks = (): boolean =>
    platformTracks.length > 0 || asrTracks.length > 0 || translateTracks.length > 0 || fileTracks.length > 0;

  /** Единая точка смены набора: движок + гашение нативного показа. */
  const applyTracks = (tracks: Track[]): void => {
    engine.setTracks(tracks);
    if (tracks.length > 0) blanker.blank(currentVideo?.el ?? null);
    else blanker.restore();
  };

  /** Состав набора как он ляжет на плашку (до 3 строк: платформа, облачные
   * переводы, файлы); при выключенном показе панели показывается тот же
   * «последний набор» — гашенность передаёт флаг enabled. */
  const lastSetTracks = (): Track[] =>
    combinedTracks([...platformTracks, ...asrTracks, ...translateTracks], fileTracks).tracks;

  /** Отчёт состояния в Core (задача 3.7): сервис состояния (subtitles.*
   * IPC) и события subtitles:set_applied для кнопки «duo» и панели.
   * via — источник изменения (alt-d/panel/select/drop/video/…, телеметрия). */
  const reportSetState = (via: string): void => {
    postToCore({
      duopulse: "set-state",
      videoKey: currentVideo?.videoKey ?? null,
      enabled,
      via,
      tracks: lastSetTracks().map((t) => ({
        id: t.id,
        lang: t.lang,
        source: t.source,
        role: t.role,
        name: displayNameOf(t),
      })),
      offsetMs: engine.getOffset(),
      style: overlay.styleInfo(),
    });
  };

  /** Отображаемое имя дорожки для панели: облачный перевод знает своё имя
   * («DeepL → ru», задача 4.2); базовые/переводы — из списка адаптера,
   * файловые — слаг из id (file:movie_ru → movie_ru). */
  const displayNameOf = (t: Track): string => {
    if (t.name) return t.name;
    if (t.source === "file") return t.id.replace(/^file:/, "");
    if (t.source === "youtube" && trackList) {
      const base = trackList.base.find((b) => b.id === t.id);
      if (base) return base.name;
      const pair = t.id.split("+");
      const translation = trackList.translations.find((x) => x.lang === pair[1]);
      if (translation) return translation.name;
    }
    return t.lang;
  };

  /** Применить и запомнить текущее разбиение набора за текущим видео. */
  const applySet = (via: string): void => {
    const { tracks, droppedFiles } = combinedTracks(
      [...platformTracks, ...asrTracks, ...translateTracks],
      fileTracks,
    );
    if (droppedFiles > 0) {
      // Файлы сверх лимита набора отброшены — телеметрия для диагностики.
      postToCore({
        duopulse: "file-tracks",
        videoKey: currentVideo?.videoKey ?? "",
        applied: fileTracks.length,
        dropped: droppedFiles,
      });
    }
    // Честность флага (duopulse-066): явное изменение состава (панель, дефолт
    // Alt+D, файлы, перевод, ASR) включает показ, опустошение набора (сняли
    // последнюю дорожку) выключает — состояния «вкл — 0 дорожек» не возникает.
    enabled = tracks.length > 0;
    applyTracks(enabled ? tracks : []);
    rememberSetState();
    reportSetState(via);
  };

  /** Выключить показ (docs/03 §8 п.2): погасить, состав набора помним —
   * включение восстановит его без перезагрузки. Состояние «выкл» уходит в
   * набор-память: возврат к видео не включит показ сам. */
  const disableSubs = (via: string): void => {
    enabled = false;
    applyTracks([]);
    rememberSetState();
    reportSetState(via);
  };

  /** Включить показ: восстановить набор, на пустом собрать дефолт
   * «оригинал + предпочитаемый перевод» (сценарий docs/01 §5.1: Alt+D на
   * свежей лекции даёт дуо en+ru; предпочитаемый язык — из настроек профиля,
   * задача 5.1, window.__DUOPULSE_DEFAULTS__ от Core). */
  const enableSubs = (via: string): void => {
    enabled = true;
    if (!hasSetTracks()) {
      const ids = defaultSetIds(trackList, preferredLangs());
      if (ids.length > 0) {
        void selectTracks(ids, via); // применит и отчитет (set-state)
        return;
      }
    }
    applySet(via);
  };

  /** Переключение показа (Alt+D, docs/03 §8 п.2): решение decideToggle —
   * «выключить» только при активном показе (флаг + непустой набор);
   * «флаг поднят, набор пуст» — это «не показано» (duopulse-066): включаем,
   * собирая дефолт, а не снимаем флаг. Работает только при детектированном
   * видео. */
  const toggleSubs = (via: string): void => {
    if (!currentVideo) return;
    if (decideToggle(enabled, hasSetTracks(), trackList, preferredLangs()).on) enableSubs(via);
    else disableSubs(via);
  };

  /** Явное включение/выключение (панель subtitles.set_enabled, e2e): «выкл»
   * гасит всегда; «вкл» на пустом наборе собирает дефолт даже при уже
   * поднятом флаге (duopulse-066). */
  const setSubsEnabled = (on: boolean, via: string): void => {
    if (on) {
      if (!enabled || !hasSetTracks()) enableSubs(via);
    } else if (enabled) {
      disableSubs(via);
    }
  };

  const parser = createCoreParser();
  let trackList: AdapterTrackList | null = null;
  let listSeq = 0;

  const reportDetected = (video: DetectedVideo, canTracks: boolean): void => {
    // Событие контракта page:video_detected (docs/05 §2): Core эмитит его в UI
    // (main.rs → bridge::emit). canTracks — по факту списка адаптера (3.3).
    postToCore({ duopulse: "video", videoKey: video.videoKey, canTracks });
  };

  /** Список дорожек YouTube-видео: после детекта (player-ответ может отставать
   * на SPA — listTracks ждёт); переотчёт при смене видео отбрасывается. */
  const onYouTubeVideo = (video: DetectedVideo): void => {
    const seq = ++listSeq;
    void adapter.listTracks().then((list) => {
      if (seq !== listSeq || currentVideo?.videoKey !== video.videoKey) return;
      trackList = list;
      const canTracks = (list?.base.length ?? 0) > 0;
      reportDetected(video, canTracks);
      if (list) {
        // Полный список — в Core (сервис состояния + событие subtitles:
        // tracks_ready для панели, задача 3.7); журнал — путь добычи.
        postToCore({
          duopulse: "tracks",
          videoKey: video.videoKey,
          path: list.usedPath,
          base: list.base.map((b) => ({
            id: b.id,
            lang: b.lang,
            kind: b.kind,
            name: b.name,
            original: b.original,
            translatable: b.translatable,
          })),
          translations: list.translations.map((t) => ({ lang: t.lang, name: t.name })),
        });
      }
    });
  };

  /** Загрузка выбранного набора (id из tracksInfo()) в движок. Смена видео
   * во время загрузки — результат не применяется (дорожки прошлого видео);
   * файловая часть набора не трогается (смешивание, docs/01 F-06).
   * Fast-path задачи 3.7: тот же состав в другом порядке (панель ↑/↓) —
   * перестановка без повторной загрузки (tlang-запросы рейт-лимитятся). */
  const selectTracks = async (
    ids: string[],
    via = "select",
  ): Promise<{ loaded: number; failures: { id: string; reason: string }[]; unknown: string[] }> => {
    const unique = [...new Set(ids)];
    if (sameMembers(platformTracks.map((t) => t.id), unique)) {
      const byId = new Map(platformTracks.map((t) => [t.id, t]));
      platformTracks = unique
        .map((id) => byId.get(id))
        .filter((t): t is Track => t !== undefined);
      applySet(via);
      return { loaded: platformTracks.length, failures: [], unknown: [] };
    }
    const resolved = adapter.resolveIds(unique);
    const failures = resolved.unknown.map((id) => ({ id, reason: "неизвестный id дорожки" }));
    if (resolved.refs.length === 0) return { loaded: 0, failures, unknown: resolved.unknown };
    const keyAtStart = currentVideo?.videoKey ?? null;
    const loaded = await adapter.loadTracks(resolved.refs, { parser });
    if (currentVideo?.videoKey !== keyAtStart) return { loaded: 0, failures, unknown: resolved.unknown };
    platformTracks = loaded.tracks;
    applySet(via);
    for (const f of loaded.failures) failures.push({ id: f.ref.id, reason: f.reason });
    return { loaded: loaded.tracks.length, failures, unknown: resolved.unknown };
  };

  let lastAppliedVideoKey: string | null = null;
  const detector = new VideoDetector({
    onVideo(video: DetectedVideo): void {
      // Детектор уточняет ключ того же объекта (loadedmetadata/SPA) и
      // переэмитит его — сравнение currentVideo.videoKey с video.videoKey
      // здесь всегда «равно» (одна ссылка), поэтому помним ключ последней
      // обработки сами: смена ключа = смена видео (docs/03 §6).
      const changed =
        currentVideo?.el !== video.el || lastAppliedVideoKey !== video.videoKey;
      lastAppliedVideoKey = video.videoKey;
      currentVideo = video;
      if (changed) {
        // Набор привязан к videoKey (docs/03 §6). Новый <video> с тем же
        // ключом (смена качества у плееров, пересоздающих элемент; ключ
        // уточняется по loadedmetadata) — применяем запомненный набор без
        // перезагрузки (3.5); чужой ключ — чистим показ, набор-память живёт
        // для возврата к тому же видео. Детект до loadedmetadata приходит с
        // ключом без длительности — память по уточнённому ключу не стёрта,
        // уточнённый детект следом её поднимет.
        const mem = setMemory.get(video.videoKey);
        platformTracks = mem ? mem.platform : [];
        asrTracks = mem ? mem.asr : [];
        translateTracks = mem ? mem.translate : [];
        fileTracks = mem ? mem.files : [];
        // Список дорожек принадлежит прошлому видео — сброс до свежего
        // (придёт с onYouTubeVideo; дефолт-набор Alt+D не соберётся по чужому).
        trackList = null;
        // Запомненное видео восстанавливает и набор, и состояние показа
        // («последний набор», docs/03 §8 п.2). Новое видео без набора —
        // показ честно выключен (duopulse-066): флаг не поднимаем «впустую»
        // (иначе кнопка duo выглядит включённой без оверлея, а первый Alt+D
        // приходилось тратить на «выключение»); Alt+D соберёт дефолт
        // «оригинал + ru» с первого нажатия. Переходный детект (ключ ещё
        // без длительности) в память промахивается — уточнённый детект
        // следом восстановит показ запомненного видео.
        enabled = mem ? mem.enabled : false;
        applyTracks(enabled ? lastSetTracks() : []);
        engine.attach(video.el);
        reportSetState("video");
        if (adapter.matches(video.url)) onYouTubeVideo(video);
        else {
          trackList = null;
          reportDetected(video, false);
        }
      }
    },
    onVideoLost(): void {
      currentVideo = null;
      engine.detach(); // плашка гасится (rows = [])
      blanker.restore(); // нативный показ платформы возвращается (docs/03 §2)
      hud.hide();
      reportSetState("lost"); // панель/кнопка «duo»: видео ушло (videoKey null)
    },
  });

  // Тест-хуки e2e-стенда (задача 3.2): тест-страница/CDP задаёт дорожку и сдвиг
  // напрямую — сервис-обвязка Core subtitles.* появится в задачах 3.5–3.7.
  // __DUOPULSE_TEST_TRACK__ — дорожка, массив дорожек (набор 3.4) или {clear:true};
  // до 3.6 хук задавал весь набор, теперь — платформенную часть (файловые
  // дорожки дропа живут своей частью — смешивание проверяется стендом 3.6).
  document.addEventListener("duopulse-test-track", () => {
    const payload = (window as unknown as Record<string, unknown>).__DUOPULSE_TEST_TRACK__;
    if (payload === null || typeof payload !== "object") return;
    if ("clear" in payload && (payload as { clear: unknown }).clear === true) {
      platformTracks = [];
      asrTracks = [];
      translateTracks = [];
      fileTracks = [];
      applySet("test");
      return;
    }
    if (Array.isArray(payload) || Array.isArray((payload as { cues?: unknown }).cues)) {
      const tracks = (Array.isArray(payload) ? payload : [payload]) as Track[];
      if (tracks.every((t) => Array.isArray(t.cues))) {
        platformTracks = tracks;
        applySet("test");
      }
    }
  });
  document.addEventListener("duopulse-test-offset", (e) => {
    const detail = (e as CustomEvent<{ offsetMs?: number }>).detail;
    if (detail && typeof detail.offsetMs === "number") setOffset(detail.offsetMs);
  });
  // Команда Core subtitles.set_offset (задача 3.5): bridge-хендлер исполняет
  // этот диспатч в активной вкладке (eval) — применение без перезагрузки
  // дорожек, кламп ±10 с в движке.
  document.addEventListener("duopulse-set-offset", (e) => {
    const detail = (e as CustomEvent<{ offsetMs?: number }>).detail;
    if (detail && typeof detail.offsetMs === "number") setOffset(detail.offsetMs);
  });

  // Горячие клавиши сдвига (задача 3.5, docs/03 §8): Alt+[ — раньше,
  // Alt+] — позже, шаг 100 мс (docs/03 §4). Действуют при активном наборе
  // субтитров; странице событие не отдаём. e.code — независимо от раскладки.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code !== "BracketLeft" && e.code !== "BracketRight") return;
      if (engine.state().trackCount === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      stepOffsetBy(e.code === "BracketRight" ? 1 : -1);
    },
    true,
  );
  // Alt+D — включить/выключить субтитры (задача 3.7, docs/03 §8 п.2):
  // выключить, помня последний набор; включить — восстановить его, на пустом
  // наборе собрать дефолт «оригинал + предпочитаемый перевод» (сценарий
  // docs/01 §5.1). Клавишу поглощаем, странице не отдаём; e.code KeyD —
  // независимо от раскладки.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.code !== "KeyD") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleSubs("alt-d");
    },
    true,
  );
  // Стиль плашки: тест-хук 3.4 и панель 3.7 (subtitles.set_style → Core eval).
  document.addEventListener("duopulse-test-style", (e) => {
    const detail = (e as CustomEvent<Partial<SubtitleStyle>>).detail;
    if (detail && typeof detail === "object") overlay.setStyle(detail);
  });
  document.addEventListener("duopulse-set-style", (e) => {
    const detail = (e as CustomEvent<{ style?: Partial<SubtitleStyle> }>).detail;
    if (detail && detail.style && typeof detail.style === "object") overlay.setStyle(detail.style);
  });

  // Переключение показа (панель 3.7: subtitles.set_enabled/toggle → Core eval;
  // без detail — «переключить», путь Alt+D из хрома — там свой keydown).
  // Явный запрос идёт через setSubsEnabled: «вкл» на пустом наборе собирает
  // дефолт даже при поднятом флаге (duopulse-066).
  document.addEventListener("duopulse-toggle", (e) => {
    const detail = (e as CustomEvent<{ enabled?: unknown; via?: unknown }>).detail;
    if (detail && typeof detail.enabled === "boolean") {
      setSubsEnabled(detail.enabled, typeof detail.via === "string" ? detail.via : "panel");
    } else {
      toggleSubs("alt-d");
    }
  });

  // Снять дорожку из набора (панель 3.7: subtitles.remove_track → Core eval):
  // файловую, облачный перевод или платформенную — остальные без перезагрузки.
  document.addEventListener("duopulse-remove-track", (e) => {
    const id = (e as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id !== "string" || !id) return;
    if (id.startsWith("file:")) {
      fileTracks = fileTracks.filter((t) => t.id !== id);
      applySet("remove");
    } else if (id.startsWith("cloud:")) {
      translateTracks = translateTracks.filter((t) => t.id !== id);
      applySet("remove");
    } else if (id.startsWith("asr:")) {
      asrTracks = asrTracks.filter((t) => t.id !== id);
      applySet("remove");
    } else {
      platformTracks = platformTracks.filter((t) => t.id !== id);
      applySet("remove");
    }
  });

  // Облачный перевод дорожки (задача 4.2: панель → subtitles.translate_track
  // → Core eval). Cues — здесь, конвейер — в Core (кэш → пачки → провайдер →
  // кэш); ответ придёт событием duopulse-translate-track (content/adapters/
  // cloud.ts). Перевод длинной дорожки — минуты: смена видео за это время —
  // результат не применяем (набор привязан к videoKey, docs/03 §6).
  document.addEventListener("duopulse-translate-request", (e) => {
    const detail = (e as CustomEvent<{ trackId?: unknown; targetLang?: unknown }>).detail;
    const targetLang = typeof detail?.targetLang === "string" ? detail.targetLang.trim() : "";
    if (!targetLang) return;
    const trackId = typeof detail.trackId === "string" ? detail.trackId : "";
    const source =
      [...platformTracks, ...fileTracks].find((t) => t.id === trackId) ??
      platformTracks.find((t) => t.role === "original") ??
      platformTracks[0] ??
      fileTracks[0] ??
      null;
    if (!source || source.cues.length === 0) return; // устаревший снапшот — Core валидировал состав
    const sourceLang = source.lang && source.lang !== "und" ? source.lang : "";
    const videoKeyAtRequest = currentVideo?.videoKey ?? "";
    void requestCloudTranslation(document, { post: postToCore }, {
      videoKey: videoKeyAtRequest,
      trackId: source.id,
      sourceLang,
      targetLang,
      cues: source.cues,
    }).then((reply) => {
      if (!reply.ok) return;
      const track = cloudTrackFrom(targetLang, typeof reply.name === "string" ? reply.name : "", reply.cues ?? []);
      if (!track) return;
      if (currentVideo?.videoKey !== videoKeyAtRequest) return; // видео сменилось
      // Повтор того же языка — замена, разные языки — разные строки набора.
      translateTracks = [...translateTracks.filter((t) => t.id !== track.id), track];
      applySet("translate");
    });
  });

  // Распознать речь видео (карточка duopulse-060: панель → subtitles.asr_start
  // → Core eval). URL аудио — из контекста страницы: адаптер платформы
  // (player-ответ YouTube), иначе src «голого» <video> (http(s), не blob —
  // MSE-плееры вне YouTube в v1 не поддержаны). Конвейер — в Core
  // (content/adapters/asr.ts); ответ — событием duopulse-asr-track.
  document.addEventListener("duopulse-asr-request", () => {
    if (!currentVideo) return;
    const platform = adapter.audioSource();
    const el = currentVideo.el as HTMLVideoElement;
    const naked = [el.currentSrc, el.src].find(
      (s) => typeof s === "string" && /^https?:/i.test(s),
    );
    const source = platform ?? (naked ? { url: naked, lang: "" } : null);
    if (!source) {
      postToCore({ duopulse: "asr-begin", reqId: 0, videoKey: currentVideo.videoKey, url: "", lang: "" });
      return; // Core ответит внятной ошибкой «аудио недоступно»
    }
    const videoKeyAtRequest = currentVideo.videoKey;
    void requestAsrTrack(document, { post: postToCore }, {
      videoKey: videoKeyAtRequest,
      url: source.url,
      lang: source.lang,
    }).then((reply) => {
      if (!reply.ok) return;
      const lang = typeof reply.lang === "string" && reply.lang ? reply.lang : "auto";
      const track = asrTrackFrom(lang, typeof reply.engine === "string" ? reply.engine : "", reply.cues ?? []);
      if (!track) return;
      if (currentVideo?.videoKey !== videoKeyAtRequest) return; // видео сменилось
      asrTracks = [...asrTracks.filter((t) => t.id !== track.id), track];
      applySet("asr");
    });
  });

  // Выбор дорожек YouTube-адаптера (панель 3.7 / e2e): событие или окно ниже.
  document.addEventListener("duopulse-select-tracks", (e) => {
    const detail = (e as CustomEvent<{ ids?: string[] }>).detail;
    if (Array.isArray(detail?.ids)) void selectTracks(detail.ids);
  });

  // Панельный путь задачи 3.6: Core прочитал файл с диска (subtitles.load_file)
  // и доставил cue этим событием (eval активной вкладки — паттерн
  // subtitles.set_offset). Дорожка строится тем же fileTrackFrom, что и после
  // drop; дроп/панель замещают файловую часть набора целиком.
  document.addEventListener("duopulse-file-track", (e) => {
    const detail = (e as CustomEvent<{ name?: unknown; cues?: unknown }>).detail;
    if (!detail || typeof detail !== "object" || !Array.isArray(detail.cues)) return;
    const cues: Cue[] = [];
    for (const c of detail.cues) {
      if (!c || typeof c !== "object") continue;
      const cue = c as Record<string, unknown>;
      if (typeof cue["startMs"] !== "number" || typeof cue["endMs"] !== "number") continue;
      cues.push({ startMs: cue["startMs"], endMs: cue["endMs"], text: String(cue["text"] ?? "") });
    }
    if (cues.length === 0) return;
    const name = typeof detail.name === "string" && detail.name ? detail.name : "субтитры.srt";
    fileTracks = [fileTrackFrom(name, langOfFileName(name), cues)];
    applySet("load_file");
    postToCore({
      duopulse: "file-tracks",
      videoKey: currentVideo?.videoKey ?? "",
      applied: 1,
      via: "load_file",
    });
  });

  // Drag&drop ручных файлов (задача 3.6): приём на window (capture), поглощение
  // только своих дропов; разбор тел — в Core (WebMessage parse-subtitles).
  const dropzone = new FileDropZone({
    win: window,
    doc: document,
    parser,
    hasVideo: () => currentVideo !== null,
    onApply(result: FileLoadResult): void {
      fileTracks = result.tracks;
      applySet("drop");
      postToCore({
        duopulse: "file-tracks",
        videoKey: currentVideo?.videoKey ?? "",
        applied: result.tracks.length,
        failures: result.failures.length,
        via: "drop",
      });
    },
  });
  dropzone.start();

  detector.start();

  // Диагностика стендов: состояние content-слоя в контексте страницы.
  (window as unknown as Record<string, unknown>).__duopulseContent = {
    state(): {
      videoKey: string | null;
      canTracks: boolean;
      enabled: boolean;
      engine: ReturnType<typeof engine.state>;
      overlayVisible: boolean;
      style: SubtitleStyle;
      nativeBlanked: boolean;
      offsetHudVisible: boolean;
      dropHintVisible: boolean;
      asrTracks: { id: string; lang: string; cues: number }[];
      translateTracks: { id: string; lang: string; cues: number }[];
      fileTracks: { id: string; lang: string; cues: number }[];
      setMemory: { key: string; enabled: boolean; tracks: number }[];
      cloud: ReturnType<typeof cloudTranslateStatus>;
      asr: ReturnType<typeof asrStatus>;
    } {
      return {
        videoKey: currentVideo?.videoKey ?? null,
        canTracks: (trackList?.base.length ?? 0) > 0,
        enabled,
        engine: engine.state(),
        overlayVisible: overlay.visible,
        style: overlay.styleInfo(),
        nativeBlanked: blanker.blanked,
        offsetHudVisible: hud.visible,
        dropHintVisible: dropzone.hintVisible(),
        asrTracks: asrTracks.map((t) => ({ id: t.id, lang: t.lang, cues: t.cues.length })),
        translateTracks: translateTracks.map((t) => ({ id: t.id, lang: t.lang, cues: t.cues.length })),
        fileTracks: fileTracks.map((t) => ({ id: t.id, lang: t.lang, cues: t.cues.length })),
        setMemory: [...setMemory.entries()].map(([key, m]) => ({
          key,
          enabled: m.enabled,
          tracks: m.platform.length + m.asr.length + m.translate.length + m.files.length,
        })),
        cloud: cloudTranslateStatus(),
        asr: asrStatus(),
      };
    },
    /** Список дорожек текущего видео (null — ещё не получен/не YouTube). */
    tracksInfo(): {
      path: string;
      version: string;
      base: { id: string; lang: string; kind: string; name: string; original: boolean }[];
      translationsCount: number;
      warnings: string[];
    } | null {
      if (!trackList) return null;
      return {
        path: trackList.usedPath,
        version: trackList.version,
        base: trackList.base.map((b) => ({
          id: b.id,
          lang: b.lang,
          kind: b.kind,
          name: b.name,
          original: b.original,
        })),
        translationsCount: trackList.translations.length,
        warnings: trackList.warnings.slice(),
      };
    },
    selectTracks,
    /** Переключить показ (диагностика/e2e пути панели). */
    setEnabled(on: boolean): void {
      setSubsEnabled(on, "test");
    },
    /** Убрать файловые дорожки набора (панель/e2e): платформенные остаются. */
    clearFiles(): void {
      fileTracks = [];
      applySet("clear");
    },
    /** Применить файловые дорожки как после дропа (диагностика стенда 3.6):
     * чтение+разбор — тем же путём, что и реальный drop. */
    async addFiles(files: readonly { name: string; text: () => Promise<string> }[]): Promise<FileLoadResult> {
      const result = await buildFileTracks(files, { parser });
      fileTracks = result.tracks;
      applySet("test");
      return result;
    },
  };
})();
