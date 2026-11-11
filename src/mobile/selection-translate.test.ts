// @vitest-environment happy-dom
// Тесты мобильного входа в перевод выделения (duopulse-103): чтение выделения
// (input/текст), чип у выделения → бабл (переиспользованный из content),
// смена языка с запоминанием, ошибки, лист «Перевести текст…» из меню «⋮».
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSelectionPorts, readSelection, MobileSelectionTranslate } from "./selection-translate";

// контроллеры тестов слушают один документ — глушим после каждого теста
// (иначе следующий тест читает чужие чипы/баблы с прошлых слушателей)
const live: MobileSelectionTranslate[] = [];

function controller(p: ReturnType<typeof ports>): MobileSelectionTranslate {
  const st = new MobileSelectionTranslate(document, p);
  live.push(st);
  return st;
}

/** Порты с управляемым переводом (resolved/отклон по тесту); calls —
 * журнал аргументов translate (проверки источника duopulse-116). */
function ports(
  impl?: (text: string, target: string, source: string) => Promise<{ translation: string; detected: string }>,
) {
  const saved: string[][] = [];
  const loaded = { value: "" };
  const calls: Array<[string, string, string]> = [];
  return {
    saved,
    loaded,
    calls,
    translate:
      impl ??
      (async (text: string, target: string, source: string) => {
        calls.push([text, target, source]);
        return { translation: `[${target}] ${text}`, detected: "en" };
      }),
    loadTargets: () => (loaded.value ? loaded.value.split(",") : []),
    saveTargets: (targets: string[]) => {
      saved.push(targets);
      loaded.value = targets.join(",");
    },
  };
}

/** Инпут с выделением (long-press в omnibox — ручки системные). */
function inputWithSelection(value: string, from: number, to: number): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  document.body.append(input);
  input.focus();
  input.setSelectionRange(from, to);
  input.dispatchEvent(new Event("select", { bubbles: true }));
  return input;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement
    .querySelectorAll("[data-duopulse-translate], .m-tr-chip, .m-tr-wrap")
    .forEach((n) => n.remove());
});

afterEach(() => {
  live.splice(0).forEach((st) => st.stop());
});

describe("readSelection", () => {
  it("берёт выделение input и даёт якорь от него", () => {
    const input = document.createElement("input");
    input.value = "Hello world";
    document.body.append(input);
    input.focus();
    input.setSelectionRange(0, 5);
    const read = readSelection(document);
    expect(read?.text).toBe("Hello");
    expect(typeof read?.anchor.x).toBe("number");
  });

  it("пустое/нет выделения — null", () => {
    expect(readSelection(document)).toBeNull();
    const input = document.createElement("input");
    input.value = "text";
    document.body.append(input);
    input.focus();
    input.setSelectionRange(2, 2);
    expect(readSelection(document)).toBeNull();
  });

  it("выделение внутри бабла перевода игнорирует", () => {
    const bubble = document.createElement("div");
    bubble.setAttribute("data-duopulse-translate", "1");
    const p = document.createElement("div");
    p.textContent = "переведено";
    bubble.append(p);
    document.documentElement.append(bubble);
    const sel = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(p);
    sel?.removeAllRanges();
    sel?.addRange(range);
    expect(readSelection(document)).toBeNull();
    sel?.removeAllRanges();
  });
});

