# AGENTS.md

<!-- ОБЩИЙ-СТАНДАРТ-КОДИРОВАНИЯ -->
## Общий стандарт программирования

Правила кода и процесса — **CODING-STANDARD.md** в корне проекта (общий для всех 14 проектов,
канон — D:\Scheduler\CODING-STANDARD.md). Главное: копия проекта через backup.bat перед
серьёзными изменениями; тесты после правок; сборки в builds/ (версия + debug/release);
временные файлы удаляем; проблема — мгновенный фикс или карточка; идеи новшеств —
на согласование в чат Aila «Хаб ИИ»; коммит → push в том же сеансе; отчётность по задачам —
только записью в CHANGELOG.md с датой и временем начала и окончания работы
(promt.txt заморожен, карточка scheduler-035).
<!-- /ОБЩИЙ-СТАНДАРТ-КОДИРОВАНИЯ -->

<!-- ДИСПЕТЧЕР-ПРОТОКОЛ-КАРТОЧЕК -->
## Система карточек задач (диспетчер)

Проектом управляет диспетчер задач (D:\Scheduler, scheduler.cjs). Задания — карточки-файлы
NNN-название.md в CARDS/: шапка между --- (id, title, status, priority, created, updated,
session), затем разделы «Задача», «Критерии готовности» (чек-лист), «Журнал». Статусы:
todo | in_progress | review | done | blocked. В шапке может стоять build: false —
флажок Артёма «версию не собирать» (aila-418): по такой карточке новую версию программы
НЕ собирать и номер версии НЕ поднимать (коммит, CHANGELOG и отчёт — как обычно).

1. Получив задание — прочитай карточку целиком; поставь status: in_progress и обнови
   updated (поля id и session не менять).
2. Выполни задачу полностью; существенные шаги кратко фиксируй в «Журнале»; перед завершением
   проверь КАЖДЫЙ критерий готовности по факту и отметь [x]; все отмечены — status: done;
   упёрся в блокер — status: blocked с причиной в журнале.
3. Других больших задач вне карточки не начинай; выявленные работы — отдельными карточками
   в CARDS/ (status: todo, с конкретными критериями готовности). Номер и id новой карточки
   (id: <проект>-NNN) — по факту папки: МАКСИМАЛЬНЫЙ номер в CARDS/ + 1; «номер родителя
   + 1» и номера из старых планов дают дубль id — он роняет «Все задания» Aila (aila-274),
   диспетчер перенумеровывает такие дубли сам.
4. Нужен ответ хозяина — вопрос в «Хаб ИИ» Aila (JSON-строка kind:question в
   D:\Aila\server\data\ai-outbox.jsonl, протокол — в шапке ai-hub.md), в шапке карточки
   wait: <id вопроса> и status: blocked — диспетчер сам подшьёт ответ Артёма в «Журнал»
   и вернёт карточку в очередь.
<!-- /ДИСПЕТЧЕР-ПРОТОКОЛ-КАРТОЧЕК -->

## Карта проекта

Настольный браузер для видео (Windows-first): YouTube и другие платформы, многодорожечные
субтитры, звук 5.1/7.1. Tauri 2 + TypeScript + Vite.

- **Структура**: src/ (фронтенд), src-tauri/ + bridge/ (Rust; мост — gen:bridge),
  content/ (контент-скрипты, сборка build-content), e2e/ (постоянные e2e-инструменты),
  scripts/, builds/.
- **Команды**: npm run dev | build (включают build-content) | typecheck | release;
  npm run gen:bridge (после правок Rust-команд).
- **Тесты**: npm run test (vitest).
- **Релизы**: версия одна на всех (tauri.conf.json = package.json = Cargo.toml; рассинхрон
  проверяет android-build.sh, синхронизирует release.mjs). Мобильный release публикуется в
  канал Aila автоматически (android-build.sh, aila-388); десктоп-релиз (`npm run release`,
  оба канала + хаб + C:\DuoPulse) обязан выходить В ТОМ ЖЕ СЕАНСЕ, что и задача, менявшая
  десктопный код (src/, src-tauri/, bridge/, content/), — иначе Windows-канал отстаёт:
  0.1.16–0.1.20 вышли только мобильными, десктоп застрял на 0.1.15 (duopulse-120).
- **Отчётность**: CHANGELOG.md в корне; карточки — CARDS/; планы — ROADMAP.md.

<!-- E2E-ИНСТРУМЕНТЫ -->
## e2e-инструменты (постоянные места)

Временная папка `_tmp/` разобрана и удалена (карточка duopulse-007). Инструменты, оставленные
насовсем, живут в `e2e/`:

- `e2e/tools/cdp.mjs` — общий CDP-помощник (eval/shot/shotfull/click/console; порт 9222 или
  переменная CDP_PORT). Используется протоколами `e2e/m0-results/` (M0 и аудио-спайк).
- `e2e/m0-audio/` — стенд многоканального звука: generate-assets.ps1 (промежуточные файлы —
  в `%TEMP%\duopulse-m0-audio-build`, не в репо), audio-test.html, serve.mjs, assets/;
  диагностика аудио-конфигурации Windows: wasapi-check.ps1, audio-enum.ps1; voices.ps1 —
  список SAPI-голосов для генератора. Понадобятся для повторного прогона
  e2e/m0-results/AUDIO-PROTOCOL.md §6 (карточка duopulse-006).
