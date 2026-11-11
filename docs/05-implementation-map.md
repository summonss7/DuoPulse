# 05 · Карта реализации

Документ отвечает на вопрос: **в каком порядке и где писать код**, чтобы этапы ROADMAP
превращались в конкретные карточки. Структура каталогов — целевая, создаётся по мере
этапов (не заранее).

## 1. Целевая структура кода

```
DuoPulse/
├── src-tauri/                      # Core + Shell (Rust)
│   ├── Cargo.toml                  # deps: tauri 2, adblock, rusqlite, serde
│   │                               #   (vpn-роутер — std::net, без fast-socks5; boringtun — 6.2)
│   ├── src/
│   │   ├── main.rs                 # точка входа, сборка приложения
│   │   ├── bridge.rs               # регистрация IPC-команд/событий (контракт §3)
│   │   ├── tabs/                   # менеджер вкладок, спящий режим, восстановление сессии
│   │   ├── adblock/                # обёртка adblock-rs, загрузка списков, cosmetic-правила
│   │   ├── vpn/                    # маршрутизация сети (docs/02 §6): локальный SOCKS5-роутер,
│   │   │   ├── mod.rs              #   этап M6
│   │   │   ├── router.rs           #   fail-closed роутер direct|upstream|wg (6.1/6.2): loopback-листенер,
│   │   │   │                       #     SOCKS5-клиент WebView2, upstream SOCKS5(RFC 1929)/HTTP CONNECT,
│   │   │   │                       #     смена маршрута на лету, kill-switch (разрыв тоннелей — 6.4)
│   │   │   ├── wg.rs               #   клиент WireGuard (boringtun 0.7 + стек smoltcp medium-ip, задача
│   │   │   │                       #     6.2): импорт .conf (ключи — DPAPI), handshake/keepalive/roaming,
│   │   │   │                       #     виртуальные TCP через туннель, DNS только сервером профиля
│   │   │   ├── rules.rs            #   split-tunnel: домен → маршрут, персист правил
│   │   │   └── dns.rs              #   резолв только через маршрут, без утечек
│   │   ├── subtitles/
│   │   │   ├── mod.rs              # сервис: включение пары, кэш, offset
│   │   │   ├── srt.rs              # парсер SubRip (+тесты на фикстурах)
│   │   │   ├── vtt.rs              # парсер WebVTT (+тесты)
│   │   │   ├── timedtext.rs        # парсер YouTube timedtext XML/JSON3 (+тесты)
│   │   │   └── cache.rs            # SQLite: videoKey → дорожки/переводы
│   │   ├── translate/              # провайдеры, батчинг, деградация
│   │   ├── history/                # история, закладки, FTS-поиск
│   │   └── settings/               # settings.json, миграции
│   └── tests/                      # интеграционные тесты Core
├── src/                            # UI-слой (Svelte + TS)
│   ├── main.ts                     # монтирование хрома
│   ├── chrome/                     # TabBar, Omnibox, Navbar, MainMenu, Star (избранное)
│   ├── pages/                      # NewTab (статический), Settings, Diagnostics
│   ├── subtitles-panel/            # панель настройки субтитров (набор дорожек 1–3, стиль, сдвиг)
│   ├── vpn-panel/                  # панель VPN: тумблер, режим off/global/split, сервер, правила
│   │                               #   (индикатор-щит в Navbar — статусы по гайду 06 §2)
│   ├── bridge/                     # типизированный IPC-клиент (генерится из контракта)
│   └── theme/                      # токены фирменного стиля (см. 06-brand-style)
├── content/                        # Content-слой (инжектируемый движок, TS)
│   ├── duopulse-content.ts         # вход IIFE-бандла (≤ 80 КБ gzip; задача 3.2)
│   ├── detector/                   # поиск <video>, MutationObserver, videoKey (3.2)
│   ├── adapters/
│   │   ├── types.ts                # интерфейс Adapter { listTracks(), version, paths[] } (3.3+)
│   │   ├── youtube.ts              # дорожки из player-ответа (+fallback TextTrack) (3.3+)
│   │   └── file.ts                 # ручные .srt/.vtt через Core (3.6+)
│   ├── engine/                     # cue-таймлайн, бинарный поиск, offset (3.2)
│   ├── overlay/                    # плашка «оригинал/перевод» (каркас 3.2; стили/позиция — 3.4)
│   ├── messaging/                  # канал до Core (WebMessage; 3.2)
│   ├── gen/                        # генерат esbuild (gitignore, include_str! в cargo)
│   └── *.js                        # досборочные скрипты без бандла: m0-spike,
│                                   #   chrome-hotkeys (+Ctrl+D), url-watch (SPA-URL,
│                                   #   карточка 057), media-watch, cosmetic
├── bridge/                         # IPC-контракт: contract.json (генерится из Rust-типов
│                                   #   src-tauri/src/bridge.rs; из него — src/bridge/gen/types.ts)
├── e2e/                            # сценарии приёмки (по этапам)
│   ├── fixtures/youtube/           # записанные снапшоты player-ответов
│   └── runners/                    # эталонный прогон метрик P-01..P-08
├── docs/                           # эта документация
├── CARDS/  ROADMAP.md  README.md  AGENTS.md  backup.bat  promt.txt
```

## 2. IPC-контракт (ядро интеграции слоёв)

Первая реализуемая вещь после M0 — `bridge` со схемами команд/событий (serde ↔ TS-типы,
единый источник: JSON Schema). Минимальный словарь:

```
Команды (UI|Content → Core):
  tabs.{open, close, activate, reopen, list, sleep, wake, restore_session}
  nav.{go_back, go_forward, reload, resolve_omnibox}
  history.{visit, search, list, delete_urls, delete_range,
           bookmark_add, bookmark_remove, bookmark_update, bookmark_list,
           group_list, group_add, group_rename, group_remove,
           group_set_sort, group_toggle_bookmark, bookmark_move}
  adblock.{set_enabled(site), status, update_lists}
  vpn.{set_enabled(on), set_mode(off|global|split), status, test_connection,
       import_profile(file), remove_profile(id), list_profiles,
       set_site_rule(domain, tunnel|direct), site_rules}
  subtitles.{set_tracks(trackRefs[]), disable, list_tracks(videoKey), load_file(path),
             set_offset(ms), set_style(style), translate_track(trackId, lang)}
  settings.{get, set, export, import}
События (Core → UI|Content):
  page.{loaded, video_detected(videoKey, canTracks)}
  vpn.{state_changed(disconnected|connecting|connected|error, reason),
       route_changed(domain, route), stats(rx_tx, ping_ms), connection_test(result)}
  subtitles.{tracks_ready(videoKey, tracks[]), set_applied(tracks[]),
             translate_progress, translate_unavailable(reason)}
  adblock.{blocked_count(delta), site_exception_changed}
  perf.{startup_ms, tab_switch_ms}
```

Фактические команды спайка до появления `bridge` (задача 1.1): `navigate`,
`go_back`, `go_forward`, `reload` и инкремент A прокси — `proxy_get`,
`proxy_save`, `proxy_status`, `proxy_restart` (карточка duopulse-009);
при миграции на bridge они ложатся на `vpn.{set_enabled, status, test_connection}`
и `settings.{get, set}`.

