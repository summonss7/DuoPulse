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
  web-оверлее (карточки 191/192/210: 210 — ДЕФОЛТ десктопный YouTube и
  починка «клина»: смена userAgentString ГАСИТ идущую навигацию Android
  WebView, потому каждое изменение UA сопровождается перезапуском адреса
  (loadWithUa) — переход google.com/goto → YouTube больше не «отскакивает»
  к выдаче, уход с YouTube не умирает; пункт «⋮» называет цель — «Мобильная
  версия YouTube»/«Десктопная версия YouTube»; шапка — зеркало старта по
  составу И иконкам: линейные Canvas-иконки SVG старта, кнопка вкладок с
  бейджем (лист вкладок хуком __duopulseShowTabs), ⬇/щит VPN — по живому
  состоянию старта (__duopulseHeaderState); 191/192 — прежняя механика
  app=desktop/UA-пар/редиректа): debug-APK + CDP 9223 + локальный
  302-редиректор (10.0.2.2:8931, имитирует goto). Фаза A (дефолт —
  десктоп): www+десктоп-UA+ytd-app, видео из десктоп-выдачи (SPA) →
  встроенный плеер (DPURL-хук), тап по чипу → example.com (смена UA живьём),
  поиск → Google, goto-редирект с мобильного UA → десктоп перезапросом
  (регресс «нажатие на ссылку не переходит»). Фаза C: состав/порядок шапки
  ⌂/вкладки/очки/[⬇ при видео]/⋮ + поле/★/GO, звёздочка тапом
  (залита/контур), «⬇» — тост при видео либо скрыта без видео, очки —
  инкогнито с закрытием оверлея и выход кнопкой старта, кнопка вкладок —
  лист старта + «назад» возвращает (тосты ловятся пикселями screencap —
  uiautomator на API 36 их не отдаёт). Фаза B: переключение на мобильную
  версию, m.youtube/app=desktop срезан/разметки нет, рестарт+goto →
  m.youtube. Результат —
  e2e/mobile/yt-mobile-force-smoke-last-run.json (gitignore, рантайм-артефакт).
- `e2e/mobile/incognito-overlay-smoke.mjs` — стенд ИНКОГНИТО web-оверлея
  (карточка 211: прежний код выкидывал все запросы режима в системный
  браузер): debug-APK + CDP 9223 + локальная cookie-страница (порт 8898,
  уникальный ?r= на открытие — мёртвые CDP-цели прошлых WebView висят в
  /json вечно); 14 проверок: очки старта включают режим; omnibox-Enter в
  инкогнито открывает оверлей В ПРИЛОЖЕНИИ (topResumedActivity DuoPulse,
  pid com.android.chrome не меняется); logcat DuoPulseWeb
  «private-profile: изолированный профиль назначен» (MULTI_PROFILE,
  androidx ProfileStore; деграда — общий профиль); изоляция профилей
  (кука приватного не видна обычному оверлею — прямой invoke
  mobile_web_open incognito:false); следов не остаётся (повторный
  инкогнито-оверлей куки не видит — профиль снесён teardown'ом; ловушка:
  deleteProfile «in-use» сразу после destroy — чистка профильных
  cookieManager/webStorage напрямую + отложенный ретрай); после выхода из
  режима обычный оверлей жив. Результат —
  e2e/mobile/incognito-overlay-smoke-last-run.json (gitignore,
  рантайм-артефакт).
- `e2e/mobile/rotate-fullscreen-smoke.mjs` — стенд ПОЛНОГО ЭКРАНА ПОВОРОТА
  мобильной ветки (карточка 217): debug-APK + CDP 9223; поворот телефона в
  ландшафт при открытом YouTube-видео разворачивает плеер на весь экран
  (класс .m-rotate-full: шапка/статус спрятаны, системные панели гасит
  Kotlin-мост DuopulseUi — поворот не жест, Fullscreen API WebView не
  пускает), портрет возвращает вид; кнопка «⛶» шапки и плавающая «⛶» поверх
  видео разворачивают/сворачивают (в портрете — с доворотом экрана в
  SENSOR_LANDSCAPE, как приложение YouTube); системный «назад» выходит из
  полного экрана, НЕ закрывая приложение (rotateBackCallback); web-оверлей
  поверх снимает полный экран (syncRotation в show/hide/teardown/open).
  Грабли: Fullscreen API embed-плеера современный WebView обрабатывает
  ВНУТРЕННЕ (тост «swipe down», свои панели/ориентация, «назад» убивает
  приложение), минуя onShowCustomView — потому iframe-allow без fullscreen;
  первичный ImmersiveModeConfirmation глотает «назад» — стенд ставит
  settings secure/global immersive_mode_confirmations=confirmed ДО входа в
  иммерсивный режим; «видео играет» — долбёжка тапами (unmute-баннер ест
  первый). Проверка панелей — InsetsSource type=statusBars в dumpsys window.
  Результат — e2e/mobile/rotate-fullscreen-smoke-last-run.json (gitignore,
  рантайм-артефакт).
