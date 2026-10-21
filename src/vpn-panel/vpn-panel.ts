// DuoPulse — панель VPN и индикатор-щит в Navbar (задача 6.5, docs/02 §6.2,
// docs/05 §2): тумблер туннеля WireGuard, сервер (импорт .conf, смена на
// лету), режим off/global/split, split-правила, живая статистика rx/tx/ping
// (событие vpn:stats) и «Маршруты сеанса» (vpn:route_changed) — событиями,
// без опроса. Быстрое действие «этот сайт — через туннель» добавляет правило
// для хоста активной вкладки. Дисклеймер: DuoPulse — только VPN-клиент,
// серверы пользователя или его провайдера (docs/01 F-12). Индикатор-щит —
// сигнальные цвета гайда 06 §2, неон — только акценты.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type {
  VpnProfileInfo,
  VpnRulesResult,
  VpnStateChanged,
  VpnStats,
  VpnStatusResult,
} from "../bridge/gen/types";
import {
  formatBytes,
  formatHandshake,
  formatPing,
  hostOf,
  noteRoute,
  routeLabel,
  routeRows,
  routingLabel,
  shieldLabel,
  shieldState,
} from "./view";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = $("vpnBtn");
const panel = $("vpnPanel");
const enabledEl = $<HTMLInputElement>("vpnEnabled");
const statusEl = $("vpnPanelStatus");
const statusStateEl = statusEl.querySelector<HTMLElement>(".state")!;
const statusDetailEl = $("vpnPanelDetail");
const profileEl = $<HTMLSelectElement>("vpnProfile");
const importEl = $("vpnImport");
const removeEl = $("vpnProfileRemove");
const modeEl = $("vpnMode");
const statsEl = $("vpnStats");
const statRx = statsEl.querySelector<HTMLElement>('[data-stat="rx"]')!;
const statTx = statsEl.querySelector<HTMLElement>('[data-stat="tx"]')!;
const statPing = statsEl.querySelector<HTMLElement>('[data-stat="ping"]')!;
const statHs = statsEl.querySelector<HTMLElement>('[data-stat="hs"]')!;
const rulesEl = $("vpnRules");
const ruleDomainEl = $<HTMLInputElement>("vpnRuleDomain");
const siteRow = $("vpnSiteRow");
const siteHostEl = $("vpnSiteHost");
const routesEl = $("vpnRoutes");
const routesListEl = $("vpnRoutesList");

const err = (e: unknown): void => console.error("vpn-panel:", e);

// --- состояние панели (снапшоты Core + живые события) ------------------------

let status: VpnStatusResult | null = null;
let profiles: VpnProfileInfo[] = [];
/** Выбранный сервер (тумблер/смена поднимут его; null — не выбран). */
let selectedId: string | null = null;
let rulesRes: VpnRulesResult | null = null;
/** Каталог маршрутных решений сеанса (vpn:route_changed). */
let sessionRoutes = new Map<string, string>();
/** Последние числа статистики (vpn:stats; null — пока не приходили). */
let stats: VpnStats | null = null;
/** Хост активной вкладки («этот сайт — через туннель»); null — внутренняя
 *  страница или адрес без хоста. */
let siteHost: string | null = null;

/** Туннель поднят (фактический маршрут wg) — тумблер включён. */
const tunnelOn = (): boolean => status?.mode === "wg";

// --- отрисовка ---------------------------------------------------------------

function renderShield(): void {
  const st = status ? shieldState(status) : "off";
  btn.dataset.vpn = st;
  btn.title =
    st === "off"
      ? `VPN — ${routingLabel(rulesRes?.mode ?? status?.routing ?? "off")}`
      : `VPN — ${shieldLabel(st)} (${routingLabel(rulesRes?.mode ?? status?.routing ?? "off")})`;
}