describe("чип у выделения → бабл", () => {
  it("selectionchange показывает чип, collapse прячет", () => {
    const st = controller(ports());
    st.start();
    expect(st.stateSnapshot().chip).toBe(false);
    inputWithSelection("Hello world", 0, 5);
    expect(st.stateSnapshot().chip).toBe(true);
    expect(document.querySelector(".m-tr-chip")?.textContent).toBe("Перевести");
    document.querySelector<HTMLInputElement>("input")!.setSelectionRange(0, 0);
    document.dispatchEvent(new Event("selectionchange"));
    expect(st.stateSnapshot().chip).toBe(false);
    expect(document.querySelector(".m-tr-chip")).toBeNull();
  });

  it("тап чипа: бабл «Переводим…» → результат с детектом и эхом оригинала", async () => {
    const st = controller(ports());
    st.start();
    inputWithSelection("Hello world", 0, 5);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    let bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("Переводим…");
    await new Promise((r) => setTimeout(r));
    bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("[ru] Hello");
    expect(bubble.textContent).toContain("Hello"); // эхо оригинала
    expect(bubble.textContent).toContain("en → ru"); // детект → цель
    expect(st.stateSnapshot()).toMatchObject({ visible: true, target: "ru", pending: false });
  });

  it("смена языка в бабле: повтор с эхом и запоминание выбора", async () => {
    const p = ports();
    const st = controller(p);
    st.start();
    inputWithSelection("Hello world", 0, 5);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const select = document.querySelector("[data-duopulse-translate] select") as HTMLSelectElement;
    select.value = "de";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("[de] Hello");
    expect(p.saved).toEqual([["ru", "de"]]); // выбор добавил язык, не заменил
    expect(st.stateSnapshot().target).toBe("de");
  });

  it("последний язык ведёт следующий перевод", async () => {
    const p = ports();
    p.loaded.value = "uk";
    const st = controller(p);
    st.start();
    inputWithSelection("Hi", 0, 2);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    expect(document.querySelector("[data-duopulse-translate]")!.textContent).toContain("[uk] Hi");
  });

  it("ошибка конвейера — «Не получилось» в бабле", async () => {
    const p = ports(async () => {
      throw new Error("сеть недоступна");
    });
    const st = controller(p);
    st.start();
    inputWithSelection("Hi", 0, 2);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("Не получилось: сеть недоступна");
    expect(st.stateSnapshot().lastError).toBe("сеть недоступна");
  });

  it("тап мимо бабла и Esc закрывают", async () => {
    const st = controller(ports());
    st.start();
    inputWithSelection("Hi", 0, 2);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    expect(st.stateSnapshot().visible).toBe(true);
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(st.stateSnapshot().visible).toBe(false);
    document.querySelector(".m-tr-chip")?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(st.stateSnapshot().visible).toBe(false);
  });
});

describe("лист «Перевести текст…»", () => {
  it("открытие, перевод, мета и закрытие по Esc", async () => {
    const st = controller(ports());
    st.start();
    const host = document.createElement("main");
    document.body.append(host);
    st.openSheet(host);
    expect(st.stateSnapshot().sheet).toBe(true);
    const input = document.querySelector(".m-tr-input") as HTMLTextAreaElement;
    const go = document.querySelector(".m-tr-go") as HTMLButtonElement;
    // пустой ввод — подсказка, конвейер не трогаем
    go.click();
    expect(document.querySelector(".m-tr-result")?.textContent).toContain("Введите текст");
    input.value = "  Bonjour  ";
    go.click();
    await new Promise((r) => setTimeout(r));
    expect(document.querySelector(".m-tr-result")?.textContent).toContain("[ru] Bonjour");
    expect(document.querySelector(".m-tr-meta")?.textContent).toContain("en → ru");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(st.stateSnapshot().sheet).toBe(false);
    expect(document.querySelector(".m-tr-wrap")).toBeNull();
  });

  it("ошибка конвейера — сообщение в листе", async () => {
    const p = ports(async () => {
      throw new Error("gtx HTTP 429");
    });
    const st = controller(p);
    st.start();
    const host = document.createElement("main");
    document.body.append(host);
    st.openSheet(host);
    (document.querySelector(".m-tr-input") as HTMLTextAreaElement).value = "Hi";
    (document.querySelector(".m-tr-go") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r));
    expect(document.querySelector(".m-tr-result")?.textContent).toContain("Не получилось: gtx HTTP 429");
  });

  it("выделение в textarea листа не поднимает чип", () => {
    const st = controller(ports());
    st.start();
    const host = document.createElement("main");
    document.body.append(host);
    st.openSheet(host);
    const ta = document.querySelector(".m-tr-input") as HTMLTextAreaElement;
    ta.value = "текст";
    ta.focus();
    ta.setSelectionRange(0, 5);
    ta.dispatchEvent(new Event("select", { bubbles: true }));
    expect(st.stateSnapshot().chip).toBe(false);
  });
});

