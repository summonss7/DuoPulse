// DuoPulse — аккаунт Aila на мобильной ветке (этап 6 карточки duopulse-112,
// цепочка duopulse-106): блок «Аккаунт Aila» в меню «⋮» (статус + вход/
// выход/синк), лист входа и лист паролей (просмотр/копирование). Ядро — те
// же команды и протокол, что на десктопе (этапы 4–5): aila_login/logout/
// status/sync_now, mobile_passwords_list/reveal; копирование — системный
// буфер через JNI (mobile_clipboard_copy). Без входа мобильная ветка
// работает как прежде — блок лишь показывает «без аккаунта».
//
// Статус меню обновляется при каждом открытии (воркер авто-синка меняет
// lastSyncAt в фоне); после ручного синка mobile.ts зовет onSynced —
// обновить закладки и статус.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

/** Снимок aila.status (mobile_account.rs, camelCase). */
export interface AilaStatus {
  loggedIn: boolean;
  username: string;
  displayName: string;
  server: string;
  revision: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

/** Итог круга синка (aila_sync_now): пароли (в облаке, применено,
 *  конфликтов, push?, revision), закладки (в облаке, применено, push?). */
export interface SyncStats {
  passwords: [number, number, number, boolean, number];
  bookmarks: [number, number, boolean];
}

/** Запись списка паролей (passwords/mod.rs PasswordEntry). */
export interface PasswordItem {
  id: number;
  origin: string;
  url: string;
  title: string;
  username: string;
  createdAt: number;
  updatedAt: number;
}

/** Время последнего синка для строки статуса (ЧЧ:ММ; «ещё не было»). */
export function syncTimeLabel(lastSyncAt: number | null): string {
  if (!lastSyncAt) return t("ещё не было");
  const d = new Date(lastSyncAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Строка статуса блока аккаунта в меню (чистая — тестируется). */
export function accountStatusText(s: AilaStatus): string {
  if (!s.loggedIn) {
    return t("Без аккаунта Aila — пароли и закладки только на этом устройстве");
  }
  const who = s.displayName || s.username;
  const when = syncTimeLabel(s.lastSyncAt);
  const err = s.lastError ? t(" · ошибка: {error}", { error: s.lastError }) : "";
  return t("{who} · синк {when}{error}", { who, when, error: err });
}

/** Кнопки блока аккаунта по состоянию (чистая — тестируется): logged-out —
 *  только вход; logged-in — пароли, синк, выход. */
export function accountButtons(s: AilaStatus): ("login" | "passwords" | "sync" | "logout")[] {
  return s.loggedIn ? ["passwords", "sync", "logout"] : ["login"];
}

/** Итог ручного синка одной строкой для статуса (чистая — тестируется). */
export function syncResultText(r: SyncStats): string {
  const [pwPulled, pwApplied, pwConflicts, pwPushed] = r.passwords;
  const [bmPulled, bmApplied, bmPushed] = r.bookmarks;
  const parts = [
    t("пароли: {n} применено", { n: pwApplied }) +
      (pwConflicts ? t(", конфликтов {n}", { n: pwConflicts }) : "") +
      (pwPushed ? t(", отправлено") : ""),
    t("закладки: {n} применено", { n: bmApplied }) + (bmPushed ? t(", отправлено") : ""),
  ];
  const pulled = t("в облаке: пароли {pw}, закладки {bm}", { pw: pwPulled, bm: bmPulled });
  return t("Синк завершён — {parts}; {pulled}", { parts: parts.join("; "), pulled });
}

/** Транспорт invoke (тесты подменяют). */
export type AccInvoke = {
  invoke: typeof invoke;
};

/** Контекст мобильной ветки от mobile.ts. */
export interface AccHost {
  /** Строка статуса мобильной ветки (под меню). */
  note: (text: string) => void;
  /** После успешного ручного синка (mobile.ts обновит закладки). */
  onSynced: () => void;
  /** Закрыть меню «⋮» (листы открываются поверх). */
  closeMenu: () => void;
}

export class MobileAccount {
  private status: AilaStatus | null = null;
  private loginSheet: HTMLElement | null = null;
  private pwSheet: HTMLElement | null = null;
  private block: HTMLElement | null = null;

  constructor(
    private readonly host: AccHost,
    private readonly api: AccInvoke = { invoke },
  ) {}

  /** Собрать блок «Аккаунт Aila» внутрь меню «⋮» (один раз из mobile.ts). */
  mount(menu: HTMLElement): void {
    const block = document.createElement("div");
    block.className = "m-acc";
    block.innerHTML = `
      <div class="m-acc-head">${t("Аккаунт Aila")}</div>
      <p class="m-acc-status" data-acc="status">…</p>
      <div class="m-acc-row"></div>
    `;
    menu.append(block);
    this.block = block;
    void this.refresh();
  }

  /** Перечитать статус и перерисовать блок (открытие меню / после действий). */
  async refresh(): Promise<void> {
    try {
      this.status = await this.api.invoke<AilaStatus>("aila_status");
    } catch (e) {
      this.status = null;
    }
    this.render();
  }

  private render(): void {
    const block = this.block;
    if (!block) return;
    const st = this.status ?? {
      loggedIn: false,
      username: "",
      displayName: "",
      server: "",
      revision: 0,
      lastSyncAt: null,
      lastError: null,
    };
    block.querySelector<HTMLElement>("[data-acc=status]")!.textContent = accountStatusText(st);
    const row = block.querySelector<HTMLElement>(".m-acc-row")!;
    row.innerHTML = "";
    for (const kind of accountButtons(st)) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.acc = kind;
      if (kind === "login") {
        b.textContent = t("Войти в Aila");
        b.addEventListener("click", () => {
          this.host.closeMenu();
          this.openLoginSheet();
        });
      } else if (kind === "passwords") {
        b.textContent = t("Пароли");
        b.addEventListener("click", () => {
          this.host.closeMenu();
          void this.openPasswordsSheet();
        });
      } else if (kind === "sync") {
        b.textContent = t("Синхронизировать");
        b.addEventListener("click", () => void this.syncNow(b));
      } else {
        b.textContent = t("Выйти");
        b.addEventListener("click", () => void this.logout());
      }
      row.append(b);
    }
  }

  /** Ручной синк (кнопка): круг обоих хранилищ, итог — в статус. */
  private async syncNow(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = t("Синк…");
    try {
      const r = await this.api.invoke<SyncStats>("aila_sync_now");
      this.host.note(syncResultText(r));
      this.host.onSynced();
      await this.refresh();
    } catch (e) {
      this.host.note(t("Синк не удался: {error}", { error: String(e) }));
    } finally {
      btn.disabled = false;
      btn.textContent = t("Синхронизировать");
    }
  }

  private async logout(): Promise<void> {
    await this.api.invoke("aila_logout");
    this.host.note(t("Выход выполнен — данные остались на устройстве"));
    await this.refresh();
  }

  /** Лист входа: имя+пароль Aila, PBKDF2 на клиенте (пароль не уходит). */
  openLoginSheet(): void {
    if (this.loginSheet) return;
    const content = document.querySelector<HTMLElement>("#mobile .m-content")!;
    const wrap = document.createElement("div");
    wrap.className = "m-acc-wrap";
    wrap.innerHTML = `
      <div class="m-tr-backdrop"></div>
      <div class="m-acc-sheet" role="dialog" aria-label="${t("Вход в Aila")}">
        <div class="m-tr-head">
          <b>${t("Вход в аккаунт Aila")}</b>
          <button type="button" class="m-tr-close" aria-label="${t("Закрыть")}">✕</button>
        </div>
        <input class="m-acc-input" type="text" autocomplete="username"
          placeholder="${t("имя в Aila")}" autocapitalize="none" spellcheck="false" />
        <input class="m-acc-input" type="password" autocomplete="current-password"
          placeholder="${t("пароль Aila")}" />
        <button type="button" class="m-acc-go">${t("Войти")}</button>
        <p class="m-acc-err" hidden></p>
        <p class="m-acc-hint">${t("Вход синхронизирует пароли и закладки с другими устройствами; сервер получает только производный ключ, сам пароль не покидает телефон.")}</p>
      </div>`;
    const [user, pass] = wrap.querySelectorAll<HTMLInputElement>(".m-acc-input")!;
    const go = wrap.querySelector<HTMLButtonElement>(".m-acc-go")!;
    const err = wrap.querySelector<HTMLElement>(".m-acc-err")!;
    const close = (): void => {
      wrap.remove();
      this.loginSheet = null;
    };
    wrap.querySelector(".m-tr-backdrop")!.addEventListener("click", close);
    wrap.querySelector<HTMLButtonElement>(".m-tr-close")!.addEventListener("click", close);

    const submit = (): void => {
      const username = user.value.trim();
      const password = pass.value;
      if (!username || !password) {
        err.hidden = false;
        err.textContent = t("Заполните имя и пароль");
        return;
      }
      go.disabled = true;
      go.textContent = t("Входим…");
      err.hidden = true;
      void (async () => {
        try {
          await this.api.invoke("aila_login", { username, password });
          close();
          this.host.note(t("Вход выполнен — синхронизирую пароли и закладки…"));
          await this.refresh();
          this.host.onSynced();
        } catch (e) {
          err.hidden = false;
          err.textContent = `${e}`;
          go.disabled = false;
          go.textContent = t("Войти");
        }
      })();
    };
    go.addEventListener("click", submit);
    for (const input of [user, pass]) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    }
    content.append(wrap);
    this.loginSheet = wrap;
    user.focus();
  }

  /** Лист паролей: список + показать/скопировать (reveal — по кнопке). */
  async openPasswordsSheet(): Promise<void> {
    if (this.pwSheet) return;
    const content = document.querySelector<HTMLElement>("#mobile .m-content")!;
    const wrap = document.createElement("div");
    wrap.className = "m-acc-wrap";
    wrap.innerHTML = `
      <div class="m-tr-backdrop"></div>
      <div class="m-acc-sheet m-acc-pw" role="dialog" aria-label="${t("Пароли")}">
        <div class="m-tr-head">
          <b>${t("Пароли")}</b>
          <button type="button" class="m-tr-close" aria-label="${t("Закрыть")}">✕</button>
        </div>
        <input class="m-acc-input m-acc-search" type="search"
          placeholder="${t("поиск по сайту или логину")}" autocomplete="off" />
        <div class="m-acc-list" role="list"></div>
        <p class="m-acc-hint">${t("Пароли синхронизируются с аккаунтом Aila; копируйте и вставляйте как в Chrome.")}</p>
      </div>`;
    const list = wrap.querySelector<HTMLElement>(".m-acc-list")!;
    const search = wrap.querySelector<HTMLInputElement>(".m-acc-search")!;
    const close = (): void => {
      wrap.remove();
      this.pwSheet = null;
    };
    wrap.querySelector(".m-tr-backdrop")!.addEventListener("click", close);
    wrap.querySelector<HTMLButtonElement>(".m-tr-close")!.addEventListener("click", close);

    const draw = (items: PasswordItem[]): void => {
      list.innerHTML = "";
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "m-acc-empty";
        empty.textContent = t("Паролей пока нет — сохраните их на компьютере и синхронизируйте");
        list.append(empty);
        return;
      }
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "m-acc-item";
        row.dataset.id = String(it.id);
        const name = it.title || it.origin;
        row.innerHTML = `
          <div class="m-acc-item-main">
            <b class="m-acc-item-title"></b>
            <span class="m-acc-item-sub"></span>
            <span class="m-acc-item-pass" hidden></span>
          </div>
          <div class="m-acc-item-btns">
            <button type="button" class="m-acc-btn" data-act="show" title="${t("Показать пароль")}" aria-label="${t("Показать пароль")}">${t("показать")}</button>
            <button type="button" class="m-acc-btn" data-act="copy" title="${t("Скопировать пароль")}" aria-label="${t("Скопировать пароль")}">${t("копировать")}</button>
          </div>`;
        row.querySelector<HTMLElement>(".m-acc-item-title")!.textContent = name;
        row.querySelector<HTMLElement>(".m-acc-item-sub")!.textContent = it.username;
        list.append(row);
      }
    };

