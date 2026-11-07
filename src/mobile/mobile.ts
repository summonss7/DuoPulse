// DuoPulse — мобильная ветка UI (этап 1 карточки duopulse-081, вариант Б из
// duopulse-053): стартовый экран «мобильная ветка», ОДНА вкладка — WebView
// страницы в iframe под omnibox. Мульти-webview с десктопа (таб-бар +
// дочерние webview вкладок) на Android не работает — child-webview API
// Tauri 2 десктоп-only; iframe — минимальный скелет этапа 1, Duo-субтитры
// и перевод приезжают в этап 2 (duopulse-082).
//
// Команды bridge десктопа (tabs.*/nav.*/history.*) на мобильной обёртке не
// зарегистрированы (lib.rs — тонкий билдер) — ветка их не зовёт; разбор
// ввода — локальный resolveMobileInput (src/mobile/platform.ts).
import { getVersion } from "@tauri-apps/api/app";
import "./mobile.css";
import { resolveMobileInput } from "./platform";

const chromeRoot = document.getElementById("app");
// DOM десктоп-хрома не трогаем, просто прячем: не [hidden] — стили десктопа
// (#app { display: flex … }) перебивают UA-правило [hidden]{display:none}
if (chromeRoot) chromeRoot.style.display = "none";

const root = document.createElement("div");
root.id = "mobile";
document.body.appendChild(root);
root.innerHTML = `
  <header class="m-bar">
    <button id="mHome" class="m-icon" title="На стартовый экран" aria-label="На стартовый экран">
      <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7 8 2.5 13.5 7v6a.5.5 0 0 1-.5.5h-3.5v-4h-3v4H3a.5.5 0 0 1-.5-.5z"/></svg>
    </button>
    <span class="m-logo" aria-hidden="true">duo<b>Pulse</b></span>
    <input id="mOmnibox" type="text" placeholder="Адрес или поиск" spellcheck="false"
      autocomplete="off" enterkeyhint="go" />
    <button id="mGo" class="m-go" title="Перейти" aria-label="Перейти">
      <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>
    </button>
  </header>
  <main class="m-content">
    <section id="mStart" class="m-start">
      <div class="m-mark" aria-hidden="true">duo<b>Pulse</b></div>
      <p class="m-branch">мобильная ветка · этап 1 из 3</p>
      <p class="m-version" id="mVersion"></p>
      <p class="m-hint">Введите адрес или поисковый запрос. Ссылки YouTube с видео
        открываются встроенным плеером; субтитры и перевод — этап 2.</p>
      <button class="m-quick" data-url="https://example.com/">Открыть пример — example.com</button>
    </section>
    <iframe id="mTab" class="m-tab" title="Страница" hidden
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="no-referrer-when-downgrade"></iframe>
  </main>
  <footer class="m-status" id="mStatus" hidden></footer>
`;

const omnibox = root.querySelector<HTMLInputElement>("#mOmnibox")!;
const go = root.querySelector<HTMLButtonElement>("#mGo")!;
const home = root.querySelector<HTMLButtonElement>("#mHome")!;
const start = root.querySelector<HTMLElement>("#mStart")!;
const tab = root.querySelector<HTMLIFrameElement>("#mTab")!;
const status = root.querySelector<HTMLElement>("#mStatus")!;

/** Показ строки статуса: что открыто / почему могло не открыться. */
function note(text: string): void {
  status.textContent = text;
  status.hidden = !text;
}

/** Загрузить адрес в единственную вкладку (iframe). */
function navigate(input: string): void {
  const res = resolveMobileInput(input);
  if (!res.url) return;
  tab.src = res.url;
  tab.hidden = false;
  start.hidden = true;
  if (res.kind === "search") {
    note("Поиск YouTube. Страницы результатов YouTube не встраиваются в iframe — откройте видео, ссылку с /watch можно ввести здесь.");
  } else if (res.url.includes("youtube.com/embed/")) {
    note("Плеер YouTube (embed). Субтитры и перевод — этап 2.");
  } else {
    note(res.url);
  }
}

function goFromOmnibox(): void {
  const value = omnibox.value;
  navigate(value);
  omnibox.blur();
}

go.addEventListener("click", goFromOmnibox);
omnibox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") goFromOmnibox();
});
home.addEventListener("click", () => {
  tab.hidden = true;
  tab.src = "about:blank";
  start.hidden = false;
  note("");
  omnibox.value = "";
  omnibox.focus();
});
for (const b of root.querySelectorAll<HTMLButtonElement>(".m-quick")) {
  b.addEventListener("click", () => {
    omnibox.value = b.dataset.url ?? "";
    navigate(b.dataset.url ?? "");
  });
}

// Версия сборки — из контекста приложения (только чтение, доступ есть у
// любой webview с core:default).
void getVersion()
  .then((v) => {
    root.querySelector("#mVersion")!.textContent = `версия ${v}`;
  })
  .catch(() => {});
