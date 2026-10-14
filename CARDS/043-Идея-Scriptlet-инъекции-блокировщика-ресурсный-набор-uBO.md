---
id: duopulse-043
title: 'Идея · Scriptlet-инъекции блокировщика (##+js, ресурсный набор uBO)'
status: blocked
priority: 4
created: 2026-10-14
updated: 2026-10-14
session: ""
src: CARD
origin: duopulse-018
wait: duopulse_043_scriptlets_20261014
---
## Задача
Выявлена при выполнении задачи 2.2 (карточка duopulse-018, журнал 14.10.2026):
косметическая фильтрация скрывает DOM-узлы, но скриптлеты (`example.com##+js(...)`)
движком adblock-rs не собираются — нужен ресурсный набор uBO (библиотека
скриптлетов set-constant/json-prune/… , `Engine::use_resources`), feature
`resource-assembler` crate'а читает файлы репозитория uBO и для поставки в
приложение не годится — ресурсы надо грузить как список (uBO scriptlets.txt,
обновление вместе с EasyList/uBO) и парсить в Resource.

Ценность: часть агрессивной рекламы/anti-adblock обходится только скриптлетами
(в т.ч. YouTube-преролл — предмет открытого вопроса P-07, id
duopulse_017_p07_20261014); сетевые списки и косметика её не трогают.
Риск: скриптлеты исполняют JS в контексте страниц — только доверенные
ресурсы uBO; исполнение — в content-скрипте (тот же мир страницы), при
выключенном блокировщике/сайт-исключении инъекции отключаются.

Протокол инъекции уже готов: `url_cosmetic_resources` возвращает
`injected_script`, канал доставки есть (main.rs PostWebMessageAsString ←
content/cosmetic.js, задача 2.2).

Вопрос автору (перед стартом): брать ли это в работу — предложение в Хаб ИИ.

## Критерии готовности
- [ ] Ресурсный набор uBO (scriptlets) грузится/кэшируется/обновляется как списки
- [ ] `##+js(...)`-правила из EasyList/uBO исполняются в контентной вкладке (e2e: правило тест-листа меняет поведение тест-страницы)
- [ ] Тумблер/white-list отключают инъекции; e2e на это
- [ ] cargo fmt/clippy/test + tsc/vitest зелёные; отчёт в CHANGELOG.md, коммит + push

## Журнал
- 14.10.2026: карточка создана из задачи 2.2 (duopulse-018): скриптлеты вне
  периметра 2.2 (карточка требует скрытия по селекторам), но движок и канал
  доставки уже поддерживают — осталось дать ресурсный набор.


- 14.10.2026, 04:12:27: диспетчер взял задачу в работу (новый запуск).
- 14.10.2026, ~04:40: вопрос автору уже задан (id duopulse_043_scriptlets_20261014,
  отправлен сессией duopulse-018), ответа ещё нет — диспетчер подхватил карточку через
  13 секунд после вопроса. По протоколу карточка встала на ожидание ответа:
  wait: duopulse_043_scriptlets_20261014, status: blocked. Реализация не начиналась.
  За сессию выполнено подготовительное исследование (без правок кода), выводы для
  следующей сессии:
  - движок adblock 0.9.8 готов к скриптлетам: `Engine::use_resources(Vec<Resource>)`,
    `url_cosmetic_resources(url).injected_script` (движок сам оборачивает код в
    try{}catch{}); правила `##+js` парсятся уже сейчас. ВАЖНО: `serialize_raw` ресурсы
    НЕ сериализует — `use_resources` звать и после `Engine::from_rules`, и после
    `deserialize` (load_compiled в src-tauri/src/adblock/mod.rs);
  - ценность: в текущем uBO filters.txt 2455 правил `##+js` (EasyList — 0); топ:
    aopr 635, acs 345, set 302, aeld 200, nostif 194, aopw 181, nowoif 178;
  - источники (проверено 14.10.2026): uAssets filters/resources.txt — 404, удалён
    апстримом 08.10.2020 («качать scriptlets.txt у uBO» напрямую не работает);
    brave/adblock-resources dist/resources.json — точный формат Vec<Resource>, но
    там осталось 17 Brave-специфичных ресурсов (uBO-скриптлеты Brave собирает при
    сборке браузера); gorhill/uBlock — скриптлеты теперь ES-модули (сборка
    src/js/make-scriptlets.js, миры ISOLATED/MAIN), #[deprecated]
    assemble_scriptlet_resources adblock-rs понимает только старый формат scriptlets.js;
  - рабочий вариант: библиотека AdGuard `@adguard/scriptlets@2.5.1` (npm, живая,
    uBO-совместимая) — 167 uBO-алиасов (ubo-aopr, ubo-acs…). Одноразовый Node-конвертер
    (scripts/) → resources.json в репо DuoPulse (Vec<Resource>, base64, aliases =
    uBO-имена и короткие формы aopr/set/…); далее третьим источником в list_defs,
    digest — в engine.json, парсинг serde_json напрямую. ParseOptions default
    (untrusted) — uBO trusted-* скриптлеты не инъекцируются (PermissionMask);
  - риск-тайминг: cosmetic.js стартует на document creation, но injected_script
    приходит асинхронным WebMessage-ответом — возможна гонка с ранними инлайн-скриптами
    страниц (uBO колет синхронно в document_start). Замерить на YouTube DoD; если
    промах — отдельная карточка на синхронную доставку.
