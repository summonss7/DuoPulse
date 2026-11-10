---
id: duopulse-109
title: Синхронизация Aila — этап 3/6 — API appdata на сервере Aila
status: done
priority: 3
created: 2026-11-10
updated: 2026-11-10
session: ""
parent: duopulse-106
---
## Задача
Этап 3 цепочки duopulse-106. Серверная часть синхронизации DuoPulse через аккаунты Aila.

Существующий протокол Aila: /api/login/params → (auth_salt, wrap_salt); клиент локально
выводит auth_hash = PBKDF2(пароль, auth_salt) — уходит серверу, и wrap_key =
PBKDF2(пароль, wrap_salt) — не покидает клиент; vault пользователя зашифрован wrap_key.
 enc_vault принадлежит веб-приложению Aila (ключи E2EE-чата) — DuoPulse его не трогает.

Нужно (в проекте D:\Aila, по его AGENTS.md, отдельной карточкой там же):

- Таблица `appdata(user_id, app, key, enc_blob, updated_at, revision)` — шифрованные
  клиентом блобы; сервер видит только ciphertext.
- API: GET /api/appdata?app=duopulse&key=… (→ blob + revision), PUT (If-Match по revision —
  конфликт 409 с телом актуального блоба), DELETE. Авторизация — сессия Aila (куки).
- Клиент DuoPulse шифрует блобы ключом, выведенным из wrap_key (HKDF, инфо «duopulse»),
  сервер plaintext не видит — как vault.
- Лимиты размера/частоты, тесты сервера, CHANGELOG Aila.

## Критерии готовности
- [x] API appdata на сервере Aila работает (GET/PUT/DELETE, конфликт ревизий 409),
      покрыто тестами сервера
- [x] Блобы хранятся только шифрованными; сервер не имеет ключей
- [x] Задокументировано в README/CHANGELOG Aila; сервер перезапущен
      (schtasks /run /tn AilaRestart при необходимости)
- [x] CHANGELOG DuoPulse (этап цепочки duopulse-106), коммиты в обоих проектах + push
## Журнал
- 10.11.2026: карточка создана (этап цепочки duopulse-106).
- 10.11.2026, 17:30–17:55: этап закрыт (в проекте D:\Aila карточкой aila-386,
  коммит 502525b): таблица appdata(user_id, app, key, enc_blob, updated_at,
  revision), GET/PUT/DELETE /api/appdata (без key — список ключей приложения),
  оптимистичная блокировка if_match → 409 с актуальным блобом, лимиты 512 КБ /
  64 ключа / rate-limit. Сервер видит только ciphertext (ключ — HKDF от
  wrap_key на клиенте, enc_vault не тронут). Тесты: appdata.test.mjs 28 ✓,
  весь набор сервера Aila 62 pass / 0 fail. Служба перезапущена (AilaRestart),
  живьем: health 200, /api/appdata без сессии → 401. README/CHANGELOG Aila
  обновлены. CHANGELOG DuoPulse — запись этапа 3.
