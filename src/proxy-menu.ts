// DuoPulse — меню «Прокси» (задача 1.8, VPN-инкремент A, карточка duopulse-009).
// Настройки внешнего прокси SOCKS5/HTTP(S) хранятся в Rust (settings.json +
// пароль в DPAPI), применяются аргументами окружения WebView2 — после
// перезапуска, который предлагается явно.
import { invoke } from "@tauri-apps/api/core";

interface ProxySettings {
  enabled: boolean;
  proto: "socks5" | "http" | "https";
  host: string;
  port: number;
  login: string | null;
  hasPassword: boolean;
}

interface ProxyStatus {
  state: "off" | "on" | "error";
  detail: string;
}

// Поля, влияющие на аргументы WebView2: их смена требует перезапуска
// (login читается обработчиком аутентификации на лету — перезапуска не требует).
interface ProxyArgs {
  enabled: boolean;
  proto: string;
  host: string;
  port: number;
}

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
const restartBlock = $("proxyRestartBlock");

let appliedArgs: ProxyArgs | null = null; // конфиг на старте приложения

function readForm(): ProxySettings {
  return {
    enabled: enabledEl.checked,
    proto: protoEl.value as ProxySettings["proto"],
    host: hostEl.value.trim(),
    port: parseInt(portEl.value, 10) || 0,
    login: loginEl.value.trim() || null,
    hasPassword: false, // заполняется в refresh()
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
  const s = await invoke<ProxySettings>("proxy_get");
  fillForm(s);
  if (appliedArgs === null) {
    appliedArgs = { enabled: s.enabled, proto: s.proto, host: s.host, port: s.port };
  }
  return s;
}

function argsOf(s: { enabled: boolean; proto: string; host: string; port: number }): ProxyArgs {
  return { enabled: s.enabled, proto: s.proto, host: s.host, port: s.port };
}

async function refreshStatus(): Promise<void> {
  const st = await invoke<ProxyStatus>("proxy_status");
  statusEl.dataset.state = st.state;
  statusEl.querySelector<HTMLElement>(".state")!.textContent =
    st.state === "on" ? "ВКЛ" : st.state === "error" ? "ОШИБКА" : "ВЫКЛ";
  statusDetailEl.textContent = st.detail;
  statusDetailEl.title = st.detail;
}

/** Сохранить конфиг; при успехе — обновить форму/статус и предложение перезапуска. */
async function save(password: string | null): Promise<boolean> {
  const cfg = readForm();
  if (cfg.enabled && (!cfg.host || cfg.port < 1 || cfg.port > 65535)) {
    showError("Заполните адрес и порт (1–65535).");
    return false;
  }
  try {
    await invoke("proxy_save", { cfg, password });
  } catch (e) {
    showError(String(e));
    return false;
  }
  showError(null);
  const saved = await refresh();
  const needsRestart = JSON.stringify(argsOf(saved)) !== JSON.stringify(appliedArgs);
  restartBlock.hidden = !needsRestart;
  await refreshStatus();
  return true;
}

// --- события меню -----------------------------------------------------------

btn.addEventListener("click", async (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
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

// Тумблер — быстрое вкл/выкл с немедленным сохранением.
enabledEl.addEventListener("change", async () => {
  const on = enabledEl.checked;
  if (!(await save(null))) {
    // не сохранилось (например, адрес не заполнен) — откатываем тумблер
    enabledEl.checked = !on;
  }
});

$("proxySave").addEventListener("click", () => {
  const password = passwordEl.value === "" ? null : passwordEl.value;
  void save(password);
});

$("proxyCheck").addEventListener("click", () => {
  void refreshStatus().catch((e) => showError(String(e)));
});

$("proxyRestart").addEventListener("click", () => {
  void invoke("proxy_restart").catch(console.error);
});

// Пароль сохранён только в DPAPI: «удалить» стирает blob, поле оставляет как есть.
passClearEl.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (await save("")) passwordEl.placeholder = "пароль";
});

// Проверка IP-эхом: страница грузится в content-webview, т.е. через прокси.
$("proxyIpEcho").addEventListener("click", () => {
  void invoke("navigate", { url: IP_ECHO_URL }).catch(console.error);
  menu.hidden = true;
});
