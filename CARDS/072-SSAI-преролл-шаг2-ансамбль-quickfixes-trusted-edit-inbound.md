---
id: duopulse-072
title: 'SSAI-преролл YouTube, шаг 2: полный ансамбль uBO quick-fixes — порт trusted-edit-inbound-object + replace/rpfr-правила adPlacements/adSlots'
status: todo
priority: 4
created: 2026-11-03
updated: 2026-11-03
session: ""
speed: 9
src: CARD
parent: duopulse-069
wish: w_duopulse072
---
## Задача
Прямое продолжение duopulse-069 (порт rpnt + serverContract-правило). Живая проверка
03.11.2026 доказала: одиночное serverContract-правило механически работает (инъекция,
перезапись ytcsi-узла, контрмера исполняется — ловушки Uint8Array(105) срабатывают,
правило байт-в-байт = живому quick-fixes uBO), но SSAI-преролл НЕ устраняет: реклама
вшита серверно в медиапоток и проигрывается полностью (29,4 с в диагностике), скип
seek-ом не срабатывает, восстановление — перезагрузка loadVideoById с патченным UA
(токены channel/lactmilli/yahi/inline), которая без правил аттестации деградирует
(в диагностике плеер завис в 0x0/0.00s; в p07-прогонах выкарабкивается фолбэком
токенов). Живой uBO против SSAI использует АНСАМБЛЬ (quick-fixes.txt, 03.11.2026):

1. 8 правил `trusted-edit-inbound-object` — аттестация исходящих player-запросов при
   патченном UA (без них перезагрузка с токеном ломается на attestationRequest);
2. сетевые `$xhr,1p,replace=` правила adPlacements/adSlots → no_ads на /player,
   /watch, /get_watch (+ trusted-rpfr-варианты);
3. serverContract-rpnt (уже портировано, 069).

Скриптета trusted-edit-inbound-object нет ни в adblock-rs, ни в ресурсном наборе
@adguard/scriptlets 2.5.1 (есть только prune-вариант trusted-prune-inbound-object) —
нужен собственный uBO-порт по образцу scripts/rpnt-scriptlet.js (069).

Задача: реализовать пункт 1 (порт trusted-edit-inbound-object, uBO-сигнатура:
target, jsonPath-редакторы с +=/=/repl, valueOrJsonPath, propsToMatch), подключить
пункт 2 (replace=/rpfr-правила) во встроенный quickfix-список, замерить p07/p08.

## Критерии готовности
- [ ] trusted-edit-inbound-object исполняется в doc-start-канале (юнит-тесты:
      редактирование входящего объекта по jsonPath, +=/=/repl, propsToMatch-фильтр)
- [ ] Правила аттестации + replace/rpfr подключены встроенным quickfix-источником
      (обновление — пересборкой), из недоверенных списков не инъецируются
- [ ] p07: реклама on ≥2/3 прогонов без ad-showing, ЛИБО зафиксирована матрица
      экспериментов «ансамбль тоже не устраняет SSAI» + вопрос Артёму: оставить
      ансамбль (быстрое восстановление) или откатить до чистого 044-состояния
- [ ] p08: медиана старта не хуже диапазона 050/061 (4,2–4,3 с), SABR-stall
      не вернулся; при столле/деградации — откат добавленных правил
- [ ] cargo + vitest зелёные; CHANGELOG дополнен
## Журнал
- 03.11.2026: карточка создана из живой верификации 069: доказано, что одиночное
  serverContract-правило преролл не убирает (механизм — детект+перезагрузка,
  не запрет), нужен полный ансамбль uBO quick-fixes.
