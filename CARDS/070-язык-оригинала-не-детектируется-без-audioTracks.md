---
id: duopulse-070
title: 'Язык оригинала не детектируется: в реальных player-ответах нет audioTracks — дефолт Alt+D и пресеты берут первую дорожку по алфавиту'
status: done
priority: 4
created: 2026-11-01
updated: 2026-11-04
session: ""
speed: 9
src: CARD
parent: duopulse-066
---
## Задача
Найдено живым прогоном карточки duopulse-066 (01.11.2026). Пометка `original`
у базовых дорожек ставится только по `audioTracks[].original` player-ответа
(content/adapters/youtube.ts, originalLangsOf). В РЕАЛЬНЫХ ответах YouTube
(фикстуры e2e/fixtures/youtube/playerResponses/*.json — 10 видео) поля
`audioTracks` нет вовсе — ни на верхнем уровне, ни в
`captions.playerCaptionsTracklistRenderer`. Итог на видео со многими ручными
дорожками (TED iG9CE55wbtY, 65 дорожек по алфавиту):

- `originalLangsOf` → пусто → НИ одна дорожка не помечена `original`;
- дефолт Alt+D (defaultSetIds) и пресет «Дуо» панели (presetSets, тот же
  фолбэк `base[0]`) берут ПЕРВУЮ дорожку списка — для TED это `yt:af`
  (африкаанс), а не en: «лекция на английском → дуо en+ru» (docs/01 §5.1)
  не собирается; работает только на видео, где первая дорожка совпадает с
  языком видео (частый, но не гарантированный случай — живые прогоны
  duopulse-065/066 проходили именно на таких).

Направление: уточнить источник языка оригинала в реальном player-ответе
(кандидаты: `playerCaptionsTracklistRenderer.audioTracks[].originalLanguage`
/ `defaultCaptionTrackIndex` → captionTrackIndices[0]; ucid/видеодетали;
соотношение с аудио-дорожками), пометить `original` устойчиво, добавить
юнит-тесты на реальную форму ответа из фикстур. Не забыть: смена базы
влияет на `defaultBase()` адаптера (голые коды переводов «ru» резолвятся
на оригинал) и на подпись чипа «Дуо <lang>+<lang>».

## Критерии готовности
- [x] На видео без `audioTracks[].original` в ответе (фикстура/живой прогон
      TED iG9CE55wbtY) язык оригинала детектируется корректно (en), дорожка
      помечена `original` в tracksInfo()
- [x] defaultSetIds/пресет «Дуо» на таком видео собирают «оригинал + ru»
      (en+ru), не af+ru
- [x] Юнит-тесты на реальную форму player-ответа (фикстуры) — пометка
      original и фолбэки
- [x] vitest и cargo зелёные; CHANGELOG дополнен

## Журнал
- 01.11.2026: карточка создана из разбора живого прогона duopulse-066
  (трассировка «набор собрался как af+ru на TED»; фикстуры подтверждили
  отсутствие audioTracks во всех 10 записанных ответах).
- 01.11.2026: id исправлен duopulse-067 → duopulse-070 и файл переименован 067→070: id дублировал карточку 067-Бейдж (создана раньше, 10:19) и ронял закладку «Все задания» в Aila (aila-273).
- 02.11.2026, 04:33:43: приоритет изменён Артёмом через Aila: 2 → 4 (0 — самый быстрый).


- 04.11.2026, 03:22:13: диспетчер взял задачу в работу (новый запуск).
- 04.11.2026, 03:24–03:32: копия проекта (backup_2026-11-04_03-23-55). Живая
  CDP-проба web-клиента (TED iG9CE55wbtY + dQw4w9WgXcQ, %TEMP%-скрипт, удалён):
  верхнеуровневых audioTracks нет; renderer = captionTracks/audioTracks/
  translationLanguages/defaultAudioTrackIndex; renderer.audioTracks БЕЗ
  original/originalLanguage; microformat/videoDetails без языка. Кандидат
  карточки defaultCaptionTrackIndex ОТВЕРГНУТ: на TED = 51 → дорожка ro —
  рекомендация под язык интерфейса сессии (hl=ro), не оригинал. Надёжный
  источник — asr-дорожка (генерится из оригинального звука): en-asr→en (TED,
  dQw), ko-asr→ko (Gangnam). Выяснена первопричина «в фикстурах нет
  audioTracks»: рекордер record.mjs при выжимке копировал только
  captionTracks/translationLanguages — поля терялись всегда.
- 04.11.2026, 03:33–03:50: реализация — originalLangsOf: три источника
  (audioTracks[].original TV/ANDROID → renderer.audioTracks[].originalLanguage
  (задел) → asr-дорожка); extractCaptionList прокидывает renderer.audioTracks;
  рекордер пишет audioTracks/defaultCaptionTrackIndex/defaultAudioTrackIndex;
  фикстуры TED/dQw дополнены живыми renderer.audioTracks (запись 04.11.2026);
  комментарии контракта обновлены (types.ts, service.rs + gen:bridge). Тесты
  +4 (TED: {en}, yt:en/yt:en:asr original, af/ro нет, defaultSetIds=[yt:en,
  ru], resolveIds("ru")→yt:en; Gangnam ko; originalLanguage; пресет «Дуо
  en+ru»). tracksInfo() отдаёт base[].original из того же списка адаптера.
  Доки: ROADMAP (запись 070 + пометка у «TED af 417 cue»), docs/05 §3.3.
- 04.11.2026, 03:50–03:55: прогоны — vitest 234/234 (+4), cargo 286 passed
  +3 ignored, typecheck чисто, бандл 24,3 КБ gzip ≤ 80; попутно cargo fmt
  реликтов 059/068 (fmt --check чисто). CHANGELOG дополнен; критерии
  проверены по факту — все [x].
