// Панель настроек duo мобильной ветки (этап 2, duopulse-082): нижний лист
// поверх контента — показ вкл/выкл, оригинал, перевод (готовые дорожки видео
// + Google gtx), кегль, позиция, сдвиг. Мобильная вёрстка/тач: крупные
// контролы, селекты нативные. Панель не знает о загрузке — изменения уходят
// колбэком контроллеру, статус приходит в setStatus.
//
// ASR (duopulse-167 облако; duopulse-168 локальный whisper): ⚙ раскрывает
// настройки — выбор провайдера (облако | на устройстве), для облака адрес
// API/модель/ключ (Android Keystore), для локального — модель ggml tiny/base
// (скачивание с прогрессом и sha256-проверкой, удаление), «Отмена» видна,
// пока конвейер занят.

import { t } from "../../i18n";
import { GTX_TARGET_LANGS, parseTranslationChoice, type DuoMobileSettings } from "./state";
import type { MobileTrackList } from "./session";
import { LOCAL_MODELS, type LocalModelSizeId, type MobileAsrSettings, type MobileAsrSettingsPatch } from "./asr";
import type { DuoStatus } from "./index";

export interface DuoPanelCallbacks {
  onUpdate(patch: Partial<DuoMobileSettings>): void;
  onClose(): void;
  /** «Распознать речь» (кэш/скачивание/провайдер — решает контроллер). */
  onAsrRun(): void;
  /** «Отмена» активного распознавания. */
  onAsrCancel(): void;
  /** Сохранить настройки ASR (ключ — только в Keystore). */
  onAsrSaveSettings(patch: MobileAsrSettingsPatch): Promise<MobileAsrSettings>;
  /** Скачать модель локального движка (прогресс — событием Core). */
  onAsrDownloadModel(size: LocalModelSizeId): Promise<void>;
  /** Удалить модель локального движка. */
  onAsrDeleteModel(size: LocalModelSizeId): Promise<MobileAsrSettings>;
}

/** Отображаемое имя дорожки: имя платформы или язык+тип. */
export function trackLabel(id: string, lang: string, kind: string, name: string): string {
  if (name) return name;
  return kind === "asr" ? t("{lang} (авто)", { lang }) : lang;
}

export class DuoPanel {
  readonly root: HTMLDivElement;
  private readonly statusEl: HTMLElement;
  private readonly originalSel: HTMLSelectElement;
  private readonly transSel: HTMLSelectElement;
  private readonly scaleVal: HTMLElement;
  private readonly offsetVal: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly posBottom: HTMLButtonElement;
  private readonly posTop: HTMLButtonElement;
  private readonly asrRunBtn: HTMLButtonElement;
  private readonly asrCancelBtn: HTMLButtonElement;
  private readonly asrSetupEl: HTMLElement;
  private readonly asrProvCloudBtn: HTMLButtonElement;
  private readonly asrProvLocalBtn: HTMLButtonElement;
  private readonly asrCloudFieldsEl: HTMLElement;
  private readonly asrLocalEl: HTMLElement;
  private readonly asrLocalSel: HTMLSelectElement;
  private readonly asrModelStatEl: HTMLElement;
  private readonly asrDlBtn: HTMLButtonElement;
  private readonly asrDelBtn: HTMLButtonElement;
  private readonly asrUrlInput: HTMLInputElement;
  private readonly asrModelInput: HTMLInputElement;
  private readonly asrKeyInput: HTMLInputElement;
  private readonly asrEnabledBox: HTMLInputElement;
  /** Выбранный в UI провайдер (до «Сохранить» — локальная буферная копия). */
  private asrProvider: "cloud" | "local" = "cloud";
  private suppressChange = false;
  private lastList: MobileTrackList | null = null;
  private builtForOriginal: string | null | undefined;

