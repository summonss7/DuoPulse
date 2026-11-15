// Диалог HTTP-авторизации сайта (карточка duopulse-148): сервер ответил
// 401 с WWW-Authenticate (роутер, внутренний портал) — без диалога WebView2
// ронял навигацию («сервер требует авторизацию», код 17). Core держит
// запрос на деферрале (src-tauri/src/auth.rs) и эмитит auth:challenge;
// хром открывает панель auth по центру окна контента, панельный режим
// рисует форму: хост/realm из auth.pending, attempts>1 — «неверный логин
// или пароль» и прежний логин. Решение — auth.respond: креды уходят в
// WebView2 (страница грузится), null — отмена (навигация падает на
// страницу ошибки). Диалог модальный, как в Chrome: клики по контенту его
// не закрывают (Core щадит auth в dp-close-panel), Esc/«Отмена» — закрывают
// (Core гасит деферрал пустым ответом).
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import { t } from "../i18n";
import type { AuthChallengeView } from "../bridge";
import { chromeHeight, closePanel, currentPanel, measurePanelHost, openPanel } from "./panel-window";

const err = (e: unknown): void => console.error("auth-dialog:", e);

/** Панельный режим: подтянуть ожидающий запрос и нарисовать форму
 *  (null — запроса уже нет: гонка события и панели — тихо закрыться).
 *  Повторный челлендж (креды не приняли) перерисовывает форму НА МЕСТЕ —
 *  панель переживает попытки, закрывает её Core по исходу навигации. */
export async function openAuthPanel(): Promise<void> {
  let c: AuthChallengeView | null = null;
  try {
    c = await bridge.auth.pending();
  } catch (e) {
    err(e);
  }
  if (!c) {
    closePanel();
    return;
  }
  renderDialog(c);
  // сервер переспросил (неверный логин/пароль) — свежий запрос, попытка+1
  void listen<AuthChallengeView>(bridge.events.authChallenge, () => {
    void bridge.auth
      .pending()
      .then((again) => {
        if (again) renderDialog(again);
        else closePanel(); // запрос уже погашен — Core закрывает и нас
      })
      .catch(err);
  });
}

/** Форма под запрос: заголовок-хост, realm, ошибка повторной попытки,
 *  логин прошлой подачи; Enter — сабмит (форма), «Отмена» — пустой ответ.
 *  После ответа панель НЕ закрывается сама: успех/ошибка навигации владельца
 *  решает Core (auth::on_nav_completed) — так повторный челлендж приходит в
 *  живую панель без мигания пересозданием webview. */
function renderDialog(c: AuthChallengeView): void {
  const form = document.getElementById("authDialog") as HTMLFormElement | null;
  const title = document.getElementById("authTitle");
  const realm = document.getElementById("authRealm");
  const error = document.getElementById("authError");
  const login = document.getElementById("authLogin") as HTMLInputElement | null;
  const password = document.getElementById("authPassword") as HTMLInputElement | null;
  const cancel = document.getElementById("authCancel") as HTMLButtonElement | null;
  if (!form || !title || !realm || !error || !login || !password || !cancel) {
    return;
  }
  const site = c.host || c.uri.replace(/^https?:\/\//, "");
  title.textContent = t("Вход на {site}", { site });
  realm.textContent = c.realm;
  error.hidden = c.attempts <= 1;
  login.value = c.lastUsername;
  password.value = "";
  (c.lastUsername ? password : login).focus();

  let done = false;
  const decide = (ok: boolean): void => {
    if (done) return;
    done = true;
    const params = ok
      ? { username: login.value, password: password.value }
      : { username: null, password: null };
    void bridge.auth
      .respond(params)
      // отмена — закрываем сами: перевыданного челленджа у неё не бывает
      // (пустой ответ роняет навигацию), закрывать панель Core-ом незачем;
      // сабмит НЕ закрывает — исход решит Core по NavigationCompleted
      .then(ok ? undefined : closePanel)
      .catch((e) => {
        err(e);
        done = false; // ответ не ушёл — кнопки живы, можно повторить
      });
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    decide(true);
  };
  cancel.onclick = () => decide(false);
}

/** Хром-режим: панель по событию Core — по центру окна контента
 *  (фокус — диалогу: панель с инпутами, набор сразу в логине). Панель уже
 *  открыта (повторный челлендж) — не трогаем: она перерисуется сама.
 *  Бут-сверка: челлендж восстановленной сессии прилетает ДО готовности
 *  UI — событие теряется, спрашиваем Core сами при старте хрома. */
export function initAuthDialog(): void {
  const openBar = (): void => {
    if (currentPanel() === "auth") return;
    const { w, h } = measurePanelHost("auth");
    const x = Math.max(8, Math.round((window.innerWidth - w) / 2));
    const top = Math.round(chromeHeight());
    const y = Math.round(top + Math.max(24, (window.innerHeight - top - h) / 3));
    openPanel("auth", x, y, w, h, true);
  };
  void listen<AuthChallengeView>(bridge.events.authChallenge, openBar);
  void bridge.auth.pending().then((c) => { if (c) openBar(); }).catch(err);
}
