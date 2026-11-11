// DuoPulse — тесты чистых helpers блока аккаунта Aila мобильной ветки
// (этап 6 duopulse-112): строки статуса, набор кнопок, итог синка.
import { describe, expect, it } from "vitest";

import {
  accountButtons,
  accountStatusText,
  syncResultText,
  syncTimeLabel,
  type AilaStatus,
} from "./account";

const loggedOut: AilaStatus = {
  loggedIn: false,
  username: "",
  displayName: "",
  server: "https://aila.example",
  revision: 0,
  lastSyncAt: null,
  lastError: null,
};

describe("syncTimeLabel", () => {
  it("без синка — «ещё не было»", () => {
    expect(syncTimeLabel(null)).toBe("ещё не было");
  });
  it("метка ЧЧ:ММ с ведущими нулями", () => {
    const d = new Date();
    d.setHours(7, 5, 0, 0);
    expect(syncTimeLabel(d.getTime())).toBe("07:05");
  });
});

describe("accountStatusText", () => {
  it("без входа — подсказка локального режима", () => {
    expect(accountStatusText(loggedOut)).toBe(
      "Без аккаунта Aila — пароли и закладки только на этом устройстве",
    );
  });
  it("вход — имя и время последнего синка", () => {
    const d = new Date();
    d.setHours(9, 41, 0, 0);
    const text = accountStatusText({
      ...loggedOut,
      loggedIn: true,
      username: "artem",
      displayName: "Артём",
      lastSyncAt: d.getTime(),
    });
    expect(text).toBe("Артём · синк 09:41");
  });
  it("без displayName — username; ошибка воркера видна", () => {
    const d = new Date();
    d.setHours(23, 0, 0, 0);
    const text = accountStatusText({
      ...loggedOut,
      loggedIn: true,
      username: "artem",
      lastSyncAt: d.getTime(),
      lastError: "сервер недоступен",
    });
    expect(text).toBe("artem · синк 23:00 · ошибка: сервер недоступен");
  });
});

describe("accountButtons", () => {
  it("без входа — только «Войти»", () => {
    expect(accountButtons(loggedOut)).toEqual(["login"]);
  });
  it("со входом — пароли, синк, выход", () => {
    expect(
      accountButtons({ ...loggedOut, loggedIn: true, username: "artem" }),
    ).toEqual(["passwords", "sync", "logout"]);
  });
});

describe("syncResultText", () => {
  it("применено + отправлено + счётчики облака", () => {
    const text = syncResultText({
      passwords: [5, 2, 0, true, 7],
      bookmarks: [3, 1, true],
    });
    expect(text).toBe(
      "Синк завершён — пароли: 2 применено, отправлено; закладки: 1 применено, отправлено; " +
        "в облаке: пароли 5, закладки 3",
    );
  });
  it("конфликты паролей показываются, push без изменений — нет", () => {
    const text = syncResultText({
      passwords: [4, 0, 1, false, 4],
      bookmarks: [0, 0, false],
    });
    expect(text).toContain("конфликтов 1");
    expect(text).not.toContain("отправлено");
  });
});
