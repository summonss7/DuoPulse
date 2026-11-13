// Панель «Перевод» (задача 4.1, docs/03 §8 п.3 «Провайдер перевода — M4»):
// секция duo-панели настроек субтитров. Выбор провайдера (DeepL / Google
// Translate / LibreTranslate), его несекретные параметры и ключ API; данные —
// translate.{get,set}_settings (конфиг — settings.json, ключ — DPAPI),
// живая проверка — translate.test (сначала сохраняет форму). Чистые функции
// формы — translate-form.ts (юнит-тесты там); этот модуль — DOM-обвязка.
import { bridge } from "../bridge";
import type { TranslateSettings } from "../bridge/gen/types";
import { t } from "../i18n";
import { formToConfig, formValues, keyPlaceholder, secretOf, validateForm, type TranslateFormValues } from "./translate-form";

const err = (e: unknown): void => console.error("translate:", e);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const enabledEl = $<HTMLInputElement>("trEnabled");
const providerEl = $<HTMLSelectElement>("trProvider");
const deeplPlanEl = $<HTMLSelectElement>("trDeeplPlan");
const deeplPlanField = $("trDeeplPlanField");
const libreUrlEl = $<HTMLInputElement>("trLibreUrl");
const libreUrlField = $("trLibreUrlField");
const keyEl = $<HTMLInputElement>("trKey");
const keyClearEl = $("trKeyClear");
const statusEl = $("trStatus");
const testBtn = $<HTMLButtonElement>("trTest");
const saveBtn = $<HTMLButtonElement>("trSave");

/** Последний снапшот настроек (placeholder ключа по выбранному провайдеру). */
let current: TranslateSettings | null = null;

function readForm(): TranslateFormValues {
  return {
    enabled: enabledEl.checked,
    provider: providerEl.value as TranslateFormValues["provider"],
    deeplPlan: deeplPlanEl.value as TranslateFormValues["deeplPlan"],
    libreUrl: libreUrlEl.value,
  };
}

/** Поля по провайдеру: тариф — только DeepL, адрес — только LibreTranslate. */
function renderFields(): void {
  const provider = providerEl.value;
  deeplPlanField.hidden = provider !== "deepl";
  libreUrlField.hidden = provider !== "libretranslate";
  const has = current?.hasApiKeys.includes(provider as TranslateSettings["provider"]) ?? false;
  keyEl.placeholder = keyPlaceholder(has);
  keyClearEl.hidden = !has;
}

function showStatus(message: string | null, ok = false): void {
  const node = statusEl;
  if (!node) return;
  node.textContent = message ?? "";
  node.hidden = !message;
  node.dataset.ok = String(ok);
}

async function refresh(): Promise<void> {
  const s = await bridge.translate.getSettings();
  current = s;
  const v = formValues(s);
  enabledEl.checked = v.enabled;
  providerEl.value = v.provider;
  deeplPlanEl.value = v.deeplPlan;
  libreUrlEl.value = v.libreUrl;
  keyEl.value = "";
  renderFields();
}

/** Сохранить форму; валидация — клиентская зеркально Core. false — не saved. */
async function save(): Promise<boolean> {
  const values = readForm();
  const problem = validateForm(values);
  if (problem) {
    showStatus(problem);
    return false;
  }
  try {
    const secret = secretOf(keyEl.value);
    await bridge.translate.setSettings({ value: formToConfig(values), secret: secret ?? undefined });
  } catch (e) {
    showStatus(String(e));
    return false;
  }
  await refresh().catch(err);
  return true;
}

/** Живая проверка провайдера: сначала сохраняет форму (ключ мог измениться). */
async function test(): Promise<void> {
  showStatus(t("Проверяем…"));
  if (!(await save())) return;
  testBtn.disabled = true;
  try {
    const r = await bridge.translate.test({ text: null, targetLang: "ru" });
    showStatus(
      r.ok ? t("Провайдер отвечает: «{t}»", { t: r.translated ?? "" }) : r.detail,
      r.ok,
    );
  } catch (e) {
    showStatus(String(e));
  } finally {
    testBtn.disabled = false;
  }
}

export function initTranslateSettings(): void {
  providerEl.addEventListener("change", () => {
    renderFields();
    keyEl.value = ""; // ключ другого провайдера не уезжает в чужой слот
    showStatus(null);
  });
  enabledEl.addEventListener("change", () => showStatus(null));
  saveBtn.addEventListener("click", async () => {
    if (await save()) showStatus(t("Сохранено"), true);
  });
  testBtn.addEventListener("click", () => void test());

  // Ключ — только DPAPI: «удалить» стирает blob (секрет "" — семантика Core).
  keyClearEl.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const values = readForm();
    try {
      await bridge.translate.setSettings({ value: formToConfig(values), secret: "" });
      await refresh();
      showStatus(t("Ключ удалён"), true);
    } catch (er) {
      showStatus(String(er));
    }
  });

  void refresh().catch(err);
}
