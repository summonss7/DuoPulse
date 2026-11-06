// DuoPulse — модель отображения панели VPN (задача 6.5, docs/02 §6.2):
// чистые функции без DOM — снапшоты/события Core переводят в состояние
// индикатора-щита и тексты панели. Сигнальные цвета — только статусы
// (гайд 06 §2): off — muted, connecting — предупреждение, connected —
// успех, error — ошибка; неон панель не заливает.

/** Состояние индикатора-щита (и строки статуса панели). */
export type ShieldState = "off" | "connecting" | "connected" | "error";

/** Минимальный снапшот, из которого выводится щит (vpn.status и событие
 *  vpn:state_changed оба подходят). Щит — про туннель WireGuard: внешний
 *  прокси (mode "proxy") его не зажигает. */
export function shieldState(st: {
  mode: string;
  wg?: { state?: string | null } | null;
}): ShieldState {
  if (st.mode !== "wg" || !st.wg) return "off";
  const s = st.wg.state ?? "connecting";
  if (s === "connected") return "connected";
  if (s === "error") return "error";
  return "connecting";
}

/** Слово статуса панели по состоянию щита. */
export function shieldLabel(st: ShieldState): string {
  switch (st) {
    case "connected":
      return "Подключён";
    case "connecting":
      return "Подключается";
    case "error":
      return "Ошибка";
    default:
      return "Выключен";
  }
}

/** Деталь строки статуса при выключенном туннеле. Тон зависит от причины:
 *  без профиля это не «просто выключено» — тумблер включить НЕЛЬЗЯ, пока не
 *  импортирован WireGuard-конфиг (DuoPulse — только VPN-клиент, своих
 *  серверов нет, docs/01 F-12; карточка duopulse-076: «всё время пишет
 *  выключен и никогда не включается»). */
export function offDetail(mode: string, hasProfiles: boolean): string {
  if (mode === "proxy") return "туннель выключен — действует внешний прокси";
  if (!hasProfiles)
    return "нет сервера: импортируйте профиль WireGuard (.conf) от вашего VPN-провайдера — DuoPulse собственных серверов не имеет";
  return "трафик браузера — напрямую";
}

/** Титул кнопки-щита при выключенном туннеле: без профиля подсказывает
 *  причину прямо в тултипе (карточка duopulse-076). */
export function shieldOffTitle(mode: string, hasProfiles: boolean): string {
  const routing = routingLabel(mode);
  return hasProfiles
    ? `VPN — ${routing}`
    : `VPN — ${routing} · нужен профиль WireGuard (.conf): импортируйте файл от вашего провайдера`;
}

/** Байты туннеля: «864 Б», «1,2 КиБ», «34 МиБ», «1,1 ГиБ» (одна десятичная,
 *  запятая — по-русски, без хвостовых нулей). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.max(0, Math.round(n))} Б`;
  const units = ["КиБ", "МиБ", "ГиБ", "ТиБ"];
  let v = n;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${String(rounded).replace(".", ",")} ${units[u]}`;
}

/** RTT пинга: null — «—» (ответа нет дольше 3 с; сервер может не отвечать
 *  на ICMP — трафик при этом жив). */
export function formatPing(ms: number | null | undefined): string {
  return ms == null ? "—" : `${ms} мс`;
}

/** Возраст handshake: без него «—», до 5 с «только что», дальше с/мин/ч. */
export function formatHandshake(msAgo: number | null | undefined): string {
  if (msAgo == null) return "—";
  const s = Math.max(0, Math.round(msAgo / 1000));
  if (s < 5) return "только что";
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

/** Хост активной вкладки для строки «этот сайт — через туннель»: внутренние
 *  страницы (duopulse://) и адреса без хоста не считаются, «www.» снимается
 *  (правило ловит домен и поддомены — www только мешает). */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === "duopulse:") return null;
    host = u.hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "");
  return host || null;
}

/** Решение роутера (vpn:route_changed) в каталог сеанса: повторный домен
 *  всплывает в конец (недавние решения — наверху списка). */
export function noteRoute(
  routes: ReadonlyMap<string, string>,
  domain: string,
  route: string,
): Map<string, string> {
  const next = new Map(routes);
  next.delete(domain);
  next.set(domain, route);
  return next;
}

/** Строки «Маршруты сеанса»: свежие сверху, не больше cap (панель не
 *  растягивается на весь экран). */
export function routeRows(
  routes: ReadonlyMap<string, string>,
  cap = 8,
): { domain: string; route: string }[] {
  return [...routes.entries()]
    .slice(-cap)
    .reverse()
    .map(([domain, route]) => ({ domain, route }));
}

/** Человекочитаемый маршрут для строки списка. */
export function routeLabel(route: string): string {
  if (route === "tunnel") return "туннель";
  if (route === "proxy") return "прокси";
  return "напрямую";
}

/** Подпись режима для титула кнопки щита (гайд 06: подпись — помощь, не шум). */
export function routingLabel(routing: string): string {
  if (routing === "global") return "глобальный";
  if (routing === "split") return "split";
  return "выключен";
}
