// Компенсация «мёртвых» window.open-попапов WebView2 (карточка duopulse-227).
// Popup-окон у WebView2 нет: NewWindowRequested перехватывает ядро (main.rs
// install_new_window_handler) — http(s)-«окно» становится фоновой вкладкой,
// а about:blank и прочие не-http вызовы просто гасятся (Handled=true без
// SetNewWindow), и window.open возвращает null. В Chrome тот же вызов даёт
// живое окно — и кликундеры кино-/туб-сайтов на это рассчитывают (живой
// прогон uakinogo.io, сеть deltarockme→js10.beeparentdo, 23.11.2026):
//   перехватить клик по <a> (preventDefault) → window.open('about:blank',
//   …, 'width=1,height=1') → document.write в попап → по возвращении фокуса
//   НАВИГИРОВАТЬ попап на рекламу и СИМУЛИРОВАТЬ исходный клик пользователя
//   (document.elementFromPoint + initMouseEvent). С null-окном конвейер падает
//   на document.write (TypeError: Cannot read properties of null) —
//   компенсирующий клик не приходит, и ссылки «просто тупо не реагируют»
//   (каждый клик: у кликундера не взводится кука успеха). С сетевым
//   блокировщиком (duopulse-sites) цепочка мертва и всё работает — жалоба
//   приходит с выключенным блокировщиком и при ротации рекламных домёнов.
// Обёртка (ставится бандлом на каждый документ, не зависит от адблока):
// не-http попапы получают живую заглушку окна вместо null, а через 500 мс
// (дольше 400-мс гварда кликундеров от повторного перехвата) на opener
// разыгрывается focus — «попап отработал, фокус вернулся». Скрипт сайта
// доигрывает свою часть: цель попапа уходит обычной фоновой вкладкой
// (сеттер location → нативный window.open → NewWindowRequested ядра),
// исходный клик симулируется и ссылка открывается. http(s)-попапы не
// трогаем: вкладку уже открыло ядро, null честно значит «попап заблокирован»
// — как в Chrome с блокировщиком popup, сайты это умеют (duopulse-057).

/** Тип window.open после обёртки (совместим с нативным по сигнатуре). */
type OpenFn = (url?: string | URL, target?: string, features?: string) => Window | null;

/** Не-http адрес попапа (about:blank/'' — ровно паттерн кликундеров). */
function isNonHttpPopup(href: string): boolean {
  return !/^https?:/i.test(href);
}

/** Мягкая заглука окна: document/methods — no-op, сеттер location — вкладкой. */
function stubPopup(win: Window, url: string, reopen: (href: string) => void): Window {
  let href = url || "about:blank";
  /** Навигация «попапа»: http(s) — фоновой вкладкой через нативный open. */
  const navigate = (value: unknown): void => {
    const target = String(value);
    if (isNonHttpPopup(target)) {
      href = target;
      return;
    }
    reopen(target);
  };
  const location: Record<string, unknown> = {
    toString(): string {
      return href;
    },
    assign: (h: unknown) => navigate(h),
    replace: (h: unknown) => navigate(h),
  };
  Object.defineProperty(location, "href", {
    get: () => href,
    set: (v: unknown) => navigate(v),
    configurable: true,
  });
  const stub: Record<string, unknown> = {
    closed: false,
    name: "",
    opener: win,
    length: 0,
    // document.write в этот «попап» ничего не исполняет — содержимое
    // кликундеров (самоскрытие крошечного окна) молча выбрасывается
    document: {
      write() {},
      writeln() {},
      open() {},
      close() {},
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      body: { appendChild() {} },
    },
    focus() {},
    blur() {},
    close() {
      stub.closed = true;
    },
    moveTo() {},
    moveBy() {},
    resizeTo() {},
    resizeBy() {},
    scrollTo() {},
    scrollBy() {},
    print() {},
    // сообщения от имени попапа не подделываем (OAuth-потоки не путаем)
    postMessage() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
  };
  Object.defineProperty(stub, "location", {
    get: () => location,
    set: (v: unknown) => navigate(v),
    configurable: true,
  });
  return stub as unknown as Window;
}

/**
 * Обернуть window.open (один раз на документ): не-http попапы, погашенные
 * WebView2, получают заглушку + отложенный focus вместо null. Ставится в
 * топ-документ и фреймы (до ветки frame-агента бандла), без зависимостей.
 */
export function installPopupShim(win: Window): void {
  const nativeOpen = win.open as OpenFn & { __duopulsePopupShim?: boolean };
  if (nativeOpen.__duopulsePopupShim) return; // повторная установка (e2e) — уже обёрнуто
  const wrapped = function (
    this: Window,
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null {
    const opened = nativeOpen.call(this, url, target, features);
    if (opened) return opened;
    const href = url === undefined || url === null ? "" : String(url);
    if (!isNonHttpPopup(href)) return null; // http(s) — вкладка уже открыта ядром
    const shim = stubPopup(win, href, (h) => {
      nativeOpen.call(win, h, "_blank");
    });
    win.setTimeout(() => {
      try {
        const ctors = win as unknown as { FocusEvent?: typeof FocusEvent; Event?: typeof Event };
        const FocusCtor = ctors.FocusEvent ?? ctors.Event ?? FocusEvent;
        win.dispatchEvent(new FocusCtor("focus"));
      } catch {
        // экзотическое окружение — компенсацию молча пропускаем
      }
    }, 500);
    return shim;
  } as OpenFn & { __duopulsePopupShim?: boolean };
  wrapped.__duopulsePopupShim = true;
  win.open = wrapped as typeof win.open;
}