  constructor(
    private readonly callbacks: DuoPanelCallbacks,
    private readonly settings: () => DuoMobileSettings,
    list: () => MobileTrackList | null,
    /** Есть ли открытое видео (кнопка ASR без него бессмысленна). */
    private readonly hasVideo: () => boolean = () => true,
    /** Настройки ASR (null — ещё не загружены: ключ не проверяем). */
    private readonly asrSettings: () => MobileAsrSettings | null = () => null,
  ) {
    this.root = document.createElement("div");
    this.root.className = "m-duo-panel";
    this.root.innerHTML = `
      <div class="m-duo-head">
        <span class="m-duo-title">${t("duo · субтитры")}</span>
        <button class="m-duo-toggle" title="${t("Показ субтитров")}">${t("вкл")}</button>
        <button class="m-duo-close" aria-label="${t("Закрыть")}">✕</button>
      </div>
      <label class="m-duo-set m-duo-field">
        <span>${t("Оригинал")}</span>
        <select class="m-duo-original"></select>
      </label>
      <label class="m-duo-set m-duo-field">
        <span>${t("Перевод")}</span>
        <select class="m-duo-trans"></select>
      </label>
      <div class="m-duo-set">
        <span>${t("Кегль")}</span>
        <div class="m-duo-stepper">
          <button class="m-duo-scale-minus" aria-label="${t("Мелче")}">−</button>
          <b class="m-duo-scale-val"></b>
          <button class="m-duo-scale-plus" aria-label="${t("Крупнее")}">+</button>
        </div>
      </div>
      <div class="m-duo-set">
        <span>${t("Позиция")}</span>
        <div class="m-duo-seg">
          <button class="m-duo-pos-bottom">${t("низ")}</button><button class="m-duo-pos-top">${t("верх")}</button>
        </div>
      </div>
      <div class="m-duo-set">
        <span>${t("Сдвиг")}</span>
        <div class="m-duo-stepper">
          <button class="m-duo-offset-minus" aria-label="${t("Раньше")}">${t("−0,5 с")}</button>
          <b class="m-duo-offset-val"></b>
          <button class="m-duo-offset-plus" aria-label="${t("Позже")}">${t("+0,5 с")}</button>
        </div>
      </div>
      <div class="m-duo-set m-duo-asr">
        <span>ASR</span>
        <div class="m-duo-asr-actions">
          <button class="m-duo-asr-run">${t("Распознать речь (ASR)…")}</button>
          <button class="m-duo-asr-cancel" hidden>${t("Отмена")}</button>
          <button class="m-duo-asr-gear" title="${t("Настройки ASR")}" aria-label="${t("Настройки ASR")}">⚙</button>
        </div>
      </div>
      <div class="m-duo-asr-setup" hidden>
        <div class="m-duo-set m-duo-field">
          <span>${t("Провайдер")}</span>
          <div class="m-duo-seg m-duo-asr-prov">
            <button class="m-duo-asr-prov-cloud">${t("Облако")}</button><button class="m-duo-asr-prov-local">${t("На устройстве")}</button>
          </div>
        </div>
        <div class="m-duo-asr-cloud-fields">
          <label class="m-duo-set m-duo-field">
            <span>${t("Адрес API (OpenAI-совместимый)")}</span>
            <input class="m-duo-asr-url" type="url" inputmode="url" autocomplete="off">
          </label>
          <label class="m-duo-set m-duo-field">
            <span>${t("Модель")}</span>
            <input class="m-duo-asr-model" autocomplete="off">
          </label>
          <label class="m-duo-set m-duo-field">
            <span>${t("Ключ API")}</span>
            <input class="m-duo-asr-key" type="password" autocomplete="off">
          </label>
        </div>
        <div class="m-duo-asr-local">
          <label class="m-duo-set m-duo-field">
            <span>${t("Модель whisper")}</span>
            <select class="m-duo-asr-lmodel"></select>
          </label>
          <div class="m-duo-set m-duo-asr-modelrow">
            <span class="m-duo-asr-modelstat"></span>
            <span class="m-duo-asr-modelbtns">
              <button class="m-duo-asr-dl">${t("Скачать")}</button>
              <button class="m-duo-asr-del" hidden>${t("Удалить")}</button>
            </span>
          </div>
          <p class="m-duo-note">${t("Распознавание на устройстве: аудио не покидает телефон, работает без интернета (после скачивания модели).")}</p>
        </div>
        <div class="m-duo-set m-duo-asr-setup-row">
          <label class="m-duo-check">
            <input type="checkbox" class="m-duo-asr-enabled">
            <span>${t("ASR включён")}</span>
          </label>
          <button class="m-duo-asr-save">${t("Сохранить")}</button>
        </div>
        <p class="m-duo-note">${t("Ключ хранится в системном хранилище устройства (Android Keystore); аудио уходит только выбранному провайдеру.")}</p>
      </div>
      <div class="m-duo-status" hidden></div>
      <p class="m-duo-note">${t("Перевод Google работает без ключей; готовые дорожки — переводы самого видео. Провайдеры (DeepL/Google API/Libre) — десктоп.")}</p>
    `;
    this.toggleBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-toggle")!;
    this.originalSel = this.root.querySelector<HTMLSelectElement>(".m-duo-original")!;
    this.transSel = this.root.querySelector<HTMLSelectElement>(".m-duo-trans")!;
    this.scaleVal = this.root.querySelector<HTMLElement>(".m-duo-scale-val")!;
    this.offsetVal = this.root.querySelector<HTMLElement>(".m-duo-offset-val")!;
    this.posBottom = this.root.querySelector<HTMLButtonElement>(".m-duo-pos-bottom")!;
    this.posTop = this.root.querySelector<HTMLButtonElement>(".m-duo-pos-top")!;
    this.asrRunBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-asr-run")!;
    this.asrCancelBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-asr-cancel")!;
    this.asrSetupEl = this.root.querySelector<HTMLElement>(".m-duo-asr-setup")!;
    this.asrProvCloudBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-asr-prov-cloud")!;
    this.asrProvLocalBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-asr-prov-local")!;
    this.asrCloudFieldsEl = this.root.querySelector<HTMLElement>(".m-duo-asr-cloud-fields")!;
    this.asrLocalEl = this.root.querySelector<HTMLElement>(".m-duo-asr-local")!;
    this.asrLocalSel = this.root.querySelector<HTMLSelectElement>(".m-duo-asr-lmodel")!;
    this.asrModelStatEl = this.root.querySelector<HTMLElement>(".m-duo-asr-modelstat")!;
    this.asrDlBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-asr-dl")!;
    this.asrDelBtn = this.root.querySelector<HTMLButtonElement>(".m-duo-asr-del")!;
    this.asrUrlInput = this.root.querySelector<HTMLInputElement>(".m-duo-asr-url")!;
    this.asrModelInput = this.root.querySelector<HTMLInputElement>(".m-duo-asr-model")!;
    this.asrKeyInput = this.root.querySelector<HTMLInputElement>(".m-duo-asr-key")!;
    this.asrEnabledBox = this.root.querySelector<HTMLInputElement>(".m-duo-asr-enabled")!;
    this.statusEl = this.root.querySelector<HTMLElement>(".m-duo-status")!;

    // модели локального движка (duopulse-168): селект из LOCAL_MODELS,
    // подпись с фактом «скачана» обновляется синхронизацией настроек
    for (const m of LOCAL_MODELS) {
      this.asrLocalSel.add(new Option(t(m.label), m.id));
    }

    this.root.querySelector(".m-duo-close")!.addEventListener("click", () => this.callbacks.onClose());
    this.toggleBtn.addEventListener("click", () => this.callbacks.onUpdate({ enabled: !this.settings().enabled }));
    this.root.querySelector(".m-duo-scale-minus")!.addEventListener("click", () => this.callbacks.onUpdate({ fontScalePct: stepScale(this.settings().fontScalePct, -1) }));
    this.root.querySelector(".m-duo-scale-plus")!.addEventListener("click", () => this.callbacks.onUpdate({ fontScalePct: stepScale(this.settings().fontScalePct, +1) }));
    this.root.querySelector(".m-duo-offset-minus")!.addEventListener("click", () => this.callbacks.onUpdate({ offsetMs: this.settings().offsetMs - 500 }));
    this.root.querySelector(".m-duo-offset-plus")!.addEventListener("click", () => this.callbacks.onUpdate({ offsetMs: this.settings().offsetMs + 500 }));
    this.posBottom.addEventListener("click", () => this.callbacks.onUpdate({ position: "bottom" }));
    this.posTop.addEventListener("click", () => this.callbacks.onUpdate({ position: "top" }));

    // ASR: без ключа облака/модели локального движка первый тап раскрывает
    // настройки (статус подскажет); ⚙ — настройки, «Отмена» — прервать.
    this.asrRunBtn.addEventListener("click", () => {
      const s = this.asrSettings();
      if (s && s.provider === "local" && !s.localReady) {
        this.showSetup(true, t("Скачайте модель локального движка в настройках ASR"));
        return;
      }
      if (s && s.provider !== "local" && !s.hasApiKey) {
        this.showSetup(true, t("Сохраните ключ API облака в настройках ASR"));
        return;
      }
      this.callbacks.onAsrRun();
    });
    this.asrCancelBtn.addEventListener("click", () => this.callbacks.onAsrCancel());
    this.root.querySelector(".m-duo-asr-gear")!.addEventListener("click", () => {
      this.showSetup(this.asrSetupEl.hidden);
    });
    this.root.querySelector(".m-duo-asr-save")!.addEventListener("click", () => void this.saveAsrSettings());
    // duopulse-168: провайдер и модель локального движка — сегменты/селект;
    // «На устройстве» активна только со скачанной выбранной моделью
    this.asrProvCloudBtn.addEventListener("click", () => this.setAsrProvider("cloud"));
    this.asrProvLocalBtn.addEventListener("click", () => {
      if (this.asrProvLocalBtn.disabled) return;
      this.setAsrProvider("local");
    });
    this.asrLocalSel.addEventListener("change", () => this.syncAsrLocalRow());
    this.asrDlBtn.addEventListener("click", () => {
      this.asrDlBtn.disabled = true;
      void this.callbacks
        .onAsrDownloadModel(this.asrLocalSel.value as LocalModelSizeId)
        .catch((e: unknown) => {
          this.asrDlBtn.disabled = false;
          this.setStatus({
            text: t("duo: {message}", { message: e instanceof Error ? e.message : String(e) }),
            busy: false,
            error: true,
          });
        });
    });
    this.asrDelBtn.addEventListener("click", () => {
      void this.callbacks
        .onAsrDeleteModel(this.asrLocalSel.value as LocalModelSizeId)
        .then(() => this.syncAsrLocalRow())
        .catch((e: unknown) =>
          this.setStatus({
            text: t("duo: {message}", { message: e instanceof Error ? e.message : String(e) }),
            busy: false,
            error: true,
          }),
        );
    });

    this.originalSel.addEventListener("change", () => {
      if (!this.suppressChange) this.callbacks.onUpdate({ originalId: this.originalSel.value || null });
    });
    this.transSel.addEventListener("change", () => {
      if (!this.suppressChange) this.callbacks.onUpdate({ translation: this.transSel.value || null });
    });
    this.rebuildSelects(list());
    this.sync();
    this.setAsrBusy(false);
  }

