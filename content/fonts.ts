// Доставка гарнитур субтитров в контекст страницы (карточка duopulse-068).
// Оверлей живёт в документе просматриваемого сайта, где фирменные @font-face
// из src/theme/fonts.css не загружены: у страниц свой CSP (YouTube data:-шрифты
// в font-src не пускает), а файлы woff2 недоступны. Поэтому гарнитура
// доставляется данными: WebMessage-запрос {duopulse:"font-request", family} →
// ответ Core {duopulse:"font-data", family, faces:[{weight, unicodeRange,
// data(base64)}]} → FontFace из ArrayBuffer (сетевой загрузки нет — CSP не
// подчинён) в document.fonts. «system» доставки не требует; вне WebView2
// (jsdom-тесты, обычный браузер) канала нет — молча остаётся системный
// фолбэк cssFontFamily.

import { hasCoreChannel, onCoreMessage, postToCore } from "./messaging";
import { FONT_FAMILY_VALUES } from "./overlay/style";

/** Гарнитуры, чьи сабсеты уже запрошены/получены (один запрос на вкладку:
 * Core отвечает полным набором, повтор не нужен). */
const requested = new Set<string>();
let subscribed = false;

/** base64 (стандартный алфавит, с padding и без) → бинарник woff2-сабсета. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(new ArrayBuffer((clean.length * 3) >> 2));
  let acc = 0;
  let bits = 0;
  let pos = 0;
  for (const ch of clean) {
    const code = ch.charCodeAt(0);
    const v =
      code >= 65 && code <= 90
        ? code - 65
        : code >= 97 && code <= 122
          ? code - 97 + 26
          : code >= 48 && code <= 57
            ? code - 48 + 52
            : code === 43
              ? 62
              : 63;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, pos);
}

/** Сабсет из ответа Core → декодированное лицо для FontFace (чистая часть
 * для тестов; мусорные элементы пропускаются снисходительно). */
export interface DecodedFace {
  weight: string;
  unicodeRange: string | undefined;
  bytes: Uint8Array<ArrayBuffer>;
}

export function decodeFaces(faces: unknown): DecodedFace[] {
  if (!Array.isArray(faces)) return [];
  const out: DecodedFace[] = [];
  for (const f of faces) {
    if (typeof f !== "object" || f === null) continue;
    const face = f as Record<string, unknown>;
    const data = face["data"];
    const weight = face["weight"];
    if (typeof data !== "string" || typeof weight !== "number") continue;
    out.push({
      weight: String(weight),
      unicodeRange: typeof face["unicodeRange"] === "string" ? face["unicodeRange"] : undefined,
      bytes: base64ToBytes(data),
    });
  }
  return out;
}

/** Загрузить гарнитуру в document.fonts, если ещё не запрошена. Вызывается
 * оверлеем на каждое применение стиля — дёшево (проверка Set); ошибки
 * доставки тихи: плашка останется на системном фолбэке, показ не ломается. */
export function ensureFontFamilyLoaded(family: string): void {
  if (family === "system" || !(FONT_FAMILY_VALUES as readonly string[]).includes(family)) return;
  if (requested.has(family)) return;
  if (!hasCoreChannel() || typeof FontFace === "undefined") return;
  const doc = typeof document !== "undefined" ? document : undefined;
  if (!doc || !doc.fonts) return;
  requested.add(family);
  if (!subscribed) {
    subscribed = true;
    onCoreMessage((message) => applyFontData(message, doc));
  }
  postToCore({ duopulse: "font-request", family });
}

/** Ответ Core: регистрация сабсетов FontFace'ами из ArrayBuffer. */
function applyFontData(message: Record<string, unknown>, doc: Document): void {
  if (message["duopulse"] !== "font-data" || message["ok"] !== true) return;
  const family = message["family"];
  if (typeof family !== "string") return;
  for (const face of decodeFaces(message["faces"])) {
    try {
      const font = new FontFace(family, face.bytes, {
        weight: face.weight,
        unicodeRange: face.unicodeRange,
        display: "swap",
      });
      void font.load().then((loaded) => doc.fonts.add(loaded)).catch(() => {
        /* мусорный сабсет — фолбэк cssFontFamily */
      });
    } catch {
      /* конструктор FontFace строг — пропускаем лицо */
    }
  }
}
