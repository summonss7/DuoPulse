---
id: duopulse-081
title: Мобильная версия DuoPulse (MVP «субтитры+перевод») — этап 1/3: Android-каркас на Tauri 2 (зонтичная aila-370)
status: done
priority: 1
created: 2026-11-07
updated: 2026-11-07
session: ""
---
## Задача
Первый этап мобильной версии DuoPulse. Контекст: пожелание Артёма aila-370 (07.11.2026,
«дуопульс и новогрид… ты вроде бы сделал для мобильных телефонов… если вдруг что-то не
готово по мобильной версии то доделай дай себе задания») снимает прежнее решение
«А — отложить» (duopulse-053, 24.10.2026): делаем мобильный MVP по варианту Б из того
исследования — Android, одна вкладка, субтитры+перевод, БЕЗ adblock/VPN/мульти-вкладок.
Портативное ядро для переиспользования перечислено в duopulse-053 (парсеры субтитров,
YouTube-адаптер, конвейер перевода, SQLite/FTS5, UI-фронтенд частично).

Этап 1 — каркас сборки под Android по образцу NovaGrid (novagrid-058, рабочая обёртка
Tauri 2 на том же движке): lib-паттерн крейта src-tauri/, gen/android, мобильные иконки,
скрипты android:dev/android:build, конфиг-развилка desktop/mobile (identifier, версия),
минимальный мобильный UI-вход в существующем фронтенде (стартовый экран «мобильная
ветка», одна вкладка-WebView с omnibox). Десктоп-сборка не ломается.

Правила проекта (обязательны): как в шапке AGENTS.md — бэкап перед правками, тесты
после (юнит + e2e десктопа), сборки в builds/ с версией и типом (debug/release),
CHANGELOG с датой начала/окончания, коммит с пушем, отчёт Артёму в «Хаб ИИ».

