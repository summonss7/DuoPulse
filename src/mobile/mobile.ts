// DuoPulse — мобильная ветка UI (этап 1 карточки duopulse-081, вариант Б из
// duopulse-053; этап 2 — duopulse-082): стартовый экран «мобильная ветка»,
// YouTube-видео в iframe под omnibox. Мульти-webview с десктопа (таб-бар +
// дочерние webview вкладок) на Android не работает — child-webview API
// Tauri 2 десктоп-only; ВКЛАДКИ (duopulse-123) — несколько iframe
// src/mobile/tabs.ts: активная видна, фоновые на паузе, сессия в
// localStorage переживает перезапуск приложения.
// Duo-субтитры и перевод — этап 2 (duopulse-082): кнопка «duo» + панель
// настроек + плашка над плеером (src/mobile/duo/). Меню настроек «⋮» в
// шапке (поисковик, обновления, версия) — duopulse-102. Шапка двухрядная:
// адрес — второй строкой на всю ширину, адрес открытого видео виден в строке
// целиком (выделить/скопировать/заменить), звёздочка закладки — в строке
// адреса (duopulse-105).
//
// Команды bridge десктопа (tabs.*/nav.*/history.*) на мобильной обёртке не
// зарегистрированы (lib.rs — тонкий билдер + Duo-движок), ветка их не зовёт;
// разбор ввода — локальный resolveMobileInput (src/mobile/platform.ts).
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import "./mobile.css";
import {
  MOBILE_SEARCH_ENGINES,
  normalizeEngine,
  resolveMobileInput,
  videoIdOfEmbed,
  type MobileEngineId,
} from "./platform";
import { MobileDuo, type DuoStatus } from "./duo";
import { MobileBookmarks } from "./bookmarks";
import { MobileTabs, parseSavedTabs, TABS_KEY, type MobileTab } from "./tabs";
import { installMobileAccount } from "./account";
import { createMobileUpdater, mb, type UpdaterUi } from "./updater";
import { createMusicDownloader } from "./download";
import {
  createSelectionPorts,
  installMobileSelectionTranslate,
} from "./selection-translate";
import { createMobilePdf } from "./pdf";

const chromeRoot = document.getElementById("app");
// DOM десктоп-хрома не трогаем, просто прячем: не [hidden] — стили десктопа
// (#app { display: flex … }) перебивают UA-правило [hidden]{display:none}
if (chromeRoot) chromeRoot.style.display = "none";

const root = document.createElement("div");
root.id = "mobile";
document.body.appendChild(root);
root.innerHTML = `
  <header class="m-bar">
    <div class="m-bar-top">
      <button id="mHome" class="m-icon" title="На стартовый экран" aria-label="На стартовый экран">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3.5v-4h-3v4H3a.5.5 0 0 1-.5-.5z"/></svg>
      </button>
      <span class="m-logo" aria-hidden="true">duo<b>Pulse</b></span>
      <button id="mPrivate" class="m-private-btn" title="Инкогнито" aria-label="Инкогнито" aria-pressed="false">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5 5 4h6l1 2.5"/><path d="M3 6.5h10"/><circle cx="5.5" cy="10.5" r="2"/><circle cx="10.5" cy="10.5" r="2"/><path d="M7.5 10.5h1"/></svg>
      </button>
      <button id="mDuo" class="m-duo-btn" hidden title="Субтитры duo">duo</button>
      <button id="mMusic" class="m-music-btn" hidden title="Скачать: аудио, видео или субтитры">⬇</button>
      <button id="mMenu" class="m-icon" title="Настройки" aria-label="Настройки" aria-haspopup="menu" aria-expanded="false">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>
      </button>
    </div>
    <!-- Адрес — второй строкой на всю ширину (duopulse-105): видно весь
         адрес, выделяется/копируется долгим тапом, звёздочка закладки —
         рядом с адресом, а не среди кнопок первой строки -->
    <div class="m-urlrow" id="mUrlrow">
      <input id="mOmnibox" type="text" placeholder="Адрес или поиск" spellcheck="false"
        autocomplete="off" enterkeyhint="go" />
      <button id="mGo" class="m-go" title="Перейти" aria-label="Перейти">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>
      </button>
    </div>
  </header>
  <div id="mUpdate" class="m-update" hidden></div>
  <main class="m-content">
    <section id="mStart" class="m-start">
      <div class="m-mark" aria-hidden="true">duo<b>Pulse</b></div>
      <p class="m-branch">мобильная ветка · субтитры и перевод</p>
      <p class="m-version" id="mVersion"></p>
      <p class="m-hint">Ссылки YouTube с видео открываются встроенным плеером —
        кнопка «duo» включает субтитры и перевод (готовые дорожки видео или
        Google). Поиск и прочие сайты открываются в приложении; на странице
        YouTube-видео появится кнопка «▶ duo» — открыть видео с субтитрами.</p>
      <button class="m-quick" data-url="https://www.youtube.com/watch?v=iG9CE55wbtY">Открыть пример — TED с субтитрами</button>
    </section>
    <div id="mMenuWrap" class="m-menu-wrap" hidden>
      <div class="m-menu-backdrop"></div>
      <div class="m-menu" role="menu" aria-label="Настройки">
        <div class="m-menu-head">
          <b>Настройки</b>
          <button id="mMenuClose" class="m-menu-close" title="Закрыть" aria-label="Закрыть">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <label class="m-engine">Поиск: <select id="mEngine"></select></label>
        <div id="mAila"></div>
        <button id="mTranslate" class="m-check-update">Перевести текст…</button>
        <button id="mCheckUpdate" class="m-check-update">Проверить обновления</button>
        <p class="m-menu-version" id="mVersionMenu"></p>
      </div>
    </div>
  </main>
  <footer class="m-status" id="mStatus" hidden></footer>
`;

