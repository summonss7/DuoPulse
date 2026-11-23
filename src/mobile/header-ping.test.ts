// DuoPulse — тесты чистого ядра живого зеркала шапки web-оверлея
// (duopulse-212): debounce-сворачивание пачки событий и фильтр одинаковых
// сигнатур. DOM-обвязка watchHeaderState (MutationObserver на бейдже вкладок
// и щите VPN) проверяется живым прогоном на эмуляторе — как лист VPN
// (vpn.test.ts, e2e/mobile).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signalOnChange } from "./header-ping";

describe("signalOnChange (duopulse-212)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("изменение сигнатуры — один send", () => {
    let sig = "a";
    const send = vi.fn();
    const notify = signalOnChange(() => sig, send);
    notify();
    expect(send).not.toHaveBeenCalled(); // debounce: не в момент события
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("пачка notify подряд сворачивается в один send", () => {
    let sig = "a";
    const send = vi.fn();
    const notify = signalOnChange(() => sig, send);
    notify();
    sig = "b";
    notify();
    sig = "c";
    notify();
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1); // последний состав — один пинг
  });

  it("сигнатура не изменилась — пинга нет (шум renderBadge)", () => {
    const send = vi.fn();
    const notify = signalOnChange(() => "same", send);
    notify();
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1); // первая отправка — стартовая
    notify();
    notify();
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1); // состояние то же — молчим
  });

  it("повторное изменение после отправленного — снова send", () => {
    let sig = "a";
    const send = vi.fn();
    const notify = signalOnChange(() => sig, send);
    notify();
    vi.advanceTimersByTime(200);
    sig = "b";
    notify();
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("мутации в следующей пачке видят уже новое состояние", () => {
    let sig = "a";
    const send = vi.fn();
    const notify = signalOnChange(() => sig, send);
    notify();
    vi.advanceTimersByTime(200);
    // событие пришло раньше, чем DOM обновился: в таймере читается свежая
    // сигнатура — пинг уходит с корректным (уже новым) составом
    notify();
    sig = "b";
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
