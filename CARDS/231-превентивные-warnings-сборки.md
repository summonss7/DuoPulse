---
id: duopulse-231
title: Превентивные warnings сборки desktop-бина (мусор в cargo test/build, 17 шт.)
status: todo
priority: 4
created: 2026-11-23
updated: 2026-11-23
session: ""
src: CARD
parent: duopulse-228
build: false
---
## Задача
При работе duopulse-228 выяснено (сравнением с HEAD): сборка desktop-цели (`cargo test`,
`cargo build`) несёт 17 ПРЕЖНИХ warnings, не относящихся к карточке (duopulse-228 своих
не добавила — 7 новых от `mod duo_mobile` в бине погашены cfg_attr(desktop, allow(dead_code))
и дедупликацией GTX_BATCH_MAX_LINES):

- mobile-остатки, мёртвые на desktop-бине: mobile_updater.rs (Manifest, version_lt,
  pick_apk), mobile_video.rs (percent_decode), adblock (set_enabled_mobile,
  cosmetic_injection_script), asr/config.rs (bytes), asr/engine.rs (LocalJni),
  asr/models.rs (field size), vpn/router.rs (socks_port);
- тестовый код: unused vars в adblock/mod.rs (2143, 3079), history/mod.rs (3088),
  passwords/mod.rs (412, 465, 666), download/filedl.rs (fn info), subtitles/ass.rs
  (unused doc comment);
- линкер-шум MinGW: «.rsrc merge failure: multiple non-default manifests» (linker_messages).

Прибрать: мобильные остатки — cfg-гейтинг или allow с комментарием по образцу
duo_mobile.rs (duopulse-228); тестовый мусор — подчёркивания/удаление мёртвых хелперов;
линкер-шум — разобраться с двумя манифестами в ресурсах (возможно, дубликат .manifest
в build.rs/tauri.conf). Цель — чистый `cargo test`/`cargo build` без warnings.

## Критерии готовности
- [ ] `cargo test` (bin+lib) и `cargo build` desktop-целей не выдают ни одного warning
- [ ] Мобильная ветка не сломана (правки cfg-совместимы; android-build.sh проходит)
- [ ] cargo test / vitest зелёные; CHANGELOG дополнен; коммит + push
## Журнал
- 23.11.2026: карточка заведена из duopulse-228 (снимок предупреждений — в журнале 228).
