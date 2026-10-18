// Синхронизация TS-клиента bridge с контрактом (задача 1.1): клиент обязан
// покрывать все команды bridge/contract.json и звать их tauri-хендлеры.
// Вместе с cargo-тестом contract_file_is_up_to_date замыкает цепочку
// Rust-типы → contract.json → TS-клиент против ручных правок и рассинхрона.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const { bridge } = await import("./client");

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../bridge/contract.json", import.meta.url)), "utf8"),
) as {
  version: number;
  commands: Record<string, { handler: string }>;
  events: Record<string, unknown>;
};

// контрактное имя → [путь в клиенте, пример params]
const cases: Record<string, { path: string[]; params?: unknown }> = {
  "bridge.version": { path: ["bridge", "version"] },
  "tabs.list": { path: ["tabs", "list"] },
  "tabs.open": { path: ["tabs", "open"], params: {} },
  "tabs.close": { path: ["tabs", "close"], params: { id: "tab-1" } },
  "tabs.reopen": { path: ["tabs", "reopen"] },
  "tabs.activate": { path: ["tabs", "activate"], params: { id: "tab-1" } },
  "tabs.sleep": { path: ["tabs", "sleep"], params: { id: "tab-1" } },
  "tabs.wake": { path: ["tabs", "wake"], params: { id: "tab-1" } },
  "nav.navigate": { path: ["nav", "navigate"], params: { url: "https://example.com/" } },
  "nav.resolve_omnibox": { path: ["nav", "resolveOmnibox"], params: { input: "rust lang" } },
  "nav.focus_page": { path: ["nav", "focusPage"] },
  "history.search": { path: ["history", "search"], params: { query: "youtube", limit: 8 } },
  "history.visit": { path: ["history", "visit"], params: { url: "https://example.com/", title: "" } },
  "history.list": { path: ["history", "list"], params: { query: null, offset: 0, limit: 100 } },
  "history.delete_urls": {
    path: ["history", "deleteUrls"],
    params: { urls: ["https://example.com/"] },
  },
  "history.delete_range": { path: ["history", "deleteRange"], params: { fromMs: 0, toMs: 123 } },
  "history.bookmark_add": {
    path: ["history", "bookmarkAdd"],
    params: { url: "https://example.com/", title: "Example" },
  },
  "history.bookmark_remove": {
    path: ["history", "bookmarkRemove"],
    params: { url: "https://example.com/" },
  },
  "history.bookmark_update": {
    path: ["history", "bookmarkUpdate"],
    params: { url: "https://example.com/", title: "Новое имя" },
  },
  "history.bookmark_list": {
    path: ["history", "bookmarkList"],
    params: { query: null, offset: 0, limit: 200 },
  },
  "nav.go_back": { path: ["nav", "goBack"] },
  "nav.go_forward": { path: ["nav", "goForward"] },
  "nav.reload": { path: ["nav", "reload"] },
  "settings.get": { path: ["settings", "get"], params: { key: "proxy" } },
  "settings.set": {
    path: ["settings", "set"],
    params: {
      key: "proxy",
      value: { enabled: false, proto: "socks5", host: "127.0.0.1", port: 1080, login: null },
    },
  },
  "vpn.set_enabled": { path: ["vpn", "setEnabled"], params: { on: true } },
  "vpn.status": { path: ["vpn", "status"] },
  "vpn.test_connection": { path: ["vpn", "testConnection"] },
  "adblock.set_enabled": { path: ["adblock", "setEnabled"], params: { site: null, on: true } },
  "adblock.status": { path: ["adblock", "status"] },
  "adblock.update_lists": { path: ["adblock", "updateLists"], params: { force: true } },
  "perf.snapshot": { path: ["perf", "snapshot"] },
  "perf.save_run": {
    path: ["perf", "saveRun"],
    params: { label: "срез", metrics: { p01_ms: 402, p03_mb: 48 } },
  },
  "perf.list_runs": { path: ["perf", "listRuns"] },
  "subtitles.set_offset": { path: ["subtitles", "setOffset"], params: { offsetMs: 300 } },
  "subtitles.load_file": {
    path: ["subtitles", "loadFile"],
    params: { path: "D:\\subs\\movie.ru.srt" },
  },
  "subtitles.list_tracks": { path: ["subtitles", "listTracks"] },
  "subtitles.set_tracks": {
    path: ["subtitles", "setTracks"],
    params: { ids: ["yt:en", "ru", "es"] },
  },
  "subtitles.set_enabled": { path: ["subtitles", "setEnabled"], params: { on: true } },
  "subtitles.toggle": { path: ["subtitles", "toggle"] },
  "subtitles.set_style": {
    path: ["subtitles", "setStyle"],
    params: { style: { fontScalePct: 120, position: "top" } },
  },
  "subtitles.remove_track": {
    path: ["subtitles", "removeTrack"],
    params: { id: "yt:en+ru" },
  },
  "subtitles.translate_track": {
    path: ["subtitles", "translateTrack"],
    params: { targetLang: "ru" },
  },
  "translate.get_settings": { path: ["translate", "getSettings"] },
  "translate.set_settings": {
    path: ["translate", "setSettings"],
    params: {
      value: { enabled: true, provider: "deepl", deeplPlan: "free", libretranslateUrl: "http://localhost:5000" },
      secret: null,
    },
  },
  "translate.test": { path: ["translate", "test"], params: { text: null, targetLang: "ru" } },
  "app.restart": { path: ["app", "restart"] },
};

describe("bridge-клиент соответствует contract.json", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(null);
  });

  it("клиент покрывает все команды контракта (и наоборот)", () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(contract.commands).sort());
  });

  it("каждая команда зовёт свой tauri-хендлер с параметрами словаря", () => {
    for (const [name, { path: pathSegs, params }] of Object.entries(cases)) {
      let target: unknown = bridge;
      for (const seg of pathSegs) {
        target = (target as Record<string, unknown>)[seg];
      }
      expect(typeof target, `метод ${pathSegs.join(".")} для ${name}`).toBe("function");

      if (params === undefined) {
        (target as () => unknown)();
        expect(invoke, name).toHaveBeenCalledWith(contract.commands[name].handler);
      } else {
        (target as (p: unknown) => unknown)(params);
        // команды с params-структурой получают её под ключом "params"
        expect(invoke, name).toHaveBeenCalledWith(contract.commands[name].handler, { params });
      }
    }
  });

  it("версия контракта зафиксирована (несовместимые изменения — bump + правка тут)", () => {
    expect(contract.version).toBe(5); // v5: событие subtitles:translate_unavailable (4.3); v4: subtitles.translate_track + translate_progress (4.2)
  });

  it("клиент знает все события контракта (listen по имени из bridge.events)", () => {
    const eventNames = Object.values(bridge.events) as string[];
    expect(eventNames.sort()).toEqual(Object.keys(contract.events).sort());
    expect(new Set(eventNames).size).toBe(eventNames.length); // имена уникальны
  });
});