const omnibox = root.querySelector<HTMLInputElement>("#mOmnibox")!;
const go = root.querySelector<HTMLButtonElement>("#mGo")!;
const home = root.querySelector<HTMLButtonElement>("#mHome")!;
const menuBtn = root.querySelector<HTMLButtonElement>("#mMenu")!;
const menuWrap = root.querySelector<HTMLElement>("#mMenuWrap")!;
const privateBtn = root.querySelector<HTMLButtonElement>("#mPrivate")!;
const duoBtn = root.querySelector<HTMLButtonElement>("#mDuo")!;
const musicBtn = root.querySelector<HTMLButtonElement>("#mMusic")!;
const start = root.querySelector<HTMLElement>("#mStart")!;
const status = root.querySelector<HTMLElement>("#mStatus")!;
const content = root.querySelector<HTMLElement>(".m-content")!;

/** Показ строки статуса: что открыто / почему могло не открыться. */
function note(text: string): void {
  status.textContent = text;
  status.hidden = !text;
}

// ── Меню настроек (duopulse-102): «⋮» в шапке открывает лист — поисковик,
// проверка обновлений, версия. До этого селектор движка и «Проверить
// обновления» жили только на стартовом экране: при открытом видео настроек
// не было добраться («нигде нет меню настроек» — жалоба Артёма).
function setMenu(open: boolean): void {
  menuWrap.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
  // статус аккаунта живой: воркер синка меняет его в фоне (duopulse-112)
  if (open) void account.refresh();
}
menuBtn.addEventListener("click", () => setMenu(menuWrap.hidden));
menuWrap.querySelector(".m-menu-backdrop")!.addEventListener("click", () => setMenu(false));
menuWrap.querySelector<HTMLButtonElement>("#mMenuClose")!.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenu(false);
});

// ── Инкогнито (карточка duopulse-096): история и вкладки мобильной ветки и
// так не пишутся (шапка файла); приватный режим чистит куки/хранилища
// системного WebView (YouTube-плеер в iframe) при входе (чистый старт) и
// выходе (следов не остаётся). После убийства процесса в инкогнито дочистит
// следующий запуск по флагу — сам флаг не является следом активности.
const DIRTY_KEY = "duopulse.mobile.dirtyIncognito";
let incognito = false;

/** Дочистка после kill в инкогнито: флаг остался — чистим и снимаем. */
try {
  if (localStorage.getItem(DIRTY_KEY) === "1") {
    localStorage.removeItem(DIRTY_KEY);
    void invoke<string>("mobile_private_cleanup").catch(() => {});
  }
} catch {
  /* localStorage недоступен — нечего дочищать */
}

