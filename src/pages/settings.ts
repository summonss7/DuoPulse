// DuoPulse — страница «Настройки» (задача 5.1, docs/05 §1 src/pages/Settings).
// Открывается вкладкой duopulse://settings (webview page-settings-N, роутер —
// src/main.ts; пункт главного меню). Разделы карточки 5.1: внешний вид
// (тема — тёмная v1, F-10), поиск (поисковик omnibox), субтитры по умолчанию
// (язык перевода дефолт-набора Alt+D + стиль плашки новых вкладок), перевод
// перевод дорожек субтитров (конфиг + ключ DPAPI), прокси/VPN (внешний прокси —
// форма из меню навбара; режим WireGuard и split-правила — задача 6.3),
// приватность (очистка при выходе, кэш),
// перенос профиля одним файлом (экспорт/импорт; секреты — по явному выбору
// с предупреждением: в файле открытым текстом).
//
// Данные — settings.get_all / settings.apply (контракт v6); прокси — та же
// форма, что в меню навбара (settings.set + vpn.test_connection, пароль —
// DPAPI); экспорт/импорт — settings.export / settings.import (пути — нативные
// диалоги tauri-plugin-dialog). Стиль — гайд 06: сине-чёрные поверхности,
// неон — акценты; секции по образцу страницы «Диагностика».
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type {
  SettingsAll,
  UpdaterCheckResult,
  UpdaterStatusResult,
  VpnRulesResult,
  VpnStateChanged,
} from "../bridge/gen/types";
import { LOOK_PRESETS, matchLookPreset, type LookSource } from "../subtitles-panel/look-presets";

const err = (e: unknown): void => console.error("settings-page:", e);