    const load = async (): Promise<void> => {
      try {
        const r = await this.api.invoke<{ items: PasswordItem[]; total: number }>(
          "mobile_passwords_list",
          { params: { query: search.value || null, limit: 100 } },
        );
        draw(r.items);
      } catch (e) {
        list.innerHTML = "";
        const p = document.createElement("p");
        p.className = "m-acc-empty";
        p.textContent = t("Не удалось прочитать пароли: {error}", { error: String(e) });
        list.append(p);
      }
    };

    // показать/скопировать — reveal по требованию, значение не логируется
    list.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-act]");
      if (!btn) return;
      const row = btn.closest<HTMLElement>(".m-acc-item")!;
      const id = Number(row.dataset.id);
      const passEl = row.querySelector<HTMLElement>(".m-acc-item-pass")!;
      const act = btn.dataset.act;
      void (async () => {
        try {
          if (act === "copy") {
            const password = await this.api.invoke<string>("mobile_passwords_reveal", { id });
            await this.api.invoke("mobile_clipboard_copy", { text: password });
            this.host.note(t("Пароль скопирован в буфер"));
            return;
          }
          if (passEl.hidden) {
            const password = await this.api.invoke<string>("mobile_passwords_reveal", { id });
            passEl.textContent = password;
            passEl.hidden = false;
            btn.textContent = t("скрыть");
          } else {
            passEl.textContent = "";
            passEl.hidden = true;
            btn.textContent = t("показать");
          }
        } catch (err) {
          this.host.note(t("Пароль: {error}", { error: String(err) }));
        }
      })();
    });

    let searchTimer = 0;
    search.addEventListener("input", () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => void load(), 250);
    });

    content.append(wrap);
    this.pwSheet = wrap;
    await load();
  }

  /** Тест-хук e2e-стендов (как __bmDebug): снапшот состояния блока. */
  debugState(): unknown {
    return { status: this.status, loginOpen: !!this.loginSheet, pwOpen: !!this.pwSheet };
  }
}

/** Состояние блока аккаунта для e2e (мобильный page-eval). */
export function installMobileAccount(
  host: AccHost,
  menu: HTMLElement,
  api?: AccInvoke,
): MobileAccount {
  const acc = new MobileAccount(host, api);
  acc.mount(menu);
  (window as unknown as { __accDebug?: () => unknown }).__accDebug = () => acc.debugState();
  return acc;
}