**Статус (14.10.2026, задачи 1.1–1.4, 2.1–2.3 выполнены — карточки
duopulse-011/012/013/014/017/018/019).**
`bridge` реализован: единственный источник контракта — Rust-типы
`src-tauri/src/bridge.rs` (schemars); из них генерируется `bridge/contract.json`
(JSON Schema draft-07, версионируется в git, версия контракта — поле `version`),
из него — TS-типы `src/bridge/gen/types.ts` (`npm run gen:bridge`). Ручные правки
генерённого исключены тестами с обеих сторон (cargo `contract_file_is_up_to_date`,
vitest `src/bridge/client.test.ts` — команды и события). Словарь v2:
команды `bridge.version`,
`tabs.{list, open, close, reopen, activate}` (менеджер вкладок — задача 1.2,
`src-tauri/src/tabs/`), `tabs.{sleep, wake}` (спящий режим — задача 2.3:
`src-tauri/src/tabs/sleep.rs` — TrySuspend/Resume WebView2 по таймауту
простоя 5 мин, `TabInfo.sleeping` в снапшотах; исключение «играет звук/видео»
определяет content/media-watch.js — он же ставит беззвучное видео скрытой
вкладки на паузу, чтобы фон засыпал по обычному таймауту — карточка
duopulse-117), `nav.{navigate, go_back, go_forward, reload}` (действуют
на активную вкладку), `nav.{resolve_omnibox, focus_page}` + `history.search`
(задача 1.3: разбор ввода omnibox — `src-tauri/src/omnibox.rs`, подсказки —
FTS5-индекс `src-tauri/src/history/`), `history.{visit, list, delete_urls,
delete_range, bookmark_add, bookmark_remove, bookmark_update, bookmark_list,
group_list, group_add, group_rename, group_remove, group_set_sort,
group_toggle_bookmark, bookmark_move}`
(задача 1.4: SQLite-хранилище `duopulse.db` в профиле — docs/02 §8; визиты
пишет Core из on_page_load вкладок, дедуп 60 с, заголовок подтягивается из
on_title; list — агрегат по URL для страницы управления; группы избранного —
карточка duopulse-058: bookmark_add с groupId (null — «Избранное» по
умолчанию), bookmark_list с groupId (null — все, -1 — без группы, id —
члены группы в её порядке), bookmark_move — позиции drag&drop, члены группы
— group_toggle_bookmark; подсказки search несут имена групп «Имя · Имя»),
`settings.{get, set}`, `vpn.{set_enabled, status, test_connection}`,
`adblock.{set_enabled, status, update_lists}` (задача 2.1: обёртка adblock-rs
в `src-tauri/src/adblock/` — сетевая фильтрация из COM-перехватчика
WebResourceRequested, списки EasyList+uBO с суточным обновлением и
compiled-кэшем `engine.bin` в `profile/filters/`; set_enabled site —
white-list per-site), `perf.{snapshot, save_run, list_runs}` (задача 2.5:
живой срез сеанса и история прогонов метрик P-01..P-08 в SQLite — таблица
perf_runs в duopulse.db, последние 10 — docs/04 §3; модуль
`src-tauri/src/perf.rs`, страница `duopulse://diagnostics` —
`src/pages/diagnostics.ts`), `app.restart`; событие `tabs:updated` (снапшот списка
вкладок после любого изменения — им перерисовывается таб-бар
`src/chrome/tabbar.ts`, omnibox-подсказки — `src/chrome/omnibox.ts`),
события `adblock:blocked_count` (прирост блокировок, батчинг ~400 мс —
счётчик в главном меню) и `adblock:site_exception_changed`, события
`perf:startup_ms` / `perf:tab_switch_ms` (итог старта main → Ready и
переключение вкладок — живой съём страницы «Диагностика», задача 2.5), а
также события-каркас `page:loaded` (каркас), `page:video_detected` (эмит —
**задача 3.2**: content-бандл субтитров шлёт WebMessage `{"duopulse":"video",
videoKey, canTracks}`, Core эмитит событие в UI; payload `PageVideoDetected`
— `videoKey`/`canTracks`), `vpn:state_changed` (M6). Имена событий —
через `:` (словарь `домен:событие`): tauri 2 разрешает в именах событий только
alnum/`-`/`/`/`:`/`_`, точечные имена не доставлялись (переименование — bump
контракта v1→v2 в задаче 1.2; имена команд с точками не затронуты — в tauri
идёт snake_case-хендлер из поля "handler"). Прокси-инкремент A мигрирован:
`proxy_*` → `settings.{get, set}` + `vpn.{set_enabled, status, test_connection}`
+ `app.restart`; состояние vpn — `off/on/error`, при WireGuard (M6) расширится
до словаря выше с bump версии. Типы событий для Content-слоя —
`content/messaging/events.ts`; транспорт контентных вкладок (без tauri-IPC) —
WebMessage: `content/messaging/index.ts` (задача 3.2). Внутренние страницы (задача 1.4): адрес
`duopulse://<имя>` открывается вкладкой с webview UI-бандла
(метка `page-<имя>-N`, `WebviewUrl::App`; IPC — capability `page-*`,
контентные вкладки `tab-*` его не имеют; канонический адрес в таб-баре
держится, пока webview в app-origin). Реестр страниц — `internal_page_name`
(Core) + роутер `src/main.ts` (UI): `duopulse://history` —
`src/pages/history.ts`, `duopulse://newtab` — `src/pages/newtab.ts` (задача
1.5: фирменная «Новая вкладка» — стартовая страница и новые вкладки без url,
гайд 06 §7; токены стиля — `src/theme/`). Сквозные e2e —
[e2e/bridge/run.mjs](../e2e/bridge/run.mjs), [e2e/tabs/run.mjs](../e2e/tabs/run.mjs),
[e2e/omnibox/run.mjs](../e2e/omnibox/run.mjs)
(чек-лист приёмки таб-бара — [e2e/tabs/CHECKLIST.md](../e2e/tabs/CHECKLIST.md));
блокировщик (задача 2.1) — [e2e/adblock/run.mjs](../e2e/adblock/run.mjs)
(фильтрация/счётчик/исключения/обновление списков, локальный тест-лист без
сети) и [e2e/adblock/p07.mjs](../e2e/adblock/p07.mjs) (замер метрики P-07
на YouTube); тёплый старт и метрики P-01..P-03 (задача 2.4) —
[e2e/perf/run.mjs](../e2e/perf/run.mjs) (релизная сборка: холодный/тёплый
старт, RAM 5 типичных вкладок, проверка прогрева топ-сайтов); страница
«Диагностика» + метрики (задача 2.5) — [e2e/perf/diagnostics.mjs](../e2e/perf/diagnostics.mjs)
(страница: живой срез, график истории, срез в историю),
[e2e/perf/p05.mjs](../e2e/perf/p05.mjs) (дропы кадров 1080p60),
[e2e/perf/p06.mjs](../e2e/perf/p06.mjs) (отклик UI: longtask + пропуски
кадров при печати/Ctrl+Tab), [e2e/perf/p08.mjs](../e2e/perf/p08.mjs)
(первый кадр повторного просмотра vs Chrome),
[e2e/perf/save-run.mjs](../e2e/perf/save-run.mjs) (итог прогона — в историю
duopulse://diagnostics); субтитры (задача 3.2) —
[e2e/subtitles/run.mjs](../e2e/subtitles/run.mjs) (детектор видео + движок
cue-таймлайна + оверлей на тест-странице с реальным роликом); YouTube-адаптер
дорожек (задача 3.3) — [e2e/youtube/run.mjs](../e2e/youtube/run.mjs)
(«10 случайных видео»: список дорожек → набор оригинал+ru+es → cue в движке →
оверлей; фикстуры player-ответов — e2e/fixtures/youtube/, рекордер
[e2e/youtube/record.mjs](../e2e/youtube/record.mjs)); WebMessage-канал
content↔Core расширен: `parse-subtitles`/`subtitles-parsed` (разбор тел
timedtext дорожек каноническими парсерами Core, задача 3.1) и `tracks`
(журнал Core до сервис-обвязки subtitles.* — задачи 3.5–3.7).
**Задача 3.5 (duopulse-026):** первая сервисная команда домена —
`subtitles.set_offset` (совместимое расширение v2): UI → Core → eval в
активную вкладку диспатчит document-событие `duopulse-set-offset`
{offsetMs} → content-движок применяет сдвиг ±10 с (кламп и в Core, и в
движке) без перезагрузки дорожек и открывает HUD со слайдером.
**Задача 3.6 (duopulse-027):** `subtitles.load_file` (path →
{name, cueCount, warnings}): ручной .srt/.vtt с диска — чтение/разбор в Core,
доставка cue eval'ом активной вкладки (document-событие
`duopulse-file-track`, склейка JS без format!-тройных скобок и eval на
главном потоке — см. подводные камни в §3); drag&drop файлов в content-слое
(`content/adapters/file.ts`) + телеметрия WebMessage `file-tracks`.
**Задача 3.7 (duopulse-028):** сервис состояния субтитров Core
(`src-tauri/src/subtitles/service.rs` — кэш по вкладкам сообщений
content-слоя «video»/«tracks»/«set-state»; навигация вкладки сбрасывает),
команды `subtitles.{list_tracks, set_tracks, set_enabled, toggle,
set_style, remove_track}` (все — eval в активную вкладку, паттерн
set_offset; set_tracks ≤3) и события `subtitles:{tracks_ready,
set_applied}` (+`tabId` в `page:video_detected`): кнопка «duo» в навбаре
(состояние выкл/1/дуо/три, видна при видео с дорожками), панель набора
`src/subtitles-panel/` (пресеты Оригинал/Дуо/Трио, добавление языков
платформы/переводов, ↑/↓ — fast-path перестановка без перезагрузки,
«Свои субтитры…» через нативный диалог tauri-plugin-dialog → load_file,
слайдер сдвига = offset HUD, размер/позиция — set_style), Alt+D —
вкл/выкл показа с восстановлением последнего набора (в content-слое
поглощает клавишу; на пустом наборе собирает дефолт «оригинал + ru»,
`content/set-defaults.ts`); панель открывается/закрывается вслед за Alt+D
(поле via события).
**Задача 3.8 (duopulse-029):** приёмочный контур субтитров — живой e2e-прогон
«10 случайных видео» дополнен offset-проверками на каждом видео (Alt+[ / Alt+]
шаг 100 мс с HUD) и ретраями набора при HTTP 429 (кумулятивный лимит tlang
анонимной сессии; паузы 75/150 с, межвидеовая 25 с — транспорт не менялся);
итоговая сводка фиксирует рабочие пути адаптера (`run-last.json.paths`,
DoD 3.8); чек-лист живого прогона — [e2e/youtube/CHECKLIST.md](../e2e/youtube/CHECKLIST.md).
Фикстуры player-ответов — в CI-контур проекта без сети: GitHub Actions
[.github/workflows/ci.yml](../.github/workflows/ci.yml) (job `js`: npm ci →
build:content → tsc → vitest, включая юнит-тесты адаптера на фикстурах
e2e/fixtures/youtube — docs/03 §9 «падение = карточка с приоритетом 0»;
job `rust`: fmt --check + clippy -D warnings + test после `npm run build` —
cargo требует content/gen (include_str!) и dist (generate_context!));
релизные артефакты остаются локальными в builds/ (конвенция duopulse-045).
Открытые вопросы docs/03 §10 закрыты решениями (§10 переписан;
авто-уменьшение кегля при переполнении — отложено карточкой CARDS/046,
полировка M5). Gate M3 (ROADMAP) — двойные/тройные субтитры стабильны на
10 случайных видео подряд, свой .srt на любом сайте; итоги — CHANGELOG
17.10 (карточка duopulse-029).
**Задача 4.1 (duopulse-030, контракт v3):** домен `translate` —
`translate.{get_settings, set_settings, test}` (`src-tauri/src/translate/`):
интерфейс провайдера `TranslationProvider` (перевод пачки строк: лимиты
`ProviderLimits`, типизированные ошибки `TranslateError` с
`retryable()`, ретраи `translate_with_retries` — экспоненциальная пауза;
HTTP за интерфейсом `HttpTransport` — ureq в бою, mock в тестах, без сети),
реализации DeepL (free/pro хост, `context` для связности терминов, цели
EN-US/PT-BR), Google Translate v2 (ключ в заголовке `x-goog-api-key`,
≤128 строк), LibreTranslate (self-hosted URL, ключ опционален, q-массив);
конфиг — ключ "translate" в settings.json (выбор провайдера, тариф,
адрес), ключи API — ТОЛЬКО DPAPI `translate/keys/<provider>.bin` (общий
код с паролем прокси вынесен в `src-tauri/src/secrets.rs`);
`translate.test` — один живой запрос (кнопка «Проверить», spawn_blocking);
UI — секция «Перевод» duo-панели (`src/subtitles-panel/translate-settings.ts`).
**Задача 4.2 (duopulse-031, контракт v4):** конвейер перевода дорожек —
`src-tauri/src/translate/pipeline.rs` (батчинг cue пачками ≤ 2 КБ и лимитов
провайдера `split_batches`, контекст пачки — последняя строка предыдущей
(DeepL `context`), `translate_track` — кэш → пачки → провайдер с ретраями →
кэш; ошибка пачки останавливает конвейер, частичный перевод в кэш не
пишется) + `src-tauri/src/subtitles/cache.rs` (SQLite-кэш `translated_tracks`
в duopulse.db: `(videoKey, trackId, targetLang, provider) → cues`, LRU 120
дорожек, чтение освежает last_used_at). IPC (контракт v4):
`subtitles.translate_track` (источник — trackId или первая непереводная
строка набора) + событие `subtitles:translate_progress` (фазы
translating/done/error, fromCache); cues — у content-слоя: команда eval'ит
`duopulse-translate-request`, content отвечает WebMessage'м «translate-track»
(конвейер в spawn_blocking, ответ — document-событие `duopulse-translate-track`,
паттерн 3.6). Облачная дорожка `cloud:<lang>` (source "translate") входит в
набор после платформенных строк; content-модуль `content/adapters/cloud.ts`.
UI — селект «+ перевод в… (облако)» (`src/subtitles-panel/cloud-langs.ts`:
языки платформы и набора исключены — бесплатный tlang приоритетнее) + статус
конвейера duoTranslateMeta.
**Задача 4.3 (duopulse-032, контракт v5):** офлайн-деградация (сценарий
docs/01 §5.4) — `src-tauri/src/translate/watcher.rs`: очередь работ
`TranslationJobs` (ключ (videoKey, trackId, targetLang); повторный запрос
того же ключа переподчиняет ответ, второй конвейер не поднимается;
поколения закрывают гонку «финальный ответ ∥ повторный запрос»; работа
снимается, когда вкладка ушла с видео) + цикл `watch_run`/`watch_loop`
(попытка конвейера → Network-отказ → бейдж → ожидание `DUOPULSE_TRANSLATE_RETRY_MS`
(5 с) → TCP-проба эндпоинта текущего конфига → повтор; провайдер
пересобирается на каждой попытке — настройки могли смениться, пока ждали;
Config-отказ (выключен/нет ключа) и терминальные ошибки — бейдж/ошибка без
автоповтора; закрытие гонки probe-vs-настроек: проба строится из текущего
конфига, а не попытки). Событие `subtitles:translate_unavailable` (reason
offline|no_provider, willRetry — панель держит бейдж «Перевод недоступен
(нет сети) — повторим…» в duoTranslateMeta до финального translate_progress);
набор живёт с оригиналом и кэшем (облачная дорожка не строится, кэш-хит
работает и без сети — DoD 4.2). Трейт провайдера получил `endpoint()` —
адрес для пробы связи.
**Задача 5.1 (duopulse-033, контракт v6):** полные настройки + экспорт/импорт
профиля — модуль `src-tauri/src/settings/` (mod.rs — канонический settings.json
+ `settingsVersion` с миграциями на старте; разделы search (поисковик omnibox
по умолчанию — YouTube/Google/Bing/DuckDuckGo, префикс движка подставляет
`nav.resolve_omnibox` через `omnibox::resolve_with`), subtitles (дефолтный
язык перевода набора Alt+D + стиль плашки новых вкладок — доставляются в
content-слой initialization-скриптом `window.__DUOPULSE_DEFAULTS__` до
бандла, читает content/defaults.ts), appearance (тема — тёмная v1, F-10) и
privacy (clearHistoryOnExit — очистка истории при выходе, main.rs RunEvent);
profile.rs — файл профиля `duopulse-profile.json` (формат `duopulseProfile: 1`):
весь settings.json (переносимые разделы proxy/translate/adblock/search/
subtitles/appearance/privacy, валидация ДО применения — битый файл ничего
не меняет), группы избранного + закладки с членствами (карточка
duopulse-058: группы мапятся по имени — id машин разные, старые файлы без
поля — закладки в группу по умолчанию), визиты (дедуп по url+время — повторный импорт
идемпотентен), кэш translated_tracks (upsert; повторный просмотр на новой
машине — из кэша, DoD 4.2 переживает переезд), секреты (пароль прокси +
ключи API — только по явному выбору `includeSecrets`: в файле открытым
текстом, при импорте — обратно в DPAPI). IPC: `settings.{get_all, apply}`
(снапшот/патч разделов; пароли/ключи — прежними командами в DPAPI),
`settings.{export, import}` (пути — нативные диалоги страницы),
`translate.clear_cache` (приватность). UI — страница `duopulse://settings`
(src/pages/settings.ts; реестр Core + роутер + пункт главного меню):
секции внешний вид/поиск/субтитры/перевод/прокси-VPN/приватность/профиль,
отчёты counts экспорта/импорта, needsRestart для переехавшего прокси.
DoD 5.1 «переезд на чистую машину за 1 файл» — стенд e2e/settings/run.mjs
17/17.

**Задача 5.2 (duopulse-034, контракт v7):** установщик NSIS + автообновление —
`src-tauri/src/updater.rs` (сервис `UpdaterService`: книга проверок
последняя-проверка/ожидающий-пакет, install одноразово забирает пакет —
повторный требует новой проверки). Каналы stable/canary — раздел `updater`
settings.json (по умолчанию stable + тихая автопроверка на старте через 20 с;
установка — всегда руками). Фид: `<база>/<канал>/{{target}}/{{arch}}/{{current_version}}`,
база — https://summonss7.github.io/duopulse-updates (GitHub Pages
репозитория duopulse-updates — решение автора 20.10.2026, вопрос
duopulse_035_hosting_20261019), перекрывается
env `DUOPULSE_UPDATE_BASE` (стенды и тестовые машины канарейки); для локальных
http-фидов в plugins.updater включён dangerousInsecureTransportProtocol —
пакет в любом случае проверяется minisign-подписью, прод-эндпоинты зашиты
https. Подпись: ключ `%USERPROFILE%\.tauri\duopulse-updater.key` (пустой
пароль), pubkey — plugins.updater.pubkey; bundler пишет .sig base64-блобом.
Установка на Windows — плагин запускает NSIS-пакет (/P /UPDATE /R: passive,
авто-перезапуск) и завершает процесс. IPC (контракт v7):
`updater.{status, check, install}`. Сборка — `npm run release`
(scripts/release.mjs): NSIS-пакет + .sig + latest.json (манифест фида,
url — имя пакета, хостинг подставит базу) в `builds/duopulse_<версия>_<тип>/`.
UI — секция «Обновления» страницы настроек (канал, автопроверка, проверить/
установить) + пункт меню «Проверить обновления…»; bridge-клиент
window.__duopulse экспонируется и в прод-бандле (стенд обновлений гоняет
установленное release-приложение по CDP). DoD 5.2 — стенд e2e/update/run.mjs
17/17 (чистая установка /S: реестр-каталог-ярлыки; обновление канарейки
0.1.0→0.1.1 по локальному фиду с проверкой подписи, авто-перезапуск, профиль
выживает, реестр 0.1.1; деинсталляция /S чистая).

