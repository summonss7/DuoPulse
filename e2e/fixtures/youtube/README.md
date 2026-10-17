# Фикстуры YouTube-адаптера (задача 3.3)

`playerResponses/*.json` — снапшоты player-ответов живого YouTube
(записаны 17.10.2026 через `e2e/youtube/record.mjs`: приложение + CDP,
путь `movie_player.getPlayerResponse()`), для юнит-тестов адаптера без
сети (`content/adapters/youtube.test.ts`, docs/03 §9).

Формат файла (по одному на видео):

| Поле | Содержимое |
|---|---|
| `videoId`, `url`, `title`, `durationSec` | идентификация видео |
| `recordedAt` | момент записи |
| `paths` | какие пути добычи работали при записи (`playerApi`/`initialResponse`) |
| `captionTracks` | список дорожек player-ответа (languageCode, kind `asr`, vssId `.en`/`a.en`, name, isTranslatable, baseUrl) |
| `translationLanguages` | языки машинного перевода (tlang, ~156 шт.) |

Набор из 11 видео покрывает: ручные дорожки и asr, многоязычные (TED —
65 дорожек), моноязычные asr (Gangnam Style — ko), дубли manual+asr одного
языка (yt:en / yt:en:asr), региональные варианты (pt-BR, es-419, zh-Hans).
`baseUrl` в фикстурах — историческая запись: живые URL timedtext требуют
PO-токен и напрямую не скачиваются (200 с пустым телом), адаптер грузит
дорожки через плеер (см. шапку `content/adapters/youtube.ts`).

Обновление: `node e2e/youtube/record.mjs [duopulse.exe] [id1,id2,…]` —
перезапишет файлы текущими ответами (тесты адаптера завязаны на форму
данных, не на конкретные видео).

Сюда же относится `e2e/youtube/run.mjs` — DoD-прогон «10 случайных
видео → наборы из 2–3 дорожек» (фиксированный список = эти фикстуры).
