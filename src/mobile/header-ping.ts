/** duopulse-212: шапка web-оверлея — живое зеркало ряда 1 старта (бейдж
 *  вкладок, «⬇», щит VPN). Прежде Kotlin узнавал состав только на смене
 *  URL/открытии оверлея (syncChrome → хук __duopulseHeaderState), пока
 *  оверлей открыт, старт менялся (закрылась вкладка, поднялся тоннель) —
 *  зеркало расходилось с оригиналом до следующей навигации.
 *
 *  signalOnChange — чистое ядро (тесты signalOnChange.test-стиля ниже в
 *  header-ping.test.ts): пачка событий сворачивается debounce-очередью в
 *  один send, одинаковая сигнатура состояния пинга не порождает (шум
 *  renderBadge, перезаписывающего textContent тем же значением).
 *  watchHeaderState — DOM-обвязка: мутации бейджа вкладок и щита VPN старта
 *  плюс внешний флаг extra() (videoOpen для «⬇» — notify() из onTabActive).
 *  send — invoke mobile_web_header_ping: Kotlin переопросит хук у ВИДИМОГО
 *  оверлея, спрятанный игнорирует (пустых переопросов нет — батарея). */

export interface HeaderStateWatch {
  /** Флаг вне DOM изменился (videoOpen) — проверить сигнатуру. */
  notify(): void;
  /** Наблюдение больше не нужно (оверлей закрыт навсегда/тест). */
  stop(): void;
}

/** Debounce-очередь «одно событие — один send» с фильтром одинакового
 *  состояния: notify() копится в один таймер, в момент срабатывания
 *  сверяется сигнатура — не изменилась, молчим. Возвращает сам notify. */
export function signalOnChange(
  getSignature: () => string,
  send: () => void,
  delayMs = 200,
): () => void {
  let last: string | null = null;
  let queued = false;
  return function notify() {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      const sig = getSignature();
      if (sig === last) return;
      last = sig;
      send();
    }, delayMs);
  };
}

export function watchHeaderState(
  badge: Element,
  shield: Element,
  extra: () => string,
  send: () => void,
): HeaderStateWatch {
  const getSignature = () =>
    `${badge.textContent}\u0001${(badge as HTMLElement).hidden}\u0001${(shield as HTMLElement).hidden}\u0001${extra()}`;
  const notify = signalOnChange(getSignature, send);
  // textContent-сеттер заменяет текстовый узел даже тем же значением —
  // потому childList, фильтр одинаковых сигнатур выше гасит шум renderBadge
  const tabsObs = new MutationObserver(notify);
  tabsObs.observe(badge, { attributeFilter: ["hidden"], childList: true, subtree: true });
  const vpnObs = new MutationObserver(notify);
  vpnObs.observe(shield, { attributeFilter: ["hidden"] });
  return {
    notify,
    stop() {
      tabsObs.disconnect();
      vpnObs.disconnect();
    },
  };
}
