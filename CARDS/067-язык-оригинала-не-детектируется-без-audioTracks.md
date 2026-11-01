---
id: duopulse-067
title: 'Язык оригинала не детектируется: в реальных player-ответах нет audioTracks — дефолт Alt+D и пресеты берут первую дорожку по алфавиту'
status: todo
priority: 2
created: 2026-11-01
updated: 2026-11-01
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
- [ ] На видео без `audioTracks[].original` в ответе (фикстура/живой прогон
      TED iG9CE55wbtY) язык оригинала детектируется корректно (en), дорожка
      помечена `original` в tracksInfo()
- [ ] defaultSetIds/пресет «Дуо» на таком видео собирают «оригинал + ru»
      (en+ru), не af+ru
- [ ] Юнит-тесты на реальную форму player-ответа (фикстуры) — пометка
      original и фолбэки
- [ ] vitest и cargo зелёные; CHANGELOG дополнен

## Журнал
- 01.11.2026: карточка создана из разбора живого прогона duopulse-066
  (трассировка «набор собрался как af+ru на TED»; фикстуры подтверждили
  отсутствие audioTracks во всех 10 записанных ответах).
