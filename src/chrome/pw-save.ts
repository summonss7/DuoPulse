// Бар «Сохранить пароль?» (этап 2 цепочки duopulse-106, карточка
// duopulse-108): панель-child-webview pwsave под полосой хрома слева —
// как бабл Chrome. Контентные webview рисуют поверх HTML UI (спайк 086),
// поэтому бар — отдельный webview (механизм duopulse-090); кнопки решают
// одну командой passwords.resolve_candidate: «Сохранить/Обновить» (upsert
// хранилища этапа 1), «Никогда для этого сайта» (denylist) и «×» (dismiss).
//
// Два режима модуля:
//  - панельный (panel-boot.ts): openPwSavePanel() тянет кандидата
//    passwords.candidate (без пароля — он ждёт решения в Core) и рисует бар;
//  - хром (chrome.ts): initPwSaveBar() открывает панель по событию
//    passwords:save_prompt (Core предлагает только активной вкладке) и
//    закрывает по tabs.updated, когда вкладка кандидата перестала быть
//    активной (Core к тому же гасит самого кандидата — passwords/prompts.rs).
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import { t } from "../i18n";
import type { PasswordsCandidateView, TabsListResult } from "../bridge";
import {
  chromeHeight,
  closePanel,
  currentPanel,
  measurePanelHost,
  openPanel,
} from "./panel-window";

const err = (e: unknown): void => console.error("pw-save:", e);

/** Хост вью кандидата с панелью: null — бара нет (гонка: Core уже погасил). */
async function currentCandidate(): Promise<PasswordsCandidateView | null> {
  try {
    return await bridge.passwords.candidate();
  } catch (e) {
    err(e);
    return null;
  }
}

/** Нарисовать бар кандидатом (панельный режим; null — тихо закрыться). */
async function openPwSavePanel(): Promise<void> {
  const c = await currentCandidate();
  if (!c) {
    closePanel();
    return;
  }
  renderBar(c);
}

/** Текст и кнопки бара под кандидата. */
function renderBar(c: PasswordsCandidateView): void {
  const text = document.getElementById("pwSaveText");
  const accept = document.getElementById("pwSaveAccept") as HTMLButtonElement | null;
  const never = document.getElementById("pwSaveNever") as HTMLButtonElement | null;
  const close = document.getElementById("pwSaveClose") as HTMLButtonElement | null;
  if (!text || !accept || !never || !close) return;
  const site = c.origin.replace(/^https?:\/\//, "");
  text.textContent = c.updated
    ? t("Обновить сохранённый пароль для «{user}» на {site}?", { user: c.username, site })
    : t("Сохранить пароль для «{user}» на {site}?", { user: c.username, site });
  accept.textContent = c.updated ? t("Обновить") : t("Сохранить");
  const decide = (action: "save" | "never" | "dismiss"): void => {
    void bridge.passwords.resolveCandidate({ action }).then(closePanel, err);
  };
  accept.onclick = () => decide("save");
  never.onclick = () => decide("never");
  close.onclick = () => decide("dismiss");
}

/** Хром-режим (chrome.ts): бар открывается по событию Core и держится
 *  сверкой состояния (duopulse-142): клик по странице бар больше не убивает
 *  (Core щадит pwsave в dp-close-panel), переключение вкладок кандидат
 *  переживает — вернулись на вкладку кандидата, панель открывается снова.
 *  Сверка идемпотентна и по tabs.updated, и по ресайзу окна (панель-child-
 *  webview не переживает ресайз — Core её закрывает, сверка возвращает).
 *  focus=false — фокус остаётся у страницы, набор в ней не умирает
 *  (ловушка duopulse-097). */
export function initPwSaveBar(): void {
  const openBar = (): void => {
    const { w, h } = measurePanelHost("pwsave");
    openPanel("pwsave", 8, chromeHeight(), w, h, false);
  };
  const reconcile = (activeId: string | null): void => {
    void bridge
      .passwords
      .candidate()
      .then((c) => {
        if (c && c.tabId === activeId) {
          if (currentPanel() !== "pwsave") openBar();
        } else if (currentPanel() === "pwsave") {
          closePanel();
        }
      })
      .catch(err);
  };
  void listen<PasswordsCandidateView>(bridge.events.passwordsSavePrompt, (ev) => {
    reconcile(ev.payload.tabId);
  });
  void listen<TabsListResult>(bridge.events.tabsUpdated, (ev) => {
    reconcile(ev.payload.tabs.find((t) => t.active)?.id ?? null);
  });
  let resizeTimer: number | undefined;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      // активную вкладку бар знает Core-кандидатом: сверка по tabs.list
      void bridge.tabs
        .list()
        .then((tabs) => reconcile(tabs.tabs.find((t) => t.active)?.id ?? null))
        .catch(err);
    }, 250);
  });
}

export { openPwSavePanel };
