// Панель настроек duo мобильной ветки (этап 2, duopulse-082): нижний лист
// поверх контента — показ вкл/выкл, оригинал, перевод (готовые дорожки видео
// + Google gtx), кегль, позиция, сдвиг. Мобильная вёрстка/тач: крупные
// контролы, селекты нативные. Панель не знает о загрузке — изменения уходят
// колбэком контроллеру, статус приходит в setStatus.

import { t } from "../../i18n";
import { GTX_TARGET_LANGS, parseTranslationChoice, type DuoMobileSettings } from "./state";
import type { MobileTrackList } from "./session";
import type { DuoStatus } from "./index";

export interface DuoPanelCallbacks {
  onUpdate(patch: Partial<DuoMobileSettings>): void;
  onClose(): void;
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
  private suppressChange = false;
  private lastList: MobileTrackList | null = null;
  private builtForOriginal: string | null | undefined;

  constructor(
    private readonly callbacks: DuoPanelCallbacks,
    private readonly settings: () => DuoMobileSettings,
    list: () => MobileTrackList | null,
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
    this.statusEl = this.root.querySelector<HTMLElement>(".m-duo-status")!;

    this.root.querySelector(".m-duo-close")!.addEventListener("click", () => this.callbacks.onClose());
    this.toggleBtn.addEventListener("click", () => this.callbacks.onUpdate({ enabled: !this.settings().enabled }));
    this.root.querySelector(".m-duo-scale-minus")!.addEventListener("click", () => this.callbacks.onUpdate({ fontScalePct: stepScale(this.settings().fontScalePct, -1) }));
    this.root.querySelector(".m-duo-scale-plus")!.addEventListener("click", () => this.callbacks.onUpdate({ fontScalePct: stepScale(this.settings().fontScalePct, +1) }));
    this.root.querySelector(".m-duo-offset-minus")!.addEventListener("click", () => this.callbacks.onUpdate({ offsetMs: this.settings().offsetMs - 500 }));
    this.root.querySelector(".m-duo-offset-plus")!.addEventListener("click", () => this.callbacks.onUpdate({ offsetMs: this.settings().offsetMs + 500 }));
    this.posBottom.addEventListener("click", () => this.callbacks.onUpdate({ position: "bottom" }));
    this.posTop.addEventListener("click", () => this.callbacks.onUpdate({ position: "top" }));

    this.originalSel.addEventListener("change", () => {
      if (!this.suppressChange) this.callbacks.onUpdate({ originalId: this.originalSel.value || null });
    });
    this.transSel.addEventListener("change", () => {
      if (!this.suppressChange) this.callbacks.onUpdate({ translation: this.transSel.value || null });
    });
    this.rebuildSelects(list());
    this.sync();
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
    if (list) {
      const gtx = document.createElement("optgroup");
      gtx.label = t("Перевод Google");
      for (const l of GTX_TARGET_LANGS) gtx.appendChild(new Option(l.name, `gtx:${l.code}`));
      this.transSel.append(gtx);
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
