// DuoPulse — меню «Прокси» (задача 1.8, VPN-инкремент A, карточка duopulse-009;
// задача 1.1 — переведено на контракт bridge).
// Настройки внешнего прокси SOCKS5/HTTP(S) ходят в Core командами словаря
// (settings.get/set, vpn.set_enabled/status/test_connection, app.restart —
// docs/05 §2): хранятся в Rust (settings.json + пароль в DPAPI), применяются
// аргументами окружения WebView2 — после перезапуска, который предлагается явно.
import { bridge } from "./bridge";
import type { ProxyConfig, ProxySettings, VpnStatusResult } from "./bridge";

const IP_ECHO_URL = "https://api.ipify.org/";

// Поля, влияющие на аргументы WebView2: их смена требует перезапуска
// (login читается обработчиком аутентификации на лету — перезапуска не требует).
interface ProxyArgs {
  enabled: boolean;
  proto: string;
  host: string;
  port: number;
}

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
const restartBlock = $("proxyRestartBlock");

let appliedArgs: ProxyArgs | null = null; // конфиг на старте приложения

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
  if (appliedArgs === null) {
    appliedArgs = { enabled: s.enabled, proto: s.proto, host: s.host, port: s.port };
  }
  return s;
}

function argsOf(s: { enabled: boolean; proto: string; host: string; port: number }): ProxyArgs {
  return { enabled: s.enabled, proto: s.proto, host: s.host, port: s.port };
}

/** Показать предложение перезапуска, если сохранённый конфиг отличается от стартового. */
async function afterSave(): Promise<void> {
  const saved = await refresh();
  restartBlock.hidden = JSON.stringify(argsOf(saved)) === JSON.stringify(appliedArgs);
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

btn.addEventListener("click", async (e) => {
  e.stopPropagation();
  const open = menu.hidden;
  if (open) {
    // прочие панели хрома закрываются (единое «одно меню на экран», mainmenu.ts)
    const mainMenu = document.getElementById("mainMenu") as HTMLElement | null;
    const tabMenu = document.getElementById("tabMenu") as HTMLElement | null;
    if (mainMenu) mainMenu.hidden = true;
    if (tabMenu) tabMenu.hidden = true;
  }
  menu.hidden = !open;
  if (!menu.hidden) {
    showError(null);
    try {
      await refresh();
    } catch (e) {
      showError(String(e));
    }
    await refreshStatus().catch(() => {});
  }
});

document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menu.hidden) menu.hidden = true;
});

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

$("proxyRestart").addEventListener("click", () => {
  void bridge.app.restart().catch(console.error);
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
});