function renderStatus(): void {
  const st = status ? shieldState(status) : "off";
  statusEl.dataset.state = st;
  statusStateEl.textContent = shieldLabel(st);
  if (st === "connected" && status?.wg) {
    statusDetailEl.textContent = `«${status.wg.profileName}» · ${status.wg.endpoint}`;
  } else if (st === "off") {
    statusDetailEl.textContent =
      status?.mode === "proxy"
        ? "туннель выключен — действует внешний прокси"
        : "трафик браузера — напрямую";
  } else {
    statusDetailEl.textContent = status?.detail ?? "";
  }
  statusDetailEl.title = statusDetailEl.textContent;
  enabledEl.checked = tunnelOn();
}

function renderProfiles(): void {
  profileEl.replaceChildren();
  if (profiles.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "профилей нет — импортируйте .conf";
    profileEl.append(opt);
    profileEl.disabled = true;
    removeEl.hidden = true;
    selectedId = null;
    return;
  }
  profileEl.disabled = false;
  if (!selectedId || !profiles.some((p) => p.id === selectedId)) {
    selectedId = profiles.find((p) => p.active)?.id ?? profiles[0]!.id;
  }
  for (const p of profiles) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.endpoint}${p.active ? " · активен" : ""}`;
    opt.selected = p.id === selectedId;
    profileEl.append(opt);
  }
  removeEl.hidden = false;
}

function renderMode(): void {
  const mode = rulesRes?.mode ?? status?.routing ?? "off";
  for (const b of modeEl.querySelectorAll<HTMLButtonElement>("button")) {
    b.classList.toggle("on", b.dataset.mode === mode);
  }
}

function renderStats(): void {
  const on = tunnelOn();
  statsEl.hidden = !on;
  if (!on) return;
  const wg = status?.wg;
  // До первого vpn:stats событие не приходило — числа из снапшота туннеля.
  const rx = stats?.rxBytes ?? wg?.rxBytes ?? null;
  const tx = stats?.txBytes ?? wg?.txBytes ?? null;
  const ping = stats?.pingMs ?? wg?.pingMs ?? null;
  const hs = stats?.lastHandshakeMs ?? wg?.lastHandshakeMs ?? null;
  statRx.textContent = `↓ ${rx == null ? "—" : formatBytes(rx)}`;
  statTx.textContent = `↑ ${tx == null ? "—" : formatBytes(tx)}`;
  statPing.textContent = `ping ${formatPing(ping)}`;
  statHs.textContent = `hs ${formatHandshake(hs)}`;
}

function renderRules(): void {
  rulesEl.replaceChildren();
  const rules = rulesRes?.rules ?? [];
  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "vpn-empty";
    empty.textContent =
      "Правил нет. В split-режиме сайт отсюда идёт через туннель, остальное — напрямую.";
    rulesEl.append(empty);
    return;
  }
  for (const r of rules) {
    const row = document.createElement("div");
    row.className = "vpn-rule";
    const dom = document.createElement("span");
    dom.className = "vpn-mono";
    dom.textContent = r.domain;
    dom.title = `правило ловит и поддомены (${r.domain} и *.${r.domain})`;
    const seg = document.createElement("div");
    seg.className = "vpn-seg";
    const mk = (route: "tunnel" | "direct", text: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.classList.toggle("on", r.route === route);
      b.addEventListener("click", () => addRule(r.domain, route));
      return b;
    };
    seg.append(mk("tunnel", "Туннель"), mk("direct", "Напрямую"));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "link";
    del.textContent = "удалить";
    del.addEventListener("click", () => {
      void bridge.vpn
        .removeRule({ domain: r.domain })
        .then((res) => {
          rulesRes = res;
          renderRules();
        })
        .catch(err);
    });
    row.append(dom, seg, del);
    rulesEl.append(row);
  }
}

function renderRoutes(): void {
  routesEl.hidden = sessionRoutes.size === 0;
  routesListEl.replaceChildren();
  for (const { domain, route } of routeRows(sessionRoutes)) {
    const row = document.createElement("div");
    row.className = "vpn-route";
    const dom = document.createElement("span");
    dom.className = "vpn-mono";
    dom.textContent = domain;
    const tag = document.createElement("span");
    tag.className = "vpn-route-tag";
    tag.dataset.route = route;
    tag.textContent = routeLabel(route);
    row.append(dom, tag);
    routesListEl.append(row);
  }
}

function renderSite(): void {
  siteRow.hidden = !siteHost;
  if (siteHost) siteHostEl.textContent = siteHost;
}

function renderAll(): void {
  renderShield();
  renderStatus();
  renderProfiles();
  renderMode();
  renderStats();
  renderRules();
  renderRoutes();
  renderSite();
}

// --- действия ----------------------------------------------------------------

/** Полный снимок: статус/профили/правила + хост активной вкладки. */
async function refreshAll(): Promise<void> {
  const [st, pr, rl, tabs] = await Promise.all([
    bridge.vpn.status(),
    bridge.vpn.listProfiles(),
    bridge.vpn.getRules(),
    bridge.tabs.list(),
  ]);
  status = st;
  profiles = pr;
  rulesRes = rl;
  const active = tabs.tabs.find((t) => t.active);
  siteHost = hostOf(active?.url);
  if (st.routing === "off") sessionRoutes.clear();
  renderAll();
}

/** Срочная строка в деталь статуса (отказы команд — честно, не молча). */
function flashDetail(text: string): void {
  statusDetailEl.textContent = text;
  statusDetailEl.title = text;
}

enabledEl.addEventListener("change", async () => {
  const on = enabledEl.checked;
  if (on && !selectedId) {
    enabledEl.checked = false;
    flashDetail("Сначала импортируйте профиль WireGuard (.conf).");
    return;
  }
  try {
    status = await bridge.vpn.useProfile({ id: on ? selectedId : null });
  } catch (e) {
    enabledEl.checked = !on;
    flashDetail(String(e));
    return;
  }
  await refreshAll().catch(err);
});

importEl.addEventListener("click", () => {
  void (async () => {
    let path: string | null = null;
    try {
      path = await invoke<string | null>("plugin:dialog|open", {
        options: {
          title: "Профиль WireGuard (.conf)",
          multiple: false,
          filters: [{ name: "WireGuard", extensions: ["conf"] }],
        },
      });
      if (!path) return;
      const info = await bridge.vpn.importProfile({ path });
      selectedId = info.id;
      await refreshAll().catch(err);
      flashDetail(
        tunnelOn()
          ? `Профиль «${info.name}» импортирован.`
          : `Профиль «${info.name}» импортирован — включите тумблер.`,
      );
    } catch (e) {
      flashDetail(String(e));
    }
  })();
});

removeEl.addEventListener("click", () => {
  void (async () => {
    if (!selectedId) return;
    const id = selectedId;
    try {
      // Активный профиль сначала глушим (остановка рвёт туннельные соединения,
      // kill-switch 6.4), потом удаляем профиль и секрет.
      if (tunnelOn()) {
        status = await bridge.vpn.useProfile({ id: null });
      }
      await bridge.vpn.removeProfile({ id });
      selectedId = null;
      await refreshAll().catch(err);
      flashDetail("Профиль удалён.");
    } catch (e) {
      flashDetail(String(e));
    }
  })();
});

profileEl.addEventListener("change", () => {
  selectedId = profileEl.value || null;
  if (!selectedId) return;
  if (!tunnelOn()) return; // туннель выключен — просто выбрали сервер
  void bridge.vpn
    .useProfile({ id: selectedId })
    .then((st) => {
      status = st;
      renderAll();
    })
    .catch((e) => {
      flashDetail(String(e));
      void refreshAll().catch(err);
    });
});

for (const b of modeEl.querySelectorAll<HTMLButtonElement>("button")) {
  b.addEventListener("click", () => {
    const mode = b.dataset.mode as "off" | "global" | "split";
    void bridge.vpn
      .setMode({ mode })
      .then(async (st) => {
        status = st;
        if (mode === "off") sessionRoutes.clear();
        await refreshAll().catch(err);
        flashDetail(
          st.mode === "wg" || mode === "off"
            ? `Режим: ${routingLabel(mode)}.`
            : `Режим сохранён (${routingLabel(mode)}), но туннель не поднят — включите тумблер.`,
        );
      })
      .catch((e) => flashDetail(String(e)));
  });
}

function addRule(domain: string, route: "tunnel" | "direct"): void {
  void bridge.vpn
    .addRule({ domain, route })
    .then((res) => {
      rulesRes = res;
      renderRules();
      renderMode();
      flashDetail(`«${domain}» — ${route === "tunnel" ? "через туннель" : "напрямую"}.`);
    })
    .catch((e) => flashDetail(String(e)));
}

function addRuleFromInput(route: "tunnel" | "direct"): void {
  const domain = ruleDomainEl.value.trim().toLowerCase();
  if (!domain) {
    flashDetail("Введите домен — например, example.com.");
    return;
  }
  addRule(domain, route);
  ruleDomainEl.value = "";
}

$("vpnRuleTunnel").addEventListener("click", () => addRuleFromInput("tunnel"));
$("vpnRuleDirect").addEventListener("click", () => addRuleFromInput("direct"));
ruleDomainEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addRuleFromInput("tunnel");
});

$("vpnSiteTunnel").addEventListener("click", () => {
  if (siteHost) addRule(siteHost, "tunnel");
});

$("vpnSettingsLink").addEventListener("click", () => {
  panel.hidden = true;
  void bridge.tabs.open({ url: "duopulse://settings" }).catch(err);
});

// --- события Core (без опроса) -----------------------------------------------

// Переходы туннеля (подключается/подключён/ошибка/выключен) несут снапшот wg
// (задача 6.5): щит и панель обновляются сразу; выключение (mode off) —
// полный переснимок (маршрут мог вернуться к прокси).
void listen<VpnStateChanged>(bridge.events.vpnStateChanged, (e) => {
  const st = e.payload;
  if (st.mode === "wg") {
    status = {
      ...(status ?? { detail: "", routing: "off", mode: "off", state: "off" }),
      mode: st.mode,
      state: st.state,
      detail: st.detail,
      wg: st.wg ?? null,
    };
    if (shieldState(status) === "off") stats = null;
    renderShield();
    renderStatus();
    renderStats();
  } else {
    stats = null;
    sessionRoutes.clear();
    void refreshAll().catch(err);
  }
});

// Живая статистика (не чаще раза в секунду и только при изменении): панель
// ведёт числа, когда открыта; закрытой — берём последний снапшот при рендере.
void listen<VpnStats>(bridge.events.vpnStats, (e) => {
  stats = e.payload;
  if (!panel.hidden) renderStats();
});

// Маршрутные решения сеанса: первый маршрут домена и его смены (дедуп в
// роутере) — панель показывает, как правила ложатся на живые соединения.
void listen<{ domain: string; route: string }>(bridge.events.vpnRouteChanged, (e) => {
  sessionRoutes = noteRoute(sessionRoutes, e.payload.domain, e.payload.route);
  if (!panel.hidden) renderRoutes();
});

// --- открытие/закрытие (единое «одно меню на экран», mainmenu.ts) -------------

btn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = panel.hidden;
  if (open) {
    for (const id of ["mainMenu", "tabMenu", "proxyMenu", "duoPanel"]) {
      const node = document.getElementById(id);
      if (node) node.hidden = true;
    }
  }
  panel.hidden = !open;
  if (!panel.hidden) void refreshAll().catch((e2) => flashDetail(String(e2)));
});

document.addEventListener("click", (e) => {
  if (!panel.hidden && !(e.target as HTMLElement).closest("#vpnPanel, #vpnBtn")) {
    panel.hidden = true;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !panel.hidden) panel.hidden = true;
});
