// Канал content → Core (docs/05 §1: content/messaging — до bridge). Контентные
// вкладки не имеют tauri-IPC (capability tab-* её не даёт, docs/05 §2), поэтому
// транспорт — WebMessage WebView2: window.chrome.webview.postMessage (строка,
// как в content/cosmetic.js) в обе стороны. Вне WebView2 (jsdom-тесты, обычный
// браузер) канал молча отсутствует — модуль не падает и не мешает странице.

interface WebviewHost {
  postMessage(message: string): void;
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  removeEventListener(type: string, listener: (event: { data: string }) => void): void;
}

function host(): WebviewHost | null {
  const w = window as unknown as { chrome?: { webview?: WebviewHost } };
  return w.chrome?.webview ?? null;
}

/** Сообщение в Core (JSON-строкой; Best-effort — канал может не быть). */
export function postToCore(message: Record<string, unknown>): void {
  try {
    host()?.postMessage(JSON.stringify(message));
  } catch {
    /* страница не виновата — молча */
  }
}

/** Подписка на сообщения Core (JSON-строки WebMessage). Не-JSON игнорируются. */
export function onCoreMessage(handler: (message: Record<string, unknown>) => void): () => void {
  const listener = (event: { data: string }): void => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (parsed && typeof parsed === "object") handler(parsed);
  };
  host()?.addEventListener("message", listener);
  return () => host()?.removeEventListener("message", listener);
}