- `e2e/mobile/google-video-smoke.mjs` — стенд ВИДЕО-РЕЗУЛЬТАТОВ ВЫДАЧИ GOOGLE
  мобильной ветки (карточка 236: жалоба «открываю видео из поиска — блокировка
  рекламы не срабатывает, играет прямо на сайте Google»): debug-APK + CDP 9223,
  живой поиск Google. Причина — «▶»-миниатюра ролика YouTube в мобильной выдаче это
  кнопка плеера Google («Відтворити в Google»): видео играет В САМОМ ДОКУМЕНТЕ
  выдачи (адрес получает #sv=…), навигации нет — shouldOverrideUrlLoading /
  onPageStarted / DPURL молчат. Фикс — document-start пейлоад
  assets/duopulse/google-video.js (WebViewCompat.addDocumentStartJavaScript;
  рантайм без DOCUMENT_START_SCRIPT — тот же текст в onPageFinished): на
  страницах google /search|/url в главном фрейме capture-слушатель click (и
  Enter/пробел по role=button) гасит клик по «▶»-миниатюре или ссылке ролика
  YouTube и репортит console.log("DPYT:<id>") → onConsole → openVideoInPlayer;
  юнит-тесты пейлоада на скелете разметки выдачи — src/mobile/google-video.test.ts.
  12 проверок: выдача с [data-vid], пейлоад в документе, тап «▶» → встроенный
  плеер (хук __duopulseOpenVideo + омнибокс, оверлей спрятан, в logcat нет
  загрузки YouTube), «назад» → выдача без плеера Google, тап по заголовку,
  вкладка «Відео» (&udm=7), «Про цей результат» — не наш, Enter по
  сфокусированной миниатюре (живой keyevent 66), инкогнито-оверлей (приватный
  профиль) и возврат в обычный режим. Ловушки: плеер Google в выдаче узнаётся по
  #sv= в hash — НЕ по iframe youtube.com/embed (скрытый стаб 0×0 есть в выдаче
  всегда, старый маркер давал ложный «открывался»); «пейлоад не трогает» — по
  вызовам хука и репортам DPYT, а не по defaultPrevented синтетического клика
  (его ставит и сам обработчик Google). Результат —
  e2e/mobile/google-video-smoke-last-run.json (gitignore, рантайм-артефакт).

- `e2e/mobile/header-live-smoke.mjs` — стенд ЖИВОГО ОБНОВЛЕНИЯ ШАПКИ
  web-оверлея (карточка 212): debug-APK + CDP 9223 + wg-stand; состав ряда 1
  (бейдж вкладок/«⬇»/щит VPN — нативные Kotlin-вьюхи, читаются uiautomator-
  дампом по content-desc) обновляется пингом mobile_web_header_ping без смены
  адреса оверлея. 10 проверок: закрытие видео-вкладки DOM-кликом листа при
  ВИДИМОМ оверлее (лист под оверлеем невидим, но DOM жив — единственный путь
  «без смены адреса») убирает «⬇»/бейдж, logcat подтверждает живой переопрос
  (header-state с новым составом); тоннель wg-stand вкл/выкл (VPN-команды —
  аргументы под ключом params, use_profile поднимает/гасит) двигает щит;
  спрятанный оверлей (тап «Вкладки» шапки — hide) при изменении счёта даёт
  «header-ping: … спрятан» БЕЗ новых header-state (пустых переопросов нет).
  Результат — e2e/mobile/header-live-smoke-last-run.json (gitignore,
  рантайм-артефакт).