## Критерии готовности
- [x] Крейт src-tauri перестроен в lib-паттерн Tauri 2 (lib.rs), gen/android сгенерирован, identifier мобильной ветки отличим от десктопа
- [x] Скрипты android:dev / android:build собирают APK одной командой (как novagrid: scripts/*.sh)
- [x] Мобильные иконки (скрипт по favicon/логотипу → mipmap, образец novagrid-058)
- [x] Минимальный мобильный UI: стартовый экран мобильной ветки, одна вкладка-WebView + omnibox, без adblock/VPN (ветвление по платформе, десктоп-пути не тронуты)
- [x] Артефакты в builds/duopulse_<версия>_android_debug|release/ с версией и типом в имени файла APK
- [x] APK виден в «Скачать» хаба Aila (карточка проекта, платформа Android — чип 🤖 после aila-370)
- [x] Юнит-тесты и e2e десктопа зелёные (регресса нет)
- [x] Живой смоук на эмуляторе: запуск, экран мобильной ветки, ввод адреса (adb-тапы, скриншоты)
- [x] CHANGELOG.md дополнен (дата-время начала/окончания), коммит с пушем

## Журнал
- 07.11.2026: карточка создана (сеанс aila-370, этап 1/3 цепочки мобильного DuoPulse;
  вариант Б из исследования duopulse-053).


- 07.11.2026, 22:53:57: диспетчер взял задачу в работу (новый запуск).

- 07.11.2026, 22:53–23:55: этап выполнен.
  - Крейт src-tauri в lib-паттерне по образцу novagrid-058: [lib] duopulse_lib
    (staticlib/cdylib/rlib) + [[bin]] duopulse; мобильная ветка — новый src/lib.rs
    (thin builder: окно из tauri.android.conf.json + плагин dialog), вся логика
    браузера осталась в бине main.rs НЕ тронутой. Десктоп-зависимости (webview2-com,
    windows, updater, rusqlite, adblock, ureq, boringtun, smoltcp, symphonia и пр.)
    уехали в [target.'cfg(not(any(android, ios)))'.dependencies]; фича unstable —
    только десктоп-секции. cargo build --bin и cargo test (300) чисто.
  - tauri android init → gen/android (43 файла, коммитится); BuildTask.kt запатчен
    (узел из PATH + относительный путь CLI — генератор печёт абсолютный путь машины,
    novagrid-058). Оверлей tauri.android.conf.json: identifier dev.duopulse.mobile
    (десктоп — dev.duopulse.spike), withGlobalTauri true (признак мобильной ветки
    window.__TAURI__ для фронтенда), окно main в конфиге (мобильная ветка не создаёт
    окна кодом — там нужны additional_browser_args десктопа).
  - Иконки: scripts/make-android-icons.mjs (ffmpeg извлекает 256-пкс знак из
    icon.ico → lanczos 1024) + `tauri icon` → mipmap gen/android + обновлённый
    набор icons/. npm run android:icons.
  - Фронтенд-ветка: src/mobile/ (platform.ts — isTauriMobile + resolveMobileInput,
    пара omnibox.rs; mobile.ts + mobile.css — стартовый экран «мобильная ветка ·
    этап 1 из 3» с версией, omnibox-пилюля + GO + HOME, единственная вкладка-iframe;
    YouTube /watch и youtu.be переписываются во встраиваемый /embed/ID — обычные
    страницы YouTube X-Frame-Options в iframe не открываются). main.ts ветвится до
    хрома; десктоп-хром (#app) на мобильной прячется display:none. 13 юнит-тестов
    (vitest 282).
  - Скрипты scripts/android-dev.sh / android-build.sh (npm run android:dev|build):
    сверка версий, фронтенд, tauri android build --apk, артефакт в
    builds/duopulse_0.1.6_android_debug|release/DuoPulse-0.1.6-android-<тип>.apk;
    release подписывается keystore (duopulse-release.keystore коммитится, пароль —
    gitignored keystore.properties, схема novagrid-059) и копируется в корень builds/
    для хаба «Скачать» Aila (как setup-release.exe в release.mjs; устаревшие
    DuoPulse-*-android-release.apk из корня убираются).
  - Два бага вскрыты живым смоуком и поправлены: (1) display:flex у .m-start/.m-tab
    перебивал UA [hidden] + .m-content без flex-direction — старт и вкладка жили
    рядом двумя колонками; (2) EDGE_TO_EDGE_ENFORCED (targetSdk 35+): шапка рисовалась
    под системным статус-баром и он СЪЕДАЛ тапы по omnibox/GO/HOME (ui-automator-тапы
    молча не доходили) — viewport-fit=cover + padding env(safe-area-inset-top) у #mobile.
  - Живой смоук на эмуляторе (AVD lecards_test, android-36 x86_64, universal debug
    APK): запуск → стартовый экран мобильной ветки (версия 0.1.6 из core) → тап
    omnibox (фокус) → IME-ввод «example.com» → GO → страница загрузилась в
    вкладку-iframe на всю ширину (CDP: tabSrc https://example.com/, пиксельный контроль
    YAVG 32→210) → m.youtube.com/watch?v=… переписался в плеер /embed (Big Buck Bunny,
    скриншот) → HOME вернул старт. CDP-инспекция WebView через
    adb forward webview_devtools_remote (порт 9223, e2e/tools/cdp.mjs). Скриншоты:
    builds/duopulse_0.1.6_android_debug/smoke-05/09/10 (gitignore, рантайм-артефакт).
  - Регресс десктопа: vitest 282/282, tsc чисто, cargo test 300, e2e-стенд
    e2e/bridge/run.mjs — ALL PASS 29/29 (первый прогон дал 1 флак-тайминг, два
    повторных чистые).
  - Артефакты: debug universal (aarch64+x86_64) 7,6 МБ; release aarch64 подписан
    (apksigner verify), 7,1 МБ, копия в корне builds/ — хаб «Скачать» Aila.