function setIncognito(on: boolean): void {
  incognito = on;
  // web-оверлей — на системном профиле WebView: в инкогнито его закрываем
  void invoke<string>("mobile_web_close").catch(() => {});
  privateBtn.classList.toggle("on", on);
  privateBtn.setAttribute("aria-pressed", String(on));
  privateBtn.title = on
    ? "Инкогнито включён — нажмите, чтобы выключить и удалить данные сайтов"
    : "Инкогнито";
  document.body.classList.toggle("m-private", on);
  try {
    if (on) localStorage.setItem(DIRTY_KEY, "1");
    else localStorage.removeItem(DIRTY_KEY);
  } catch {
    /* приватный режим без localStorage — флаг живёт до перезапуска */
  }
  if (on) {
    tabs.clearPersisted(); // сессию вкладок не оставляем (096: без следов)
  } else {
    // выход из инкогнито: вкладки закрываем (onTabActive(null) вернёт старт),
    // куки/хранилища чистятся ниже
    tabs.closeAll();
    duo.close();
    duoPanel?.remove();
    duoPanel = null;
    omnibox.value = "";
    void bookmarks.syncVideo();
  }
  void invoke<string>("mobile_private_cleanup")
    .then(() =>
      note(
        on
          ? "Инкогнито включён: история не ведётся, куки и данные сайтов удалятся при выключении."
          : "Инкогнито выключен: куки и данные сайтов удалены.",
      ),
    )
    .catch((e) => note(`Инкогнито: очистка не удалась (${e})`));
}

privateBtn.addEventListener("click", () => setIncognito(!incognito));

// ── OTA-обновления из центра Aila (этап 3, duopulse-083) ───────────────
const updateBanner = root.querySelector<HTMLElement>("#mUpdate")!;

/** Перерисовка баннера обновления по состоянию контроллера (updater.ts). */
function renderUpdate(ui: UpdaterUi): void {
  updateBanner.innerHTML = "";
  updateBanner.hidden = ui.kind === "idle";
  if (ui.kind === "idle") return;
  if (ui.kind === "checking") {
    updateBanner.textContent = "Проверяю обновления…";
    return;
  }
  if (ui.kind === "available") {
    const head = document.createElement("b");
    head.textContent = `⬆ Доступна версия ${ui.version}`;
    updateBanner.appendChild(head);
    if (ui.notes) {
      const notes = document.createElement("span");
      notes.className = "m-update-notes";
      notes.textContent = ui.notes;
      updateBanner.appendChild(notes);
    }
    const btn = document.createElement("button");
    btn.className = "m-update-btn";
    btn.textContent = "Обновить";
    btn.addEventListener("click", () => void updater.install());
    updateBanner.appendChild(btn);
    return;
  }
  if (ui.kind === "downloading") {
    const pct = ui.total ? Math.min(100, Math.round((ui.downloaded / ui.total) * 100)) : 0;
    updateBanner.textContent = `Скачиваю ${ui.version}: ${pct}%` + (ui.total ? ` (${mb(ui.downloaded)} из ${mb(ui.total)})` : "");
    return;
  }
  if (ui.kind === "installing") {
    updateBanner.textContent =
      "Открыт системный установщик — подтвердите установку, приложение обновится само. Если Play Protect предупреждает — «Подробнее» → «Всё равно установить»: приложение не из Play Store, идёт с нашего канала обновлений.";
    return;
  }
  if (ui.kind === "needs-permission") {
    updateBanner.textContent = "Разрешите установку из этого источника в открывшихся настройках.";
    const btn = document.createElement("button");
    btn.className = "m-update-btn";
    btn.textContent = "Обновить";
    btn.addEventListener("click", () => void updater.install());
    updateBanner.appendChild(btn);
    return;
  }
  if (ui.kind === "latest") {
    updateBanner.textContent = `✓ У вас последняя версия (${ui.version})`;
    return;
  }
  // error: причина + «Повторить», если есть чем повторять (duopulse-101 —
  // обрыв скачивания лечится повтором с докачкой, а не перезапуском приложения)
  updateBanner.textContent = `Обновления: ${ui.message}`;
  if (ui.retry) {
    const btn = document.createElement("button");
    btn.className = "m-update-btn";
    btn.textContent = "Повторить";
    btn.addEventListener("click", () => void (ui.retry === "install" ? updater.install() : updater.check(true)));
    updateBanner.appendChild(btn);
  }
}