  /** Перестроить селекты под список дорожек видео (вызов при новой сессии). */
  refreshList(list: MobileTrackList | null): void {
    this.lastList = list;
    this.builtForOriginal = undefined; // форсируем перестройку в sync
    this.sync();
  }

  private rebuildSelects(list: MobileTrackList | null): void {
    this.lastList = list;
    this.builtForOriginal = this.settings().originalId;
    this.suppressChange = true;
    this.originalSel.innerHTML = "";
    if (!list || list.base.length === 0) {
      this.originalSel.disabled = true;
      this.originalSel.add(new Option(t("нет дорожек"), ""));
    } else {
      this.originalSel.disabled = false;
      for (const tr of list.base) {
        this.originalSel.add(
          new Option(
            trackLabel(tr.id, tr.lang, tr.kind, tr.name) + (tr.original ? t(" · оригинал") : ""),
            tr.id,
          ),
        );
      }
    }
    this.transSel.innerHTML = "";
    this.transSel.add(new Option(t("нет"), ""));
    // gtx-цели предлагаем ВСЕГДА (duopulse-182): gtx переводит любой
    // оригинал, включая дорожку ASR видео без субтитров — раньше при
    // null/синтетическом списке селектор вырождался в «нет» и попытка смены
    // языка молча обнуляла настройку перевода
    const gtx = document.createElement("optgroup");
    gtx.label = t("Перевод Google");
    for (const l of GTX_TARGET_LANGS) gtx.appendChild(new Option(l.name, `gtx:${l.code}`));
    this.transSel.append(gtx);
    if (list) {
      const ready = list.base.filter((tr) => tr.id !== this.settings().originalId);
      if (ready.length) {
        const own = document.createElement("optgroup");
        own.label = t("Готовые дорожки видео");
        for (const tr of ready) own.appendChild(new Option(trackLabel(tr.id, tr.lang, tr.kind, tr.name), `track:${tr.id}`));
        this.transSel.append(own);
      }
    }
    this.suppressChange = false;
  }

