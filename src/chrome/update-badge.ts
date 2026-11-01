// DuoPulse — бейдж найденного обновления на кнопке «⋮» (карточка
// duopulse-067): логика показа/скрытия чистая и не знает DOM — её держат
// юнит-тесты (update-badge.test.ts), применение к кнопке — mainmenu.ts.
// Источник — событие updater:check_done (итог любой проверки фида:
// автопроверка старта ~20 с и ручные из «Настроек → Обновления»).
// Инвариант зеркален книге проверок Core: available=true → pending есть;
// «у вас последняя версия» и отказ сети (available=false) — pending в Core
// тем же переходом очищается, индикатор гаснет; после установки приложение
// перезапускается — индикатора просто нет.
import type { UpdaterCheckResult } from "../bridge/gen/types";

/** Состояние индикатора кнопки «⋮» (применяет mainmenu). */
export interface UpdateBadgeState {
  /** Зажечь точку — есть ждущее пользователя обновление. */
  on: boolean;
  /** Версия найденного пакета (для подсказки кнопки; null — нет). */
  version: string | null;
}

/** Итог проверки фида → состояние индикатора «⋮» (duopulse-067). */
export function updateBadgeState(res: UpdaterCheckResult | null): UpdateBadgeState {
  const on = !!res?.available && !res?.error && typeof res?.version === "string";
  return { on, version: on ? res!.version! : null };
}

/** Подсказка кнопки «⋮»: базовый текст или с версией найденного пакета. */
export function updateBadgeTitle(state: UpdateBadgeState, base = "Меню браузера"): string {
  return state.on ? `${base} — доступна версия ${state.version}` : base;
}
