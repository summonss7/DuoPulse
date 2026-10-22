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

const page = getCurrentWebview().label.match(/^page-([a-z]+)-\d+$/)?.[1];
if (page === "history") {
  void import("./pages/history");
} else if (page === "newtab") {
  void import("./pages/newtab");
} else if (page === "diagnostics") {
  void import("./pages/diagnostics");
} else if (page === "settings") {
  void import("./pages/settings"); // задача 5.1: полные настройки + профиль
} else if (page === "error") {
  void import("./pages/error"); // страница ошибки загрузки, карточка 048
} else {
  void import("./chrome");
}