- `e2e/asr/` — стенд ASR (run.mjs, 10 проверок): движок whisper-server и модель ggml-base
  готовит prepare.mjs по требованию (сборка whisper.cpp @ 284029c cmake+ninja+MinGW,
  промежуточные — `%TEMP%\duopulse-asr-build`; модель — huggingface) в постоянный
  gitignored-кэш `e2e/asr/.cache/` — спайковые `%TEMP%\duopulse-asr-proto` вычищены
  чисткой (карточка duopulse-091); переопределения — DUOPULSE_E2E_ASR_ENGINE/MODEL/CACHE.
- `e2e/adblock/ssai-probe.mjs` — стенд SSAI/USDAI-преролла YouTube (карточки 074/080):
  свежий профиль на прогон, seed-списки из прогретого профиля; зонд — инъекция
  скриптлетов, rpnt-пейлоад в DOM, UA-токены, `.ad-showing`, SSAP/USDAI-маркер в
  stats for nerds; `--deep` — плотный дамп во время рекламы (playerResponse, патчи
  нативов). Результат — e2e/adblock/ssai-last-run.json (gitignore, рантайм-артефакт).
- `e2e/tabs/mem-hang-probe.mjs` — стенд «много вкладок → память/зависание»
  (карточка 115): N вкладок локального «тяжёлого» сайта (HEAVY=1 — играющее видео
  + JS-куча), режим живых адресов URLS=http://…,http://…; меряет дерево
  duopulse.exe+msedgewebview2 (МБ/процессы), свободную память системы и
  round-trip UI→Core (зависание = таймаут). Отчёт — e2e/tabs/mem-hang-last-run.json
  (gitignore, рантайм-артефакт).
- `e2e/youtube/mobile-fullscreen.mjs` — мобильный стенд HTML-fullscreen YouTube
  (карточка 134): порт 9223, сам зовёт adb (тапы в ФИЗИЧЕСКИХ пикселях CSS×dpr —
  контролы m.youtube показывает только реальный тач; поворот user_rotation;
  «назад» keyevent 4); CDP цеплять к конкретной цели оверлея — мёртвые цели
  прошлых сессий висят в /json вечно. Скриншоты — %TEMP%/duopulse-134-*.png.
- `e2e/mobile/pass-capture-smoke.mjs` + `dp165-login.html` — стенд паролей
  web-оверлея (карточки 165–166): debug-APK, CDP webview_devtools_remote
  (порт 9223); оверлей открывает invoke'ом из UI-webview (без тапов), сабмит
  формы → бар «Сохранить пароль?» → save/update/never/инкогнито проверяются
  хуком __duopulseMobilePassSave и mobile_passwords_list; автозаполнение
  (166): иконка-ключ у поля пароля → тап — один аккаунт заполняет форму,
  несколько — нативный лист выбора (uiautomator dump + input tap в
  физических пикселях), инкогнито — иконки нет; logcat прогона без паролей;
  логин и порт уникальны на прогон («Никогда» держит denylist в сторе
  эмулятора). Результат —
  e2e/mobile/pass-capture-smoke-last-run.json (gitignore, рантайм-артефакт).
- `e2e/mobile/asr-local-smoke.mjs` — стенд ЛОКАЛЬНЫХ ASR-субтитров мобильной
  ветки (карточка 168, паритет 5/8): debug-APK + CDP 9223 (как облачный 167);
  менеджер моделей ggml (настоящий HuggingFace: прогресс-события с байтами,
  done — только после sha256; файл сверяется run-as stat), провайдер «На
  устройстве», полный прогон локальным whisper (фазы audio→decode→transcribe→
  done, движок local:whisper, дорожка asr:<lang>), airplane-mode повтор из
  кэша asr_tracks, удаление модели кнопкой панели. Результат —
  e2e/mobile/asr-local-smoke-last-run.json (gitignore, рантайм-артефакт).
- `e2e/mobile/asr-local-release-smoke.mjs` — тот же сценарий в ПОДПИСАННОМ
  release-APK без CDP (карточка 168: R8-keep JNI-хелпера): статика APK
  (apksigner, libwhisperjni.so в packaging, dex с nativeInit/nativeTranscribe/
  nativeFree), управление чистым adb — omnibox → input text → ENTER, тапы по
  uiautomator-дереву (exact-матчинг: «duo» подстрокой ловит DuoPulse-лейблы);
  x86_64-релиз для эмулятора собирается напрямую `tauri android build --apk
  --target x86_64` (условие по -PabiList в build.gradle.kts оставляет x86_64-
  whisper в APK; телефонной aarch64-сборке она не нужна). Результат —
  e2e/mobile/asr-local-release-smoke-last-run.json (gitignore,
  рантайм-артефакт).

Новые временные файлы в корне не накапливать: одноразовое — `%TEMP%`, постоянное — `e2e/`.
<!-- /E2E-ИНСТРУМЕНТЫ -->
