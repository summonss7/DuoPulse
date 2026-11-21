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
- `e2e/adblock/sites-ads-probe.mjs` — стенд рекламы кинотеатров uakinogo/kinogo
  (карточки 188/190): живая страница фильма + плеер-iframe cinemar.cc (OOPIF),
  duopulse-sites поверх живых EasyList/uBO; клик play обходит дом-прероллы
  плеера (видео-зонд с детектом метки «Реклама», duopulse-190). Результат —
  e2e/adblock/sites-ads-last-run.json (gitignore, рантайм-артефакт).
- `e2e/adblock/frame-storm-probe.mjs` — стенд OOPIF-охвата адблока (карточка
  190): локальная страница + 40 кросс-доменных iframes sub*.localhost; fetch
  BLOCK_TEST_PATH из фрейма → 403 только при регистрации фильтра перегрузкой
  AddWebResourceRequestedFilterWithRequestSourceKinds(ALL) (базовая — OOPIF
  мимо; DUOPULSE_OOPIF_FILTER=0 — A/B-доказательство, проверка 2 инвертируется);
  UI/Core round-trip и CPU при шторме DCL, YouTube-эмбед жив; детали и замеры —
  e2e/adblock/OOPIF-NETWORK-SPIKE.md. Результат —
  e2e/adblock/frame-storm-last-run.json (gitignore, рантайм-артефакт).
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
- `e2e/mobile/vpn-core-smoke.mjs` — стенд тоннель-ядра WireGuard мобильной
  ветки (карточка 169): debug-APK + CDP 9223 против живого WG-сервера
  e2e/wg-stand на хосте (эмулятор видит хост как 10.0.2.2 — endpoint в
  .conf подменяется); 23 проверки: импорт текста .conf, Keystore-блоб
  «v1:» без ключа в открытых файлах (run-as), handshake/endpoint/rx/tx,
  проба test_connection целью из тоннеля (DNS+HTTP видит стенд), события
  vpn:state_changed/vpn:stats контрактом vpn.*, кнопка «VPN: тест» листа
  диагностики (проба — localStorage __duopulseVpnProbe), kill-switch
  (до порога — таймаут тоннельного DNS; после REJECT_AFTER_TIME — «мёртв»,
  fail-fast, событие), гигиена off/удаления. Сначала сносит прошлую сборку
  (релиз подписан другим ключом). Результат —
  e2e/mobile/vpn-core-smoke-last-run.json (gitignore, рантайм-артефакт).
- `e2e/mobile/vpn-route-smoke.mjs` — стенд МАРШРУТИЗАЦИИ трафика приложения
  через тоннель (карточка 170): тот же debug-APK + CDP 9223 + wg-stand
  (--serve отдаёт страницу в туннель), 20 проверок: до VPN blocked.tun
  напрямую не резолвится; тумблер переключает роутер+прокси WebView без
  перезапуска (logcat DuoPulseProxy, тост-перезагрузка страниц); UI-фронт
  жив при включённом прокси (bypass *.localhost — лист диагностики с новой
  секцией VPN); web-оверлей открывает страницу тоннелем (absolute-form —
  стенд видит dns+http, маркер в overlay-webview по URL-предикату),
  CONNECT доходит tcp-событием; core-фетч duo_yt_player уходит тоннелем
  (DNS стенда, напрямую не проходит; отказ invoke читается JSON-обёрткой —
  exceptionDetails CDP теряется обычным evalJs); kill-switch чёрной дырой —
  без хитов стенда; выключение возвращает Direct (query-суффикс URL —
  другой ключ HTTP-кэша), повторное включение снова пускает трафик.
  Результат — e2e/mobile/vpn-route-smoke-last-run.json (gitignore,
  рантайм-артефакт).
- `e2e/mobile/vpn-ui-smoke.mjs` — стенд ЛИСТА «VPN» (карточка 171): тот же
  debug-APK + CDP 9223 + wg-stand, 19 проверок ПОЛЬЗОВАТЕЛЬСКИМ циклом без
  dev-кнопок: импорт .conf системным SAF-пикером (adb push в Download →
  «Импортировать .conf…» → тапы в DocumentsUI по uiautomator-дереву;
  clickable-узлы и точные совпадения — предикат послабее ловит заголовки),
  тумблер/статус/rx-рост/щит в шапке, split-режим и правило инпутом листа
  (страница тоннеля — через тоннель, посторонний домен — напрямую),
  kill-switch-дыра — внятный статус листа и щит error (REJECT_AFTER_TIME
  180 с), рестарт приложения — режим/правило пережили, тоннель поднят сам
  (mobile_vpn_restore), выкл тумблером → Direct, удаление профилей ✕
  (Keystore-блобы вычищены). Снапшот листа — глобал
  window.__duopulseMobileVpn. Результат —
  e2e/mobile/vpn-ui-smoke-last-run.json (gitignore, рантайм-артефакт).
- `e2e/mobile/duo-default-smoke.mjs` — стенд ДЕФОЛТА дуо-набора мобильной
  ветки (карточка 186, мобильные п.4/п.5 дуопульса-184): debug-APK + CDP
  9223, живой YouTube; 8 проверок: VEVO-кейс без сигналов оригинала
  (vk_xq1P7vIU, все дорожки ручные, zh-Hans в списке) — дефолт yt:en не
  yt:zh-Hans, селект панели согласован, движок грузит yt:en + перевод
  yt:en+gtx:ru с репликами (перевод — soft: gtx на эмуляторе бот-блокится);
  регрессия asr-фолбэка (Gangnam 9bZkp7q19f0) — yt:ko:asr. Гонка: видео-вход
  обновляет videoId раньше parse — стенд ждёт стабильного originalId.
  Результат — e2e/mobile/duo-default-smoke-last-run.json (gitignore,
  рантайм-артефакт).
