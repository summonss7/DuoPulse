// Тесты контроллера загрузки музыки (duopulse-121): чистые форматтеры и
// конечный автомат на фейковом транспорте (invoke/listen), без Tauri.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMusicDownloader,
  idleMusicState,
  mb,
  musicStatusText,
  type MusicUiState,
} from "./download";
import type { UnlistenFn } from "@tauri-apps/api/event";

describe("musicStatusText/mb", () => {
  it("прогресс с процентами и размерами", () => {
    const s: MusicUiState = { kind: "downloading", downloaded: 1226824, total: 4083640, message: "" };
    expect(mb(4083640)).toBe("3.9 МБ");
    expect(mb(0)).toBe("0 МБ");
    expect(mb(12 * 1024 * 1024)).toBe("12 МБ");
    expect(musicStatusText(s)).toBe("♪ Музыка: качаю 30% (1.2 МБ из 3.9 МБ)");
  });
  it("неизвестный размер — только проценты-прочерк, итог/ошибка/idle", () => {
    expect(musicStatusText({ kind: "downloading", downloaded: 5, total: 0, message: "" })).toBe(
      "♪ Музыка: качаю 0%",
    );
    expect(
      musicStatusText({ kind: "done", downloaded: 0, total: 0, message: "Song.m4a · Music/DuoPulse" }),
    ).toBe("♪ Музыка сохранена: Song.m4a · Music/DuoPulse");
    expect(musicStatusText({ kind: "error", downloaded: 0, total: 0, message: "сеть" })).toBe(
      "♪ Музыка: сеть",
    );
    expect(musicStatusText(idleMusicState())).toBe("");
  });
});

type ProgressHandler = (e: {
  payload: { videoId: string; downloaded: number; total: number };
}) => void;

function fakePorts() {
  const rendered: MusicUiState[] = [];
  let progressHandler: ProgressHandler | null = null;
  let invokeImpl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> = async () => "ok";
  const ports = {
    getVideoId: () => "abc12345678" as string | null,
    render: (s: MusicUiState) => rendered.push(s),
    doInvoke: vi.fn((cmd: string, args?: Record<string, unknown>) => invokeImpl(cmd, args)),
    // подписка сразу отдаёт слушателя в тест
    doListen: vi.fn(
      (
        _name: string,
        h: ProgressHandler,
      ): Promise<UnlistenFn> =>
        new Promise((res) => {
          progressHandler = h;
          res(() => {});
        }),
    ),
  };
  return {
    ports,
    rendered,
    progress: (p: { videoId: string; downloaded: number; total: number }) =>
      progressHandler?.({ payload: p }),
    setInvoke: (fn: typeof invokeImpl) => (invokeImpl = fn),
  };
}

describe("createMusicDownloader", () => {
  afterEach(() => vi.restoreAllMocks());

  it("старт → прогресс → итог рисуется по порядку", async () => {
    const f = fakePorts();
    const d = createMusicDownloader(f.ports);
    await vi.waitFor(() => expect(f.ports.doListen).toHaveBeenCalled());
    f.setInvoke(async () => "Song.m4a · Music/DuoPulse");
    d.start();
    expect(d.stateSnapshot().kind).toBe("downloading");
    f.progress({ videoId: "abc12345678", downloaded: 1000, total: 2000 });
    await vi.waitFor(() => expect(d.stateSnapshot().kind).toBe("done"));
    const last = f.rendered[f.rendered.length - 1];
    expect(last.kind).toBe("done");
    expect(last.message).toBe("Song.m4a · Music/DuoPulse");
    expect(f.rendered.some((s) => s.kind === "downloading" && s.total === 2000)).toBe(true);
  });

  it("без видео — подсказка; ошибка Rust — честной строкой; повторный тап не дублирует старт", async () => {
    const f = fakePorts();
    f.ports.getVideoId = () => null;
    const d = createMusicDownloader(f.ports);
    d.start();
    expect(d.stateSnapshot().kind).toBe("error");
    expect(d.stateSnapshot().message).toContain("видео");

    f.ports.getVideoId = () => "abc12345678";
    let resolveInvoke: (v: unknown) => void = () => {};
    f.setInvoke(() => new Promise((res) => (resolveInvoke = res)));
    d.start();
    d.start(); // идёт загрузка — второго invoke быть не должно
    expect(f.ports.doInvoke).toHaveBeenCalledTimes(1);
    resolveInvoke("x.m4a · Music/DuoPulse");
    await vi.waitFor(() => expect(d.stateSnapshot().kind).toBe("done"));

    f.setInvoke(async () => {
      throw new Error("сеть недоступна");
    });
    d.start();
    await vi.waitFor(() => expect(d.stateSnapshot().kind).toBe("error"));
    expect(d.stateSnapshot().message).toContain("сеть");
  });
});