  /** Синхронизировать контролы с настройками (после патча/нового списка). */
  sync(): void {
    const s = this.settings();
    if (s.originalId !== this.builtForOriginal) this.rebuildSelects(this.lastList);
    this.suppressChange = true;
    this.toggleBtn.textContent = s.enabled ? t("вкл") : t("выкл");
    this.toggleBtn.classList.toggle("m-on", s.enabled);
    if (s.originalId && Array.from(this.originalSel.options).some((o) => o.value === s.originalId)) {
      this.originalSel.value = s.originalId;
    }
    const choice = s.translation ?? "";
    if (Array.from(this.transSel.options).some((o) => o.value === choice)) {
      this.transSel.value = choice;
    }
    this.suppressChange = false;
    this.scaleVal.textContent = `${s.fontScalePct}%`;
    this.offsetVal.textContent = fmtOffset(s.offsetMs);
    this.posBottom.classList.toggle("m-on", s.position === "bottom");
    this.posTop.classList.toggle("m-on", s.position === "top");
  }

  setStatus(st: DuoStatus): void {
    this.statusEl.hidden = !st.text;
    this.statusEl.textContent = st.text ?? "";
    // ошибка — явный флаг статуса (duopulse-138): переведённый текст
    // префиксом «duo: перев» уже не опишешь
    this.statusEl.classList.toggle("m-err", st.error === true && !!st.text);
  }

