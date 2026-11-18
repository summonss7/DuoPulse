// @vitest-environment happy-dom
// Тесты контроллера duo мобильной ветки по карточке duopulse-182: «Отмена»
// освобождает конвейер в ЛЮБОЙ фазе (включая зависший офлайн-перевод — кнопка
// возвращается немедленно, а не по таймауту), сбой перевода — честная
// ошибка статуса (error), конвейер не остаётся «занят».
import { describe, expect, it, vi } from "vitest";
import { MobileDuo, type DuoStatus } from "./index";
import type { DuoInvoke } from "./session";

function makeDuo(invoke: DuoInvoke) {
  const statuses: DuoStatus[] = [];
  const el = document.createElement("div");
  document.body.append(el);
  const duo = new MobileDuo(el, () => null, (s) => statuses.push({ ...s }), invoke);
  return { duo, statuses };
}

/** Кэш-хит ASR (сеть не нужна) + lang=en: сразу после распознавания applySet
 *  уходит в авто-перевод gtx:ru — фаза, на которой офлайн и вешал конвейер. */
const startDone = { status: "done", cues: [{ startMs: 0, endMs: 900, text: "hello world" }], lang: "en", fromCache: true, engine: "local:whisper" };

describe("MobileDuo: конвейер ASR не виснет на переводе (duopulse-182)", () => {
  it("«Отмена» в фазе перевода возвращает кнопку сразу (invoke завис)", async () => {
    const invoke: DuoInvoke = (cmd) => {
      if (cmd === "subtitles_asr_start") return Promise.resolve(startDone);
      if (cmd === "duo_translate_texts") return new Promise(() => {}); // офлайн-зависание
      return Promise.resolve({});
    };
    const { duo, statuses } = makeDuo(invoke);
    (duo as unknown as { videoId: string }).videoId = "abc12345678";
    const running = duo.recognizeSpeech();
    await vi.waitFor(() =>
      expect(statuses.some((s) => /перевожу|перевод \d/.test(s.text ?? ""))).toBe(true));
    expect(duo.isAsrBusy).toBe(true);
    duo.cancelAsr();
    expect(duo.isAsrBusy).toBe(false); // кнопка «Распознать речь» вернулась немедленно
    expect(statuses[statuses.length - 1]?.text).toContain("распознавание отменено");
    await running; // зависший перевод погашен абортом (не таймаутом)
    expect(duo.isAsrBusy).toBe(false);
  });

  it("отказ перевода — статус-ошибка, конвейер свободен", async () => {
    const invoke: DuoInvoke = (cmd) => {
      if (cmd === "subtitles_asr_start") return Promise.resolve(startDone);
      if (cmd === "duo_translate_texts") return Promise.reject(new Error("сеть: Network is unreachable"));
      return Promise.resolve({});
    };
    const { duo, statuses } = makeDuo(invoke);
    (duo as unknown as { videoId: string }).videoId = "abc12345678";
    await duo.recognizeSpeech();
    const fail = statuses.find((s) => (s.text ?? "").includes("перевод недоступен"));
    expect(fail).toBeTruthy();
    expect(fail?.error).toBe(true); // панель красит строку, «занято» больше нет
    expect(fail?.busy).toBe(false);
    expect(duo.isAsrBusy).toBe(false);
  });

  it("успешный прогон возвращает кнопку детерминированно (finally переэмулирует статус)", async () => {
    const invoke: DuoInvoke = (cmd, args) => {
      if (cmd === "subtitles_asr_start") return Promise.resolve(startDone);
      if (cmd === "duo_translate_texts") {
        const texts = (args as { texts: string[] }).texts;
        return Promise.resolve(texts.map((t) => `✓${t}`));
      }
      return Promise.resolve({});
    };
    const { duo, statuses } = makeDuo(invoke);
    (duo as unknown as { videoId: string }).videoId = "abc12345678";
    await duo.recognizeSpeech();
    expect(duo.isAsrBusy).toBe(false);
    // последний статус — повторная эмуляция после finally: панель перечитала
    // занятость (раньше событие done Core могло прийти раньше конца цепочки)
    expect(statuses[statuses.length - 1]?.busy).toBe(false);
  });

  it("позднее событие done Core не затирает ошибку перевода", async () => {
    const invoke: DuoInvoke = (cmd) => {
      if (cmd === "subtitles_asr_start") return Promise.resolve(startDone);
      if (cmd === "duo_translate_texts") return Promise.reject(new Error("сеть: Dns Failed"));
      return Promise.resolve({});
    };
    const { duo, statuses } = makeDuo(invoke);
    (duo as unknown as { videoId: string }).videoId = "abc12345678";
    await duo.recognizeSpeech();
    expect(statuses.some((s) => (s.text ?? "").includes("перевод недоступен"))).toBe(true);
    // событие done приходит ПОСЛЕ ошибки applySet (офлайн-отказ быстрее доставки)
    duo.onAsrProgress({ tabId: "abc12345678", videoKey: "k", engine: "local:whisper", phase: "done", done: 5, total: 5, fromCache: true });
    expect(statuses[statuses.length - 1]?.text).toContain("перевод недоступен");
  });
});
