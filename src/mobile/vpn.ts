// DuoPulse — лист «VPN» мобильной ветки (карточка duopulse-171, паритет 8/8
// аудита duopulse-156): аналог десктопной панели src/vpn-panel — тумблер
// тоннеля WireGuard, живой статус (состояние/endpoint/handshake/rx/tx/ping —
// события vpn:state_changed / vpn:stats, как на десктопе), профили (импорт
// .conf системным пикером SAF — MobileVpnHelper, итог глобалом
// __duopulseVpnConfPicked; активный — галочка, удаление с ключом Keystore),
// режимы off/global/split и редактор split-правил (персист
// vpn/split-rules.json Core — тот же, что на десктопе). «Маршруты сеанса»
// десктопной панели не переносятся — упрощённый статус (карточка).
// Индикатор-щит — кнопка в шапке (m-bar), видна при активном тоннеле,
// сигнальные цвета --ok/--warn/--err. Модель отображения — чистые функции
// src/vpn-panel/view.ts (переиспользование без дубля: формат байт/пинга/
// handshake, слова состояния, offDetail). Паттерн листа — m-sheet
// (diagnostics.ts); тест-хук e2e — window.__duopulseMobileVpn.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n";
import {
  formatBytes,
  formatHandshake,
  formatPing,
  offDetail,
  routingLabel,
  shieldLabel,
  shieldState,
} from "../vpn-panel/view";

/** Статус mobile_vpn_status (зеркало Rust VpnStatusResult, camelCase —
 *  контракт vpn.* десктопа; переехал из diagnostics.ts вместе с кнопкой
 *  «VPN: тест» этапа 6/8, которую заменил этот лист). */
export interface VpnStatusDto {
  mode: string;
  routing: string;
  state: string;
  detail: string;
  wg?: {
    profileId: string;
    profileName: string;
    state: string;
    endpoint: string;
    lastHandshakeMs?: number | null;
    rxBytes: number;
    txBytes: number;
    pingMs?: number | null;
    sinceMs: number;
  } | null;
}

/** Строка списка профилей (зеркало Rust VpnProfileInfo). */
export interface VpnProfileDto {
  id: string;
  name: string;
  endpoint: string;
  address: string;
  dns: string[];
  keepalive?: number;
  active: boolean;
}

/** Результат mobile_vpn_get_rules (зеркало Rust VpnRulesResult). */
export interface VpnRulesDto {
  mode: string;
  rules: { domain: string; route: string; addedAt: number }[];
}

/** Событие vpn:stats (зеркало Rust VpnStats). */
export interface VpnStatsDto {
  state: string;
  rxBytes: number;
  txBytes: number;
  pingMs?: number;
  lastHandshakeMs?: number;
}

