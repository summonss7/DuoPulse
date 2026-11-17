// DuoPulse — бар «Сохранить пароль?» мобильной ветки (карточка duopulse-165,
// паритет 2/8 аудита duopulse-156): сабмит формы логина в web-оверлее →
// кандидат в памяти Core (src-tauri/src/mobile_pass.rs, тот же
// PasswordPrompts, что у десктопного бара duopulse-108) → событие
// passwords:save_prompt (без пароля) → этот нижний лист (m-sheet, паттерн
// diagnostics.ts). Кнопки решают одной командой mobile_password_resolve:
// «Сохранить/Обновить» (upsert по (origin, username) — общий PasswordStore),
// «Никогда для этого сайта» (denylist: повторные сабмиты origin не
// предлагают), «Закрыть»/фон (dismiss). Лист одноразовый — reconcile бара
// десктопа (duopulse-142, мультипанельное окно) мобильной ветке не нужен:
// любое закрытие сразу уходит командой в Core, кандидат не зависает; слушатель
// события ставится в конструкторе (лист создаётся при старте mobile.ts),
// поэтому событие раньше готовности UI не теряется.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

/** Вид кандидата от Core (mobile_pass.rs, camelCase — как у десктопа). */
export interface PassPromptView {
  tabId: string;
  origin: string;
  username: string;
  updated: boolean;
}

/** Снимок для e2e-стендов (window.__duopulseMobilePassSave). */
export interface PassSaveSnapshot {
  open: boolean;
  view: PassPromptView | null;
  lastAction: string;
}

/** Текст бара под кандидата (чистая — vitest). */
export function passPromptText(c: PassPromptView): string {
  const site = c.origin.replace(/^https?:\/\//, "");
  return c.updated
    ? t("Обновить сохранённый пароль для «{user}» на {site}?", { user: c.username, site })
    : t("Сохранить пароль для «{user}» на {site}?", { user: c.username, site });
}

/** Контекст мобильной ветки (mobile.ts). */
export interface PassSaveHost {
  /** .m-content — сюда лист. */
  content: HTMLElement;
  /** Строка статуса (тосты исхода). */
  note: (text: string) => void;
}

export class MobilePassSave {
  private readonly wrap: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private view: PassPromptView | null = null;
  private lastAction = "";

  constructor(private readonly host: PassSaveHost) {
    this.wrap = document.createElement("div");
    this.wrap.className = "m-sheet-wrap m-pass-wrap";
    this.wrap.hidden = true;
    this.wrap.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet m-pass-sheet" role="dialog" aria-label="${t("Сохранение пароля")}">
        <b class="m-pass-text"></b>
        <button type="button" class="m-sheet-item m-pass-save"></button>
        <button type="button" class="m-sheet-item m-pass-never">${t("Никогда для этого сайта")}</button>
        <button type="button" class="m-sheet-item m-pass-close">${t("Закрыть")}</button>
      </div>
    `;
    host.content.append(this.wrap);
    this.textEl = this.wrap.querySelector(".m-pass-text")!;
    this.saveBtn = this.wrap.querySelector<HTMLButtonElement>(".m-pass-save")!;
    this.saveBtn.addEventListener("click", () => void this.decide("save"));
    this.wrap
      .querySelector<HTMLButtonElement>(".m-pass-never")!
      .addEventListener("click", () => void this.decide("never"));
    this.wrap.querySelector<HTMLButtonElement>(".m-pass-close")!.addEventListener("click", () => void this.decide("dismiss"));
    this.wrap.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => void this.decide("dismiss"));
    // Core предлагает — показываем (кандидат с паролём остался в Core)
    void listen<PassPromptView>("passwords:save_prompt", (ev) => this.show(ev.payload));
    // Тест-хук e2e-стендов (как __duopulseMobileDiagnostics)
    (window as unknown as { __duopulseMobilePassSave?: () => unknown }).__duopulseMobilePassSave =
      () => this.snapshot();
  }

  /** Показать бар кандидатом (битый/пустой payload — тихо). */
  private show(c: PassPromptView): void {
    if (
      !c ||
      typeof c.username !== "string" ||
      typeof c.origin !== "string" ||
      !c.username ||
      !c.origin
    )
      return;
    this.view = c;
    this.textEl.textContent = passPromptText(c);
    this.saveBtn.textContent = c.updated ? t("Обновить") : t("Сохранить");
    this.wrap.hidden = false;
  }

  /** Решение по бару: команда Core + закрыть (исход — тост; dismiss молчит). */
  private async decide(action: "save" | "never" | "dismiss"): Promise<void> {
    if (this.view === null) return;
    this.lastAction = action;
    this.wrap.hidden = true;
    try {
      await invoke("mobile_password_resolve", { action });
      if (action === "save")
        this.host.note(
          this.view.updated ? t("Пароль обновлён") : t("Пароль сохранён"),
        );
      else if (action === "never") this.host.note(t("Сайт добавлен в «никогда не сохранять»"));
    } catch {
      this.host.note(t("Не удалось сохранить пароль"));
    }
    this.view = null;
  }

  private snapshot(): PassSaveSnapshot {
    return { open: !this.wrap.hidden, view: this.view, lastAction: this.lastAction };
  }
}
