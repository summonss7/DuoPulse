// DuoPulse — роутер точек входа UI-бандла (задача 1.4).
// Один бандл грузится в два вида webview: хром браузера (метка "main") и
// внутренние страницы duopulse:// (метки page-<имя>-N, создаются в
// src-tauri/src/tabs/). Ветка определяется меткой webview; импорты
// динамические, чтобы слушатели хрома не жили в странице (и наоборот).
// Новые внутренние страницы: имя в internal_page_name (Core) + ветка тут.
import "./theme/fonts.css"; // фирменные шрифты (гайд 06 §4), локальные сабсеты
import "./theme/tokens.css"; // токены стиля (§2–§5) — до всех стилей экранов
import "./style.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
// dev-хук window.__duopulse нужен и хрому, и внутренним страницам (e2e).
import "./bridge/dev-probe";
// Мобильная ветка (duopulse-081): обёртка Android включает withGlobalTauri,
// признак — window.__TAURI__ (см. src/mobile/platform.ts); хром и внутренние
// страницы десктопа на телефоне не живут — своя ветка UI.
import { isTauriMobile } from "./mobile/platform";
import { panelKind } from "./chrome/panel-window";
import { bridge } from "./bridge";
import { listen } from "@tauri-apps/api/event";

// Смена языка интерфейса (duopulse-136): Core эмитит settings:ui_lang_changed
// всем webview (хром, панели, внутренние страницы) — кэшируем язык в
// localStorage (init-скрипт webview остаётся со старым значением) и
// перезагружаемся на новый язык.
void listen<{ lang: string }>(bridge.events.settingsUiLangChanged, (ev) => {
  try {
    localStorage.setItem("duopulse.uiLang", ev.payload.lang);
  } catch {
    /* приватный режим — перезагрузка поднимет init-скрипт Core */
  }
  location.reload();
}).catch(console.error);

// Панельный режим (duopulse-090): popup-окно панели хрома грузит этот же
// бандл с ?panel=<kind> — хром не инициализируется, показывается только
// панель (логика — теми же модулями, panel-boot.ts).
if (panelKind()) {
  void import("./panel-boot").then((m) => m.bootPanel(panelKind()!));
} else if (isTauriMobile()) {
  void import("./mobile/mobile");
} else {
  const page = getCurrentWebview().label.match(/^page-([a-z]+)-\d+$/)?.[1];
  if (page === "history") {
    void import("./pages/history");
  } else if (page === "newtab") {
    void import("./pages/newtab");
  } else if (page === "diagnostics") {
    void import("./pages/diagnostics");
  } else if (page === "settings") {
    void import("./pages/settings"); // задача 5.1: полные настройки + профиль
  } else if (page === "passwords") {
    void import("./pages/passwords"); // «Пароли», этап 1 duopulse-106
  } else if (page === "error") {
    void import("./pages/error"); // страница ошибки загрузки, карточка 048
  } else if (page === "incognito") {
    void import("./pages/incognito"); // стартовая страница инкогнито, 096
  } else if ((window as { __DUOPULSE_INCOGNITO__?: number }).__DUOPULSE_INCOGNITO__ === 1) {
    // инкогнито-вкладка с адресом сайта (карточка 096): webview стартует
    // с UI-бандла (среда назначается только при создании) и сразу уводится
    // на адрес (tabs/mod.rs) — вложенный хром не монтируем
  } else {
    void import("./chrome");
  }
}