/** Итог SAF-пикера (глобал __duopulseVpnConfPicked из MobileVpnHelper). */
export interface VpnPickDto {
  name?: string;
  text?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Чистые модели отображения (vitest): строки статуса/тостов без DOM.
// ---------------------------------------------------------------------------

/** Строка статистики тоннеля: событие vpn:stats свежее снапшота — числа
 *  берём из него (null — показываем снапшот/прочерки). */
export function statsView(
  wg: VpnStatusDto["wg"],
  stats: VpnStatsDto | null,
): { rx: string; tx: string; ping: string; hs: string } {
  const rx = stats?.rxBytes ?? wg?.rxBytes ?? null;
  const tx = stats?.txBytes ?? wg?.txBytes ?? null;
  const ping = stats?.pingMs ?? wg?.pingMs ?? null;
  const hs = stats?.lastHandshakeMs ?? wg?.lastHandshakeMs ?? null;
  return {
    rx: `↓ ${rx == null ? "—" : formatBytes(rx)}`,
    tx: `↑ ${tx == null ? "—" : formatBytes(tx)}`,
    ping: `${t("пинг")} ${formatPing(ping)}`,
    hs: `${t("handshake")} ${formatHandshake(hs)}`,
  };
}

/** Тост после смены режима: туннель поднят — «Режим: …», не поднят —
 *  честная подсказка включить тумблер (десктопная vpn-panel). */
export function modeFlash(st: VpnStatusDto, mode: string): string {
  const r = routingLabel(mode);
  return st.mode === "wg" || mode === "off"
    ? t("Режим: {r}.", { r })
    : t("Режим сохранён ({r}), но туннель не поднят — включите тумблер.", { r });
}

/** Тост после импорта: тоннель поднялся сам — короткая форма, иначе —
 *  подсказка включить тумблер (десктопная vpn-panel). */
export function importFlash(st: VpnStatusDto, name: string): string {
  return st.mode === "wg"
    ? t("Профиль «{p}» импортирован.", { p: name })
    : t("Профиль «{p}» импортирован — включите тумблер.", { p: name });
}

/** Итог SAF-пикера в тост: отмена — внятно, отказ чтения — как пришёл. */
export function pickErrorText(p: VpnPickDto): string {
  if (p.error === "cancelled") return t("Импорт отменён");
  return p.error ?? t("Не удалось прочитать файл");
}

// ---------------------------------------------------------------------------
// Лист «VPN» + индикатор-щит в шапке.
// ---------------------------------------------------------------------------

/** Контекст мобильной ветки (mobile.ts). */
export interface VpnHost {
  /** .m-content — сюда лист. */
  content: HTMLElement;
  /** .m-bar-top — сюда индикатор-щит (перед «инкогнито»). */
  barTop: HTMLElement;
  /** Строка статуса (тосты). */
  note: (text: string) => void;
  /** Закрыть меню «⋮» (открываем лист поверх). */
  closeMenu: () => void;
}

export class MobileVpn {
  private readonly wrap: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly switchEl: HTMLInputElement;
  private readonly statsEl: HTMLElement;
  private readonly profilesEl: HTMLElement;
  private readonly rulesBoxEl: HTMLElement;
  private readonly rulesEl: HTMLElement;
  private readonly ruleDomainEl: HTMLInputElement;
  private readonly shieldBtn: HTMLButtonElement;
  private status: VpnStatusDto | null = null;
  private profiles: VpnProfileDto[] = [];
  private rules: VpnRulesDto | null = null;
  private stats: VpnStatsDto | null = null;
  /** Выбранный профиль (тумблер/смена поднимут его; null — активный/первый). */
  private selectedId: string | null = null;