**Обновление 27.10.2026 (карточка duopulse-062):** каждый релиз
(`npm run release`) последним шагом обновляет и локальную портативную копию
`C:\DuoPulse\duopulse.exe` (+WebView2Loader.dll) свежим exe из
`target/<тип>/` — конец `scripts/release.mjs`, `deployLocal()`. Папки нет
(чужая машина/CI) — шаг пропускается; файл занят (DuoPulse открыт) — релиз
падает с подсказкой: закрыть DuoPulse и повторить
`npm run release -- --deploy-local` (только докопирование, без сборки и
публикации). Встроенный автоапдейтер такую копию не трогает — он обновляет
NSIS-установку, поэтому правило «релиз = свежий C:\DuoPulse» лежит на
релизном конвейере. Там же в карточке: заголовок окна — `DuoPulse <версия>`
(main.rs, версия из package_info = tauri.conf.json).

**Обновление 31.10.2026 (карточка duopulse-063):** каждый релиз обновляет
и корень `builds/` для хаба «Скачать» Aila — `deployHub()` в
`scripts/release.mjs` перед `deployLocal()`. Причина: хаб сканирует только
корень `builds/` (подпапки релизов `duopulse_<верс>_<тип>/` не видит), и
оказавшийся там установщик 0.1.0 от 19.10 (база фида — тогда ещё не
существовавший `updates.duopulse.dev`, до решения о GitHub Pages 20.10 и
зеркала Aila 23.10) навсегда отрезал установившие его машины от обновлений —
жалоба «на другом компе программа всё равно старая». Теперь в корне всегда
лежит `DuoPulse-<верс>-setup-release.exe` текущего релиза (побайтово пакет
из фида), устаревшие установщики и портативные zip убираются: портативная
копия не умеет самообновляться (NSIS-апдейтер её не трогает) и в хабе больше
не раздаётся. Debug-сборки в хаб не идут. Лечение уже попавших на старый
билд машин — одна ручная установка свежего установщика; дальше обновления
идут сами (обе базы + фолбэк).

**duopulse-049 (контракт v11): зеркало фида на Aila + выбор источника.**
Источник — раздел `updater` настроек (`source`: github — по умолчанию /
aila), семантика в `src/updater.rs`: попытки строго по одной (выбранный
источник → второе зеркало; DUOPULSE_UPDATE_BASE подменяет базу выбранного,
вторая попытка-зеркало остаётся — мёртвый подменённый стенд и проверяет
фолбэк), «кто ответил» фиксируется в поле
`source` результата `updater.check` (и в `updater.status`) — фолбэк
наблюдаем. Адресация: GitHub — прежняя `<база>/<канал>/{{target}}/{{arch}}/
{{current_version}}` (файл фида на версию клиента в репозитории
duopulse-updates), Aila — `<база>/latest.json` / `latest-canary.json`
(статика /updates/duopulse/ рядом с manifest.json v2, aila-163; url пакета
в фиде абсолютный — плагин не разрешает относительные). UI: селект
«Источник» (GitHub/Aila) + явное «✓ У вас последняя версия · источник: …»
(и пометка «выбранный недоступен — ответило зеркало»). Публикация релиза в
оба канала одной командой — scripts/release.mjs (`--publish-only` —
повторная публикация готовых артефактов): сборка → latest.json/
latest-canary.json (подпись из фактического .sig) → канал Aila через
`node D:\Scheduler\tools\publish-update.cjs duopulse --extra …` (флаг
--extra — точный список файлов публикации, общий для проектов) → канал
GitHub коммитом в локальный клон duopulse-updates внутри проекта (env
DUOPULSE_GH_FEED_DIR, дефолт D:\DuoPulse\duopulse-updates — duopulse-071;
файлы фида прошлых версий перезаписываются текущим
фидом — старые клиенты узнают о релизе). Стенд e2e/update: ассерты контракта
v11, `source` в проверках, фаза B+ «источник aila» (адресация
latest-canary.json → «у вас последняя версия», source=aila).

**Задача 5.3 (duopulse-035):** чек-лист приёмки релиза + прогон метрик —
полный приёмочный контур на эталонной машине (релизная сборка HEAD f2253d3,
19–20.10.2026). P-метрики (e2e/perf, e2e/sleep, e2e/adblock): P-01 848 мс
(≤1500; на gate M2 было 405 — машина в момент замера несла сеансовые
процессы, в бюджете с запасом), P-02 365 мс (≤500), P-03 оболочка
duopulse.exe 49 МБ (≤250; дерево 5 вкладок 962 МБ, дельта контента 635 МБ —
Chromium-домен, трактовка «поверх WebView2» подтверждена автором 16.10),
P-04 0,54–1,01% ядра спящей вкладки (≈0; без сна 64–69%), P-06 0 longtask /
макс. блокировка 16,4 мс — **в бюджете**. P-05 — 16,5% дропов при формальном
бюджете «0/мин»: YouTube перевёл 1080p60 на AV1 (av01.0.09M.08, itag 399),
на эталонной машине нет аппаратного AV1-декода → софт; контроль Chrome на
том же ролике — тот же кодек и те же 16,7% дропов, платформенное изменение
(вопрос трактовки — Aila duopulse_035_p05_20261019). P-07 — в сеть 256→201
(79% при цели ≤60%): как решено по gate M2 (duopulse_017_p07), путь до
первого кадра — first-party трафик плеера, сетевые списки больше не режут;
практический критерий «реклама не показана» выполнен (0/3 прогона,
скриптлеты). P-08 — медиана 19,8 с против Chrome 3,7 с: расследование
показало themeRefresh-гипотеза устарела (перезагрузок нет) — плеер ~18 с
стоит в buffering (readyState 0) при скрытой рекламе до отработки
серверного ad-решения (SABR/USDAI), с выключенным блокировщиком реклама
стартует ~4 с; факты и дифференциал подшиты в CARDS/044 (вопрос приёмки —
Aila duopulse_035_accept_20261019). Сценарии docs/01 §5: §5.1 —
e2e/youtube 52/52 ALL PASS (10/10 видео, наборы из UI-хрома, дроп .srt);
§5.2 — scriptlets 11/11 + cosmetic 12/12 (рекламы и заглушек нет), старт
видео задержан SABR-stall (карточка 044); §5.3/§5.4 — e2e/subtitles 97/97;
§5.5 — **явная пометка: поканальный тест 5.1/7.1 не выполнялся — устройство
вывода 5.1/7.1 не появилось** (активны только стерео-динамики Realtek;
duopulse-006 остаётся blocked, программная проверка M0 «сведения нет» в
силе); §5.6 — инкремент A: e2e/proxy-a 16/16 (порт стенда переопределяется
env E2E_PROXY_A_PORT — 8899 занял сервис Aila), полный сценарий — этап M6.
Регресс: cargo 170+1 ignored / vitest 169/169 / tsc чисто, e2e/bridge 14/14,
e2e/settings 17/17; e2e/update 17/17 — прогнан в сеансе 5.2 на том же HEAD
(код не менялся). **Решения автора 20.10.2026 02:00–02:03 (Aila):** приёмка
5.3 **принята** — SABR-stall (P-08/§5.2) чинить карточкой CARDS/044 **до
финального релиза** (duopulse_035_accept_20261019); P-05 — трактовка «не хуже
Chrome/Edge на той же машине», docs/04 §2 обновлён (duopulse_035_p05_20261019);
хостинг фида — GitHub Pages summonss7.github.io/duopulse-updates, база сменена
в коде (`updater.rs` + `tauri.conf.json`, duopulse_035_hosting_20261019),
физическая публикация фида — релизным конвейером (после LICENSE, карточка
036). Трактовку P-05 поддержаны: страница «Диагностика» (P-05 — сравнительная
метрика budgetMax null, как P-08) и стенд e2e/perf/p05.mjs (контрольный замер
Chrome тем же методом, критерий DuoPulse ≤ Chrome; с 21.10 YouTube-сервер
гейтит свежие Chrome/Edge-профили — стенд честно пропускает контроль с
пометкой, восстановление — карточка 047).

**Карточка 047 (duopulse-047, 21.10.2026): контроль P-05/P-08 заменён по
решению автора** (duopulse_047_control_20261021, ответ 21.10 03:48: «Контроль
= DuoPulse с выключенным блокировщиком»). Расследование зондами CDP: гейт
YouTube — серверный по семейству клиента (Chrome/Edge: playerState 3,
readyState 0 при playability OK, сервер при этом отдаёт 200-ответы потока
yt-ump; WebView2/DuoPulse в то же время играет; отброшены персистентный
профиль, пересадка кук WebView2-сеанса, host-resolver/DoH/QUIC/no-proxy,
Chrome через SOCKS5-роутер DuoPulse, срез X-Client-Data, --lang; движки и
публичный IP идентичны) — локального обхода нет. Стенды e2e/perf/p05.mjs и
p08.mjs переведены на контроль «DuoPulse без блокировщика» (settings.json
`adblock.enabled=false` в профиле контроля до запуска; отказ контроля =
провал прогона, DUOPULSE_P05_REQUIRE_CONTROL эпохи Chrome-гейта упразднён),
«Диагностика» — подписи бюджетов P-05/P-08 без привязки к Chrome, решение и
плата (потеря независимости движка) зафиксированы в docs/04 §2; возврат к
Chrome-контролю — если YouTube восстановит выдачу свежим профилям.

**Задача 6.2 (duopulse-038, контракт v8):** клиент WireGuard — `src-tauri/src/vpn/wg.rs`
(boringtun 0.7 + TCP/IP-стек smoltcp medium-ip, userspace, без TUN-драйвера
и прав администратора). Схема: роутер терминирует TCP-соединения WebView2 в
виртуальных сокетах стека, их IP-пакеты идут через boringtun-туннель UDP на
сервер пользователя. Импорт `.conf` (формат wg-quick, снисходительный парсер:
несколько `[Peer]` → первый, MTU/SaveConfig игнорируются, IPv6-only Address
честно отклоняется): профили в `wg-profiles.json` (id детерминирован публичным
ключом пира — повторный импорт upsert), приватный ключ + PSK — единым
DPAPI-blob `vpn/wg/<id>.bin` (открытым текстом нигде, тест проверяет файлы).
Handshake — первый initiation явно (update_timers ретраит только после
первого), keepalive/rekey — таймерами протокола; roaming — `network_changed()`:
сокет и сессия пересоздаются, established-соединения стека переживают переход
(сервер WG принимает с любого адреса). DNS без утечек: домены туннельного
маршрута резолвит DNS-сервер профиля через UDP-сокет стека (внутри туннеля),
endpoint самого сервера — системно (как любой WG-клиент). Тактование нити
туннеля: nonblock-дрен UDP + poll дважды за такт + блокирующее ожидание
датаграммы в конце итерации (пробуждение по приходу датаграммы, не по тику
Windows ~15,6 мс); wake-датаграммы от WgStream/команд будят нить мгновенно;
ACK без задержки (set_ack_delay(None)) — иначе RTT виртуального канала
убивал пропускную способность (замер: было ~9 Мбит/с → стало гигабиты
loopback-стенда). IPC (контракт v8): `vpn.{import_profile, list_profiles,
remove_profile, use_profile}` + расширение `vpn.{status, test_connection}`
(mode off/proxy/wg + снапшот туннеля; проба через туннель, DUOPULSE_WG_PROBE,
default one.one.one.one:80) и события `vpn:state_changed` (переходы
connecting/connected/error с полем mode/wg); включение WG гасит прокси-режим
(маршруты взаимоисключимы до split-правил 6.3), активный профиль поднимается
на старте (main.rs → `bridge::apply_wg_saved`). Стенд в cargo-тестах: loopback
WireGuard-сервер (Tunn boringtun + smoltcp: TCP-echo/генератор, DNS-ответчик,
roaming-ответы последнему адресу клиента) — handshake, echo, DNS, keepalive
при простое, roaming с сохранением соединения, fail-closed на мёртвом
endpoint, сквозной SOCKS5→роутер→туннель→echo; throughput (ignored-тест,
release + DUOPULSE_WG_TPUT_MIN_MBPS) и soak (DUOPULSE_WG_SOAK_SECS).

