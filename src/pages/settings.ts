// DuoPulse — страница «Настройки» (задача 5.1, docs/05 §1 src/pages/Settings).
// Открывается вкладкой duopulse://settings (webview page-settings-N, роутер —
// src/main.ts; пункт главного меню). Разделы карточки 5.1: внешний вид
// (тема — тёмная v1, F-10), поиск (поисковик omnibox), субтитры по умолчанию
// (язык перевода дефолт-набора Alt+D + стиль плашки новых вкладок), перевод
// (конфиг + ключ DPAPI), прокси/VPN, приватность (очистка при выходе, кэш),
// перенос профиля одним файлом (экспорт/импорт; секреты — по явному выбору
// с предупреждением: в файле открытым текстом).
//
// Данные — settings.get_all / settings.apply (контракт v6); прокси — та же
// форма, что в меню навбара (settings.set + vpn.test_connection, пароль —
// DPAPI); экспорт/импорт — settings.export / settings.import (пути — нативные
// диалоги tauri-plugin-dialog). Стиль — гайд 06: сине-чёрные поверхности,
// неон — акценты; секции по образцу страницы «Диагностика».
import { invoke } from "@tauri-apps/api/core";
import { bridge } from "../bridge";
import type { SettingsAll } from "../bridge/gen/types";

const err = (e: unknown): void => console.error("settings-page:", e);

/** Стиль-патч субтитров из формы (числа — с клампами content-слоя в Core). */
interface SubtitlesForm {
  lang: string;
  fontScalePct: number;
  position: string;
  marginPct: number;
  plateOpacity: number;
}

const el = (tag: string, cls?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

/** Строка «поле с подписью» (label + контрол формы). */
function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrap = el("label", "set-field");
  const name = el("span", "set-field-name");
  name.textContent = label;
  wrap.append(name, control);
  if (hint) {
    const h = el("span", "set-hint");
    h.textContent = hint;
    wrap.append(h);
  }
  return wrap;
}

/** Секция-карточка с заголовком. */
function section(title: string, note?: string): { root: HTMLElement; body: HTMLElement } {
  const root = el("section", "set-section");
  const head = el("h2", "set-section-title");
  head.textContent = title;
  root.append(head);
  if (note) {
    const n = el("div", "set-note");
    n.textContent = note;
    root.append(n);
  }
  const body = el("div", "set-section-body");
  root.append(body);
  return { root, body };
}

const pct = (v: number): string => `${Math.round(v)}%`;