describe("несколько целей и источник (duopulse-116)", () => {
  it("добавление цели в бабле переводит на обе, чип × убирает язык", async () => {
    const p = ports();
    const st = controller(p);
    st.start();
    inputWithSelection("Hello world", 0, 5);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const select = document.querySelector("[data-duopulse-translate] select") as HTMLSelectElement;
    select.value = "de";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    let bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("[ru] Hello");
    expect(bubble.textContent).toContain("[de] Hello");
    expect(st.stateSnapshot().targets).toEqual(["ru", "de"]);
    // чип «×» убирает язык — повтор уже без него
    (bubble.querySelector('button[aria-label="Убрать Русский"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r));
    bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("[de] Hello");
    expect(bubble.textContent).not.toContain("[ru] Hello");
    expect(p.saved[p.saved.length - 1]).toEqual(["de"]);
  });

  it("селект источника («Авто» → язык) уходит в конвейер", async () => {
    const p = ports();
    const st = controller(p);
    st.start();
    inputWithSelection("Hello", 0, 5);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const src = document.querySelector(
      '[data-duopulse-translate] select[aria-label="Язык оригинала"]',
    ) as HTMLSelectElement;
    src.value = "en";
    src.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    expect(p.calls[p.calls.length - 1]).toEqual(["Hello", "ru", "en"]);
    expect(st.stateSnapshot().source).toBe("en");
    // маркер детекта при явном источнике не нужен — язык и так известен
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("[ru] Hello");
    expect(bubble.textContent).not.toContain("en → ru");
  });

  it("частичная ошибка рендерится по своему языку, вторая цель живёт", async () => {
    const p = ports(async (text, target) => {
      if (target === "de") throw new Error("gtx 429");
      return { translation: `[${target}] ${text}`, detected: "en" };
    });
    const st = controller(p);
    st.start();
    inputWithSelection("Hello", 0, 5);
    document.querySelector(".m-tr-chip")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const select = document.querySelector("[data-duopulse-translate] select") as HTMLSelectElement;
    select.value = "de";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r));
    const bubble = document.querySelector("[data-duopulse-translate]")!;
    expect(bubble.textContent).toContain("[ru] Hello");
    expect(bubble.textContent).toContain("Не получилось: gtx 429");
    expect(st.stateSnapshot()).toMatchObject({ visible: true, pending: false });
  });
});

describe("createSelectionPorts", () => {
  it("translate зовёт команду (с источником) и валидирует ответ; языки хранятся (инкогнито — нет)", async () => {
    const invoke = vi.fn(async () => ({ translation: "Привет", detected: "en" }));
    let inc = false;
    const p = createSelectionPorts(invoke, () => inc);
    localStorage.removeItem("duopulse.mobile.translateTarget");
    expect(p.loadTargets()).toEqual(["ru"]);
    expect(await p.translate("Hi", "ru", "auto")).toEqual({ translation: "Привет", detected: "en" });
    expect(invoke).toHaveBeenCalledWith("duo_translate_selection", {
      text: "Hi",
      target: "ru",
      source: "auto",
    });
    p.saveTargets(["de", "ro"]);
    expect(p.loadTargets()).toEqual(["de", "ro"]);
    inc = true;
    p.saveTargets(["fr"]);
    expect(p.loadTargets()).toEqual(["de", "ro"]);
    localStorage.removeItem("duopulse.mobile.translateTarget");
  });

  it("пустой ответ конвейера — ошибка", async () => {
    const p = createSelectionPorts(async () => ({ translation: "" }));
    await expect(p.translate("Hi", "ru", "auto")).rejects.toThrow("пустой ответ");
  });
});