const updater = createMobileUpdater(renderUpdate);
void updater.init();
root.querySelector<HTMLButtonElement>("#mCheckUpdate")!.addEventListener("click", () => void updater.check(true));

// ── закладки (карточка duopulse-104): группы + перекладывание пальцем ────
// Хранилище — то же history.* (SQLite в профиле приложения, команды — тонкая
// мобильная либа lib.rs); здесь — экран со стартовой кнопки, звёздочка в
// шапке открытого видео и long-press-тяга закладки на чип группы.
const bookmarks = new MobileBookmarks({
  currentVideo: () => {
    const id = duo.currentVideoId;
    return id ? { url: `https://www.youtube.com/watch?v=${id}`, title: duo.currentTitle } : null;
  },
  // тап по закладке — новая вкладка (как в Chrome), а не замена текущей
  open: (url) => void navigate(url, true),
  note,
});

// ── Вкладки (duopulse-123): каждая — своё видео в своём iframe; активная
// видна, фоновые на паузе; сессия в localStorage переживает перезапуск
// (восстановление — в конце файла, когда все модули готовы).
const tabs = new MobileTabs({
  content,
  bar: root.querySelector<HTMLElement>(".m-bar-top")!,
  note,
  isPrivate: () => incognito,
  onActive: (t) => onTabActive(t),
});

/** Активная вкладка сменилась (открытие/переключение/восстановление): единая
 *  точка доводки хрома — duo-сессия, omnibox, кнопки, звёздочка, стартовый
 *  экран. null — вкладок нет (все закрыты / «новая вкладка» / старт). */
function onTabActive(t: MobileTab | null): void {
  videoOpen = t !== null;
  start.hidden = t !== null;
  duoBtn.hidden = t === null;
  musicBtn.hidden = t === null;
  duoPanel?.remove();
  duoPanel = null;
  if (!t) {
    duo.close();
    omnibox.value = "";
    void bookmarks.syncVideo();
    return;
  }
  // канонический watch-URL (как у закладки), не /embed (duopulse-105)
  omnibox.value = `https://www.youtube.com/watch?v=${t.videoId}`;
  void duo.open(t.videoId).then(() => tabs.setTitle(t.videoId, duo.currentTitle));
  void bookmarks.syncVideo();
  note("Плеер YouTube. Нажмите «duo» для субтитров и перевода.");
}

// ── Аккаунт Aila (этап 6 duopulse-112): блок в меню «⋮», листы входа и
// паролей; синк паролей/закладок — общее ядро с десктопом (aila.rs). После
// круга синка обновляем закладки (открытый экран и звёздочку) — данные
// могли прийти из облака.
const account = installMobileAccount(
  {
    note,
    closeMenu: () => setMenu(false),
    onSynced: () => {
      void bookmarks.refreshIfOpen();
    },
  },
  root.querySelector<HTMLElement>("#mAila")!,
);

// ── duo: субтитры и перевод (этап 2) ───────────────────────────────────
let duoPanel: import("./duo/panel").DuoPanel | null = null;
let videoOpen = false;
const duo = new MobileDuo(content, () => tabs.activeFrame, (s: DuoStatus) => {
  duoPanel?.setStatus(s);
  // Панель закрыта — статус duo виден в общей строке (панель открыта — только в ней).
  if (!duoPanel) {
    note(s.text ?? (videoOpen ? "Плеер YouTube. Нажмите «duo» для субтитров и перевода." : ""));
  }
});
duoBtn.addEventListener("click", () => {
  if (duoPanel) {
    duoPanel.remove();
    duoPanel = null;
    return;
  }
  void (async () => {
    const { DuoPanel } = await import("./duo/panel");
    duoPanel = new DuoPanel(
      {
        onUpdate: (patch) => {
          duo.update(patch);
          duoPanel?.sync();
        },
        onClose: () => {
          duoPanel?.remove();
          duoPanel = null;
        },
      },
      () => duo.currentSettings,
      () => duo.trackList,
    );
    content.appendChild(duoPanel.root);
    duoPanel.refreshList(duo.trackList);
  })();
});