  /** Занятость ASR-конвейера: «Распознать» ↔ «Отмена» (прогресс — статусом). */
  setAsrBusy(busy: boolean): void {
    this.asrRunBtn.hidden = busy;
    this.asrCancelBtn.hidden = !busy;
    this.asrRunBtn.disabled = !this.hasVideo() && !busy;
  }

  /** Раскрыть/скрыть блок настроек ASR; значения — из текущего снапшота
   * (пустой ключ — не менять; placeholder подскажет, что ключ сохранён). */
  private showSetup(show: boolean, hint?: string): void {
    this.asrSetupEl.hidden = !show;
    if (show) {
      const s = this.asrSettings();
      this.asrProvider = s?.provider === "local" ? "local" : "cloud";
      this.asrLocalSel.value = s?.localModel === "base" ? "base" : "tiny";
      this.asrUrlInput.value = s?.openaiBaseUrl ?? "https://api.openai.com/v1";
      this.asrModelInput.value = s?.openaiModel ?? "whisper-1";
      this.asrEnabledBox.checked = s?.enabled ?? true;
      this.asrKeyInput.value = "";
      this.asrKeyInput.placeholder = s?.hasApiKey ? t("Ключ API") + " · ✓" : t("Ключ API");
      this.syncAsrProvider();
      this.syncAsrLocalRow();
    }
    if (hint) this.setStatus({ text: hint, busy: false });
  }