- `e2e/subs/embed-subs-probe.mjs` — стенд ДОРОЖЕК СУБТИТРОВ ПЛЕЕР-ФРЕЙМОВ
  кино-сайтов (карточки 199/225): живая страница фильма uakinogo.io; таб
  плеера №2 (data-provider="1", дефолт стенда) включает OOPIF api.embf.net,
  в чьём инлайн-конфиге makePlayer лежат подписанные .vtt (Eng. full/Укр./
  Рус.); DUOPULSE_E2E_PROVIDER=0 — ДЕФОЛТНЫЙ таб «Смотреть онлайн» =
  cinemar.cc (duopulse-225): дорожек в разметке нет — агент фрейма
  перехватывает обёрткой XHR ответ POST /api/playlist/load (субтитры
  принадлежат ДУБЛЯЖУ: дефолтный дубляж может идти без них — стенд сам
  открывает список дубляжей и выбирает DUOPULSE_E2E_DUB, по умолчанию
  «Дубляж (TVShows)»); агент бандла во фрейме (init-script исполняется во
  всех фреймах, WebMessage-канал туда не достаёт) пересылает дорожки/часы/
  файлы top-документу window.postMessage, топ-бандл заводит виртуальное
  видео (iframe = геометрия плашки, прокси = часы движка), .vtt грузит агент
  фрейма (CDN подписан под origin плеера, топу CORS запрещён); 6 проверок:
  OOPIF-таргет, агент во фрейме, дорожки в топ-бандле (>=1, есть
  DUOPULSE_E2E_LANG=en), авто-дуо из дорожек плеера (duopulse-232: video-auto
  поднимает ДВЕ строки en+ru без облака), загрузка дорожки (cues>100) и
  реплики по плашке со сменой текста (часы идут); перевод дорожки — soft.
  Результат — e2e/subs/embed-subs-last-run.json (gitignore, рантайм-артефакт).