// ── Загрузки с YouTube (duopulse-121 → 122): «⬇» на экране видео открывает
// лист выбора — аудио (m4a/opus), видео (mp4, склейка со звуком) и субтитры
// (srt); медиа качает fetch внутри youtube-iframe (dl-fetcher.js), файл
// собирает Rust и сохраняет в медиатеку (подробности — src/mobile/download.ts).
const music = createMusicDownloader({
  getVideoId: () => duo.currentVideoId,
  host: content,
  getFrame: () => tabs.activeFrame,
  render: (text) => {
    if (text) note(text);
  },
});
musicBtn.addEventListener("click", () => music.start());
// диагностика e2e-стендов (как __duopulseMobileTranslate)
(window as { __duopulseMobileMusic?: () => unknown }).__duopulseMobileMusic = () =>
  music.stateSnapshot();

// ── Перевод выделенного текста (duopulse-103): мобильный вход в gtx-конвейер
// десктопного пункта «Перевести выделение». Вход два: long-press по тексту
// нашей страницы (omnibox; кросс-доменный iframe плеера недостижим) → чип
// «Перевести» у выделения → бабл; и «Перевести текст…» в этом меню — лист с
// полем ввода. Последний язык — как поисковик, в localStorage (инкогнито —
// до перезапуска).
const selectionTranslate = installMobileSelectionTranslate(
  document,
  createSelectionPorts(invoke, () => incognito),
);

// ── Просмотрщик PDF (карточка duopulse-119): DuoPulse — системный
// просмотрщик application/pdf (intent-filter); файл из «Открыть с
// помощью» рисуется pdf.js (WebView Android PDF не рендерит). poll — на
// старте (холодный запуск с файлом) и по возврату фокуса (onNewIntent при
// живом приложении; visibilitychange срабатывает надёжно focus-события
// WebView). Десктоп ветки не касается: там PDF показывает WebView2.
const pdfView = createMobilePdf({
  note,
  host: content,
  hideContent: () => {
    start.hidden = true;
    tabs.setVisible(false);
  },
  restoreContent: () => {
    tabs.setVisible(true);
    start.hidden = tabs.active !== null;
  },
  showInOmnibox: (text) => {
    omnibox.value = text;
  },
  setVideoButtons: (visible) => {
    duoBtn.hidden = !visible;
    musicBtn.hidden = !visible;
  },
});
void pdfView.poll();
window.addEventListener("focus", () => void pdfView.poll());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void pdfView.poll();
});
// диагностика стендов (как __duopulseMobileTranslate/__duopulseMobileMusic)
(window as { __duopulseMobilePdf?: () => unknown }).__duopulseMobilePdf = () =>
  pdfView.snapshot();
// диагностика стендов (e2e/selection/mobile.mjs)
(window as { __duopulseMobileTranslate?: () => unknown }).__duopulseMobileTranslate = () =>
  selectionTranslate.stateSnapshot();
root.querySelector<HTMLButtonElement>("#mTranslate")!.addEventListener("click", () => {
  setMenu(false);
  selectionTranslate.openSheet(content);
});

// ── Поисковик по умолчанию (duopulse-085): Google, выбор — селектор
// стартового экрана, хранение — localStorage (у мобильной обёртки нет
// settings.json и команд Core — см. шапку).
const ENGINE_KEY = "duopulse.mobile.searchEngine";
let engine: MobileEngineId = normalizeEngine(
  (typeof localStorage !== "undefined" && localStorage.getItem(ENGINE_KEY)) || null,
);
const engineSel = root.querySelector<HTMLSelectElement>("#mEngine")!;
for (const e of MOBILE_SEARCH_ENGINES) {
  const opt = document.createElement("option");
  opt.value = e.id;
  opt.textContent = e.title;
  opt.selected = e.id === engine;
  engineSel.append(opt);
}
engineSel.addEventListener("change", () => {
  engine = normalizeEngine(engineSel.value);
  try {
    // инкогнито: выбор движка живёт в памяти до перезапуска (карточка 096)
    if (!incognito) localStorage.setItem(ENGINE_KEY, engine);
  } catch {
    // приватный режим без localStorage — выбор живёт до перезапуска
  }
});

/** Открыть адрес системным браузером (mobile.open_url → Intent ACTION_VIEW):
 * фолбэк web-оверлея — оверлей недоступен (старая сборка без команды,
 * ошибка хелпера) лучше внешним браузером, чем «ничего не открылось»
 * (duopulse-085). */