  /** Сегмент «Облако/На устройстве»: подсветка + видимость блоков. */
  private syncAsrProvider(): void {
    this.asrProvCloudBtn.classList.toggle("m-on", this.asrProvider === "cloud");
    this.asrProvLocalBtn.classList.toggle("m-on", this.asrProvider === "local");
    this.asrCloudFieldsEl.hidden = this.asrProvider === "local";
    // Блок модели локального движка видим при ЛЮБОМ провайдере: без скачанной
    // модели «На устройстве» неактивна — скачать её можно только отсюда
    // (прятать вместе с провайдером = свежий пользователь не дощёлкнется до
    // «Скачать»; репро релизного смоука duopulse-168).
    this.asrLocalEl.hidden = false;
  }

  private setAsrProvider(p: "cloud" | "local"): void {
    this.asrProvider = p;
    this.syncAsrProvider();
  }

  /** Строка модели локального движка: статус скачивания + кнопки;
   * «На устройстве» доступна только со скачанной выбранной моделью
   * (duopulse-168: без модели локальный провайдер не предлагается). */
  private syncAsrLocalRow(): void {
    const s = this.asrSettings();
    const id = this.asrLocalSel.value as LocalModelSizeId;
    const downloaded = s ? (id === "tiny" ? s.modelTinyDownloaded : s.modelBaseDownloaded) : false;
    this.asrProvLocalBtn.disabled = !downloaded;
    if (this.asrProvider === "local" && !downloaded) this.setAsrProvider("cloud");
    this.asrModelStatEl.textContent = downloaded
      ? t("Модель скачана") + " · " + t(this.asrLocalSel.selectedOptions[0]?.text ?? id)
      : t("Модель не скачана");
    this.asrDlBtn.hidden = downloaded;
    this.asrDelBtn.hidden = !downloaded;
    this.asrDlBtn.disabled = false;
  }

  /** Прогресс менеджера моделей (событие Core): строка модели + статус. */
  onAsrModelProgress(phase: string, error?: string): void {
    if (phase === "done") this.syncAsrLocalRow();
    if (phase === "error") this.asrDlBtn.disabled = false;
    if (phase === "download") this.asrDlBtn.disabled = true;
    void error;
  }

  /** Перерисовать блок ASR после обновления снапшота настроек контроллером. */
  refreshAsr(): void {
    if (!this.asrSetupEl.hidden) this.showSetup(true);
  }

  /** Собрать поля и сохранить (ключ пуст — не менять). */
  private async saveAsrSettings(): Promise<void> {
    const local = this.asrProvider === "local";
    const patch: MobileAsrSettingsPatch = {
      enabled: this.asrEnabledBox.checked,
      provider: this.asrProvider,
      localModel: this.asrLocalSel.value as LocalModelSizeId,
      openaiBaseUrl: this.asrUrlInput.value.trim(),
      openaiModel: this.asrModelInput.value.trim() || "whisper-1",
      ...(this.asrKeyInput.value.trim() && !local ? { apiKey: this.asrKeyInput.value.trim() } : {}),
    };
    try {
      const s = await this.callbacks.onAsrSaveSettings(patch);
      this.showSetup(false);
      const ok = s.provider === "local" ? s.localReady : s.hasApiKey;
      const missText = s.provider === "local" ? t("Скачайте модель локального движка в настройках ASR") : t("Сохраните ключ API облака в настройках ASR");
      this.setStatus({ text: ok ? t("Настройки ASR сохранены") : missText, busy: false, error: !ok });
    } catch (e) {
      this.setStatus({
        text: t("duo: {message}", { message: e instanceof Error ? e.message : String(e) }),
        busy: false,
        error: true,
      });
    }
  }

  remove(): void {
    this.root.remove();
  }
}

/** Шаг кегля — как колесо десктопа (style.ts stepScale). */
export function stepScale(current: number, direction: number): number {
  const stepped = Math.round((current + direction * 10) / 10) * 10;
  return Math.min(300, Math.max(75, stepped));
}

export function fmtOffset(ms: number): string {
  const sign = ms > 0 ? "+" : ms < 0 ? "−" : "";
  const s = Math.abs(ms) / 1000;
  return t("{v} с", { v: `${sign}${s.toFixed(1)}` });
}

export { parseTranslationChoice };