**Задача 6.3 (duopulse-039, контракт v9):** split-tunnel — `src-tauri/src/vpn/rules.rs`
(правила домен → маршрут) + `vpn/dns.rs` (резолв строго по маршруту). Режимы
(docs/02 §6.2): off (весь трафик напрямую, туннель не поднимается) / global
(всё через туннель — поведение 6.2) / split (целевой: правило «tunnel» —
через туннель, остальное и правило «direct» — напрямую). Матчинг — суффикс по
границе меток (`example.com` ловит и `sub.example.com`, `ample.com` — нет),
домен известен до резолва (Chromium шлёт ATYP=domain), IP-литералы доменными
правилами не ловятся. Персист — `vpn/split-rules.json` (режим + правила,
секретов нет, битый файл → дефолт off/пусто); стор общий для IPC и роутера —
правка действует на новые соединения сразу, без перезапуска. Роутер:
`Policy::Single` (маршрут на всё — off/global/прокси) | `Policy::Split`
(решение на каждое соединение); прокси-конфиг при живом туннельном режиме
маршрут не трогает (взаимная исключительность, вернётся при off). DNS без
утечек (`vpn/dns.rs::Resolver`): туннельный домен — только DNS-сервер профиля
через UDP-сокет стека внутри туннеля, прямой — системный резолвер, upstream —
удалённый резолв RFC 1928; endpoint WG-сервера — системно (как любой
WG-клиент). IPC v9: `vpn.{set_mode, get_rules, add_rule, remove_rule}`
(add_rule — upsert по домену), `vpn.status/test_connection` расширен полем
`routing` (vpn-режим off/global/split, отличим от фактического mode);
use_profile(Some) в off поднимает global, set_mode(global/split) без профиля —
честный отказ; старт — `apply_wg_saved` в сохранённом режиме. UI: секция
«VPN-туннель WireGuard» на странице «Настройки» — селектор режима, список
правил (сегмент туннель/напрямую на строке, удаление), добавление домена.
Тесты: cargo — split-сквозной через loopback WG-стенд (заблокированный домен
через туннель + прямой одновременно, DNS только сервером туннеля по счётчикам
стенда, правило на лету, fail-closed на мёртвом туннеле — REP и ноль прямых
соединений), правила (матчинг/валидация/персист/upsert/битый файл), dns;
e2e/bridge v9 — правила/режим/файл персиста; смоук UI (DOM + геометрия).

