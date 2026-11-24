---
id: duopulse-231
title: Превентивные warnings сборки desktop-бина (мусор в cargo test/build, 17 шт.)
status: done
priority: 2
created: 2026-11-23
updated: 2026-11-24
session: ""
src: CARD
parent: duopulse-228
build: true
paused: auto
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
- [x] `cargo test` (bin+lib) и `cargo build` desktop-целей не выдают ни одного warning
- [x] Мобильная ветка не сломана (правки cfg-совместимы; android-build.sh проходит)
- [x] cargo test / vitest зелёные; CHANGELOG дополнен; коммит + push

## Журнал
- 23.11.2026: карточка заведена из duopulse-228 (снимок предупреждений — в журнале 228).
- 23.11.2026, 16:01:01: флажок сборки версии ВКЛЮЧЁН Артёмом через Aila (aila-418): по завершении задания собрать новую версию программы как обычно.
- 23.11.2026, 21:55:44: приоритет изменён Артёмом через Aila: 4 → 2 (0 — самый быстрый).
- 23.11.2026, 21:56:30: флажок сборки версии ВЫКЛЮЧЕН Артёмом через Aila (aila-418): по завершении задания НОВУЮ ВЕРСИЮ программы НЕ собирать и номер версии НЕ поднимать — только правки, тесты, коммит, CHANGELOG и отчёт (для ЭТОЙ карточки это отменяет правило проекта о сборке).


- 24.11.2026, 03:20:37: диспетчер взял задачу в работу (новый запуск).


- 24.11.2026, 05:55:37: диспетчер: временная авто-пауза — параллельно запущена срочная задача (приоритет 0); вернётся в работу после её завершения.
- 24.11.2026, 06:25:34: флажок сборки версии ВКЛЮЧЁН Артёмом через Aila (aila-418): по завершении задания собрать новую версию программы как обычно.
- 24.11.2026, 03:21:58: backup.bat → backups/backup_2026-11-24_03-21-58.
- 24.11.2026, 04:10: снимок предупреждений шире карточки: 34 вместо 17 — 4 в lib (хост) + 30 в бине (часть видна только в тестовых целях). Каждый разобран по потребителям (grep вызовов): мобильные остатки, мёртвые в бине; код только для Android/тестов; мёртвое везде; тестовый мусор; линкер-шум.
- 24.11.2026, 04:25: причина линкер-шума найдена — НЕ дубликат .manifest в build.rs/tauri.conf (предположение карточки не подтвердилось): драйвер gcc тулчейна winlibs подмешивает к каждой ссылке свой default-manifest.o (язык ресурса 1033), рядом с манифестом приложения из tauri-winres BFD видит два «не-дефолтных» манифеста. Лечение — в src-tauri/build.rs (нейтральная копия через -B<OUT_DIR>/manifest/), системный тулчейн не тронут.
- 24.11.2026, 05:13: правки внесены (17 файлов src-tauri, +176/−38). cargo build — 0 warnings, без «rsrc merge»; cargo test --no-run (05:16) и cargo test (05:20) — 0 warnings: lib 36 passed / 1 ignored, bin 478 passed / 0 failed / 6 ignored.
- 24.11.2026, 05:33: vitest — 71 файл / 855 тестов, зелёные.
- 24.11.2026, 05:34: мобильная ветка: cargo check --lib --target aarch64-linux-android — exit 0; предупреждений 16 → 12 против снимка HEAD (05:48, git archive), новых нет. Оставшиеся 12 — Android-only мёртвый код, вне рамок карточки (заведена карточка 240).
- 24.11.2026, 05:51: контроль без incremental (CARGO_INCREMENTAL=0): build и test --no-run — 0 warnings, 0 «rsrc merge». PE debug-exe: ровно один манифест 24/1/1033, 334 байта (приложения, Common-Controls v6); smoke-запуск debug-exe — жив через 12 с.
- 24.11.2026, 07:05: коммит кода 1909d97 (только свои 17 файлов), push origin main; финальный cargo test перед коммитом — 0 warnings, зелёный.
- 24.11.2026, 07:12: по находкам заведены карточки: 240 «Превентивные warnings мобильной сборки (12 шт.)» — todo; 241 «Линкер-шум .rsrc в остальных Rust-проектах» — blocked, вопрос Артёму отправлен в «Хаб ИИ» (ждёт ответа).
- 24.11.2026, 07:17: релиз 0.1.103, десктоп (флажок сборки включён Артёмом в 06:25): версия поднята (tauri.conf.json = package.json = Cargo.toml = Cargo.lock), npm run release — 4,5 мин, без предупреждений компилятора и без «rsrc merge»; канал Aila, GitHub Pages (stable+canary → 0.1.103), хаб «Скачать», C:/DuoPulse.
- 24.11.2026, 07:31: релиз 0.1.103, Android: scripts/android-build.sh release (aarch64) — exit 0, APK подписан (duopulse-release.keystore); в логе те же 12 Android-only предупреждений (карточка 240), новых нет. Затем node scripts/release.mjs --publish-only — манифест канала снова полный: 0.1.103, 5 ассетов (ловушка карточки 234: после android-build.sh в манифесте один APK; окно неполного манифеста — около минуты).
- 24.11.2026, 07:40: проверки релиза: манифест канала по HTTPS — 5 ассетов, sha256 каждого = локальная сборка; PE release-exe — один манифест (приложения); smoke release-exe — жив через 12 с, окно «DuoPulse 0.1.103 · 24.11.2026 07:12», снят без остатка процессов; C:/DuoPulse/duopulse.exe = target/release; APK — versionName 0.1.103, versionCode 1103, apksigner verify ок. Живой прогон release-APK на эмуляторе не делался (поведение мобильной ветки не менялось; эмулятор не занимался, чтобы не сбивать стенды соседней срочной задачи).
- 24.11.2026, 08:01: авто-пауза 05:55 застала сессию уже работающей — по регламенту диспетчера она продолжила автономно, релиз вошёл в этот же сеанс; чужого WIP в дереве не было (git status перед сборкой — только свои файлы и карточки диспетчера).
- 24.11.2026, 08:01: критерии готовности проверены по факту — все три выполнены (android-build.sh release пройден в 07:31). CHANGELOG дописан; релиз-коммит (версия, Cargo.lock, CHANGELOG, карточки 231/240/241, AGENTS.md) + push; отчёт в Aila. Карточка закрыта.
