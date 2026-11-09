// Тесты чистой части OTA мобильной ветки (duopulse-083): калитка тихой
// проверки, метка localStorage, разметка исхода проверки в UI-состояние.
// duopulse-101: у error появился retry («Повторить»), install получил
// гвардию от двойного клика — оба покрытия здесь, invoke/listen замоканы.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { createMobileUpdater, mb, shouldSilentCheck, uiFromCheck, type MobileUpdateAsset, type MobileUpdateCheck, type UpdaterUi } from "./updater";

function check(partial: Partial<MobileUpdateCheck>): MobileUpdateCheck {
  return {
    status: "latest",
    current: "0.1.7",
    latest: null,
    notes: null,
    publishedAt: null,
    asset: null,
    error: null,
    ...partial,
  };
}

describe("shouldSilentCheck", () => {
  const period = 10 * 60 * 1000;

  it("не проверяли — проверяем", () => {
    expect(shouldSilentCheck(null, 123, period)).toBe(true);
  });

  it("внутри периода — тишина, после его выхода — проверяем", () => {
    expect(shouldSilentCheck(1000, 1000 + period - 1, period)).toBe(false);
    expect(shouldSilentCheck(1000, 1000 + period, period)).toBe(false);
    expect(shouldSilentCheck(1000, 1000 + period + 1, period)).toBe(true);
  });

  it("битая метка — как не проверяли", () => {
    // readLastCheck превращает битое в null; калитка должна это покрывать
    expect(shouldSilentCheck(null, Date.now(), period)).toBe(true);
  });
});

describe("uiFromCheck", () => {
  it("available — баннер с версией и notes (и тихая, и ручная)", () => {
    const ui = uiFromCheck(check({ status: "available", latest: "0.1.8", notes: "Субтитры и перевод" }), false);
    expect(ui).toEqual({ kind: "available", version: "0.1.8", notes: "Субтитры и перевод" });
    expect(uiFromCheck(check({ status: "available", latest: "0.1.8", notes: null }), true)).toEqual({
      kind: "available",
      version: "0.1.8",
      notes: null,
    });
  });

  it("latest: ручная — «✓ последняя», тихая — ничего", () => {
    expect(uiFromCheck(check({ current: "0.1.8" }), true)).toEqual({ kind: "latest", version: "0.1.8" });
    expect(uiFromCheck(check({ current: "0.1.8" }), false)).toEqual({ kind: "idle" });
  });

  it("network-error/bad-manifest: ручная — ошибка с повтором, тихая — тишина (§5)", () => {
    for (const status of ["network-error", "bad-manifest"] as const) {
      expect(uiFromCheck(check({ status, error: "HTTP 500" }), true)).toEqual({
        kind: "error",
        message: "HTTP 500",
        retry: "check",
      });
      expect(uiFromCheck(check({ status, error: "HTTP 500" }), false)).toEqual({ kind: "idle" });
    }
  });
});

describe("createMobileUpdater.install", () => {
  const asset: MobileUpdateAsset = {
    name: "DuoPulse-0.1.14-android-release.apk",
    url: "https://example.invalid/DuoPulse-0.1.14-android-release.apk",
    size: 8797439,
    sha256: "a".repeat(64),
  };
  const storage = { getItem: () => null, setItem: () => {} };

  function updaterWith(states: UpdaterUi[]) {
    const u = createMobileUpdater((ui) => states.push(ui), storage);
    const mock = vi.mocked(invoke);
    mock.mockImplementation((cmd: string) => {
      if (cmd === "updater_check") {
        return Promise.resolve(
          check({ status: "available", latest: "0.1.14", asset }),
        );
      }
      if (cmd === "updater_download") return Promise.resolve("/cache/updates/apk.apk");
      return Promise.resolve("started");
    });
    return { u, mock };
  }

  it("скачивание+установка: installing после started", async () => {
    const states: UpdaterUi[] = [];
    const { u } = updaterWith(states);
    await u.check(false);
    await u.install();
    expect(states[states.length - 1]).toEqual({ kind: "installing", version: "0.1.14" });
  });

  it("двойной клик по «Обновить» не запускает второе скачивание", async () => {
    const states: UpdaterUi[] = [];
    const { u, mock } = updaterWith(states);
    mock.mockImplementation((cmd: string) => {
      if (cmd === "updater_check") return Promise.resolve(check({ status: "available", latest: "0.1.14", asset }));
      if (cmd === "updater_download") return new Promise<string>(() => {}); // висит — как обрыв
      return Promise.resolve("started");
    });
    await u.check(false);
    void u.install();
    void u.install(); // вторая — мимо: уже качаем
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.mock.calls.filter((c) => c[0] === "updater_download")).toHaveLength(1);
  });

  it("обрыв скачивания — error с retry: install (кнопка «Повторить»)", async () => {
    const states: UpdaterUi[] = [];
    const { u, mock } = updaterWith(states);
    mock.mockImplementation((cmd: string) => {
      if (cmd === "updater_check") return Promise.resolve(check({ status: "available", latest: "0.1.14", asset }));
      if (cmd === "updater_download") return Promise.reject(new Error("скачивание не удалось за 5 попыток: download: timed out"));
      return Promise.resolve("started");
    });
    await u.check(false);
    await u.install();
    expect(states[states.length - 1]).toMatchObject({ kind: "error", retry: "install" });
  });
});

describe("mb", () => {
  it("округляет в целые МБ, минимум 1", () => {
    expect(mb(0)).toBe("1 МБ");
    expect(mb(512 * 1024)).toBe("1 МБ");
    expect(mb(7.6 * 1024 * 1024)).toBe("8 МБ");
  });
});
