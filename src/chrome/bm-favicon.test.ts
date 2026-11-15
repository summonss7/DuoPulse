// @vitest-environment happy-dom
// DuoPulse — фавикон сайта в значке чипа/строки (карточка duopulse-155):
// applyFavicon вешает <img src="/favicon.ico"> поверх бейджа-буквы; загрузка
// гасит бейдж (has-fav), ошибка — возвращает бейдж (значок остаётся как был).
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve() }));
import { applyFavicon } from "./bmbar";

const ico = (): HTMLElement => {
  const el = document.createElement("i");
  el.className = "bm-ico";
  el.textContent = "Y";
  return el;
};

describe("duopulse-155: applyFavicon — фавикон поверх бейджа-буквы", () => {
  it("у сайтового адреса — img с адресом /favicon.ico", () => {
    const el = ico();
    applyFavicon(el, "https://www.youtube.com/watch?v=1");
    const img = el.querySelector("img.bm-fav");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://www.youtube.com/favicon.ico");
    expect(el.classList.contains("has-fav")).toBe(false); // ещё не загрузился
  });

  it("загрузился — бейдж гасится (has-fav, градиент снят)", () => {
    const el = ico();
    el.style.background = "linear-gradient(145deg, red, blue)";
    applyFavicon(el, "https://example.com/");
    const img = el.querySelector("img.bm-fav") as HTMLImageElement;
    img.dispatchEvent(new Event("load"));
    expect(el.classList.contains("has-fav")).toBe(true);
    expect(el.style.background).toBe("");
  });

  it("не загрузился (404/оффлайн) — img убран, бейдж-буква остаётся", () => {
    const el = ico();
    applyFavicon(el, "https://no-favicon.example/");
    const img = el.querySelector("img.bm-fav") as HTMLImageElement;
    img.dispatchEvent(new Event("error"));
    expect(el.querySelector("img.bm-fav")).toBeNull();
    expect(el.classList.contains("has-fav")).toBe(false);
    expect(el.textContent).toBe("Y");
  });

  it("внутренние страницы (duopulse://) — без img, только бейдж", () => {
    const el = ico();
    applyFavicon(el, "duopulse://history");
    expect(el.querySelector("img")).toBeNull();
  });
});