/** Стиль-патч субтитров из формы (числа/цвета — с клампами Core/content). */
interface SubtitlesForm {
  lang: string;
  fontScalePct: number;
  fontFamily: string;
  position: string;
  marginPct: number;
  plateOpacity: number;
  originalColor: string;
  translationColor: string;
  mutedColor: string;
  plateColor: string;
  textStroke: boolean;
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
  // Гарнитура (карточка duopulse-068): только фирменные с кириллическими
  // сабсетами (Inter, JetBrains Mono) плюс системная.
  const fontSel = document.createElement("select");
  for (const [value, text] of [
    ["Inter", "Inter"],
    ["JetBrains Mono", "JetBrains Mono"],
    ["system", "Системная"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    fontSel.append(opt);
  }
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

  // Вид плашки (карточка duopulse-059): пресет-чипы заполняют форму цветов,
  // точные цвета — пипетки input[type=color]; живой предпросмотр — DuoPulse
  // на любом видео, здесь задаётся только дефолт для новых вкладок.
  const lookColors = {
    originalColor: document.createElement("input"),
    translationColor: document.createElement("input"),
    mutedColor: document.createElement("input"),
    plateColor: document.createElement("input"),
  } as const;
  for (const input of Object.values(lookColors)) input.type = "color";
  const strokeCheck = document.createElement("input");
  strokeCheck.type = "checkbox";
  const strokeLabel = el("label", "set-check");
  strokeLabel.append(strokeCheck, Object.assign(el("span"), { textContent: " Обводка текста (читаемость на светлом видео)" }));
  const lookForm = (): LookSource => ({
    originalColor: lookColors.originalColor.value,
    translationColor: lookColors.translationColor.value,
    mutedColor: lookColors.mutedColor.value,
    plateColor: lookColors.plateColor.value,
    textStroke: strokeCheck.checked,
    plateOpacity: Number(opacity.value),
  });
  const lookSeg = el("div", "set-look-chips");
  const lookChips: Record<string, HTMLButtonElement> = {};
  for (const p of LOOK_PRESETS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.textContent = p.label;
    chip.addEventListener("click", () => {
      lookColors.originalColor.value = p.patch.originalColor;
      lookColors.translationColor.value = p.patch.translationColor;
      lookColors.mutedColor.value = p.patch.mutedColor;
      lookColors.plateColor.value = p.patch.plateColor;
      strokeCheck.checked = p.patch.textStroke;
      opacity.value = String(p.patch.plateOpacity);
      opacityVal.textContent = pct(p.patch.plateOpacity * 100);
      markLookChip();
    });
    lookSeg.append(chip);
    lookChips[p.id] = chip;
  }
  /** Подсветка чипа пресета, совпадающего с формой (иначе — ничего). */
  const markLookChip = (): void => {
    const active = matchLookPreset(lookForm());
    for (const p of LOOK_PRESETS) lookChips[p.id].classList.toggle("on", active?.id === p.id);
  };
  for (const input of Object.values(lookColors)) input.addEventListener("input", markLookChip);
  strokeCheck.addEventListener("change", markLookChip);
  opacity.addEventListener("input", markLookChip);

  const subsStatus = el("div", "set-status");
  const subsSave = document.createElement("button");
  subsSave.type = "button";
  subsSave.className = "primary";
  subsSave.textContent = "Сохранить";
  subs.body.append(
    field("Язык перевода по умолчанию", langInput, "код из 2–3 букв (ru, es, pt-br)"),
    field("Размер плашки", scale),
    field("Гарнитура плашки", fontSel, "фирменные с кириллицей или системная"),
    field("Позиция плашки", posSeg),
    field("Отступ от края видео", margin),
    field("Непрозрачность подложки", opacity),
    lookSeg,
    field("Цвет оригинала", lookColors.originalColor),
    field("Цвет перевода", lookColors.translationColor),
    field("Цвет третьих строк", lookColors.mutedColor),
    field("Цвет подложки", lookColors.plateColor),
    strokeLabel,
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
    fontFamily: fontSel.value,
    position: posTop.classList.contains("on") ? "top" : "bottom",
    marginPct: Number(margin.value),
    ...lookForm(),
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
            fontFamily: form.fontFamily,
            position: form.position,
            marginPct: form.marginPct,
            plateOpacity: form.plateOpacity,
            originalColor: form.originalColor,
            translationColor: form.translationColor,
            mutedColor: form.mutedColor,
            plateColor: form.plateColor,
            textStroke: form.textStroke,
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

  // --- 4a. Распознавание речи (карточка duopulse-060) -------------------------
  const asr = section(
    "Распознавание речи (ASR)",
    "Субтитры для видео без дорожек: локальный whisper (приватно, офлайн) или OpenAI-совместимое облако (OpenAI/Groq/свой сервер); ключ — в DPAPI.",
  );
  const asrEnabled = document.createElement("input");
  asrEnabled.type = "checkbox";
  const asrEnabledLabel = el("label", "set-check");
  asrEnabledLabel.append(asrEnabled, Object.assign(el("span"), { textContent: " Разрешить распознавание речи" }));
  const asrProvider = document.createElement("select");
  for (const [value, text] of [
    ["local", "Локальный whisper (офлайн)"],
    ["openai", "Облако (OpenAI-совместимое)"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    asrProvider.append(opt);
  }
  const asrModel = document.createElement("select");
  const mBase = document.createElement("option");
  mBase.value = "base";
  mBase.textContent = "base — 148 МБ, быстрее";
  const mSmall = document.createElement("option");
  mSmall.value = "small";
  mSmall.textContent = "small — 488 МБ, точнее (ru)";
  asrModel.append(mBase, mSmall);
  const asrModelField = field("Модель whisper", asrModel);
  const asrEnginePath = document.createElement("input");
  asrEnginePath.type = "text";
  asrEnginePath.placeholder = "пусто — авто (профиль/рядом с приложением)";
  asrEnginePath.spellcheck = false;
  const asrEnginePathField = field("Путь whisper-server.exe", asrEnginePath);
  const asrUrl = document.createElement("input");
  asrUrl.type = "text";
  asrUrl.placeholder = "https://api.openai.com/v1";
  asrUrl.spellcheck = false;
  const asrUrlField = field("Base URL API", asrUrl);
  const asrCloudModel = document.createElement("input");
  asrCloudModel.type = "text";
  asrCloudModel.placeholder = "whisper-1";
  asrCloudModel.spellcheck = false;
  const asrCloudModelField = field("Модель облака", asrCloudModel);
  const asrKey = document.createElement("input");
  asrKey.type = "password";
  asrKey.autocomplete = "new-password";
  asrKey.placeholder = "ключ";
  const asrKeyClear = document.createElement("button");
  asrKeyClear.type = "button";
  asrKeyClear.className = "link";
  asrKeyClear.textContent = "удалить";
  const asrKeyField = field("Ключ API", asrKey);
  asrKeyField.querySelector(".set-field-name")?.append(asrKeyClear);
  const asrStatus = el("div", "set-status");
  const asrSave = document.createElement("button");
  asrSave.type = "button";
  asrSave.className = "primary";
  asrSave.textContent = "Сохранить";
  const asrTest = document.createElement("button");
  asrTest.type = "button";
  asrTest.className = "ghost";
  asrTest.textContent = "Проверить";
  const asrPrepare = document.createElement("button");
  asrPrepare.type = "button";
  asrPrepare.className = "ghost";
  asrPrepare.textContent = "Скачать движок и модель";
  const asrRow = el("div", "set-row");
  asrRow.append(asrSave, asrTest, asrPrepare, asrStatus);
  asr.body.append(
    asrEnabledLabel,
    field("Движок", asrProvider),
    asrModelField,
    asrEnginePathField,
    asrUrlField,
    asrCloudModelField,
    asrKeyField,
    asrRow,
  );
  const asrVis = (): void => {
    const local = asrProvider.value === "local";
    asrModelField.hidden = !local;
    asrEnginePathField.hidden = !local;
    asrUrlField.hidden = local;
    asrCloudModelField.hidden = local;
    asrKeyField.hidden = local;
    asrKeyClear.hidden = !asrKeySaved;
    asrKey.placeholder = asrKeySaved ? "сохранён — пусто = не менять" : "ключ";
  };
  asrProvider.addEventListener("change", asrVis);
  let asrKeySaved = false;
  let asrEngineReady = false;
  let asrModelReady = false;

  const asrForm = () => ({
    value: {
      enabled: asrEnabled.checked,
      provider: asrProvider.value as "local" | "openai",
      localModel: asrModel.value as "base" | "small",
      localEnginePath: asrEnginePath.value.trim(),
      openaiBaseUrl: asrUrl.value.trim(),
      openaiModel: asrCloudModel.value.trim(),
    },
    secret: asrKey.value === "" ? undefined : asrKey.value,
  });
  const asrApply = async (): Promise<boolean> => {
    const { value, secret } = asrForm();
    try {
      await bridge.asr.setSettings({ value, secret });
    } catch (e) {
      asrStatus.textContent = String(e);
      return false;
    }
    asrKey.value = "";
    await loadAsr();
    return true;
  };
  asrSave.addEventListener("click", () => {
    void asrApply().then((ok) => {
      if (ok) asrStatus.textContent = "Сохранено.";
    });
  });
  asrTest.addEventListener("click", () => {
    asrStatus.textContent = "Проверяю…";
    void asrApply().then((ok) => {
      if (!ok) return;
      void bridge.asr
        .test()
        .then((res) => {
          asrStatus.textContent = res.ok ? "Движок отвечает." : res.detail;
        })
        .catch((e) => (asrStatus.textContent = String(e)));
    });
  });
  asrPrepare.addEventListener("click", () => {
    asrStatus.textContent = "Скачиваю… (движок ~3 МБ, модель 148/488 МБ)";
    void asrApply().then((ok) => {
      if (!ok) return;
      void bridge.asr
        .prepare()
        .then((res) => {
          asrStatus.textContent = res.ok ? "Готово: движок и модель на месте." : res.detail;
          return loadAsr();
        })
        .catch((e) => (asrStatus.textContent = String(e)));
    });
  });
  asrKeyClear.addEventListener("click", (e) => {
    e.preventDefault();
    void bridge.asr
      .setSettings({ value: { ...asrForm().value }, secret: "" })
      .then(() => {
        asrKeySaved = false;
        asrVis();
        asrStatus.textContent = "Ключ удалён.";
      })
      .catch((e2) => (asrStatus.textContent = String(e2)));
  });

  // --- 5. Прокси / VPN --------------------------------------------------------
  const proxy = section(
    "Прокси / VPN",
    "Внешний прокси SOCKS5/HTTP(S); применяется сразу — через локальный роутер, без перезапуска. Пароль — в DPAPI.",
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
  proxy.body.append(
    proxyEnabledLabel,
    field("Тип", proxyProto),
    field("Адрес", proxyHost),
    field("Порт", proxyPort),
    field("Логин", proxyLogin),
    proxyPassField,
    proxyRow,
  );
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

  // --- 5b. Split-tunnel WireGuard (задача 6.3) ---------------------------------
  // Режим туннеля (off/global/split) и правила «домен → маршрут». Профили
  // WireGuard — vpn.import_profile (контракт v8); панель с профилями и
  // статистикой — задача 6.5. Правила действуют на новые соединения сразу
  // (общий стор IPC ↔ роутер) и переживают перезапуск (vpn/split-rules.json).
  const split = section(
    "VPN-туннель WireGuard — режим и split-правила",
    "Split-tunnel: заблокированные домены — через туннель, YouTube и видео — напрямую, без потери скорости. DNS каждого домена идёт его же маршрутом (туннельный — DNS-сервером туннеля), утечек нет. Применяется сразу, без перезапуска; нужен активный профиль WireGuard.",
  );
  const vpnMode = document.createElement("select");
  vpnMode.dataset.vpn = "mode";
  for (const [value, text] of [
    ["off", "Выключен — весь трафик напрямую"],
    ["global", "Глобальный — весь трафик через туннель"],
    ["split", "Split-tunnel — по правилам ниже (целевой)"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    vpnMode.append(opt);
  }
  const vpnStatus = el("div", "set-status");
  vpnStatus.dataset.vpn = "status";
  vpnMode.addEventListener("change", () => {
    vpnStatus.textContent = "Применяю…";
    void bridge.vpn
      .setMode({ mode: vpnMode.value as "off" | "global" | "split" })
      .then((st) => {
        vpnStatus.textContent =
          st.mode === "wg" || st.routing === "off"
            ? `Режим применён: ${labelRouting(st.routing)}.`
            : `Режим сохранён: ${labelRouting(st.routing)} — туннель не поднят (${st.detail}).`;
        return loadVpnRules();
      })
      .catch((e) => (vpnStatus.textContent = String(e)));
  });
  const labelRouting = (r: string): string =>
    r === "global" ? "глобальный" : r === "split" ? "split-tunnel" : "выключен";

  const rulesList = el("div", "set-rules");
  rulesList.dataset.vpn = "rules";
  const renderRules = (res: VpnRulesResult): void => {
    vpnMode.value = res.mode;
    rulesList.replaceChildren();
    if (res.rules.length === 0) {
      const empty = el("div", "set-rules-empty");
      empty.textContent =
        "Правил нет. Добавьте заблокированный сайт ниже — в split-режиме он пойдёт через туннель, остальное — напрямую.";
      rulesList.append(empty);
      return;
    }
    for (const r of res.rules) {
      const row = el("div", "set-rule");
      const dom = el("span", "set-rule-domain");
      dom.textContent = r.domain;
      dom.title = `правило ловит и поддомены (${r.domain} и *.${r.domain})`;
      const seg = el("div", "set-seg");
      const bTunnel = document.createElement("button");
      bTunnel.type = "button";
      bTunnel.textContent = "Туннель";
      const bDirect = document.createElement("button");
      bDirect.type = "button";
      bDirect.textContent = "Напрямую";
      bTunnel.classList.toggle("on", r.route === "tunnel");
      bDirect.classList.toggle("on", r.route === "direct");
      bTunnel.addEventListener("click", () => routeRule(r.domain, "tunnel"));
      bDirect.addEventListener("click", () => routeRule(r.domain, "direct"));
      seg.append(bTunnel, bDirect);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link";
      del.textContent = "удалить";
      del.addEventListener("click", () => {
        void bridge.vpn
          .removeRule({ domain: r.domain })
          .then((res2) => {
            renderRules(res2);
            vpnStatus.textContent = `Правило «${r.domain}» удалено.`;
          })
          .catch((e) => (vpnStatus.textContent = String(e)));
      });
      row.append(dom, seg, del);
      rulesList.append(row);
    }
  };
  const routeRule = (domain: string, route: "tunnel" | "direct"): void => {
    void bridge.vpn
      .addRule({ domain, route })
      .then((res) => {
        renderRules(res);
        vpnStatus.textContent = `«${domain}» — ${route === "tunnel" ? "через туннель" : "напрямую"}.`;
      })
      .catch((e) => (vpnStatus.textContent = String(e)));
  };

  const ruleDomain = document.createElement("input");
  ruleDomain.type = "text";
  ruleDomain.placeholder = "example.com";
  ruleDomain.spellcheck = false;
  ruleDomain.dataset.vpn = "rule-domain";
  const ruleRoute = document.createElement("select");
  ruleRoute.dataset.vpn = "rule-route";
  for (const [value, text] of [
    ["tunnel", "Через туннель"],
    ["direct", "Напрямую"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    ruleRoute.append(opt);
  }
  const ruleAdd = document.createElement("button");
  ruleAdd.type = "button";
  ruleAdd.className = "primary";
  ruleAdd.textContent = "Добавить правило";
  ruleAdd.dataset.vpn = "rule-add";
  const ruleRow = el("div", "set-row");
  ruleRow.append(ruleAdd, vpnStatus);
  const addRuleForm = (): void => {
    const domain = ruleDomain.value.trim();
    if (!domain) {
      vpnStatus.textContent = "Введите домен — например, example.com.";
      return;
    }
    void bridge.vpn
      .addRule({ domain, route: ruleRoute.value as "tunnel" | "direct" })
      .then((res) => {
        renderRules(res);
        ruleDomain.value = "";
        vpnStatus.textContent = "Правило добавлено — в split-режиме действует сразу.";
      })
      .catch((e) => (vpnStatus.textContent = String(e)));
  };
  ruleAdd.addEventListener("click", addRuleForm);
  ruleDomain.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addRuleForm();
  });
  split.body.append(
    field("Режим", vpnMode, "действует на новые соединения сразу"),
    field("Правила", rulesList, "правило ловит домен и его поддомены"),
    field("Домен", ruleDomain),
    field("Маршрут", ruleRoute),
    ruleRow,
  );

  // Статус-события туннеля (задача 6.4): переходы connecting/connected/
  // error и выключение приходят событием vpn:state_changed — строка статуса
  // живая, без опроса (kill-switch: «туннель мёртв — соединения закрыты»
  // виден сразу, страница знает, что соединения закрыты, а не грузятся).
  void listen<VpnStateChanged>(bridge.events.vpnStateChanged, (e) => {
    const st = e.payload;
    if (st.mode === "wg") {
      const label =
        st.state === "error" ? "ошибка" : st.detail === "туннель жив" ? "подключён" : "подключается";
      vpnStatus.textContent = `Туннель: ${label} (${st.detail})`;
    } else if (st.mode === "off" && st.state === "off") {
      vpnStatus.textContent = "Туннель выключен — соединения закрыты, трафик по конфигу прокси/напрямую.";
    }
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

  // --- 7. Обновления (задача 5.2; источник — duopulse-049) ---------------------
  const upd = section(
    "Обновления",
    "Подписанные пакеты установщика; проверка — по кнопке или тихо на старте, установка всегда вручную. " +
      "Если выбранный источник недоступен, проверка уходит ко второму (GitHub ↔ Aila).",
  );
  const updChannel = document.createElement("select");
  for (const [value, text] of [
    ["stable", "Стабильный"],
    ["canary", "Канарейка (ранние сборки)"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    updChannel.append(opt);
  }
  const updSource = document.createElement("select");
  for (const [value, text] of [
    ["github", "GitHub (по умолчанию)"],
    ["aila", "Aila (семейный сервер)"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    updSource.append(opt);
  }
  const updAuto = document.createElement("input");
  updAuto.type = "checkbox";
  const updAutoLabel = el("label", "set-check");
  updAutoLabel.append(updAuto, Object.assign(el("span"), { textContent: " Проверять обновления на старте (тихо)" }));
  const updVersionLine = el("div", "set-status");
  updVersionLine.dataset.upd = "version";
  const updStatus = el("div", "set-status");
  updStatus.dataset.upd = "status";
  const updCheckBtn = document.createElement("button");
  updCheckBtn.type = "button";
  updCheckBtn.className = "primary";
  updCheckBtn.textContent = "Проверить сейчас";
  updCheckBtn.dataset.upd = "check";
  const updInstallBtn = document.createElement("button");
  updInstallBtn.type = "button";
  updInstallBtn.className = "primary";
  updInstallBtn.hidden = true;
  updInstallBtn.dataset.upd = "install";
  const updRow = el("div", "set-row");
  updRow.append(updCheckBtn, updInstallBtn, updStatus);
  upd.body.append(
    field("Канал", updChannel, "канарейка — ранние сборки на тестовые машины"),
    field("Источник", updSource, "зеркало Aila не зависит от GitHub; ответ второго — в строке проверки"),
    updAutoLabel,
    updVersionLine,
    updRow,
  );

  /** Канал/источник/автопроверка → раздел настроек updater. */
  const updApply = (): void => {
    void bridge.settings
      .apply({
        updater: {
          channel: updChannel.value as "stable" | "canary",
          source: updSource.value as "github" | "aila",
          autoCheck: updAuto.checked,
        },
      })
      .catch((e) => (updStatus.textContent = String(e)));
  };
  updChannel.addEventListener("change", updApply);
  updSource.addEventListener("change", updApply);
  updAuto.addEventListener("change", updApply);

  /** Подпись источника проверки (duopulse-049): кто ответил и не было ли фолбэка. */
  const updSourceNote = (answered: "github" | "aila" | null | undefined): string => {
    if (!answered) return "";
    const label = answered === "aila" ? "Aila" : "GitHub";
    return answered === updSource.value
      ? ` · источник: ${label}`
      : ` · источник: ${label} (выбранный недоступен — ответило зеркало)`;
  };

  /** Итог проверки/статуса → кнопки и тексты. */
  const renderUpdateState = (st: UpdaterStatusResult | null, res: UpdaterCheckResult | null): void => {
    const pending = res?.available
      ? { version: res.version ?? "?", notes: res.notes ?? null, dateUnix: res.dateUnix }
      : st?.pending ?? null;
    if (st) {
      updVersionLine.textContent =
        `Текущая версия: ${st.currentVersion} · канал: ${st.channel === "canary" ? "канарейка" : "стабильный"}` +
        ` · источник: ${st.source === "aila" ? "Aila" : "GitHub"}`;
      if (!res) {
        if (pending) updStatus.textContent = `Доступна версия ${pending.version} (найдена ранее).`;
        else if (st.lastCheck) {
          updStatus.textContent = st.lastCheck.error
            ? `Последняя проверка: ${st.lastCheck.error}`
            : `Последняя проверка: ✓ у вас последняя версия${updSourceNote(st.lastCheck.source ?? null)}`;
        }
      }
    }
    if (res) {
      if (res.available) {
        const when = res.dateUnix > 0 ? ` от ${new Date(res.dateUnix * 1000).toLocaleDateString("ru-RU")}` : "";
        updStatus.textContent = `Доступна версия ${res.version}${when}${res.notes ? ` — ${res.notes}` : ""}${updSourceNote(res.source ?? null)}`;
      } else {
        updStatus.textContent = res.error
          ? res.error
          : `✓ У вас последняя версия${updSourceNote(res.source ?? null)}`;
      }
    }
    updInstallBtn.hidden = !pending;
    if (pending) updInstallBtn.textContent = `Установить ${pending.version} и перезапустить`;
  };
  updCheckBtn.addEventListener("click", () => {
    updStatus.textContent = "Проверяю…";
    void bridge.updater
      .check()
      .then((res) => renderUpdateState(null, res))
      .catch((e) => (updStatus.textContent = String(e)));
  });
  updInstallBtn.addEventListener("click", () => {
    // Windows: установщик пассивно ставит пакет и сам перезапускает
    // приложение — ответ команды при успехе не приходит.
    updStatus.textContent = "Скачиваю пакет и устанавливаю — приложение перезапустится…";
    void bridge.updater.install().catch((e) => (updStatus.textContent = String(e)));
  });

  // --- 8. Профиль: экспорт/импорт одним файлом --------------------------------
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
        await reload();
      } catch (e) {
        profileStatus.textContent = String(e);
      }
    })();
  });
  const profileRow = el("div", "set-row");
  profileRow.append(exportBtn, importBtn, profileStatus);
  profile.body.append(secretsLabel, secretsWarn, profileRow);

  root.append(appearance.root, search.root, subs.root, tr.root, asr.root, proxy.root, split.root, privacy.root, upd.root, profile.root);

  // --- загрузка ---------------------------------------------------------------

  const loadAsr = async (): Promise<void> => {
    const st = await bridge.asr.getSettings();
    asrEnabled.checked = st.enabled;
    asrProvider.value = st.provider;
    asrModel.value = st.localModel;
    asrEnginePath.value = st.localEnginePath;
    asrUrl.value = st.openaiBaseUrl;
    asrCloudModel.value = st.openaiModel;
    asrKeySaved = st.hasApiKey;
    asrEngineReady = st.engineFound;
    asrModelReady = st.modelDownloaded;
    asrVis();
  };

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
  };

  const loadVpnRules = async (): Promise<void> => {
    await bridge.vpn
      .getRules()
      .then(renderRules)
      .catch(err);
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
      fontSel.value = st.fontFamily ?? "Inter";
      segSet(st.position ?? "bottom");
      margin.value = String(st.marginPct ?? 6);
      marginVal.textContent = pct(st.marginPct ?? 6);
      opacity.value = String(st.plateOpacity ?? 0.78);
      opacityVal.textContent = pct((st.plateOpacity ?? 0.78) * 100);
      lookColors.originalColor.value = st.originalColor ?? "#ffffff";
      lookColors.translationColor.value = st.translationColor ?? "#bdfe4f";
      lookColors.mutedColor.value = st.mutedColor ?? "#ffffff";
      lookColors.plateColor.value = st.plateColor ?? "#0a0e17";
      strokeCheck.checked = st.textStroke ?? true;
      markLookChip();
      clearHist.checked = all.privacy.clearHistoryOnExit ?? false;
      const up = all.updater;
      updChannel.value = up.channel ?? "stable";
      updSource.value = up.source ?? "github";
      updAuto.checked = up.autoCheck ?? true;
      subsStatus.textContent = "";
    } catch (e) {
      err(e);
    }
    await loadTranslate().catch(err);
    await loadAsr().catch(err);
    await loadProxy().catch(err);
    await loadVpnRules().catch(err);
    // Начальный статус туннеля (задача 6.4): дальше строку ведёт событие
    // vpn:state_changed, при загрузке страницы — снапшот vpn.status.
    await bridge.vpn
      .status()
      .then((st) => {
        if (st.mode === "wg" && st.wg) {
          const label =
            st.wg.state === "connected"
              ? "подключён"
              : st.wg.state === "error"
                ? "ошибка"
                : "подключается";
          vpnStatus.textContent = `Туннель: ${label} — профиль «${st.wg.profileName}» (${st.wg.endpoint}).`;
        } else {
          vpnStatus.textContent = "Туннель не поднят — трафик идёт по конфигу прокси/напрямую.";
        }
      })
      .catch(err);
    // Обновления (задача 5.2): версия/канал/последняя проверка из Core
    await bridge.updater
      .status()
      .then((st) => renderUpdateState(st, null))
      .catch(err);
  };

  void reload();
}

// модуль импортируется роутером src/main.ts — стартуем сразу
initSettingsPage();
