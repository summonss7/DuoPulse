// DuoPulse — бар «Появилась новая версия» (карточка duopulse-127): строка
// поверх таб-бара, пока проверка фида нашла обновление и пользователь его
// не отклонил. Логика показа чистая и не знает DOM — её держат юнит-тесты
// (update-bar.test.ts), применение к разметке — initUpdateBar ниже.
// Источники те же, что у точки на «⋮» (duopulse-067): событие
// updater:check_done (автопроверка старта ~20 с и ручные из настроек) и
// updater.status на старте хрома (pending прошлой проверки — бар виден
// сразу, не дожидаясь автопроверки). «Отмена» помнит отклонённую версию
// в sessionStorage: до перезапуска бар не возвращается, точка на «⋮»
// остаётся как ненавязчивый признак; новая версия снова показывает бар.
import { listen } from "@tauri-apps/api/event";
import { bridge } from "../bridge";
import type { UpdaterCheckResult } from "../bridge/gen/types";

/** Ключ sessionStorage: версия, отклонённая кнопкой «Отмена». */
const DISMISS_KEY = "duopulse.updateBar.dismissed";

/** Состояние бара (применяет initUpdateBar). */
export interface UpdateBarState {
  /** Показать бар — есть непросмотренное обновление. */
  show: boolean;
  /** Версия найденного пакета (для текста; null — нет). */
  version: string | null;
}

/** Итог проверки фида → состояние бара (duopulse-127). */
export function updateBarState(res: UpdaterCheckResult | null, dismissed: string | null): UpdateBarState {
  const on = !!res?.available && !res?.error && typeof res?.version === "string";
  return { show: on && res!.version !== dismissed, version: on ? res!.version! : null };
}

/** Текст бара: версия + заметки релиза, если фид их дал. */
export function updateBarText(state: UpdateBarState, notes?: string | null): string {
  if (!state.show || !state.version) return "";
  return notes ? `Появилась новая версия ${state.version} — ${notes}` : `Появилась новая версия ${state.version}`;
}

/** Инициализация бара в хроме: события, стартовый статус, кнопки. */
export function initUpdateBar(): void {
  const bar = document.getElementById("updateBar");
  const text = document.getElementById("updateBarText");
  const install = document.getElementById("updateBarInstall");
  const cancel = document.getElementById("updateBarCancel");
  if (!bar || !text || !install || !cancel) return;
  const err = (e: unknown): void => console.error("update-bar:", e);

  let dismissed: string | null = null;
  try {
    dismissed = sessionStorage.getItem(DISMISS_KEY);
  } catch {
    /* приватный режим/квота — бар просто без памяти об отказе */
  }

  let foundVersion: string | null = null; // версия последнего найденного пакета

  const render = (res: UpdaterCheckResult | null): void => {
    const st = updateBarState(res, dismissed);
    foundVersion = st.version;
    text.textContent = st.show ? updateBarText(st, res?.notes ?? null) : "";
    bar.hidden = !st.show;
  };

  // pending прошлой проверки — бар виден сразу, не дожидаясь автопроверки
  void bridge.updater
    .status()
    .then((st) =>
      render(
        st.pending
          ? { available: true, checkedAtUnix: Date.now(), dateUnix: st.pending.dateUnix, error: null, notes: st.pending.notes ?? null, source: st.source, version: st.pending.version }
          : st.lastCheck ?? null,
      ),
    )
    .catch(err);

  void listen<UpdaterCheckResult>(bridge.events.updaterCheckDone, (ev) => render(ev.payload));

  cancel.addEventListener("click", () => {
    // отклонена найденная версия: до перезапуска бар не возвращается
    dismissed = foundVersion;
    try {
      if (foundVersion) sessionStorage.setItem(DISMISS_KEY, foundVersion);
    } catch {
      /* без памяти — просто скрыть до следующей проверки */
    }
    bar.hidden = true;
  });

  install.addEventListener("click", () => {
    text.textContent = "Скачиваю пакет и устанавливаю — приложение перезапустится…";
    cancel.hidden = true;
    install.hidden = true;
    // Windows: установщик пассивно ставит пакет и сам перезапускает
    // приложение — ответ команды при успехе не приходит (как в настройках).
    void bridge.updater.install().catch((e) => {
      text.textContent = String(e);
      cancel.hidden = false;
      install.hidden = false;
    });
  });
}
