// DuoPulse — меню «Прокси» (задача 1.8, VPN-инкремент A, карточка duopulse-009;
// задача 1.1 — переведено на контракт bridge; задача 6.1 — миграция на роутер).
// Настройки внешнего прокси SOCKS5/HTTP(S) ходят в Core командами словаря
// (settings.get/set, vpn.set_enabled/status/test_connection — docs/05 §2):
// хранятся в Rust (settings.json + пароль в DPAPI). Применение — мгновенное:
// WebView2 постоянно направлен на локальный SOCKS5-роутер Core, режим
// переключает роутер, перезапуск не нужен (docs/02 §6.1, карточка duopulse-037).
// Карточка duopulse-090: форма живёт в popup-окне над webview (panel-window.ts)
// — инпуты/селект доступны на любой вкладке; открытие — кнопка навбара.
import { bridge } from "./bridge";
import type { ProxyConfig, ProxySettings, VpnStatusResult } from "./bridge";
import { anchorPanel, closePanel, currentPanel, openPanel, panelKind } from "./chrome/panel-window";

const IP_ECHO_URL = "https://api.ipify.org/";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = $("proxyBtn");
const menu = $("proxyMenu");
const enabledEl = $<HTMLInputElement>("proxyEnabled");
const protoEl = $<HTMLSelectElement>("proxyProto");
const hostEl = $<HTMLInputElement>("proxyHost");
const portEl = $<HTMLInputElement>("proxyPort");
const loginEl = $<HTMLInputElement>("proxyLogin");
const passwordEl = $<HTMLInputElement>("proxyPassword");
const passClearEl = $("proxyPassClear");
const statusEl = $("proxyStatus");
const statusDetailEl = $("proxyStatusDetail");
const errorEl = $("proxyError");

/** Конфиг из формы + порт отдельным числом (в схеме ProxyConfig.port опционален). */
function readConfig(): { cfg: ProxyConfig; port: number } {
  const port = parseInt(portEl.value, 10) || 0;
  return {
    port,
    cfg: {
      enabled: enabledEl.checked,
      proto: protoEl.value as ProxyConfig["proto"],
      host: hostEl.value.trim(),
      port,
      login: loginEl.value.trim() || null,
    },
  };
}

function fillForm(s: ProxySettings): void {
  enabledEl.checked = s.enabled;
  protoEl.value = s.proto;
  hostEl.value = s.host;
  portEl.value = String(s.port || "");
  loginEl.value = s.login ?? "";
  passwordEl.value = "";
  passwordEl.placeholder = s.hasPassword ? "сохранён — пусто = не менять" : "пароль";
  passClearEl.hidden = !s.hasPassword;
}

function showError(message: string | null): void {
  errorEl.textContent = message ?? "";
  errorEl.hidden = !message;
}

async function refresh(): Promise<ProxySettings> {
  const s = await bridge.settings.get({ key: "proxy" });
  fillForm(s);
  return s;
}

/** После сохранения: форма/статус по свежим данным (роутер уже применил режим). */
async function afterSave(): Promise<void> {
  await refresh();
  await refreshStatus();
}

async function refreshStatus(st?: VpnStatusResult): Promise<void> {
  const s = st ?? (await bridge.vpn.status());
  statusEl.dataset.state = s.state;
  statusEl.querySelector<HTMLElement>(".state")!.textContent =
    s.state === "on" ? "ВКЛ" : s.state === "error" ? "ОШИБКА" : "ВЫКЛ";
  statusDetailEl.textContent = s.detail;
  statusDetailEl.title = s.detail;
}

/** Сохранить конфиг формы (settings.set); при успехе — обновить форму/статус. */
async function save(secret: string | null): Promise<boolean> {
  const { cfg, port } = readConfig();
  if (cfg.enabled && (!cfg.host || port < 1 || port > 65535)) {
    showError("Заполните адрес и порт (1–65535).");
    return false;
  }
  try {
    await bridge.settings.set({ key: "proxy", value: cfg, secret: secret ?? undefined });
  } catch (e) {
    showError(String(e));
    return false;
  }
  showError(null);
  await afterSave();
  return true;
}

// --- события меню -----------------------------------------------------------

btn.addEventListener("click", (e) => {
  e.stopPropagation();
  // тумблер: открыто — закрыть; новое окно сносит старую панель (Core)
  if (currentPanel() === "proxy") {
    closePanel();
    return;
  }
  const g = anchorPanel("proxy", btn, "right");
  openPanel("proxy", g.x, g.y, g.w, g.h);
});

/** Открытие в панельном окне (panel-boot): показать форму, снапшот + статус. */
export async function openProxyPanel(): Promise<void> {
  menu.hidden = false;
  showError(null);
  try {
    await refresh();
  } catch (e) {
    showError(String(e));
  }
  await refreshStatus().catch(() => {});
}

// Тумблер — быстрое вкл/выкл (vpn.set_enabled: сохранённый конфиг + новый флаг),
// форма при этом не сохраняется — только кнопкой «Сохранить» (settings.set).
enabledEl.addEventListener("change", async () => {
  const on = enabledEl.checked;
  try {
    await bridge.vpn.setEnabled({ on });
  } catch (e) {
    showError(String(e));
    enabledEl.checked = !on; // не включилось (например, адрес не сохранён) — откат
    return;
  }
  showError(null);
  await afterSave();
});

$("proxySave").addEventListener("click", () => {
  const password = passwordEl.value === "" ? null : passwordEl.value;
  void save(password);
});

$("proxyCheck").addEventListener("click", () => {
  void bridge.vpn
    .testConnection()
    .then((st) => refreshStatus(st))
    .catch((e) => showError(String(e)));
});

// Пароль сохранён только в DPAPI: «удалить» стирает blob, поле оставляет как есть.
passClearEl.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (await save("")) passwordEl.placeholder = "пароль";
});

// Проверка IP-эхом: страница грузится в content-webview, т.е. через прокси.
$("proxyIpEcho").addEventListener("click", () => {
  void bridge.nav.navigate({ url: IP_ECHO_URL }).catch(console.error);
  menu.hidden = true;
  if (panelKind()) closePanel();
});