  constructor(private readonly host: VpnHost) {
    this.wrap = document.createElement("div");
    this.wrap.className = "m-sheet-wrap m-tabs-wrap";
    this.wrap.hidden = true;
    this.wrap.innerHTML = `
      <div class="m-sheet-backdrop"></div>
      <div class="m-sheet m-tabs-sheet m-vpn" role="menu" aria-label="${t("VPN")}">
        <b class="m-tabs-head">${t("VPN")}</b>
        <div class="m-vpn-body m-tabs-list">
          <div class="m-vpn-status" data-state="off">
            <span class="m-vpn-state"></span>
            <span class="m-vpn-detail"></span>
            <input type="checkbox" class="m-vpn-switch" aria-label="${t("Туннель")}" />
          </div>
          <div class="m-vpn-stats" hidden>
            <span data-stat="rx"></span><span data-stat="tx"></span>
            <span data-stat="ping"></span><span data-stat="hs"></span>
          </div>
          <div class="m-diag-sec">${t("Профили")}</div>
          <div class="m-vpn-profiles"></div>
          <button type="button" class="m-sheet-item m-vpn-import">${t("Импортировать .conf…")}</button>
          <div class="m-diag-sec">${t("Режим")}</div>
          <div class="m-vpn-modes" role="group" aria-label="${t("Режим")}">
            <button type="button" data-mode="off">${t("Выключен")}</button>
            <button type="button" data-mode="global">${t("Глобальный")}</button>
            <button type="button" data-mode="split">split</button>
          </div>
          <div class="m-vpn-rules-box" hidden>
            <div class="m-vpn-rules"></div>
            <div class="m-vpn-rule-add">
              <input type="text" class="m-vpn-rule-domain" placeholder="${t("домен, например example.com")}"
                spellcheck="false" autocomplete="off" dir="ltr" />
              <button type="button" class="m-vpn-rule-btn" data-route="tunnel">${t("Туннель")}</button>
              <button type="button" class="m-vpn-rule-btn" data-route="direct">${t("Напрямую")}</button>
            </div>
          </div>
        </div>
      </div>
    `;
    host.content.append(this.wrap);
    this.stateEl = this.wrap.querySelector(".m-vpn-state")!;
    this.detailEl = this.wrap.querySelector(".m-vpn-detail")!;
    this.switchEl = this.wrap.querySelector<HTMLInputElement>(".m-vpn-switch")!;
    this.statsEl = this.wrap.querySelector(".m-vpn-stats")!;
    this.profilesEl = this.wrap.querySelector(".m-vpn-profiles")!;
    this.rulesBoxEl = this.wrap.querySelector(".m-vpn-rules-box")!;
    this.rulesEl = this.wrap.querySelector(".m-vpn-rules")!;
    this.ruleDomainEl = this.wrap.querySelector<HTMLInputElement>(".m-vpn-rule-domain")!;

    this.wrap.querySelector(".m-sheet-backdrop")!.addEventListener("click", () => this.close());
    this.switchEl.addEventListener("change", () => void this.toggle());
    this.wrap.querySelector<HTMLButtonElement>(".m-vpn-import")!.addEventListener("click", () =>
      void this.pickConf(),
    );
    for (const b of this.wrap.querySelectorAll<HTMLButtonElement>(".m-vpn-modes button")) {
      b.addEventListener("click", () => void this.setMode(b.dataset.mode!));
    }
    for (const b of this.wrap.querySelectorAll<HTMLButtonElement>(".m-vpn-rule-btn")) {
      b.addEventListener("click", () => this.addRuleFromInput(b.dataset.route as "tunnel" | "direct"));
    }
    this.ruleDomainEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.addRuleFromInput("tunnel");
    });

    // Индикатор-щит в шапке: виден при активном тоннеле, тап — открыть лист
    // (как Navbar десктопа). Сигнальные цвета — data-vpn (CSS).
    this.shieldBtn = document.createElement("button");
    this.shieldBtn.className = "m-icon m-vpn-shield";
    this.shieldBtn.hidden = true;
    this.shieldBtn.setAttribute("aria-label", t("VPN"));
    this.shieldBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.8 13 3.6v3.9c0 3.2-2.1 5.5-5 6.7-2.9-1.2-5-3.5-5-6.7V3.6z"/><path d="M5.6 7.8 7.4 9.6l3-3.4"/></svg>';
    this.shieldBtn.addEventListener("click", () => this.setSheet(true));
    const privateBtn = host.barTop.querySelector(".m-private-btn");
    if (privateBtn) host.barTop.insertBefore(this.shieldBtn, privateBtn);
    else host.barTop.append(this.shieldBtn);

    // SAF-пикер (MobileVpnHelper): Kotlin читает файл и зовёт этот глобал.
    (window as unknown as { __duopulseVpnConfPicked?: (p: VpnPickDto) => void }).__duopulseVpnConfPicked =
      (p) => void this.onPicked(p);

    // События Core (контракт десктопа): переходы тоннеля — сразу в щит/статус,
    // статистика — живые числа; полное состояние добираем переснимком.
    void listen<VpnStatusDto>("vpn:state_changed", (e) => void this.onStateChanged(e.payload));
    void listen<VpnStatsDto>("vpn:stats", (e) => {
      this.stats = e.payload;
      this.renderStats();
    });