- `e2e/subs/fullscreen-subtitles.mjs` — стенд СУБТИТРОВ В ПОЛНОМ ЭКРАНЕ +
  дуо плеер-фрейма (карточка 232: жалоба «субтитры есть на свёрнутом окне,
  разворачиваю на весь экран — исчезают» + «не могу включить русский и
  английский двумя строками»): ПОЛНОСТЬЮ офлайн (без живого сайта) — локальный
  сервер (порт 8897): топ-страница с видео и кнопкой фулскрина контейнера,
  вторая страница с кросс-доменным OOPIF sub1.localhost (внутри видео +
  инлайн makePlayer с en/ru .vtt — топология эмбеда кино-сайта); 14 проверок:
  плашка в окне; фулскрин контейнера топ-документа (плеер YouTube-стиля) —
  плашка :popover-open, геометрия = вьюпорт (фикс 232 — Popover API против
  top layer Fullscreen API, content/overlay/top-layer.ts), выход; фаза embed:
  агент анонсировал дорожки, авто-дуо ДВЕ строки (en+ru, перевод сверху —
  роли embed-дорожек по en-предпочтению), фулскрин ИЗ фрейма
  (fullscreenElement топа = IFRAME, якорь-iframe растянут UA-стилями) —
  плашка в top layer с обеими строками, выход. Скриншоты —
  %TEMP%/duopulse-232-fs-*.png. Результат —
  e2e/subs/fullscreen-subtitles-last-run.json (gitignore, рантайм-артефакт).
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
- `e2e/mobile/background-audio-smoke.mjs` — стенд ФОНОВОЙ МУЗЫКИ мобильной
  ветки (карточки 218/237, жалобы «перехожу в другое приложение — музыка
  выключается» и «в фоне играют все вкладки — нужна только активная»):
  debug-APK + CDP 9223 + локальный сервер 10.0.2.2:8898
  (тон-фикстуры ffmpeg в %TEMP%, НЕ в репо). Детерминирован офлайн-путями —
  файловый плеер из VIEW-intent (mp4 с звуком, MediaStore-грант — паттерн
  video-release-smoke 179) и локальная музыка web-оверлея (тап play — в
  оверлее медиа требует жеста), YouTube-embed — мягкая фаза (бит-блок
  эмулятора даёт readyState 0 навсегда; DP218_YT=hard — жёсткая). 35
  проверок: сервис mediaPlayback поднят (запись ServiceRecord обязана нести
  pid ЖИВОГО процесса — мёртвые записи убитых процессов живут в дампсе и
  ложно проходят проверку), в другом приложении время/звук идут (dumpsys
  audio: «u/pid:<uid>/» + state:started — двоеточия только перед uid, ловушка
  парсинга), 15+ с фона (заморозка рендерера), HOME, «⏸» (run-as + am
  startservice --user 0 — shell-uid чужой неэкспортированный сервис не
  пускает), музыка оверлея в фоне, закрытие оверлея гасит сервис, возврат —
  UI жив. Фаза вкладок duopulse-237 — тоже без сети: iframe вкладок —
  ЗАГЛУШКИ с источником youtube (Fetch.enable на CDP-цели UI-webview подменяет
  документ вкладки до сети — локальная страница не годится, targetOrigin
  youtube не совпал бы; контекст вкладки ищется в ui.contexts по origin+href,
  мёртвые контексты закрытых вкладок отсеиваются eval-пробой), часы duo — фейк
  FAKE_JS в UI-странице (подменяет __duopulseMobileDuo: идут, пока «вкладка
  играет», встают на hidden — как медиа под WebView.onPause, — и снова идут
  по playVideo, дошедшему до активной вкладки; доклад заглушки родителю —
  строкой НЕ JSON, чтобы не попасть в чужие слушатели): активная играет →
  HOME → playVideo ТОЛЬКО ей, в фоне часы идут; источник — файл/оверлей →
  вкладкам ничего; «переключился на паузную и сразу ушёл» → тишина, сервис
  гаснет; «переключился, включил и сразу ушёл» быстрее тика зонда → играет
  включённая (до 4 раундов: путь «снимок до onPause» ловится только раундом
  без тика — причина реплея читается из logcat); скачок часов непроигрываемой
  вкладки (30→900) не поднимает сервис; файловое видео поверх активной
  вкладки → в фоне только файл; в конце вкладки-заглушки закрыты (иначе сессия
  вкладок в localStorage переживает перезапуск и мешает другим стендам).
  Logcat читается по времени устройства (logcat -T '<мм-дд чч:мм:сс.000>'), не
  по номеру строки — кольцо буфера чужими логами фазу не рвёт. A/B: на коде до
  фикса 13 проверок падают (playVideo уходил во все iframe), 18 прежних
  проверок 218 зелёные. Мёртвые CDP-цели повторного URL обходятся пингом
  (connect перебирает кандидатов). Результат —
  e2e/mobile/background-audio-smoke-last-run.json (gitignore, рантайм-
  артефакт).
- `e2e/tabs/tab-drag.mjs` — стенд ПЕРЕТАСКИВАНИЯ ВКЛАДОК (карточка 205):
  debug-exe + CDP (порт 9234, паттерн bm-drag), 8 проверок синтетическими
  DragEvent + DataTransfer: сид 4 вкладок локального стенда, drag перед
  первой (порядок в DOM бара и tabs.list совпадают, активная прежняя),
  drag в конец (дроп правее последней), no-op перед соседом справа (команда
  не шлётся), drag активной вкладки (контент жив), drop «в себя»; скриншот
  бара — %TEMP%/duopulse-205-tabbar.png.
- `e2e/bookmarks/mobile.mjs` — стенд ЗАКЛАДОК мобильной ветки (карточки
  104/235): debug-APK + CDP 9223 (приложение и adb-форвард поднимает
  запускающий: `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`);
  хранилище (команды history.* мобильной либы), экран закладок, «+»/✎,
  сенсорное перекладывание синтетическими PointerEvent, входы меню «⋮» и
  хуков оверлея; фавиконы (235) — детерминированно локальным сервером стенда
  (с эмулятора 10.0.2.2: страница с `<link rel=icon>`), «сайт не дошёл» —
  бейдж-буква остаётся. Ключ кэша фавиконов — хост: холодный фетч Core —
  первый прогон профиля, дальше кэш (30 дней). Скриншоты —
  e2e/bookmarks/mobile-*.png.

Новые временные файлы в корне не накапливать: одноразовое — `%TEMP%`, постоянное — `e2e/`.
<!-- /E2E-ИНСТРУМЕНТЫ -->
