// @vitest-environment happy-dom
// DuoPulse — фавикон сайта в значке чипа/строки (карточка duopulse-161):
// Core (history.favicon) разбирает <link rel=icon> в HTML страницы и отдаёт
// data-URL; applyFavicon ждёт ответ моста и вешает <img> поверх бейджа-буквы;
// загрузка гасит бейдж (has-fav), «иконки нет» (icon: null) и ошибки моста —
// бейдж остаётся, как раньше. Дубли в полёте и кэш сеанса — один invoke.
import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn(
  (_cmd: string, _args: unknown): Promise<{ icon: string | null }> =>
    Promise.resolve({ icon: null }),
);
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => invokeMock(cmd, args),
}));
import { applyFavicon } from "./bmbar";

const ico = (host = document.body): HTMLElement => {
  const el = document.createElement("i");
  el.className = "bm-ico";
  el.textContent = "Y";
  host.append(el); //.isConnected: ответ моста приходит после рендера
  return el;
};

describe("duopulse-161: applyFavicon — фавикон через history.favicon", () => {
  it("иконка есть — img с data-URL, загрузка гасит бейдж", async () => {
    invokeMock.mockImplementationOnce(() =>
      Promise.resolve({ icon: "data:image/png;base64,AAA" }),
    );
    const el = ico();
    applyFavicon(el, "https://github.com/");
    await vi.waitFor(() => expect(el.querySelector("img.bm-fav")).not.toBeNull());
    expect(invokeMock).toHaveBeenCalledWith("history_favicon", {
      params: { url: "https://github.com/" },
    });
    const img = el.querySelector("img.bm-fav") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAA");
    el.style.background = "linear-gradient(145deg, red, blue)";
    img.dispatchEvent(new Event("load"));
    expect(el.classList.contains("has-fav")).toBe(true);
    expect(el.style.background).toBe("");
  });

  it("иконки нет (icon: null) — бейдж-буква остаётся, img нет", async () => {
    const el = ico();
    applyFavicon(el, "https://noicon.example/");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r)); // промисы отыграли
    expect(el.querySelector("img.bm-fav")).toBeNull();
    expect(el.textContent).toBe("Y");
  });

  it("ошибка моста — бейдж остаётся, без rejected-хвостов", async () => {
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const el = ico();
    applyFavicon(el, "https://broken.example/");
    await new Promise((r) => setTimeout(r));
    expect(el.querySelector("img.bm-fav")).toBeNull();
    expect(el.textContent).toBe("Y");
  });

  it("внутренние страницы (duopulse://) — invoke не зовётся", () => {
    const el = ico();
    applyFavicon(el, "duopulse://history");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(el.querySelector("img")).toBeNull();
  });

  it("дедуп в полёте и кэш сеанса: три значка одного хоста — один invoke", async () => {
    invokeMock.mockImplementationOnce(() =>
      Promise.resolve({ icon: "data:image/png;base64,BBB" }),
    );
    const a = ico();
    const b = ico();
    applyFavicon(a, "https://same.example/x");
    applyFavicon(b, "https://same.example/y");
    await vi.waitFor(() => expect(a.querySelector("img.bm-fav")).not.toBeNull());
    await vi.waitFor(() => expect(b.querySelector("img.bm-fav")).not.toBeNull());
    const later = ico();
    applyFavicon(later, "https://same.example/z"); // из кэша сеанса
    await vi.waitFor(() => expect(later.querySelector("img.bm-fav")).not.toBeNull());
    const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "history_favicon");
    expect(calls).toHaveLength(1);
  });

  it("строка перерисовалась, пока Core фетчил, — img не вешается", async () => {
    invokeMock.mockImplementationOnce(() =>
      Promise.resolve({ icon: "data:image/png;base64,CCC" }),
    );
    const el = ico();
    applyFavicon(el, "https://detached.example/");
    el.remove(); // рендер заменил строку до ответа
    await new Promise((r) => setTimeout(r));
    expect(el.querySelector("img.bm-fav")).toBeNull();
  });
});
