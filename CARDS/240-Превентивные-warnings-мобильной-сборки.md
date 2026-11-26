---
id: duopulse-240
title: Превентивные warnings мобильной сборки (aarch64-linux-android, 12 шт.)
status: in_progress
priority: 2
created: 2026-11-24
updated: 2026-11-26
session: ""
parent: duopulse-231
build: false
wish: w_5QwBe9XNCAkr
model: GLM-5.3
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
- [x] `cargo check --lib --target aarch64-linux-android` (тулчейн NDK — рецепт в журнале 231) не выдаёт ни одного warning
- [x] Десктоп не тронут: `cargo build` и `cargo test` (bin+lib) по-прежнему без warnings, cargo test и vitest зелёные
- [x] Поведение программы не изменилось (правки — только cfg/allow/подчёркивания/удаление мёртвого; каждый allow пояснён комментарием)
- [ ] CHANGELOG дополнен (дата-время начала и окончания, как проверено), коммит + push

## Журнал
- 24.11.2026, 06:52: карточка заведена в сеансе duopulse-231 (выявленная работа вне карточки, правило 3).
- 24.11.2026, 18:22:58: модель ИИ изменена Артёмом через Aila (aila-441): по умолчанию → GLM-5.3 — дальнейшая работа по заданию идёт на этой модели (работающая сессия будет перезапущена и продолжит на ней). Правка ушла и в исходное пожелание w_5QwBe9XNCAkr.

- 24.11.2026, 18:23:26: диспетчер: модель ИИ изменена человеком — (по умолчанию) -> GLM-5.3 (поле model в шапке, aila-441); дальнейшая работа по заданию идёт на этой модели.


- 26.11.2026, 06:29:45: диспетчер взял задачу в работу (новый запуск).

- 26.11.2026, 06:29:45: диспетчер: модель ИИ для задания — GLM-5.3 (выбор в шапке карточки).

- 26.11.2026, 06:31: старт работы; backup.bat -q → backups/backup_2026-11-26_06-32-54 (правило
  проекта; первый запуск через cmd.exe из Git Bash без MSYS_NO_PATHCONV повис на pause —
  повтор с -q и конверсией флагов прошёл).
- 26.11.2026, 06:36: правки внесены (5 файлов src-tauri, +30/−22):
  adblock/replace.rs — раздел самофетча/перезаписи тел (use std::io::Read, MAX_BODY_BYTES,
  FETCH_TIMEOUT, apply_ops, RewrittenResponse, skip_request_header, skip_response_header,
  fetch_and_rewrite) закрыт cfg(not(any(android, ios))) по образцу соседних гейтов mod.rs:
  единственный потребитель — десктопный COM-перехватчик main.rs, мобильная либа механику
  не подключает (подмена ответов на мобильной ветке НЕ включена — по карточке);
  поля ReplaceOp (regex/replacement/global читает только apply_ops) —
  cfg_attr(mobile, allow(dead_code)) с комментарием, парсер на мобильных их пишет;
  adblock/mod.rs — replace_plan: cfg_attr(mobile, allow(private_interfaces)) с комментарием
  (pub-метод отдаёт pub(crate)-тип: реальный потребитель — бин main.rs, в бинах линт
  не срабатывает, на десктопе атрибут выключен);
  asr/engine.rs — удалён мёртвый везде call_static_string (local_jni зовёт call_static_method
  напрямую; на десктопе модуль не компилируется вовсе);
  mobile_updater.rs — неиспользуемый attempt → _attempt; mobile_asr.rs — убран лишний mut
  у on_chunk (замыкание Fn, зовётся дважды по ссылке).
- 26.11.2026, 06:40: проверки: `cargo check --lib --target aarch64-linux-android`
  (NDK 28.2.13676358: CC/AR/CARGO_TARGET_…_LINKER = aarch64-linux-android24-clang.cmd/llvm-ar,
  msys64-ucrt64 в PATH) — 0 warnings, в т.ч. контрольный прогон CARGO_INCREMENTAL=0
  (0 warnings); десктоп: cargo build — 0 warnings; cargo test — 0 warnings,
  lib 36 passed/1 ignored, bin 480 passed/0 failed/6 ignored; vitest — 73 файла,
  894 теста, зелёные. Поведение не менялось: правки — cfg/allow/подчёркивание/удаление
  мёртвой приватной функции.