async function openExternal(url: string): Promise<void> {
  try {
    const r = await invoke<string>("mobile_open_url", { url });
    note(r === "opened" ? `Открыл в браузере: ${url}` : r);
  } catch (e) {
    note(`Не удалось открыть: ${e}`);
  }
}

/** Открыть адрес в приложении (duopulse-126): YouTube-видео — вкладка
 *  /embed-плеера, поиск и прочие сайты — нативный web-оверлей поверх UI
 *  (MobileWebHelper: тулбар назад/адрес/«▶ duo»/закрыть). Прежде всё
 *  не-видео уходило в системный браузер (Chrome) — страницы с
 *  X-Frame-Options в iframe не встраиваются; оверлей снимает ограничение. */
async function openInApp(url: string): Promise<void> {
  try {
    const r = await invoke<string>("mobile_web_open", { url });
    if (r === "opened") {
      note(`Открыл в приложении: ${url}`);
      return;
    }
    note(r);
  } catch {
    // команды нет (десктоп-сборка UI) или хелпер отказал — системный браузер
    await openExternal(url);
  }
}

/** Загрузить адрес: YouTube-видео — во вкладку (новую из закладок/линков
 *  стартового экрана, заменой текущей — из omnibox, как вкладка Chrome);
 *  поиск и прочие адреса — web-оверлей в приложении (duopulse-126). */
async function navigate(input: string, newTab = false): Promise<void> {
  const res = resolveMobileInput(input, engine);
  // YouTube-видео — встраиваемый /embed-плеер (единственный официальный
  // путь в iframe); поиск и прочие адреса — web-оверлей.
  const videoId = res.kind === "url" ? videoIdOfEmbed(res.url) : null;
  if (videoId) {
    pdfView.close();
    tabs.open(videoId, "", newTab); // доводку хрома делает onTabActive
    return;
  }
  await openInApp(res.url);
}

/** Вход для кнопки «▶ duo» web-оверлея (duopulse-126): Kotlin-хелпер
 *  закрывает оверлей и дергает этот глобал в UI-webview Tauri — видео
 *  открывается во встроенном плеере, как из omnibox (новая вкладка). */
(window as { __duopulseOpenVideo?: (id: string) => void }).__duopulseOpenVideo = (id: string) => {
  if (!/^[\w-]{6,20}$/.test(id)) return; // id из evaluateJavascript — проверяем
  pdfView.close();
  tabs.open(id, "", true);
};

function goFromOmnibox(): void {
  const value = omnibox.value;
  void navigate(value);
  omnibox.blur();
}

go.addEventListener("click", goFromOmnibox);
omnibox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") goFromOmnibox();
});
home.addEventListener("click", () => {
  setMenu(false);
  pdfView.close();
  // web-оверлей тоже закрываем: «домой» — стартовый экран, не страница
  void invoke<string>("mobile_web_close").catch(() => {});
  // «домой» = новая вкладка: открытые видео остаются в фоне (переключатель
  // вкладок в шапке), до duopulse-123 «домой» убивал единственное видео
  tabs.newTab();
  note("");
  omnibox.value = "";
  omnibox.focus();
});
for (const b of root.querySelectorAll<HTMLButtonElement>(".m-quick")) {
  b.addEventListener("click", () => {
    omnibox.value = b.dataset.url ?? "";
    void navigate(b.dataset.url ?? "");
  });
}

// Версия сборки — из контекста приложения (только чтение, доступ есть у
// любой webview с core:default): стартовый экран и меню настроек.
void getVersion()
  .then((v) => {
    root.querySelector("#mVersion")!.textContent = `версия ${v}`;
    root.querySelector("#mVersionMenu")!.textContent = `DuoPulse ${v} · мобильная ветка`;
  })
  .catch(() => {});

// ── Восстановление сессии (duopulse-123): после перезапуска приложения
// возвращаем вкладки прошлого запуска — активная грузится сразу (без
// autoplay — автозвук после рестарта был бы неожиданным), фоновые лениво
// при первом переключении. В инкогнито сессия не писалась — restore ничего
// не найдёт, чистый старт.
try {
  const saved = parseSavedTabs(localStorage.getItem(TABS_KEY));
  if (saved) tabs.restore(saved);
} catch {
  /* нет localStorage — чистый старт */
}