- `e2e/mobile/yt-mobile-force-smoke.mjs` — стенд МОБИЛЬНОГО YouTube в
  web-оверлее (карточки 191/192: 191 «поиск Ютуб → тап по Ютуб — браузер
  виснет» — ссылки выдачи Google несут app=desktop, десктопный Polymer-сайт
  на мобильном UA вешает WebView скелетоном; 192 — доработка: адресный чип
  кликабелен (тап → поле ввода: URL-догадка/поиск GO), YouTube по умолчанию
  «расширенный» — десктопный сайт с ДЕСКТОП-UA (вис был у пары «десктопный
  Polymer + мобильный UA»), m.youtube переписывается на www, серверный
  редирект goto (стартует мимо хуков) ловится в onPageStarted UA-мисматчем →
  перезапрос, тумблер «Десктопный YouTube» в меню «⋮» живёт в
  SharedPreferences и переживает рестарт, выкл — поведение 191): debug-APK +
  CDP 9223 + локальный 302-редиректор (10.0.2.2:8931, имитирует goto), фазы
  A/B: десктоп www+UA+разметка+рендерер жив, видео из десктоп-выдачи →
  встроенный плеер (DPURL-хук), редирект → десктоп, тап по чипу →
  example.com; тумблер OFF → m.youtube/app=desktop срезан/разметки нет,
  видео из мобильной выдачи → плеер, ввод запроса → Google, рестарт —
  тумблер жив. uiautomator-тапы по нативной шапке (content-desc «Адресная
  строка»/«Меню», input text/keyevent 66). Фаза C (карточка 207): шапка —
  полное зеркало старта — состав/порядок ⌂/очки-инкогнито/⬇/⋮ + поле/★/GO,
  звёздочка закладки тапом ★/☆, «⬇» на обычной странице — тост (uiautomator
  на API 36 тосты НЕ отдаёт — ловится пикселями сырого screencap: серый пилл
  внизу), очки — инкогнито ON с закрытием оверлея (m-private) и выход
  кнопкой старта. Результат —
  e2e/mobile/yt-mobile-force-smoke-last-run.json (gitignore, рантайм-артефакт).

- `e2e/subs/embed-subs-probe.mjs` — стенд ДОРОЖЕК СУБТИТРОВ ПЛЕЕР-ФРЕЙМОВ
  кино-сайтов (карточка 199): живая страница фильма uakinogo.io, таб плеера
  №2 (data-provider="1") включает OOPIF api.embf.net, в чьём инлайн-конфиге
  makePlayer лежат подписанные .vtt (Eng. full/Укр./Рус.); агент бандла во
  фрейме (init-script исполняется во всех фреймах, WebMessage-канал туда не
  достаёт) пересылает дорожки/часы/файлы top-документу window.postMessage,
  топ-бандл заводит виртуальное видео (iframe = геометрия плашки, прокси =
  часы движка), .vtt грузит агент фрейма (CDN подписан под origin плеера,
  топу CORS запрещён); 5 проверок: OOPIF-таргет, агент во фрейме, дорожки в
  топ-бандле (>=3, есть en), загрузка англ. дорожки (cues>100) и реплики по
  плашке со сменой текста (часы идут); перевод дорожки — soft. Результат —
  e2e/subs/embed-subs-last-run.json (gitignore, рантайм-артефакт).
- `e2e/subtitles/pause-no-autoplay.mjs` — стенд «DuoPulse НЕ ЗАПУСКАЕТ ВИДЕО
  САМ» (карточка 195: «некоторые видео сами включаются потом»): живой YouTube,
  6 проверок — устоявшийся просмотр (15 с) → пауза (тег dataset.pStand195
  отличит пересозданный YouTube элемент) → включение duo toggle: видео стоит
  18 с (лестница ретраев), инструментированный call-log (обёртки video.play/
  player API со стеками) не видит чужих playVideo до явного play стенда
  (nudge ad-skip уважает паузу, транспорт не трогает плеер на паузе — даже
  loadModule: YouTube играет паузу от программирования); явный play поднимает
  дефолт-набор (re-arm duoWanted): дорожки в движке, плашка видна (перевод
  может 429-квотиться — достаточно оригинала). Результат —
  e2e/subtitles/pause-no-autoplay-last-run.json (gitignore, рантайм-артефакт).
- `e2e/tabs/tab-drag.mjs` — стенд ПЕРЕТАСКИВАНИЯ ВКЛАДОК (карточка 205):
  debug-exe + CDP (порт 9234, паттерн bm-drag), 8 проверок синтетическими
  DragEvent + DataTransfer: сид 4 вкладок локального стенда, drag перед
  первой (порядок в DOM бара и tabs.list совпадают, активная прежняя),
  drag в конец (дроп правее последней), no-op перед соседом справа (команда
  не шлётся), drag активной вкладки (контент жив), drop «в себя»; скриншот
  бара — %TEMP%/duopulse-205-tabbar.png.

Новые временные файлы в корне не накапливать: одноразовое — `%TEMP%`, постоянное — `e2e/`.
<!-- /E2E-ИНСТРУМЕНТЫ -->
