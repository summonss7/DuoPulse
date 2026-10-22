// DuoPulse — модель отображения страницы ошибки загрузки (карточка
// duopulse-048, docs/02 §6.2): чистые функции без DOM — контекст Core
// (адрес/причина) и срез статуса VPN переводятся в данные рендера: хост для
// split-правила и решение кнопки «этот сайт — через туннель» (автоповтор
// по правилу или подсказка включить туннель/split-режим).

/** Хост упавшего адреса для split-правила «этот сайт — через туннель»:
 *  только внешние http/https, «www.» снимается (правило ловит домен и
 *  поддомены); IP-адреса не считаются — правило доменное. null — кнопки
 *  «через туннель» не будет. */
export function errorHost(url: string | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "");
  if (!host || host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  return host;
}

/** Минимальный срез vpn.status, нужный решению кнопки. */
export interface VpnSlice {
  /** Фактический маршрут роутера: off | proxy | wg. */
  mode: string;
  /** Режим split-правил: off | global | split. */
  routing: string;
}

/** Что делать после vpn.add_rule: туннель поднят и правило действует
 *  (режим split/global) — сразу повторная загрузка по правилу; иначе —
 *  подсказка: включить туннель и/или split-режим, затем «Повторить». */
export function tunnelAction(st: VpnSlice | null): { retry: boolean; note: string } {
  if (!st) {
    return {
      retry: false,
      note: "Правило добавлено, статус туннеля неизвестен — нажмите «Повторить».",
    };
  }
  if (st.mode !== "wg") {
    return {
      retry: false,
      note: "Правило добавлено. Включите туннель (щит в панели VPN) и нажмите «Повторить».",
    };
  }
  if (st.routing === "off") {
    return {
      retry: false,
      note: "Правило добавлено, но режим выключен — включите split в панели VPN и повторите.",
    };
  }
  return { retry: true, note: "Правило добавлено — пробуем снова через туннель…" };
}