**Задача 6.4 (duopulse-040):** kill-switch — разрыв/падение туннеля не
выпускает туннельный трафик в открытую. Новые соединения при мёртвом
туннеле отказывали и раньше (fail-closed роутера 6.1/6.3); 6.4 закрывает
главную дыру — УЖЕ УСТАНОВЛЕННЫЕ соединения, которые доживали цикл на
ретрансмиссиях стека (страница «грузилась» минутами). Порог мёртвости:
handshake старше `dead_after` (по умолчанию REJECT_AFTER_TIME протокола —
180 с: ключи сессии истекли, данные гарантированно не дойдут; env
`DUOPULSE_WG_DEAD_MS` для диагностики, минимум 1 с) либо не поднявшийся за
порог туннель — `Runtime::publish_status` (`vpn/wg.rs`) переводит состояние
в Error «kill-switch: туннель мёртв» и `kill_tunneled` закрывает ВСЕ потоки
(EOF клиентам роутера, отказ ждущим connect/DNS — страница видит обрыв);
новые TCP/DNS отказывают сразу (fail-fast в open_tcp/open_dns, без 10-с
таймаута). До порога молчание двусмысленно (роуминг/rekey) — соединения
живут; восстановление handshake возвращает Connected, клиенты
переподключаются. Выключение/смена профиля (`stop_wg_tunnel` в bridge)
рвёт установленные соединения тем же образом (shutdown сессии) и эмитит
`vpn:state_changed` Off «выключен»; причина — в `detail` события (эмит
kill-switch — один раз за эпизод мёртвости, форс-обход дедупликации по
состоянию — не теряется за Error'ом «сеть сменилась»). UI: настройки VPN
слушают `vpn:state_changed` — строка статуса живая (подключён/подключается/
ошибка kill-switch/выключен), начальный снапшот — `vpn.status` при загрузке
страницы; контракт не менялся (дополнилось schema-описание события).
Автотесты DoD (cargo, loopback WG-стенд):
kill_switch_dead_upstream_closes_established_and_fails_closed — соединение
к туннельной цели качает генератор («загрузка страницы»), upstream-сервер
убивается СЕРЕДИНЫ передачи: установленный поток получает EOF в пределах
порога, прямых соединений к цели — ноль (прямой путь при этом жив: контрольное
соединение умолчания split проходит), событие Error kill-switch уходит,
новые соединения к туннельной цели отказывают;
kill_switch_route_change_closes_established_connections — выключение
туннеля (stop-путь bridge) рвёт установленный поток. Порог для теста —
параметр сессии (15 с), не env — параллельные тесты не задевает.

**Задача 6.5 (duopulse-041):** UI VPN — индикатор-щит в Navbar и панель
(`src/vpn-panel/`; разметка в index.html). Щит — сигнальные цвета гайда 06
§2: off muted / connecting предупреждение с пульсом / connected успех со
свечением / error ошибка; состояние — из фактического маршрута (`mode wg`)
и фазы туннеля. Панель: тумблер туннеля (`vpn.use_profile`), сервер
(импорт `.conf` нативным диалогом → `vpn.import_profile`, смена на лету,
удаление с честной остановкой активного), режим off/global/split
(`vpn.set_mode`), split-правила (сегмент туннель/напрямую на строке,
добавление, «этот сайт — через туннель» — правило для хоста активной
вкладки), статистика и «Маршруты сеанса» — событиями, без опроса;
дисклеймер «DuoPulse — только VPN-клиент» (docs/01 F-12) со ссылкой на
настройки. Контракт v10: `VpnWgState.pingMs` (RTT ICMP-эхом до DNS-сервера
профиля через туннель — он всегда внутри туннеля; null — ответа нет дольше
3 с: сервер может не отвечать на ICMP, трафик при этом жив) + события
`vpn:stats` (rx/tx/ping/handshake, эмит нитью туннеля не чаще раза в
секунду и только при изменении — простой без трафика молчит, панель держит
последние числа) и `vpn:route_changed` (решение роутера домен →
tunnel|direct|proxy: первый маршрут домена и смена — дедуп в роутере;
прямой off-режим решений не сообщает). Пинг — долгоживущий ICMP-сокет
smoltcp (`socket-icmp`), echo DNS-серверу профиля раз в секунду, RTT в
статус; в loopback-стенде на echo отвечает стек сервера
(`auto-icmp-echo-reply`). Тесты: cargo — ping_measures_rtt_through_tunnel
(RTT в ping_ms, пинг не мешает TCP-эху) и stats_event_reports_ping_and_
bytes (событие несёт rx>0 и ping; троттлинг/дедуп), router — route_events_
first_decision_and_dedup (первое решение — событие, повтор — молчание,
off молчит, решение не отменяется отказом соединения дальше); vitest —
модель панели (щит из снапшотов, формат rx/tx/ping/handshake, хост вкладки,
каталог маршрутов с всплытием смен и cap); e2e/bridge v10 — панель в живом
приложении (кнопка-щит, статус/тумблер/режим/дисклеймер, правило из панели
доходит до Core, Escape).

## 3. Эпики → карточки (порядок работ)

Каждая строка — кандидат в карточку CARDS/ (создаётся диспетчером/разработчиком при
старте эпика; здесь — канонический список). «DoD» = критерии готовности карточки.

**Обновление 12.10.2026 (карточка duopulse-010):** весь оставшийся бэклог M1–M6
инстанцирован карточками CARDS/011–042 (priority 9, status todo; порядок
выполнения = нумерация, одна карточка = один сеанс — экономия токенов).
Gate-проверки этапов включены в последние карточки этапов: 016 (M1), 021 (M2),
029 (M3), 032 (M4), 036 (M5), 042 (M6). При изменении плана — править
соответствующую карточку и этот список вместе.

### M0 — спайк движка
| # | Задача | DoD |
|---|---|---|
| 0.1 | Каркас Tauri 2 + WebView2, окно с адресной строкой-заглушкой | `cargo tauri dev` открывает youtube.com |
| 0.2 | Проверка видео: 1080p60/4K, дропы кадров, DRM-ролики (премиум/музыка) | протокол испытаний заполнен, решение Go/No-Go зафиксировано |
| 0.3 | Инжекция content-скрипта (AddScriptToExecuteOnDocumentCreated) + перехват запросов (WebResourceRequested) | скрипт пишет в консоль метку на каждой странице; запрос к тест-URL блокируется |

### M1 — каркас браузера
| # | Задача | DoD |
|---|---|---|
| 1.1 | **✅ выполнено 12.10.2026 (карточка duopulse-011)** IPC-контракт bridge + кодогенерация типов | команда `tabs.list` проходит сквозной тест |
| 1.2 | **✅ выполнено 12.10.2026 (карточка duopulse-012)** Таб-бар: вкладки, закрытие, Ctrl+Tab, восстановление закрытой | ручной чек-лист проходит ([e2e/tabs/CHECKLIST.md](../e2e/tabs/CHECKLIST.md)) |
| 1.3 | **✅ выполнено 12.10.2026 (карточка duopulse-013)** Omnibox: URL/поиск, подсказки (история+закладки, FTS5) | поиск по 10k записей истории < 50 мс |
| 1.4 | **✅ выполнено 13.10.2026 (карточка duopulse-014)** История и закладки (SQLite + страница управления) | запись/поиск/удаление работают |
| 1.5 | **✅ выполнено 13.10.2026 (карточка duopulse-015)** Фирменный тёмный UI-хром по гайду 06 | сверка с гайдом по чек-листу |
| 1.6 | **✅ выполнено 13.10.2026 (карточка duopulse-016)** Восстановление сессии (ленивое): session.json в профиле, при старте грузится только активная | 10 вкладок восстанавливаются, старт не деградирует > 10% (замер: −7,3%) |
| 1.7 | Спайк многоканального звука 5.1/7.1 (карточка duopulse-006): поканальные тесты + YouTube 5.1 на реальной системе 5.1/7.1 | протокол e2e заполнен; все каналы звучат из правильных динамиков не хуже Chrome/Edge; при провале — карточка-решение и запись в ROADMAP |
| 1.8 | **✅ выполнено 11.10.2026 (карточка duopulse-009)** Прокси (F-12, инкремент A): настройки SOCKS5/HTTP(S) с аутентификацией, применение через аргументы WebView2 (перезапуск), тумблер и статус в меню (карточка CARDS/009) | браузер ходит через внешний прокси (проверка IP-эхом), без прокси — напрямую; пароль прокси — в DPAPI |
| 1.9 | **✅ выполнено 27.10.2026 (карточка duopulse-057)** UX первого запуска: полный URL в omnibox на SPA-YouTube (content/url-watch.js → `TabManager::on_spa_url` — адрес вкладки, визит истории, сессия); «открыть в новой вкладке»/target=_blank/средняя кнопка → COM NewWindowRequested открывает вкладку DuoPulse; звёздочка избранного в Navbar + Ctrl+D из контента (`HistoryStore::toggle_bookmark`); кнопка «duo» видна на любом видео; подсказка возможностей на «Новой вкладке» | живой стенд 10/10 (SPA-URL в omnibox/tabs.list/истории; target=_blank и window.open → новые вкладки; звезда вкл/выкл кликом и Ctrl+D), пиксель-проверка залитой звезды #BDFE4F; cargo 243, vitest 187 |
| 1.10 | **✅ выполнено 29.10.2026 (карточка duopulse-058)** Группы избранного: таблицы `bookmark_groups`/`bookmark_group_items` (миграция плоского списка — все закладки в «Избранное»), команды `history.{group_list, group_add, group_rename, group_remove, group_set_sort, group_toggle_bookmark, bookmark_move}`; страница управления — чипы групп, панель сортировки (вручную drag&drop/по имени/по дате), меню папки строки (закладка в нескольких группах или без), мини-меню звёздочки с выбором группы и «Новая группа…», подсказки omnibox с именами групп; экспорт/импорт профиля переносит группы (мап по имени, старые файлы — в «Избранное») | живой CDP-стенд e2e/bookmarks 23/23 (сид/CRUD/фильтры/сортировки/dnd/меню звёздочки/страница управления), cargo 250 (+7: миграция, CRUD, сортировки, метки поиска, импорт групп и старого профиля), vitest 187 |

### M2 — скорость
| # | Задача | DoD |
|---|---|---|
| 2.1 | **✅ выполнено 14.10.2026 (карточка duopulse-017)** adblock-rs: сетевая фильтрация + списки EasyList/uBO + обновление | метрика P-07 достигнута — сетевым слоем не достигнута (замер e2e/adblock/p07.mjs: 246→229 запросов до первого кадра, 93%; в сеть 246→213, 87% при цели ≤60%): EasyList+uBO режут ~15 внешних ad/telemetry-запросов, путь до первого кадра YouTube — first-party трафик плеера; YouTube-преролл сетевые списки не подавляют — закрыто скриптлетами карточки 043 (P-07-замер с ними: реклама не показана ни в одном прогоне). Решение о критерии — вопрос автору (Aila, id duopulse_017_p07_20261014, ответ: P-07 — на 2.2/gate M2) |
| 2.2 | **✅ выполнено 14.10.2026 (карточка duopulse-018)** Косметическая фильтрация в content-скрипте | главная YouTube без рекламных блоков-заглушек — **достигнуто** (e2e/adblock/cosmetic-youtube.mjs: видимых заглушек на главной и watch нет, сетка/вёрстка целы; скриншоты до/после — e2e/adblock/shots-2.2/). Механика: content/cosmetic.js (initialization_script каждой вкладки) запрашивает у Core селекторы скрытия для URL (WebMessage → adblock-rs `url_cosmetic_resources` → PostWebMessageAsString) — host-специфичные + misc-generic сразу, generic class/id — по классам/идам из DOM (первичный проход + MutationObserver-дельта); CSS-скрытие живое (SPA/поздние узлы). Ограничения: top-level документ; скриптлеты `##+js` — выполнены карточкой 043 (ниже); YouTube-преролл — видео-поток, косметикой не режется (закрыто скриптлетами 043) |
| 2.6 | **✅ выполнено 15.10.2026 (карточка duopulse-043)** Скриптлеты `##+js` (ресурсный набор uBO) | правила `##+js(...)` из EasyList/uBO исполняются в контентной вкладке — **достигнуто**. Механика: ресурсный набор uBO-скриптлетов генерируется scripts/build-adblock-resources.mjs из npm-пакета @adguard/scriptlets (родной uBO resources.txt апстрим удалил) в src-tauri/src/adblock/scriptlets-resources.json — вкомпилирован в бинарник, digest входит в метки engine.json (смена набора перестраивает кэш); `Engine::use_resources` после from_rules и после deserialize; движок собирает код в `injected_script` (function-style, try/catch), доставляется тем же WebMessage-каналом косметики, content/cosmetic.js исполняет его `<script>`-элементом в мире страницы (Trusted Types — своя политика duopulse-scriptlets, youtube-кейс). Тумблер/white-list отключают инъекции; trusted-* скриптлеты с 30.10.2026 инъенцируются спискам, которым доверяет `trusted_list()` в adblock/mod.rs (ublock-ads, duopulse-compat — решение автора 29.10, карточка 061; до этого — untrusted ParseOptions, эксперимент 050). Приёмка: e2e/adblock/scriptlets.mjs 11/11; cosmetic-youtube.mjs 12/12 — YouTube-преролл исчез (playerAds/adSlots = undefined, P-07: реклама 0/3 прогонов), известное ограничение — асинхронная доставка (ранние инлайн-скрипты страницы могут успеть раньше) |
| 2.3 | **✅ выполнено 14.10.2026 (карточка duopulse-019)** Спящие вкладки + исключения (звук/видео) | метрика P-04 ≈ 0% — **достигнуто** (e2e/sleep/p04.mjs: 67,6%→0,54% ядра при «шумовой» фоновой вкладке; воркер во сне заморожен, пробуждение без потери состояния). Механика: `src-tauri/src/tabs/sleep.rs` — TrySuspend/Resume (WebView2) по таймауту простоя 5 мин (`DUOPULSE_SLEEP_AFTER_SECS`, 0=выкл; скан-нить), IPC `tabs.{sleep, wake}`, `TabInfo.sleeping` в контракте; исключение «играет звук/видео» — content/media-watch.js (WebMessage → on_media), активная не спит; пробуждение — активацией/tabs.wake. Функциональный стенд e2e/sleep/run.mjs — 15/15 (замечено: подключённый CDP-отладчик контентной вкладки отменяет приостановку — состояние страниц стенд читает через document.title) |
| 2.4 | **✅ выполнено 16.10.2026 (карточка duopulse-020)** Тёплый старт + преднастройка кэшей | метрики P-01..P-03 в бюджете docs/04 §2 — **P-01 447→402 мс (≤1500), P-02 380→365 мс (≤500), P-03 оболочка duopulse.exe 48 МБ (≤250)** (релизная сборка, медианы 3 прогонов, e2e/perf/run.mjs; дельта дерева на 5 вкладках с играющим YouTube ~+806 МБ — контент в процессах WebView2, домен Chromium; трактовка «поверх WebView2» = оболочка duopulse.exe подтверждена хозяином 16.10.2026 — Aila, duopulse_020_p03_20261016, кнопка 1). Механика: кэши/профиль WebView2 живут между запусками (не чистится); свежий старт идёт лениво, как восстановление (первая вкладка материализуется по RunEvent::Ready — creation webview в setup блокировал старт цикла, −45 мс); прогрев топ-сайтов истории при простое UI (`src-tauri/src/prefetch.rs`: preconnect/dns-prefetch в хроме — все webview делят сетевой стек; DUOPULSE_PREFETCH=0 — выкл, стенды DUOPULSE_START_URL не греют); метки фаз старта `[startup]` в stderr (stores 9–12 мс — SQLite не откладываем, окно+окружение WebView2 ~330 мс — доминанта) |
| 2.5 | **✅ выполнено 16.10.2026 (карточка duopulse-021)** Страница «Диагностика»: съём и история метрик | график последних прогонов — **достигнуто** (duopulse://diagnostics: живой срез сеанса perf.snapshot — старт и фазы [startup], переключения вкладок perf:tab_switch_ms, RAM duopulse.exe, счётчики блокировщика; история прогонов P-01..P-08 в SQLite (таблица perf_runs в duopulse.db, последние 10 — docs/04 §3) со спарклайн-графиком, бюджетами и подсветкой «вне бюджета»; «Снять срез» сохраняет p01/p02/p03; пункт в главном меню; стенд e2e/perf/diagnostics.mjs 4/4). Gate M2 (полный прогон P-01..P-08, релизная сборка, эталонная машина): P-01 405 мс (≤1500), P-02 379 мс (≤500), P-03 48 МБ (≤250), P-04 0,93% ядра (≈0), P-06 0 longtask/макс 18,2 мс; открытые пункты — вопросы автору (Aila, 16.10): P-05 5 дропов/3600 кадров = 0,14%/мин при бюджете «0/мин» (M0-прецедент: 3/3149 = 0,10% принят PASS), P-08 медиана 5,9–8,7 с хуже Chrome ~4,4 с (перенаправ themeRefresh в каждом запуске — расследование CARDS/044), P-07 контрольный: реклама с блокировщиком не показана ни в одном прогоне (0/2+0/3), субъективная оценка YouTube — вопрос отправлен. **Gate M2 принят автором 16.10.2026 19:57 (Aila, duopulse_021_m2_20261016, кнопка 1: «Принять M2, P-08 починить карточкой 044 до M3»)** — этап M2 закрыт; P-08 — CARDS/044 до старта M3, ответы по P-05/YouTube-оценке подшиваются в карточку duopulse-021 |

### M3 — многоязычные субтитры v1 (центральный этап)
| # | Задача | DoD |
|---|---|---|
| 3.1 | **✅ выполнено 17.10.2026 (карточка duopulse-022)** Парсеры srt/vtt/timedtext (Rust) + фикстурные тесты | 100% фикстур проходят, границы cue корректны — **достигнуто**. Механика: `src-tauri/src/subtitles/` — единая модель `Cue` + диагностика `ParsedCues` (docs/03 §6); `mod.rs` — общая нормализация (BOM/CRLF, вырезание тегов разметки, сущности; timedtext — два прохода: YouTube экранирует дважды, `&amp;#39;` → `'`; стабильная сортировка по start; перекрытия сохраняются и диагностируются — смёржит движок показа, docs/03 §4); разбор снисходительный — битые блоки/тайминги/элементы пропускаются с предупреждением (srt/vtt — с номером строки), целиком битый файл (не-WEBVTT, битые XML/JSON) — диагностика + salvage, без паник; `srt.rs` (SubRip: номер cue опционален и не сверяется, мс через `,`/`.`, часы можно опустить), `vtt.rs` (WebVTT: NOTE/STYLE/REGION пропускаются, настройки cue игнорируются, таймстампы MM:SS.mmm, сущности; экранированный `&lt;b&gt;` — литерал), `timedtext.rs` (XML `<transcript>` start/dur в секундах + legacy `<timedtext><body><p>` t/d в мс + JSON3: пословные `aAppend`-события автосубтитров разбираются нарастающей строкой — cue «что видно сейчас»: всегда одна строка, набираемое слово в момент речи, завершённая (уже проговорённая) держится лишь до первого слова следующей фразы, без стопки строк (duopulse-094/113), служебные события пропускаются; детект формата по `{`; quick-xml); фикстуры — e2e/fixtures/subtitles/ (12, включая негативные + README); тесты cargo 92/92 (+25), fmt/clippy чисто; сервис-обвязка (IPC subtitles.*, кэш) — задачи 3.3–3.6 |
| 3.2 | **✅ выполнено 17.10.2026 (карточка duopulse-023)** content: детектор видео + каркас движка cue-таймлайна | на тест-странице overlay показывает тест-cue точно по времени — **достигнуто** (e2e/subtitles/run.mjs 21/21: границы cue, правило 150 мс при seek, смёрженные перекрытия, offset, призраки, живое воспроизведение, MutationObserver, SPA). Механика: content-слой переведён на TS-модули с бандлом — `content/{detector,engine,overlay,messaging}` + вход `duopulse-content.ts` → esbuild IIFE `content/gen/` (15 КБ / 5 КБ gzip ≤ 80; `npm run build:content`, входит в `npm run dev/build`; генерат в .gitignore как dist/, cargo требует npm-шаг до сборки); инжекция 5-м initialization_script каждой вкладки. Детектор: скан + MutationObserver (видео добавляется/уходит динамически; initialization script до разбора документа — старт по DOMContentLoaded), выбор ключевого видео по площади, опрос location.href (SPA-переходы), ключ `videoKeyFor` (yt:watch/shorts/youtu.be, прочие — url:URL+duration, docs/03 §6; уточнение ключа по loadedmetadata) → WebMessage «video» → Core эмитит `page:video_detected` (каркас с 1.1 ожил). Движок: `CueTimeline` (сортировка + смёрж цепочек перекрытий — тексты через \n, смежные не сливаются; активный cue бинарным поиском за O(log n)), `SubtitlesEngine` (часы — только `video.currentTime`; подписки timeupdate/seeked + детект программных скачков по Δt>250 мс; offset ±10 c ко всему набору; правило 150 мс docs/03 §4 — cue с меньшим остатком при скачке не показывается и не «вспыхивает» на остатке при продолжении; перерисовка только по смене набора строк). Overlay-каркас: fixed-плашка по rect видео, pointer-events:none, fade 80 мс, строки набора (1-я белая, 2-я лайм #BDFE4F — относительные размеры docs/03 §5), кегль от ширины видео (cqw); полный стиль/позиция/колесо — задача 3.4. Дорожки до IPC subtitles.* (3.3–3.6) движок получает тест-хуком (custom-события duopulse-test-track/-offset). Тесты: vitest 34 новых (38/38 — выбор cue/offset/seek, смёрж/границы таймлайна, videoKey), cargo 92/92, fmt/clippy чисто; стенд e2e/subtitles/ (testpage.html + testsrc.mp4 30 с с счётчиком кадров — визуальная сверка таймингов, скриншот shot-overlay.png)
| 3.3 | **✅ выполнено 17.10.2026 (карточка duopulse-024)** YouTube-адаптер: полный список дорожек + загрузка выбранных N (оригинал + 1–2 `tlang`-перевода или любые языки) | 10 случайных видео → наборы из 2–3 дорожек получены — **достигнуто** (e2e/youtube/run.mjs 22/22: все 10 видео дали набор «оригинал+ru+es» с cue > 0 и оверлеем; например TED af+ru+es по 417 cue (af — баг до duopulse-070: несуществующий в web-клиенте audioTracks → первая дорожка; после — en+ru+es), Gangnam ko(asr)+ru+es, Bohemian ar+ru+es). Механика: `content/adapters/{types,youtube}.ts` — все знания о YouTube в одном модуле (docs/03 §9), версия + цепочка путей (player-api → initial → texttrack), фикстуры записанных player-ответов — e2e/fixtures/youtube/playerResponses/ (11 видео: manual/asr/моноязычные/65-дорожечный TED, рекордер e2e/youtube/record.mjs), юнит-тесты на них без сети. Ключевые открытия (пробы на живом YouTube, окт. 2026): прямые timedtext-URL из player-ответа отдают 200 с ПУСТЫМ телом (нужен PO-токен `pot`), textTracks у плеера пуст (субтитры рендерит своим DOM-слоем), подпись sparams НЕ покрывает tlang. Рабочие пути: перехват fetch/XHR в initialization script (бандл до скриптов страницы; пустые тела тоже пишет в буфер — диагностика) снимает тела timedtext-ответов, которые сам плеер запрашивает по команде `captions.setOption track`; переводы — параллельным fetch живого URL + `&tlang=` (pot остаётся валиден, работает и после unloadModule). Живучесть транспорта (выяснена телеметрией e2e): преролл — команды уходят рекламному плееру (ждать конца `ad-showing`; серия прероллов бывает 2–3), ленивая загрузка дорожек — только у фактически играющего плеера (ждать `getPlayerState()===1`), пустой ответ (pot ещё не сгенерирован BotGuard'ом) плеер не ретраит, а повторный setOption той же дорожки — ноун-оп → между попытками перезапуск captions-модуля + пауза; серийные tlang-запросы рейт-лимитятся (HTTP 429) → бэкофф 6/12/18 с. Разбор тел — канонический в Core: `subtitles::parse_auto` (автодетект json3/XML/vtt/srt), WebMessage `parse-subtitles`/`subtitles-parsed` (reqId, cues camelCase); выбор дорожек — custom-событие `duopulse-select-tracks` / `__duopulseContent.selectTracks(ids)` (id: `yt:en`, `yt:en:asr`, `yt:en+ru`, голый код перевода → база по умолчанию — язык оригинала по originalLangsOf: `audioTracks[].original` (TV/ANDROID-клиенты) → renderer.`audioTracks[].originalLanguage` → asr-дорожка; web-клиент original-флага не отдаёт, до duopulse-070 оригиналом ошибочно была первая дорожка — duopulse-070); набор привязан к videoKey (смена видео сбрасывает; in-flight загрузка не применяется к новому видео). Тесты: vitest 71/71 (+33), cargo 93/93 (+1), fmt/clippy чисто, бандл 39,6 КБ/11,3 КБ gzip ≤ 80; скриншот e2e/youtube/shot-duo.png, итог прогона run-last.json |
| 3.4 | **✅ выполнено 17.10.2026 (карточка duopulse-025)** Полный оверлей: плашка из N строк (1–3), стили строк, позиция, колесо-размер | сверка по гайду 06 §6; без миганий при коротких cue — **достигнуто** (e2e/subtitles 31/31: стили строк — вычисленные цвета/кегли/обводка 2px/радиус 6/blur 2/градиент/≤80% ширины видео; скриншот trio-плашки shot-overlay-3rows.png; смена смежного cue — тот же контейнер и узлы строк, opacity 1 без пере-fade). Механика: `content/overlay/{overlay,style}.ts` — SubtitleStyle {fontScalePct 75–300, position bottom/top, marginPct ≤25, plateOpacity} с клампами (mergeStyle/stepScale — чистые, юнит-тесты); плашка по гайду 06 §6 (градиент rgba(10,14,23,.78)→прозрачный, скругление 6px, backdrop-blur 2px; строки: оригинал #FFF/500, перевод #BDFE4F/85%, третьи+ rgba(255,255,255,.75)/75%, обводка 2px paint-order:stroke fill; разделитель строк — межстрочный отступ 0,22em, гайд линий не задаёт); позиция низ/верх флекс-выравниванием контейнера + margin, геометрия следует за видео (resize/scroll/fullscreen + ResizeObserver); кегль clamp(14px,2.6cqw,34px)×масштаб (cqw — плашка масштабируется с плеером); колесо над плашкой — ±10% (75–300%, Shift — сдвиг ±100 мс docs/03 §8): плашка pointer-events:none, попадание считается геометрически (window-capture wheel), клики по плееру проходят; дифф-обновление строк по trackId (text меняется на месте — контейнер не пересоздаётся, fade 80 мс только на появление/исчезание); гашение нативных показа платформы (docs/03 §2): `content/native-captions.ts` — generic textTracks showing→hidden с восстановлением + YouTube blankYouTubeCaptions (CSS-класс на <html>, селектор .ytp-caption-window-container знает только адаптер, docs/03 §9; CSS переживает перезапуск captions-модуля и не мешает добыче); тест-хуки duopulse-test-style/-track (массив дорожек, {clear:true}), state().style/nativeBlanked. Попутно починен стенд e2e/subtitles, сломанный задачей 3.3 (набор чистится при смене videoKey — инлайн-диспатч тест-дорожки стал гоняться с очисткой; ранер задаёт дорожку детерминированно после успокоения детектора). vitest 91/91 (+20), cargo fmt/clippy/test 93/93, tsc чисто, бандл 49,5 КБ/14,1 gzip ≤80; e2e/youtube 32/32 (+1 чек гашения: класс <html> на всех 10 видео) |
| 3.5 | **✅ выполнено 17.10.2026 (карточка duopulse-026)** Синхронизация: offset-слайдер, горячие клавиши, seek-устойчивость | скачки по таймлайну не дают «призраков» cue — **достигнуто** (e2e/subtitles 49/49: серия seek 2→13→7,5→4→14,96→10,5 с — каждый раз ровно ожидаемая реплика или пусто, хвост <150 мс подавлен; смена качества — новый src того же `<video>` и пересоздание элемента с тем же videoKey — набор дорожек не теряется, показ в такт). Механика: покадровая точность — цикл `requestVideoFrameCallback` в движке (docs/03 §4 п.1; кадр отрисован → пересчёт, время по-прежнему только `video.currentTime`; отмена кадра при detach, флаг `state().engine.frameCallback` для стендов); сдвиг ±10 с шагом 100 мс из любого источника — Shift+колесо по плашке (3.4), горячие клавиши `Alt+[`/`Alt+]` (раньше/позже, поглощают keydown, работают при активном наборе), IPC `subtitles.set_offset` (первая сервисная команда subtitles.*: bridge-хендлер → eval активной вкладки → document-событие `duopulse-set-offset`; кламп в Core и движке) — применение без перезагрузки дорожек; HUD синхронизации `content/overlay/hud.ts` (гайд 06 §6: тёмная плашка, лайм-акцент, слайдер ±10 с/шаг 100, «Сброс», автоскрытие 2,4 с, pointer-events только на HUD, край — противоположный плашке субтитров). Набор дорожек привязан к videoKey: запоминается в content-слое и переживает пересоздание `<video>` с тем же ключом (смена качества у плееров, пересоздающих элемент; детект до loadedmetadata приходит с ключом без длительности — уточнённый ключ следом, память набора не стирается); попутно починен дефект 3.2: детектор мутировал `this.current` до переэмитa — смена videoKey того же элемента (SPA-переход без пересоздания видео) не доходила до обработчика (`changed` всегда false по одной ссылке), теперь content-слой помнит ключ последней обработки. Тесты: vitest 101/101 (+10: rVFC-цикл — кадры тикают/не спамят/отменяются, seek между кадрами, frameCallback; HUD — формат «+0,3 с», шаг с клампом), cargo fmt/clippy/test 93/93, tsc чисто, бандл 58,4 КБ/16,1 gzip ≤80 |
| 3.6 | **✅ выполнено 17.10.2026 (карточка duopulse-027)** Ручные субтитры: drag&drop 1–3 файлов .srt/.vtt на любой сайт, смешивание с дорожками платформы | работает на 3 тестовых сайтах с `<video>` — **достигнуто** (e2e/subtitles 66/66: сайт-1 testpage — дроп 2 файлов поглощён и разобран, смешанный набор 3 строк; сайт-2 — видео в плеерной обвязке, файл без платформенных; сайт-3 — ленивый SPA-монтаж видео, дроп до детекта не наш, после — смешивание; скриншот shot-file-mix.png; контрольный живой YouTube e2e/youtube 35/35: дроп .srt поверх дорожки платформы — смешанный набор 2 строки, shot-file-mix-yt.png). Механика: `content/adapters/file.ts` — drag&drop на window (capture): подсказка «Отпустите…» при переносе (гайд 06 §6), поглощение только своих дропов (.srt/.vtt по расширению, ≤3 файлов, только когда детектор нашёл видео — docs/03 §3.2; чужие дропы проходят странице); чтение — File API страницы (UTF-8; Windows-1251 — v1.1), разбор — канонический в Core (WebMessage parse-subtitles, задача 3.1); язык дорожки — из имени файла (`movie.ru.srt` → ru; BCP-47 сегмент 2–3 буквы) или заголовка VTT `Language:`, иначе `und`; id `file:<lang>` (дубликаты `:2/:3`), дроп/панель замещают файловую часть набора целиком. Смешивание (docs/01 F-06): набор = платформенные + файловые до 3 строк (combinedTracks, лишние файлы отброшены — телеметрия WebMessage `file-tracks` «сверх набора» в журнал [subtitles]); набор-память по videoKey (LRU 8) помнит обе части. Панельный путь IPC `subtitles.load_file` (path → {name, cueCount, warnings}): Core читает файл с диска (`subtitles::read_manual_file` — UTF-8, лимит 4 МБ, снисходительные ошибки) на блокирующем пуле, cue доставляет eval активной вкладки (document-событие `duopulse-file-track`); найден и закрыт подводный камень: eval-строка, собранная `format!` с тройными скобками, давала SyntaxError (тихий Ok у ExecuteScript) — склейка без format! и eval строго на главном потоке (`run_on_main_thread`); тест-хуки `__duopulseContent.clearFiles()/addFiles()`, state().fileTracks/dropHintVisible |
| 3.7 | **✅ выполнено 17.10.2026 (карточка duopulse-028)** Кнопка «duo» в omnibox + Alt+D + панель настроек набора (языки, источники, порядок) | сценарии docs/01 §5.1 и §5.3 проходят, включая тройной набор — **достигнуто** (e2e/subtitles 78/78: кнопка/панель/Alt+D/IPC; e2e/youtube §5.1: пресет «Дуо» из панели → тройной набор «оригинал + перевод + свой файл», порядок строк, Alt+D вкл/выкл). Механика: сервис состояния Core (кэш по вкладкам) + команды subtitles.{list/set_tracks, set_enabled, toggle, set_style, remove_track} + события subtitles:{tracks_ready, set_applied}; кнопка «duo» (выкл/1/дуо/три), панель src/subtitles-panel/ (пресеты, ↑/↓ fast-path, «Свои субтитры…» — нативный диалог, слайдер сдвига, размер/позиция), Alt+D с дефолт-набором «оригинал + ru» на пустом |
| 3.8 | **✅ выполнено 17.10.2026 (карточка duopulse-029)** E2E-прогон «10 случайных видео» + фикстуры YouTube в CI | прогон зелёный, фиксация рабочих путей адаптера — **достигнуто**: 10/10 видео — набор 2–3 дорожки (оригинал + tlang ru/es, включая asr/mono/65-дорожечный TED), оверлей, гашение нативных, offset Alt+[/] с HUD; на первом — дроп .srt поверх платформенной дорожки и сценарий §5.1 из UI-хрома (кнопка «duo», пресет «Дуо» → тройной набор, порядок строк, Alt+D); рабочие пути зафиксированы сводкой run-last.json (списки — player-api 10/10, базы — перехват timedtext по captions.setOption, переводы — tlang поверх живого URL). Фикстуры — в CI без сети (.github/workflows/ci.yml: vitest на player-ответах + cargo fmt/clippy/test); живой прогон — по чек-листу e2e/youtube/CHECKLIST.md. Вопросы docs/03 §10 закрыты (авто-уменьшение кегля — карточка 046, M5) |

### M4 — перевод
| # | Задача | DoD |
|---|---|---|
| 4.1 | **✅ выполнено 18.10.2026 (карточка duopulse-030)** Провайдеры перевода (интерфейс + DeepL/Google/LibreTranslate) | подменные тесты провайдеров зелёные — **достигнуто** (cargo 134/134, из них ~30 по translate: запросы/ответы/ошибки/лимиты/ретраи всех трёх провайдеров на mock-транспорте без сети; e2e/subtitles 87/87 — секция «Перевод» панели, конфиг в settings.json, ключ API в DPAPI-blob). Механика: `src-tauri/src/translate/` — trait `TranslationProvider` (пачка строк: `ProviderLimits` max_texts/max_bytes, `TranslateError` с retryable-таксономией Network/RateLimited/Server/Auth/Quota/TooLarge/UnsupportedLang/BadResponse/Config, `translate_with_retries` — экспоненциальная пауза 400·2ⁿ, до 3 попыток), `HttpTransport` (ureq-агент 10/30 с; HTTP-статусы маппятся провайдерами, транспортные сбои — Network) + MockTransport (очередь ответов + запись запросов); DeepL (хосты free/pro, `Authorization: DeepL-Auth-Key`, `context` предыдущей пачки, цели EN→EN-US/PT→PT-BR, квота 456), Google v2 (`x-goog-api-key` — не в query, ≤128 строк, «API key not valid» из 400 → Auth, daily limit из 403 → Quota), LibreTranslate (base URL + ключ в теле, q-массив + один-строка, `{"error":"…"}`-тела). Ключи API — DPAPI `translate/keys/<id>.bin`, DPAPI-код выделен из proxy.rs в общий `src-tauri/src/secrets.rs`; конфиг — ключ "translate" settings.json (provider/deeplPlan/libretranslateUrl/enabled, инъекция ключей в JSON игнорируется). IPC (контракт v3): `translate.{get_settings, set_settings, test}`; UI — секция «Перевод» duo-панели (провайдер, поля по провайдеру, ключ с placeholder «сохранён», «Проверить» = сохранить + один живой запрос). Использование в конвейере (батчинг ≤2 КБ, контекст, кэш) — 4.2 |
| 4.2 | **✅ выполнено 18.10.2026 (карточка duopulse-031)** Батчинг cue + контекст + кэш SQLite | повторный просмотр — 0 сетевых вызовов перевода — **достигнуто** (cargo 146/146, из них 12 новых: пачки по байтовому/строчному потолку, контекст пачки (DeepL `context` = последняя строка предыдущей), кэш-хит с 0 обращений к сети на mock-транспорте, LRU-вытеснение с освежением чтением, персистентность файловой базы; e2e/subtitles 92/92 — мок LibreTranslate на стенде: пачка ушла в провайдера, дорожка cloud:es в наборе с переводом на плашке, повторный запрос того же языка — мок не тронут (кэш SQLite), статус «из кэша», выключенный конвейер — честный отказ без сети). Механика: конвейер `src-tauri/src/translate/pipeline.rs` (пачки ≤ min(2 КБ, ProviderLimits), контекст — последняя строка предыдущей пачки, ретраи translate_with_retries; ошибка пачки останавливает конвейер, частичный перевод в кэш не пишется; прогресс — событие `subtitles:translate_progress` translating/done/fromCache/error) + кэш `src-tauri/src/subtitles/cache.rs` (duopulse.db, таблица translated_tracks, ключ (videoKey, trackId, targetLang, provider), LRU 120 дорожек ~4 МБ); cues — у content-слоя: IPC `subtitles.translate_track` (контракт v4) eval'ит duopulse-translate-request, content шлёт WebMessage «translate-track» с cue, ответ — document-событие duopulse-translate-track (паттерн 3.6), переведённая дорожка `cloud:<lang>` входит в набор после платформенных (source "translate", хранит имя «DeepL → ru»); UI — селект «+ перевод в… (облако)» панели (`src/subtitles-panel/cloud-langs.ts`, исключает языки платформы/набора) + статус конвейера; тайминги кэш-хита выравниваются по свежей сетке cue. Деградация с бейджем — 4.3 |
| 4.3 | **✅ выполнено 18.10.2026 (карточка duopulse-032)** Офлайн-деградация и бейдж «перевод недоступен» | сценарий docs/01 §5.4 проходит — **достигнуто** (e2e/subtitles 97/97: офлайн (мёртвый URL) — набор падает до оригинала, бейдж «Перевод недоступен (нет сети) — повторим…» держится (событие subtitles:translate_unavailable, offline/willRetry=true), перевод es возвращается из кэша при мёртвом провайдере; «сеть появилась» (URL → живой мок) — перевод de завершается сам без действий пользователя, бейдж сменяется статусом «готово»; выключенный конвейер — бейдж no_provider без автоповтора; cargo 153/153 (+7: таксономия отказов, разбор endpoint→host:port, очередь дедупа с переподчинением, офлайн→онлайн сценарий цикла на mock-транспорте, терминальный отказ без ожидания, снятая работа молчит), vitest 163/163 (+3 тексты бейджа)). Механика: `src-tauri/src/translate/watcher.rs` — очередь `TranslationJobs` (ключ (videoKey, trackId, targetLang), повторный запрос переподчиняет ответ, поколения закрывают гонку финала) + цикл с TCP-пробой эндпоинта текущего конфига каждые DUOPULSE_TRANSLATE_RETRY_MS (5 с); провайдер пересобирается на каждой попытке. **Gate M4** — замер перевода cue-таблицы 420 реплик (~33 КБ, 19 пачек) сквозным путём панели на моке с латентностью 400 мс/пачка: **7,9 с ≤ 30 с**; повторный просмотр — из кэша при мёртвом провайдере (0 обращений к живому моку) — отчёт CHANGELOG 18.10. Контракт v5 (событие subtitles:translate_unavailable) |

### M5 — полировка и релиз
| # | Задача | DoD |
|---|---|---|
| 5.1 | **✅ выполнено 18.10.2026 (карточка duopulse-033)** Полные настройки + экспорт/импорт профиля | переезд на чистую машину за 1 файл — **достигнуто** (e2e/settings/run.mjs 17/17: машина A с настройками/закладками/историей/секретами → duopulse-profile.json → свежий профиль → импорт — всё на месте, повторный импорт идемпотентен; перенос кэша переводов — юнит-тест cargo clean_machine_roundtrip_one_file: put → файл → import → кэш-хит). Механика: src-tauri/src/settings/ (settings.json + версия схемы с миграциями на старте; разделы search/subtitles/appearance/privacy; экспорт/импорт профиля одним файлом с валидацией до применения; секреты — по явному выбору, при импорте в DPAPI), omnibox — поисковик по умолчанию из настроек, контент-слой получает дефолты субтитров window.__DUOPULSE_DEFAULTS__ initialization-скриптом, страница duopulse://settings (контракт v6: settings.{get_all,apply,export,import} + translate.clear_cache); cargo 165/165, vitest 169/169, e2e/subtitles 97/97 (регресс), бандл 79,5 КБ/21,3 gzip ≤80 |
| 5.2 | **✅ выполнено 19.10.2026 (карточка duopulse-034)** Установщик (NSIS/MSI), автообновление | установка на чистой Windows, обновление канарейки — **достигнуто** (e2e/update/run.mjs 17/17: тихая установка setup.exe /S — запись Uninstall в HKCU (версия/каталог), duopulse.exe+uninstall.exe, ярлыки рабочего стола и «Пуска», приложение отвечает с контрактом v7, updater.status 0.1.0/stable/автопроверка; обновление канарейки — синтетический подписанный 0.1.1 на локальном фиде (DUOPULSE_UPDATE_BASE): updater.check нашёл по подписи, pending ждёт решения, install завершил приложение, установщик пассивно обновил и перезапустил — версия 0.1.1, профиль выжил (канал canary на месте), реестр 0.1.1; деинсталляция /S — реестра и каталога нет). Механика: tauri-plugin-updater (minisign-подпись, каналы stable/canary — раздел updater настроек, установка NSIS /P /UPDATE /R с авто-перезапуском), src-tauri/src/updater.rs (UpdaterService), контракт v7 updater.{status,check,install}, сборка npm run release → builds/duopulse_<версия>_<тип> (setup.exe+.sig+latest.json), UI — секция «Обновления» настроек + пункт меню; cargo 170+1ignored/171, vitest 169/169, e2e/bridge 14/14, e2e/settings 17/17 |
| 5.3 | **✅ выполнено 19–20.10.2026 (карточка duopulse-035), приёмка принята автором 20.10.2026 02:02** Чек-лист приёмки релиза + прогон метрик (детали — §2) | P-01..P-04, P-06 в бюджете; P-05 — принят с трактовкой «не хуже Chrome/Edge на той же машине» (docs/04 §2 обновлён, стенд p05.mjs меряет контроль Chrome, «Диагностика» — budgetMax null; с 21.10 контроль заменён на DuoPulse без блокировщика — CARDS/047), P-08 — приёмка принята, SABR-stall чинится CARDS/044 до финального релиза; хостинг фида — GitHub Pages summonss7.github.io/duopulse-updates, база в коде сменена |
| 5.4 | **✅ выполнено 20–21.10.2026 (карточка duopulse-036)** Лицензия и README-финал | README — продуктовая форма (готово 20.10: скриншоты e2e-стендов, возможности со статусами, установка/обновление, статус этапов M0–M7, разработка/CI); LICENSE — GPL-3.0 (выбор автора 20.10, Aila duopulse_036_license_20261020): проставлен 21.10 — корневой `LICENSE` (канонический текст gnu.org, 35 149 Б) + SPDX-поля `package.json`/`Cargo.toml` (GPL-3.0-only) + раздел «Лицензия» README (причина: вкомпилированные скриптлеты @adguard GPL-3.0, карточка 043); README дочищен по фактам решений (фид — GitHub Pages, статус M5 — закрыт). Gate M5: чек-лист приёмки 5.3 принят автором 20.10 (строка 5.3) — **M5 закрыт** |

### M6 — VPN и доступ к заблокированным сайтам (F-12, инкремент B)
Дизайн — docs/02 §6 (локальный роутер, fail-closed, split-tunnel). Карточки
созданы заранее — CARDS/037–042 (duopulse-010); при старте эпика сверить их
актуальность с ROADMAP и docs/02 §6.

| # | Задача | DoD |
|---|---|---|
| 6.1 | **✅ выполнено 20.10.2026 (карточка duopulse-037)** Локальный SOCKS5-роутер в Core (`vpn/router.rs`): WebView2 постоянно направлен на `127.0.0.1:<port>`, маршруты direct/upstream | режим off «страницы как без роутера» и fail-closed — **достигнуты** (e2e/proxy-a/run.mjs 26/26: аргументы WebView2 всегда `socks5://127.0.0.1:<port>`, от режима не зависят; off — внешние страницы грузятся напрямую, CONNECT-лог прокси пуст; вкл — трафик WebView2 → роутер → внешний прокси, DNS на стороне маршрута (ATYP=domain); тумблер переключает режим роутером БЕЗ перезапуска — миграция инкремента A: выкл → страницы напрямую → вкл тем же процессом, блок «перезапустить» убран из меню и настроек, needs_restart импорта всегда false; пароль — RFC 1929 через роутер из DPAPI (стенд с обязательной аутентификацией: AUTH ok); fail-closed — двойное подтверждение: уровень роутера (проба SOCKS5-клиентом при битом upstream: REP=01, целевой сервер соединений не получил) и уровень страницы (ERR_SOCKS_CONNECTION_FAILED); после перезапуска приложения роутер и режим на месте). Механика: `src-tauri/src/vpn/router.rs` — loopback-листенер, только CONNECT/no-auth, маршруты Direct/Upstream (RwLock, смена на лету; битый включённый конфиг даёт Upstream — отказ у каждого соединения, не «протекает» в прямые), upstream — SOCKS5 с RFC 1929 или HTTP CONNECT с Basic, домены уходят в upstream неразрешёнными; `proxy::router_browser_args(port)` — постоянные аргументы WebView2 (фолббек при отказе роутера — прежняя схема инкремента A); bridge: settings.set / vpn.set_enabled / settings.import дёргают `vpn::router::apply_saved` — режим применяется сразу; BasicAuthenticationRequested-обработчик снят (креденшалы подставляет роутер). Тесты: cargo 183 passed/1 ignored (+11 роутера: direct-флоу, upstream SOCKS5 домен+креденшлы, HTTP CONNECT+Basic+403, fail-closed на мёртвом upstream, смена маршрута на лету, unsupported-команды, apply_config), vitest 169/169, tsc чисто, e2e/bridge 14/14 + e2e/settings 17/17 (B2: needsRestart=false) |
| 6.2 | **✅ выполнено 20.10.2026 (карточка duopulse-038)** Клиент WireGuard (`vpn/wg.rs`, boringtun): импорт `.conf`, handshake, keepalive, roaming | handshake/keepalive/roaming/DNS/fail-closed — **достигнуты** автотестами с loopback WG-сервером (boringtun+smoltcp in-process: 11 тестов модуля, включая сквозной SOCKS5→роутер→туннель→echo и keepalive при простое); пропускная способность ≥ 100 Мбит/с — **с запасом**: release-замер 16 МиБ download через туннель 1,4–1,9 Гбит/с (замеры двух прогонов), RTT ~0,2 мс (после починки тактования нити: nonblock-дрен + wake-датаграммы + no-delay ACK; до — ~9 Мбит/с); стабильность ≥ 30 мин — soak DUOPULSE_WG_SOAK_SECS=1800 (30 мин, keepalive 15 с, rekey-циклы ~120 с, отчёт CHANGELOG); ключ — в DPAPI (`vpn/wg/<id>.bin`, тесты подтверждают отсутствие открытого ключа в файлах). Ограничение v1: стек proto-ipv4 (IPv6-only конфиги отклоняются честной ошибкой), UI-панель — задача 6.5; живой сервер пользователя для приёмки — вопрос автору (Aila) |
| 6.3 | **✅ выполнено 21.10.2026 (карточка duopulse-039)** Split-tunnel (`vpn/rules.rs` + `vpn/dns.rs`): правила домен → маршрут, режимы off/global/split, DNS только через маршрут | заблокированный домен открывается через туннель, YouTube — напрямую, одновременно; правила переживают перезапуск; DNS-утечек нет (трассировка) — **достигнуто** автотестами loopback WG-стенда: split_routes_blocked_via_tunnel_and_direct_simultaneously (один роутер, split-политика: `blocked.tun` — DNS сервером туннеля по счётчику dns_hits + TCP-echo через туннель, одновременное прямое соединение к местному echo — туннель новых DNS/TCP не видит; правило добавляется на лету общим стором IPC↔роутер; apply_config прокси при живом split маршрут не роняет) + split_tunnel_rule_is_fail_closed_on_dead_tunnel (мёртвый туннель — REP≠0 и ноль прямых соединений к цели). Персист: rules-тесты reload из `vpn/split-rules.json` (режим+правила, upsert, битый файл → дефолт) + e2e/bridge v9 проверяет файл в профиле. Режимы и правила редактируются из UI (секция «VPN-туннель WireGuard» настроек, смоук 7/7); контракт v9: vpn.{set_mode,get_rules,add_rule,remove_rule} + routing в статусе |
| 6.4 | **✅ выполнено 21.10.2026 (карточка duopulse-040)** Kill-switch: разрыв туннеля не выпускает туннельный трафик в открытую | автотест: обрыв upstream при загрузке страницы — соединение закрывается, не уходит напрямую — **достигнут** (kill_switch_dead_upstream_closes_established_and_fails_closed: генератор качается через туннель, сервер убит в середине передачи — установленное соединение получает EOF в пределах порога мёртвости, ноль прямых соединений к цели при живом прямом пути, событие Error kill-switch в UI, новые соединения отказывают; + kill_switch_route_change_closes_established_connections — выключение туннеля рвёт установленный поток). Механика: порог мёртвости по возрасту handshake (REJECT_AFTER_TIME 180 с, `DUOPULSE_WG_DEAD_MS`), `kill_tunneled` закрывает все потоки/DNS, fail-fast новых соединений, `stop_wg_tunnel` эмитит Off; UI-настройки слушают `vpn:state_changed` |
| 6.5 | **✅ выполнено 21.10.2026 (карточка duopulse-041)** UI VPN: индикатор-щит в Navbar, панель (тумблер, режим, сервер, правила, статистика), дисклеймер | сверка с гайдом 06; сценарий docs/01 §5.6 проходит руками — **достигнуто** (смоук живого приложения 9/9 + визуальная сверка с гайдом 06 по скриншотам: сине-чёрные поверхности, неон — только акценты, без наложений/обрезаний; e2e/bridge 29/29 — панель в живом приложении: кнопка-щит, статус/тумблер/режим/дисклеймер, правило из панели доходит до Core, Escape; туннельная часть сценария §5.6 — включение из меню ведёт к туннелю — автотестами loopback WG-стенда: ping/RTT и события живут, живой WG-сервер автора в сеансе недоступен). Механика: `src/vpn-panel/` — панель и щит; щит — сигнальные цвета гайдa 06 §2 (off muted / connecting warn+пульс / connected ok+свечение / error err), состояние из mode wg + фазы туннеля; панель: тумблер (`vpn.use_profile`, без профиля — честная подсказка), сервер (импорт `.conf` нативным диалогом, смена на лету, удаление с остановкой активного), режим off/global/split, split-правила (сегмент на строке, добавление, «этот сайт — через туннель» — хост активной вкладки), статистика rx/tx/ping/hs и «Маршруты сеанса» — событиями `vpn:stats`/`vpn:route_changed` без опроса; дисклеймер «DuoPulse — только VPN-клиент» (docs/01 F-12). Контракт v10: `VpnWgState.pingMs` (ICMP-RTT до DNS-сервера туннеля, echo раз в секунду, null — нет ответа дольше 3 с), `vpn:stats` (троттлинг 1 с, дедуп по изменению), `vpn:route_changed` (первый маршрут домена и смена, дедуп; off молчит). Действие на странице ошибки (docs/02 §6.2) — отложено отдельной карточкой 048 (быстрая кнопка «этот сайт» в панели покрывает сценарий) |
| 6.6 | **✅ выполнено 22.10.2026 (карточка duopulse-042)** E2E маршрутные тесты: direct / tunnel / kill-switch / split-правила | автотесты зелёные, включены в CI-контур проекта — **достигнуто** на двух уровнях. (1) Core: loopback WG-стенд (boringtun-сервер + smoltcp-стек с DNS/echo/HTTP) вынесен из `wg.rs::tests` в пакет `e2e/wg-stand` (dev-dependency) — все cargo-тесты маршрутизации (direct/upstream, сквозной SOCKS5→туннель, split одновременно в обе стороны, fail-closed на мёртвом туннеле, kill-switch 6.4) крутятся в CI-джобе rust на каждый коммит. (2) Приёмочный E2E реального приложения без внешней сети — стенд `e2e/vpn/run.mjs` (22 проверки, ALL PASS, два прогона подряд) в отдельном CI-джобе e2e-vpn: debug-exe + wg-stand.exe (loopback WG-сервер, внутри туннеля HTTP/DNS/echo, события JSONL в stdout), сценарии — A direct (off: локальная страница напрямую, «заблокированный» домен .tun — ERR, туннель молчит); B §5.6 (импорт .conf через bridge → тумблер панели → handshake → http://blocked.tun/ открывается ЧЕРЕЗ туннель: DNS-запрос и HTTP-хит видит только стенд, rx/ping живые); C gate «1080p без буферизации» (видео 1920×1080 4 Мбит/с фикстурой e2e/fixtures/vpn, играет до конца, 0 stall-событий, буфер +11 с впереди); D split (правило из панели, blocked.tun — туннель, посторонний домен — напрямую мимо туннеля, прямые страницы живут, «Маршруты сеанса» события); E kill-switch вторым сеансом с DUOPULSE_WG_DEAD_MS=20 с (перезапуск: split-режим/профиль восстановились, upsert того же пира перевёл на новый эндпоинт; обрыв upstream посередине paced-загрузки 64 МиБ — fetch видит обрыв, новые соединения ERR, панель/щит Error «kill-switch», прямой маршрут жив, тумблер выкл гасит) |
| 6.7 | **✅ выполнено 22.10.2026 (карточка duopulse-048)** Действие «этот сайт — через туннель» на странице ошибки загрузки (docs/02 §6.2, из отступления 6.5) | страница ошибки при недоступном сайте предлагает «этот сайт — через туннель»; правило создаётся (общий стор IPC ↔ роутер), повторная загрузка идёт по правилу; кнопка не появляется для внутренних страниц и отменённых навигаций (Esc) — **достигнуто** (e2e/vpn: A2 — неудачная навигация «заблокированного» домена без туннеля = собственная страница ошибки с адресом/причиной/действиями, F1/F2 — клик «через туннель» создаёт split-правило и повторная загрузка проходит туннелем (HTTP-хит стенда), F3/F4 — «Новая вкладка» без страницы ошибки и вкладок-ошибок не плодится; E2 — kill-switch новые соединения = страница ошибки; cargo-тесты фильтра: отмена (OPERATION_CANCELED) и внутренние страницы не показываются). Механика: перехват NavigationCompleted в Core (COM, вслед подписке wry — URL вкладки уже актуален) → webview вкладки пересоздаётся меткой `page-error-N` с UI-бандлом (роутер src/main.ts по метке, capability page-* для IPC), контекст {url, code, reason} — init-скриптом до бандла; контент-скрипты ставятся как у контентных вкладок — «Повторить» (nav.navigate) уводит на сайт с полным стеком (блокировщик/субтитры); канонический адрес вкладки (omnibox, сессия) остаётся адресом сайта. Страница `src/pages/error.ts`: адрес, причина (словарь WebErrorStatus → по-русски), «Повторить», «„домен“ — через туннель» (vpn.add_rule; туннель поднят в split/global — автоповтор, иначе подсказка включить туннель/split); стенды e2e/vpn и e2e/proxy-a переведены с матчинга ERR_-страницы Chromium на маркеры страницы ошибки |
| 6.8 | **✅ выполнено 11.11.2026 (карточка duopulse-114)** Подсказка маршрута на странице ошибки: при поднятом global-туннеле/прокси поясняет, чем грузился упавший сайт | страница ошибки при маршруте wg+global (или proxy) показывает строку «Весь трафик сейчас идёт через туннель „<профиль>“ — сайт мог отказать соединениям с его адреса…» с отсылкой к кнопке «напрямую»; прямой маршрут и split без правила — без подсказки — **достигнуто** (источник — пожелание: y2mate.gs «код 9» при работающем Хроме; диагностика: и напрямую, и через demo-туннель сайт открывается, падение было транзиентным для адреса туннеля; юнит-тесты routeContextNote 5 сценариев, vitest 404/404; живая проверка CDP: страница ошибки при global-туннеле рендерит .err-route с именем профиля). Механика: `src/pages/error-view.ts` — чистая `routeContextNote(VpnSlice)` (VpnSlice расширен `wg?.profileName`), `src/pages/error.ts` — вставка `<p class="err-route">` перед кнопками тем же запросом vpn.status, что и порядок split-кнопок |

### M7 — платформы (по карточкам): vimeo-адаптер, импорт из Chrome/Edge, локализация UI, OCR-исследование.

## 4. Definition of Done (для любой карточки кода)

1. Код соответствует контрактам слоёв (не лезет через границы, docs/02 §1).
2. Тесты задачи зелёные; если тронуты метрики — сняты до/после (docs/04 §3).
3. `backup.bat` перед стартом; коммит с осмысленным сообщением; push (когда есть remote).
4. Отчёт в `promt.txt`; документация обновлена, если затронута.
5. UI-изменения сверены с [06-brand-style.md](06-brand-style.md).

## 5. Инструменты и CI

- Rust: `cargo fmt` + `cargo clippy -D warnings` + `cargo test`.
- Content-бандл (задача 3.2): `npm run build:content` — esbuild IIFE из
  `content/*.ts` в `content/gen/` (gitignore, как `dist/`); файл подключается
  `include_str!`, поэтому fresh clone требует npm-шаг до cargo (делают
  `npm run dev` / `npm run build` — команды tauri).
- TS/JS: strict-режим `tsc`, `vitest` (включая content-движок), `playwright`
  (E2E, где драйвер позволяет).
- CI (GitHub Actions, `.github/workflows/ci.yml`): js (tsc+vitest на фикстурах
  без сети), rust (fmt+clippy+test — включая маршрутные автотесты Core на
  loopback WG-стенде, задача 6.6), e2e-vpn (приёмочный E2E реального
  приложения без внешней сети: стенд `e2e/vpn` + WG-сервер `e2e/wg-stand`,
  задача 6.6), e2e-proxy-a (приёмочный E2E SOCKS5-роутера и меню «Прокси»:
  стенд `e2e/proxy-a`, карточка duopulse-051 — ходы на example.com/iana.org
  через локальные socks5-стенды, обычная сеть раннера). Дефолтный порт http-стендов
  8899 на машине автора занят сервисом Aila — переопределяется env: `E2E_PROXY_A_PORT`
  (карточка 035), `E2E_OMNIBOX_PORT` / `E2E_SESSION_PORT` (карточка duopulse-052);
  на CI-раннере дефолт свободен. Сборка Windows-артефакта локально в
  `builds/duopulse_<версии>_<тип>` (debug/release) — правило проекта про
  сборки APK применяется по аналогии к EXE: всегда в `builds/` с версией и
  типом сборки.