export function initSettingsPage(): void {
  document.title = "Настройки — DuoPulse";
  document.body.classList.add("internal-page");
  document.getElementById("app")?.remove();

  const root = el("div", "set");
  root.dataset.page = "settings";

  const head = el("header", "diag-head");
  const logo = el("div", "mgr-logo");
  logo.textContent = "Duo";
  const pulse = el("span");
  pulse.textContent = "Pulse";
  logo.append(pulse);
  const title = el("h1", "mgr-title");
  title.textContent = "Настройки";
  head.append(logo, title);
  root.append(head);
  document.body.append(root);

  // --- 1. Внешний вид ---------------------------------------------------------
  const appearance = section("Внешний вид");
  const themeSel = document.createElement("select");
  const darkOpt = document.createElement("option");
  darkOpt.value = "dark";
  darkOpt.textContent = "Тёмная (фирменная)";
  darkOpt.selected = true;
  themeSel.append(darkOpt);
  const lightOpt = document.createElement("option");
  lightOpt.value = "light";
  lightOpt.textContent = "Светлая — в разработке";
  lightOpt.disabled = true;
  themeSel.append(lightOpt);
  appearance.body.append(
    field("Тема", themeSel, "v1 — тёмная фирменная (docs/01 F-10); светлая — позже"),
  );

  // --- 2. Поиск ---------------------------------------------------------------
  const search = section("Поиск", "Поисковый запрос в адресной строке уходит выбранной системе.");
  const engineSel = document.createElement("select");
  const searchStatus = el("div", "set-status");
  /** Заполнение один раз (повторные reload — например после импорта — только
   *  выставляют выбранное значение). */
  let enginesFilled = false;
  engineSel.addEventListener("change", () => {
    void bridge.settings
      .apply({ search: { engine: engineSel.value as SettingsAll["search"]["engine"] } })
      .then(() => (searchStatus.textContent = "Сохранено."))
      .catch((e) => (searchStatus.textContent = String(e)));
  });
  search.body.append(field("Поисковик по умолчанию", engineSel), searchStatus);

  // --- 3. Субтитры ------------------------------------------------------------
  const subs = section(
    "Субтитры",
    "Применяются к новым вкладкам: Alt+D на свежем видео собирает «оригинал + выбранный язык», плашка — в заданном стиле.",
  );
  const langInput = document.createElement("input");
  langInput.type = "text";
  langInput.placeholder = "ru";
  langInput.spellcheck = false;
  langInput.maxLength = 8;
  langInput.className = "set-lang";
  const scale = document.createElement("input");
  scale.type = "range";
  scale.min = "75";
  scale.max = "300";
  scale.step = "5";
  const scaleVal = el("span", "set-range-val");
  scale.addEventListener("input", () => (scaleVal.textContent = pct(Number(scale.value))));
  const margin = document.createElement("input");
  margin.type = "range";
  margin.min = "0";
  margin.max = "25";
  margin.step = "1";
  const marginVal = el("span", "set-range-val");
  margin.addEventListener("input", () => (marginVal.textContent = pct(Number(margin.value))));
  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0.2";
  opacity.max = "1";
  opacity.step = "0.05";
  const opacityVal = el("span", "set-range-val");
  opacity.addEventListener("input", () => (opacityVal.textContent = pct(Number(opacity.value) * 100)));
  const posSeg = el("div", "set-seg");
  const posBottom = document.createElement("button");
  posBottom.type = "button";
  posBottom.textContent = "Низ";
  const posTop = document.createElement("button");
  posTop.type = "button";
  posTop.textContent = "Верх";
  posSeg.append(posBottom, posTop);
  const segSet = (pos: string): void => {
    posBottom.classList.toggle("on", pos !== "top");
    posTop.classList.toggle("on", pos === "top");
  };
  posBottom.addEventListener("click", () => segSet("bottom"));
  posTop.addEventListener("click", () => segSet("top"));

  const subsStatus = el("div", "set-status");
  const subsSave = document.createElement("button");
  subsSave.type = "button";
  subsSave.className = "primary";
  subsSave.textContent = "Сохранить";
  subs.body.append(
    field("Язык перевода по умолчанию", langInput, "код из 2–3 букв (ru, es, pt-br)"),
    field("Размер плашки", scale),
    field("Позиция плашки", posSeg),
    field("Отступ от края видео", margin),
    field("Непрозрачность подложки", opacity),
  );
  const subsRow = el("div", "set-row");
  subsRow.append(subsSave, subsStatus);
  subs.body.append(subsRow);
  scale.parentElement?.append(scaleVal);
  margin.parentElement?.append(marginVal);
  opacity.parentElement?.append(opacityVal);

  const subsForm = (): SubtitlesForm => ({
    lang: langInput.value.trim(),
    fontScalePct: Number(scale.value),
    position: posTop.classList.contains("on") ? "top" : "bottom",
    marginPct: Number(margin.value),
    plateOpacity: Number(opacity.value),
  });
  subsSave.addEventListener("click", () => {
    const form = subsForm();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(form.lang)) {
      subsStatus.textContent = "Язык — код из 2–3 букв (ru, es, pt-br).";
      return;
    }
    bridge.settings
      .apply({
        subtitles: {
          defaultTranslationLang: form.lang,
          style: {
            fontScalePct: form.fontScalePct,
            position: form.position,
            marginPct: form.marginPct,
            plateOpacity: form.plateOpacity,
          },
        },
      })
      .then(() => {
        subsStatus.textContent = "Сохранено — новые вкладки подхватят.";
      })
      .catch((e) => (subsStatus.textContent = String(e)));
  });

  // --- 4. Перевод -------------------------------------------------------------
  const tr = section(
    "Перевод",
    "Облачный перевод дорожек субтитров; ключ хранится в DPAPI (не в settings.json).",
  );
  const trProvider = document.createElement("select");
  for (const [value, text] of [
    ["deepl", "DeepL"],
    ["google", "Google Translate"],
    ["libretranslate", "LibreTranslate"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    trProvider.append(opt);
  }
  const trEnabled = document.createElement("input");
  trEnabled.type = "checkbox";
  const trEnabledLabel = el("label", "set-check");
  trEnabledLabel.append(trEnabled, Object.assign(el("span"), { textContent: " Разрешить облачный перевод" }));
  const trPlan = document.createElement("select");
  const planFree = document.createElement("option");
  planFree.value = "free";
  planFree.textContent = "Free (api-free.deepl.com)";
  const planPro = document.createElement("option");
  planPro.value = "pro";
  planPro.textContent = "Pro (api.deepl.com)";
  trPlan.append(planFree, planPro);
  const trPlanField = field("Тариф DeepL", trPlan);
  const trUrl = document.createElement("input");
  trUrl.type = "text";
  trUrl.placeholder = "http://localhost:5000";
  trUrl.spellcheck = false;
  const trUrlField = field("Адрес LibreTranslate", trUrl);
  const trKey = document.createElement("input");
  trKey.type = "password";
  trKey.autocomplete = "new-password";
  trKey.placeholder = "ключ";
  const trKeyClear = document.createElement("button");
  trKeyClear.type = "button";
  trKeyClear.className = "link";
  trKeyClear.textContent = "удалить";
  const trKeyField = field("Ключ API", trKey);
  trKeyField.querySelector(".set-field-name")?.append(trKeyClear);
  const trStatus = el("div", "set-status");
  const trSave = document.createElement("button");
  trSave.type = "button";
  trSave.className = "primary";
  trSave.textContent = "Сохранить";
  const trTest = document.createElement("button");
  trTest.type = "button";
  trTest.className = "ghost";
  trTest.textContent = "Проверить";
  const trRow = el("div", "set-row");
  trRow.append(trSave, trTest, trStatus);
  tr.body.append(trEnabledLabel, field("Провайдер", trProvider), trPlanField, trUrlField, trKeyField, trRow);
  const trPlanUrlVis = (): void => {
    trPlanField.hidden = trProvider.value !== "deepl";
    trUrlField.hidden = trProvider.value !== "libretranslate";
    const has = trKeySaved.has(trProvider.value as "deepl" | "google" | "libretranslate");
    trKeyClear.hidden = !has;
    trKey.placeholder = has ? "сохранён — пусто = не менять" : "ключ";
  };
  trProvider.addEventListener("change", trPlanUrlVis);
  const trKeySaved = new Set<string>();

  const trForm = () => ({
    value: {
      enabled: trEnabled.checked,
      provider: trProvider.value as "deepl" | "google" | "libretranslate",
      deeplPlan: trPlan.value as "free" | "pro",
      libretranslateUrl: trUrl.value.trim(),
    },
    secret: trKey.value === "" ? undefined : trKey.value,
  });
  const trApply = async (): Promise<boolean> => {
    const { value, secret } = trForm();
    try {
      await bridge.translate.setSettings({ value, secret });
    } catch (e) {
      trStatus.textContent = String(e);
      return false;
    }
    trKey.value = "";
    await loadTranslate();
    return true;
  };
  trSave.addEventListener("click", () => {
    void trApply().then((ok) => {
      if (ok) trStatus.textContent = "Сохранено.";
    });
  });
  trTest.addEventListener("click", () => {
    trStatus.textContent = "Проверяю…";
    void trApply().then((ok) => {
      if (!ok) return;
      void bridge.translate
        .test({ text: null, targetLang: null })
        .then((res) => {
          trStatus.textContent = res.ok ? `Провайдер отвечает: «${res.translated ?? ""}»` : res.detail;
        })
        .catch((e) => (trStatus.textContent = String(e)));
    });
  });
  trKeyClear.addEventListener("click", (e) => {
    e.preventDefault();
    const provider = trProvider.value as "deepl" | "google" | "libretranslate";
    void bridge.translate
      .setSettings({ value: { ...trForm().value }, secret: "" })
      .then(() => {
        trKeySaved.delete(provider);
        trPlanUrlVis();
        trStatus.textContent = "Ключ удалён.";
      })
      .catch((e2) => (trStatus.textContent = String(e2)));
  });

  // --- 5. Прокси / VPN --------------------------------------------------------
  const proxy = section(
    "Прокси / VPN",
    "Внешний прокси SOCKS5/HTTP(S); применяется аргументами WebView2 — после перезапуска. Пароль — в DPAPI.",
  );
  const proxyEnabled = document.createElement("input");
  proxyEnabled.type = "checkbox";
  const proxyEnabledLabel = el("label", "set-check");
  proxyEnabledLabel.append(proxyEnabled, Object.assign(el("span"), { textContent: " Ходить через прокси" }));
  const proxyProto = document.createElement("select");
  for (const [value, text] of [
    ["socks5", "SOCKS5"],
    ["http", "HTTP"],
    ["https", "HTTPS"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    proxyProto.append(opt);
  }
  const proxyHost = document.createElement("input");
  proxyHost.type = "text";
  proxyHost.placeholder = "127.0.0.1";
  proxyHost.spellcheck = false;
  const proxyPort = document.createElement("input");
  proxyPort.type = "number";
  proxyPort.min = "1";
  proxyPort.max = "65535";
  const proxyLogin = document.createElement("input");
  proxyLogin.type = "text";
  proxyLogin.placeholder = "не обязательно";
  proxyLogin.spellcheck = false;
  const proxyPassword = document.createElement("input");
  proxyPassword.type = "password";
  proxyPassword.autocomplete = "new-password";
  const proxyPassClear = document.createElement("button");
  proxyPassClear.type = "button";
  proxyPassClear.className = "link";
  proxyPassClear.textContent = "удалить";
  const proxyPassField = field("Пароль", proxyPassword);
  proxyPassField.querySelector(".set-field-name")?.append(proxyPassClear);
  const proxyStatus = el("div", "set-status");
  const proxySave = document.createElement("button");
  proxySave.type = "button";
  proxySave.className = "primary";
  proxySave.textContent = "Сохранить";
  const proxyCheck = document.createElement("button");
  proxyCheck.type = "button";
  proxyCheck.className = "ghost";
  proxyCheck.textContent = "Проверить";
  const proxyRow = el("div", "set-row");
  proxyRow.append(proxySave, proxyCheck, proxyStatus);
  const proxyRestartBlock = el("div", "set-restart");
  proxyRestartBlock.hidden = true;
  const proxyRestartNote = el("span");
  proxyRestartNote.textContent = "Применяется после перезапуска браузера.";
  const proxyRestart = document.createElement("button");
  proxyRestart.type = "button";
  proxyRestart.className = "primary";
  proxyRestart.textContent = "Перезапустить сейчас";
  proxyRestartBlock.append(proxyRestartNote, proxyRestart);
  proxy.body.append(
    proxyEnabledLabel,
    field("Тип", proxyProto),
    field("Адрес", proxyHost),
    field("Порт", proxyPort),
    field("Логин", proxyLogin),
    proxyPassField,
    proxyRow,
    proxyRestartBlock,
  );
  /** Стартовые аргументы приложения: их смена требует перезапуска. */
  let appliedProxy: string | null = null;
  const proxyArgsOf = (s: { enabled: boolean; proto: string; host: string; port: number }): string =>
    JSON.stringify([s.enabled, s.proto, s.host, s.port]);
  const proxySaveForm = async (): Promise<boolean> => {
    const port = parseInt(proxyPort.value, 10) || 0;
    const cfg = {
      enabled: proxyEnabled.checked,
      proto: proxyProto.value as "socks5" | "http" | "https",
      host: proxyHost.value.trim(),
      port,
      login: proxyLogin.value.trim() || null,
    };
    if (cfg.enabled && (!cfg.host || port < 1 || port > 65535)) {
      proxyStatus.textContent = "Заполните адрес и порт (1–65535).";
      return false;
    }
    try {
      await bridge.settings.set({
        key: "proxy",
        value: cfg,
        secret: proxyPassword.value === "" ? undefined : proxyPassword.value,
      });
    } catch (e) {
      proxyStatus.textContent = String(e);
      return false;
    }
    proxyPassword.value = "";
    await loadProxy();
    return true;
  };
  proxySave.addEventListener("click", () => {
    void proxySaveForm().then((ok) => {
      if (ok) proxyStatus.textContent = "Сохранено.";
    });
  });
  proxyCheck.addEventListener("click", () => {
    proxyStatus.textContent = "Проверяю…";
    void bridge.vpn
      .testConnection()
      .then((st) => {
        proxyStatus.textContent = `${st.state === "on" ? "ВКЛ" : st.state === "error" ? "ОШИБКА" : "ВЫКЛ"} — ${st.detail}`;
      })
      .catch((e) => (proxyStatus.textContent = String(e)));
  });
  proxyPassClear.addEventListener("click", (e) => {
    e.preventDefault();
    const port = parseInt(proxyPort.value, 10) || 0;
    void bridge.settings
      .set({
        key: "proxy",
        value: {
          enabled: proxyEnabled.checked,
          proto: proxyProto.value as "socks5" | "http" | "https",
          host: proxyHost.value.trim(),
          port,
          login: proxyLogin.value.trim() || null,
        },
        secret: "",
      })
      .then(() => loadProxy())
      .catch((e2) => (proxyStatus.textContent = String(e2)));
  });
  proxyRestart.addEventListener("click", () => {
    void bridge.app.restart().catch(err);
  });

  // --- 6. Приватность ---------------------------------------------------------
  const privacy = section("Приватность", "Данные хранятся локально в профиле браузера.");
  const clearHist = document.createElement("input");
  clearHist.type = "checkbox";
  const clearHistLabel = el("label", "set-check");
  clearHistLabel.append(clearHist, Object.assign(el("span"), { textContent: " Очищать историю при выходе" }));
  clearHist.addEventListener("change", () => {
    void bridge.settings
      .apply({ privacy: { clearHistoryOnExit: clearHist.checked } })
      .catch((e) => (privacyStatus.textContent = String(e)));
  });
  const privacyStatus = el("div", "set-status");
  const clearHistNow = document.createElement("button");
  clearHistNow.type = "button";
  clearHistNow.className = "ghost";
  clearHistNow.textContent = "Очистить историю сейчас";
  clearHistNow.addEventListener("click", () => {
    if (!window.confirm("Удалить всю историю посещений? Закладки останутся.")) return;
    void bridge.history
      .deleteRange({ fromMs: 0, toMs: 4102444800000 })
      .then(() => (privacyStatus.textContent = "История очищена."))
      .catch((e) => (privacyStatus.textContent = String(e)));
  });
  const clearCache = document.createElement("button");
  clearCache.type = "button";
  clearCache.className = "ghost";
  clearCache.textContent = "Очистить кэш переводов";
  clearCache.addEventListener("click", () => {
    void bridge.translate
      .clearCache()
      .then((res) => (privacyStatus.textContent = `Кэш очищен (${res.cleared} дорожек).`))
      .catch((e) => (privacyStatus.textContent = String(e)));
  });
  const privacyRow = el("div", "set-row");
  privacyRow.append(clearHistNow, clearCache, privacyStatus);
  privacy.body.append(clearHistLabel, privacyRow);

  // --- 7. Профиль: экспорт/импорт одним файлом --------------------------------
  const profile = section(
    "Профиль",
    "Переезд на другую машину одним файлом: настройки, закладки, история, кэш переводов.",
  );
  const withSecrets = document.createElement("input");
  withSecrets.type = "checkbox";
  const secretsLabel = el("label", "set-check set-secrets");
  secretsLabel.append(withSecrets, Object.assign(el("span"), { textContent: " Включить секреты (пароль прокси, ключи API)" }));
  const secretsWarn = el("div", "set-warn");
  secretsWarn.hidden = true;
  secretsWarn.textContent =
    "Секреты попадут в файл ОТКРЫТЫМ текстом. Храните файл аккуратно и удаляйте после переноса.";
  withSecrets.addEventListener("change", () => (secretsWarn.hidden = !withSecrets.checked));
  const profileStatus = el("div", "set-status");
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "primary";
  exportBtn.textContent = "Экспорт в файл…";
  exportBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const path = await invoke<string | null>("plugin:dialog|save", {
          options: {
            title: "Экспорт профиля DuoPulse",
            defaultPath: "duopulse-profile.json",
            filters: [{ name: "Профиль DuoPulse", extensions: ["json"] }],
          },
        });
        if (!path) return;
        const res = await bridge.settings.export({ path, includeSecrets: withSecrets.checked });
        const c = res.counts ?? {};
        profileStatus.textContent =
          `Экспортировано: ${c.settingsSections ?? 0} разд. настроек, ` +
          `${c.bookmarks ?? 0} закл., ${c.visits ?? 0} визитов, ` +
          `${c.translatedTracks ?? 0} дорожек кэша` +
          ((c.secrets ?? 0) > 0 ? `, ${c.secrets} секретов` : "") +
          ` — ${((res.bytes ?? 0) / 1024).toFixed(0)} КБ`;
      } catch (e) {
        profileStatus.textContent = String(e);
      }
    })();
  });
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "ghost";
  importBtn.textContent = "Импорт из файла…";
  importBtn.addEventListener("click", () => {
    void (async () => {
      try {
        const path = await invoke<string | null>("plugin:dialog|open", {
          options: {
            title: "Импорт профиля DuoPulse",
            multiple: false,
            filters: [{ name: "Профиль DuoPulse", extensions: ["json"] }],
          },
        });
        if (!path) return;
        const res = await bridge.settings.import({ path });
        const c = res.counts ?? {};
        profileStatus.textContent =
          `Импортировано: ${c.settingsSections ?? 0} разд. настроек, ` +
          `${c.bookmarks ?? 0} закл., ${c.visits ?? 0} визитов, ` +
          `${c.translatedTracks ?? 0} дорожек кэша` +
          ((c.secrets ?? 0) > 0 ? `, ${c.secrets} секретов` : "");
        if (res.needsRestart) proxyRestartBlock.hidden = false;
        await reload();
      } catch (e) {
        profileStatus.textContent = String(e);
      }
    })();
  });
  const profileRow = el("div", "set-row");
  profileRow.append(exportBtn, importBtn, profileStatus);
  profile.body.append(secretsLabel, secretsWarn, profileRow);

  root.append(appearance.root, search.root, subs.root, tr.root, proxy.root, privacy.root, profile.root);

  // --- загрузка ---------------------------------------------------------------

  const loadTranslate = async (): Promise<void> => {
    const st = await bridge.translate.getSettings();
    trEnabled.checked = st.enabled;
    trProvider.value = st.provider;
    trPlan.value = st.deeplPlan;
    trUrl.value = st.libretranslateUrl;
    trKeySaved.clear();
    for (const p of st.hasApiKeys) trKeySaved.add(p);
    trPlanUrlVis();
  };

  const loadProxy = async (): Promise<void> => {
    const s = await bridge.settings.get({ key: "proxy" });
    proxyEnabled.checked = s.enabled;
    proxyProto.value = s.proto;
    proxyHost.value = s.host;
    proxyPort.value = String(s.port || "");
    proxyLogin.value = s.login ?? "";
    proxyPassword.value = "";
    proxyPassword.placeholder = s.hasPassword ? "сохранён — пусто = не менять" : "пароль";
    proxyPassClear.hidden = !s.hasPassword;
    if (appliedProxy === null) appliedProxy = proxyArgsOf(s);
    proxyRestartBlock.hidden = proxyArgsOf(s) === appliedProxy;
  };

  const reload = async (): Promise<void> => {
    try {
      const all: SettingsAll = await bridge.settings.getAll();
      if (!enginesFilled) {
        for (const engine of all.engines) {
          const opt = document.createElement("option");
          opt.value = engine.id;
          opt.textContent = engine.title;
          engineSel.append(opt);
        }
        enginesFilled = true;
      }
      engineSel.value = all.search.engine ?? "youtube";
      // serde-default поля опциональны в TS-схеме — дефолты разделов
      const st = all.subtitles.style ?? {};
      langInput.value = all.subtitles.defaultTranslationLang ?? "ru";
      scale.value = String(st.fontScalePct ?? 100);
      scaleVal.textContent = pct(st.fontScalePct ?? 100);
      segSet(st.position ?? "bottom");
      margin.value = String(st.marginPct ?? 6);
      marginVal.textContent = pct(st.marginPct ?? 6);
      opacity.value = String(st.plateOpacity ?? 0.78);
      opacityVal.textContent = pct((st.plateOpacity ?? 0.78) * 100);
      clearHist.checked = all.privacy.clearHistoryOnExit ?? false;
      subsStatus.textContent = "";
    } catch (e) {
      err(e);
    }
    await loadTranslate().catch(err);
    await loadProxy().catch(err);
  };

  void reload();
}

// модуль импортируется роутером src/main.ts — стартуем сразу
initSettingsPage();