    // Тест-хук e2e-стендов (как __duopulseMobileDiagnostics).
    (window as unknown as { __duopulseMobileVpn?: () => unknown }).__duopulseMobileVpn = () =>
      this.snapshot();
  }

  /** Восстановить сохранённый тоннель на старте (режим из split-rules.json
   *  переживает рестарт — Core поднимает сессию и прокси WebView). */
  restoreOnBoot(): void {
    void invoke<VpnStatusDto>("mobile_vpn_restore")
      .then((st) => this.applyStatus(st))
      .catch(() => {}); // команда недоступна (десктоп-сборка UI) — молча
  }

  /** Показать/спрятать лист; открытие перечитывает состояние. */
  setSheet(open: boolean): void {
    this.wrap.hidden = !open;
    if (open)
      void this.refresh().catch(() =>
        this.host.note(t("VPN: не удалось прочитать состояние")),
      );
  }

  private close(): void {
    this.setSheet(false);
  }

  /** Тоннель поднят (фактический маршрут wg). */
  private tunnelOn(): boolean {
    return this.status?.mode === "wg";
  }

  /** Профиль для тумблера: явный выбор → активный → первый. */
  private effectiveId(): string | null {
    if (this.selectedId && this.profiles.some((p) => p.id === this.selectedId)) return this.selectedId;
    return this.profiles.find((p) => p.active)?.id ?? this.profiles[0]?.id ?? null;
  }

  private async refresh(): Promise<void> {
    const [st, pr, rl] = await Promise.all([
      invoke<VpnStatusDto>("mobile_vpn_status"),
      invoke<VpnProfileDto[]>("mobile_vpn_list_profiles"),
      invoke<VpnRulesDto>("mobile_vpn_get_rules"),
    ]);
    this.status = st;
    this.profiles = pr;
    this.rules = rl;
    if (st.mode !== "wg") this.stats = null;
    this.renderAll();
  }

  private applyStatus(st: VpnStatusDto): void {
    this.status = st;
    if (st.mode !== "wg") this.stats = null;
    this.renderStatus();
    this.renderShield();
    this.renderStats();
    this.renderModes();
  }

  private async onStateChanged(st: VpnStatusDto): Promise<void> {
    // переходы тоннеля — сразу; выключение/смена — полный переснимок
    if (st.mode === "wg") {
      this.applyStatus({ ...(this.status ?? st), ...st });
    } else {
      await this.refresh().catch(() => {});
    }
  }

  // --- отрисовка --------------------------------------------------------------

  private renderAll(): void {
    this.renderStatus();
    this.renderShield();
    this.renderStats();
    this.renderProfiles();
    this.renderModes();
    this.renderRules();
  }

  private renderStatus(): void {
    const st = this.status ? shieldState(this.status) : "off";
    const box = this.wrap.querySelector<HTMLElement>(".m-vpn-status")!;
    box.dataset.state = st;
    this.stateEl.textContent = shieldLabel(st);
    if (st === "connected" && this.status?.wg) {
      this.detailEl.textContent = t("«{p}» · {e}", {
        p: this.status.wg.profileName,
        e: this.status.wg.endpoint,
      });
    } else if (st === "off") {
      this.detailEl.textContent = offDetail(
        this.status?.mode ?? "off",
        this.profiles.length > 0,
      );
    } else {
      // connecting/error — причина из Core (kill-switch: «туннель мёртв,
      // соединения закрыты, напрямую не уходим» и т.п.)
      this.detailEl.textContent = this.status?.detail ?? "";
    }
    this.detailEl.title = this.detailEl.textContent;
    this.switchEl.checked = this.tunnelOn();
  }

  private renderShield(): void {
    const st = this.status ? shieldState(this.status) : "off";
    this.shieldBtn.hidden = st === "off";
    this.shieldBtn.dataset.vpn = st;
    this.shieldBtn.title =
      st === "off"
        ? t("VPN")
        : t("VPN — {s} ({r})", { s: shieldLabel(st), r: routingLabel(this.status?.routing ?? "off") });
  }

  private renderStats(): void {
    const on = this.tunnelOn();
    this.statsEl.hidden = !on;
    if (!on) return;
    const v = statsView(this.status?.wg ?? null, this.stats);
    for (const [k, text] of Object.entries(v)) {
      const el = this.statsEl.querySelector<HTMLElement>(`[data-stat="${k}"]`);
      if (el) el.textContent = text;
    }
  }

  private renderProfiles(): void {
    const kids: HTMLElement[] = [];
    if (this.profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "m-vpn-empty";
      empty.textContent = t("профилей нет — импортируйте .conf");
      kids.push(empty);
    }
    for (const p of this.profiles) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "m-vpn-profile" + (p.active ? " active" : "");
      const name = document.createElement("span");
      name.className = "m-vpn-profile-name";
      name.textContent = p.name;
      const ep = document.createElement("span");
      ep.className = "m-vpn-profile-ep";
      ep.textContent = p.endpoint;
      row.append(name, ep);
      if (p.active) {
        const mark = document.createElement("span");
        mark.className = "m-vpn-profile-mark";
        mark.textContent = "✓";
        mark.title = t("активен");
        row.append(mark);
      }
      row.addEventListener("click", () => void this.selectProfile(p.id));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "m-vpn-profile-del";
      del.title = t("удалить");
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.removeProfile(p.id);
      });
      const cell = document.createElement("div");
      cell.className = "m-vpn-profile-row";
      cell.append(row, del);
      kids.push(cell);
    }
    this.profilesEl.replaceChildren(...kids);
  }

  private renderModes(): void {
    const mode = this.rules?.mode ?? this.status?.routing ?? "off";
    for (const b of this.wrap.querySelectorAll<HTMLButtonElement>(".m-vpn-modes button")) {
      b.classList.toggle("on", b.dataset.mode === mode);
    }
    this.rulesBoxEl.hidden = mode !== "split";
  }

  private renderRules(): void {
    const rules = [...(this.rules?.rules ?? [])].sort((a, b) => a.addedAt - b.addedAt);
    const kids: HTMLElement[] = [];
    if (rules.length === 0) {
      const empty = document.createElement("div");
      empty.className = "m-vpn-empty";
      empty.textContent = t(
        "Правил нет. В split-режиме сайт отсюда идёт через туннель, остальное — напрямую.",
      );
      kids.push(empty);
    }
    for (const r of rules) {
      const row = document.createElement("div");
      row.className = "m-vpn-rule";
      const dom = document.createElement("span");
      dom.className = "m-vpn-mono";
      dom.textContent = r.domain;
      dom.title = t("правило ловит и поддомены ({d} и *.{d})", { d: r.domain });
      const seg = document.createElement("div");
      seg.className = "m-vpn-seg";
      for (const [route, label] of [
        ["tunnel", t("Туннель")],
        ["direct", t("Напрямую")],
      ] as const) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.classList.toggle("on", r.route === route);
        b.addEventListener("click", () => void this.addRule(r.domain, route));
        seg.append(b);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "m-vpn-rule-del";
      del.textContent = "✕";
      del.title = t("удалить");
      del.addEventListener("click", () => void this.removeRule(r.domain));
      row.append(dom, seg, del);
      kids.push(row);
    }
    this.rulesEl.replaceChildren(...kids);
  }

  /** Срочная строка в деталь статуса (отказы команд — честно, не молча). */
  private flashDetail(text: string): void {
    this.detailEl.textContent = text;
    this.detailEl.title = text;
  }

  // --- действия ----------------------------------------------------------------

  private async toggle(): Promise<void> {
    const on = this.switchEl.checked;
    const id = this.effectiveId();
    if (on && !id) {
      this.switchEl.checked = false;
      this.flashDetail(
        t(
          "Сначала импортируйте профиль WireGuard (.conf) — файл выдаёт ваш VPN-провайдер; собственных серверов у DuoPulse нет.",
        ),
      );
      return;
    }
    try {
      await this.useProfile(on ? id : null);
    } catch (e) {
      this.switchEl.checked = !on;
      this.flashDetail(String(e));
    }
  }

  /** Включить тоннель с профилем / выключить; общий хвост — переснимок. */
  private async useProfile(id: string | null): Promise<void> {
    const st = await invoke<VpnStatusDto>("mobile_vpn_use_profile", { params: { id } });
    this.applyStatus(st);
    await this.refresh().catch(() => {});
  }

  private async selectProfile(id: string): Promise<void> {
    this.selectedId = id;
    if (!this.tunnelOn()) {
      this.renderProfiles(); // только выбор — поднимет тумблер
      return;
    }
    try {
      await this.useProfile(id);
    } catch (e) {
      this.flashDetail(String(e));
      await this.refresh().catch(() => {});
    }
  }

  private async removeProfile(id: string): Promise<void> {
    try {
      // активный Core гасит сам (тоннель, маршрут, режим off)
      await invoke("mobile_vpn_remove_profile", { params: { id } });
      if (this.selectedId === id) this.selectedId = null;
      await this.refresh().catch(() => {});
      this.flashDetail(t("Профиль удалён."));
    } catch (e) {
      this.flashDetail(String(e));
    }
  }

  private async pickConf(): Promise<void> {
    try {
      const r = await invoke<string>("mobile_vpn_pick_conf");
      if (r !== "ok") this.flashDetail(r);
    } catch (e) {
      this.flashDetail(String(e));
    }
  }

  /** Итог SAF-пикера (глобал из MobileVpnHelper): текст → Core, лист — как
   *  после кнопки импорта десктопа. */
  private async onPicked(p: VpnPickDto): Promise<void> {
    if (p.error || !p.text) {
      this.flashDetail(pickErrorText(p));
      return;
    }
    try {
      const info = await invoke<VpnProfileDto>("mobile_vpn_import_profile", {
        params: { text: p.text, name: p.name ?? "profile.conf" },
      });
      this.selectedId = info.id;
      await this.refresh().catch(() => {});
      this.flashDetail(importFlash(this.status ?? { mode: "off", routing: "off", state: "off", detail: "" }, info.name));
    } catch (e) {
      this.flashDetail(String(e));
    }
  }

  private async setMode(mode: string): Promise<void> {
    try {
      const st = await invoke<VpnStatusDto>("mobile_vpn_set_mode", { params: { mode } });
      this.applyStatus(st);
      await this.refresh().catch(() => {});
      this.flashDetail(modeFlash(st, mode));
    } catch (e) {
      this.flashDetail(String(e));
    }
  }

  private async addRule(domain: string, route: "tunnel" | "direct"): Promise<void> {
    try {
      this.rules = await invoke<VpnRulesDto>("mobile_vpn_add_rule", {
        params: { domain, route },
      });
      this.renderRules();
      this.renderModes();
      this.flashDetail(
        route === "tunnel"
          ? t("«{d}» — через туннель.", { d: domain })
          : t("«{d}» — напрямую.", { d: domain }),
      );
    } catch (e) {
      this.flashDetail(String(e));
    }
  }

  private addRuleFromInput(route: "tunnel" | "direct"): void {
    const domain = this.ruleDomainEl.value.trim().toLowerCase();
    if (!domain) {
      this.flashDetail(t("Введите домен — например, example.com."));
      return;
    }
    void this.addRule(domain, route);
    this.ruleDomainEl.value = "";
  }

  private async removeRule(domain: string): Promise<void> {
    try {
      this.rules = await invoke<VpnRulesDto>("mobile_vpn_remove_rule", {
        params: { domain },
      });
      this.renderRules();
    } catch (e) {
      this.flashDetail(String(e));
    }
  }

  /** Снимок для e2e-стендов (window.__duopulseMobileVpn). */
  private snapshot(): {
    open: boolean;
    mode: string;
    routing: string;
    tunnelOn: boolean;
    wgState: string | null;
    rx: number | null;
    tx: number | null;
    ping: number | null;
    profiles: number;
    rules: number;
    shield: string;
  } {
    const wg = this.status?.wg ?? null;
    return {
      open: !this.wrap.hidden,
      mode: this.status?.mode ?? "off",
      routing: this.rules?.mode ?? this.status?.routing ?? "off",
      tunnelOn: this.tunnelOn(),
      wgState: wg?.state ?? null,
      rx: this.stats?.rxBytes ?? wg?.rxBytes ?? null,
      tx: this.stats?.txBytes ?? wg?.txBytes ?? null,
      ping: this.stats?.pingMs ?? wg?.pingMs ?? null,
      profiles: this.profiles.length,
      rules: this.rules?.rules.length ?? 0,
      shield: this.shieldBtn.dataset.vpn ?? "off",
    };
  }
}
