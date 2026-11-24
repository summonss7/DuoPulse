---
id: duopulse-240
title: Превентивные warnings мобильной сборки (aarch64-linux-android, 12 шт.)
status: todo
priority: 2
created: 2026-11-24
updated: 2026-11-24
session: ""
parent: duopulse-231
build: false
wish: w_5QwBe9XNCAkr
---
## Задача
Выявлено в сеансе duopulse-231 (правило 3 диспетчера): после чистки десктопа
`cargo check --lib --target aarch64-linux-android` показывает 12 предупреждений — всё это
мёртвый код, который виден только на Android-таргете (на десктопе те же элементы используются).
Снимок — журнал карточки 231; номера строк — на 24.11.2026.

- `src/adblock/replace.rs` — never used / never read: MAX_BODY_BYTES (:32), FETCH_TIMEOUT (:34),
  поля regex/replacement/global (:39), apply_ops (:355), RewrittenResponse (:385),
  skip_request_header (:399), skip_response_header (:414), fetch_and_rewrite (:434) —
  механика подмены ответов на Android не подключена;
- `src/adblock/mod.rs` (:593) — private type `ReplaceOp` в `AdblockService::replace_plan`
  (private_interfaces);
- `src/asr/engine.rs` — `call_static_string` на Android не зовётся;
- `src/mobile_updater.rs` (~:335) — неиспользуемая переменная `attempt`;
- `src/mobile_asr.rs` (:580) — лишнее `mut`.

Прибрать по образцу duopulse-231: cfg-гейтинг или allow с комментарием, кто потребитель;
неиспользуемые переменные и mut — подчёркивание или удаление. Механику подмены ответов
на мобильной ветке не включать (это отдельная задача, если понадобится).

## Критерии готовности
- [ ] `cargo check --lib --target aarch64-linux-android` (тулчейн NDK — рецепт в журнале 231) не выдаёт ни одного warning
- [ ] Десктоп не тронут: `cargo build` и `cargo test` (bin+lib) по-прежнему без warnings, cargo test и vitest зелёные
- [ ] Поведение программы не изменилось (правки — только cfg/allow/подчёркивания/удаление мёртвого; каждый allow пояснён комментарием)
- [ ] CHANGELOG дополнен (дата-время начала и окончания, как проверено), коммит + push

## Журнал
- 24.11.2026, 06:52: карточка заведена в сеансе duopulse-231 (выявленная работа вне карточки, правило 3).
