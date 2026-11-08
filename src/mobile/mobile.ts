// DuoPulse — мобильная ветка UI (этап 1 карточки duopulse-081, вариант Б из
// duopulse-053; этап 2 — duopulse-082): стартовый экран «мобильная ветка»,
// ОДНА вкладка — WebView страницы в iframe под omnibox. Мульти-webview с
// десктопа (таб-бар + дочерние webview вкладок) на Android не работает —
// child-webview API Tauri 2 десктоп-only; iframe — минимальный скелет,
// Duo-субтитры и перевод — этап 2 (duopulse-082): кнопка «duo» + панель
// настроек + плашка над плеером (src/mobile/duo/).
//
// Команды bridge десктопа (tabs.*/nav.*/history.*) на мобильной обёртке не
// зарегистрированы (lib.rs — тонкий билдер + Duo-движок), ветка их не зовёт;
// разбор ввода — локальный resolveMobileInput (src/mobile/platform.ts).
import { getVersion } from "@tauri-apps/api/app";
import "./mobile.css";
import { resolveMobileInput, videoIdOfEmbed } from "./platform";
import { MobileDuo, type DuoStatus } from "./duo";
import { createMobileUpdater, mb, type UpdaterUi } from "./updater";

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
    <button id="mDuo" class="m-duo-btn" hidden title="Субтитры duo">duo</button>
    <input id="mOmnibox" type="text" placeholder="Адрес или поиск" spellcheck="false"
      autocomplete="off" enterkeyhint="go" />
    <button id="mGo" class="m-go" title="Перейти" aria-label="Перейти">
      <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h9M9 4.5 12.5 8 9 11.5"/></svg>
    </button>
  </header>
  <div id="mUpdate" class="m-update" hidden></div>
  <main class="m-content">
    <section id="mStart" class="m-start">
      <div class="m-mark" aria-hidden="true">duo<b>Pulse</b></div>
      <p class="m-branch">мобильная ветка · субтитры и перевод</p>
      <p class="m-version" id="mVersion"></p>
      <p class="m-hint">Введите адрес или поисковый запрос. Ссылки YouTube с видео
        открываются встроенным плеером — кнопка «duo» включает субтитры и
        перевод (готовые дорожки видео или Google).</p>
      <button class="m-quick" data-url="https://www.youtube.com/watch?v=iG9CE55wbtY">Открыть пример — TED с субтитрами</button>
      <button id="mCheckUpdate" class="m-check-update">Проверить обновления</button>
    </section>
    <iframe id="mTab" class="m-tab" title="Страница" hidden
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="no-referrer-when-downgrade"></iframe>
  </main>
  <footer class="m-status" id="mStatus" hidden></footer>
`;

const omnibox = root.querySelector<HTMLInputElement>("#mOmnibox")!;
const go = root.querySelector<HTMLButtonElement>("#mGo")!;
const home = root.querySelector<HTMLButtonElement>("#mHome")!;
const duoBtn = root.querySelector<HTMLButtonElement>("#mDuo")!;
const start = root.querySelector<HTMLElement>("#mStart")!;
const tab = root.querySelector<HTMLIFrameElement>("#mTab")!;
const status = root.querySelector<HTMLElement>("#mStatus")!;
const content = root.querySelector<HTMLElement>(".m-content")!;

/** Показ строки статуса: что открыто / почему могло не открыться. */
function note(text: string): void {
  status.textContent = text;
  status.hidden = !text;
}

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
    updateBanner.textContent = "Открыт системный установщик — подтвердите установку, приложение обновится само.";
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
  updateBanner.textContent = `Обновления: ${ui.message}`;
}

const updater = createMobileUpdater(renderUpdate);
void updater.init();
root.querySelector<HTMLButtonElement>("#mCheckUpdate")!.addEventListener("click", () => void updater.check(true));

// ── duo: субтитры и перевод (этап 2) ───────────────────────────────────
let duoPanel: import("./duo/panel").DuoPanel | null = null;
let videoOpen = false;
const duo = new MobileDuo(content, tab, (s: DuoStatus) => {
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

/** Загрузить адрес в единственную вкладку (iframe). */
function navigate(input: string): void {
  const res = resolveMobileInput(input);
  if (!res.url) return;
  tab.src = res.url;
  tab.hidden = false;
  start.hidden = true;
  duoPanel?.remove();
  duoPanel = null;
  const videoId = videoIdOfEmbed(res.url);
  videoOpen = !!videoId;
  if (videoId) {
    duoBtn.hidden = false;
    void duo.open(videoId);
    note("Плеер YouTube. Нажмите «duo» для субтитров и перевода.");
  } else {
    duoBtn.hidden = true;
    duo.close();
    if (res.kind === "search") {
      note("Поиск YouTube. Страницы результатов не встраиваются в iframe — откройте видео, ссылку с /watch можно ввести здесь.");
    } else {
      note(res.url);
    }
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
  duoBtn.hidden = true;
  duo.close();
  duoPanel?.remove();
  duoPanel = null;
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
