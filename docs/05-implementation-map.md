# 05 · Карта реализации

Документ отвечает на вопрос: **в каком порядке и где писать код**, чтобы этапы ROADMAP
превращались в конкретные карточки. Структура каталогов — целевая, создаётся по мере
этапов (не заранее).

## 1. Целевая структура кода

```
DuoPulse/
├── src-tauri/                      # Core + Shell (Rust)
│   ├── Cargo.toml                  # deps: tauri 2, adblock, rusqlite, reqwest, serde,
│   │                               #   boringtun + fast-socks5 (vpn, этап M6)
│   ├── src/
│   │   ├── main.rs                 # точка входа, сборка приложения
│   │   ├── bridge.rs               # регистрация IPC-команд/событий (контракт §3)
│   │   ├── tabs/                   # менеджер вкладок, спящий режим, восстановление сессии
│   │   ├── adblock/                # обёртка adblock-rs, загрузка списков, cosmetic-правила
│   │   ├── vpn/                    # маршрутизация сети (docs/02 §6): локальный SOCKS5-роутер,
│   │   │   ├── mod.rs              #   сервис-менеджер: состояния, события в UI
│   │   │   ├── router.rs           #   fail-closed роутер direct|proxy|wg, kill-switch
│   │   │   ├── upstream.rs         #   исходящие транcпорты: внешний SOCKS5/HTTP (1.8)
│   │   │   ├── wg.rs               #   WireGuard-сессия (boringtun): handshake, keepalive
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
│   ├── chrome/                     # TabBar, Omnibox, Navbar, MainMenu
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
│                                   #   chrome-hotkeys, media-watch, cosmetic
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
           bookmark_add, bookmark_remove, bookmark_update, bookmark_list}
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
определяет content/media-watch.js), `nav.{navigate, go_back, go_forward, reload}` (действуют
на активную вкладку), `nav.{resolve_omnibox, focus_page}` + `history.search`
(задача 1.3: разбор ввода omnibox — `src-tauri/src/omnibox.rs`, подсказки —
FTS5-индекс `src-tauri/src/history/`), `history.{visit, list, delete_urls,
delete_range, bookmark_add, bookmark_remove, bookmark_update, bookmark_list}`
(задача 1.4: SQLite-хранилище `duopulse.db` в профиле — docs/02 §8; визиты
пишет Core из on_page_load вкладок, дедуп 60 с, заголовок подтягивается из
on_title; list — агрегат по URL для страницы управления),
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

### M2 — скорость
| # | Задача | DoD |
|---|---|---|
| 2.1 | **✅ выполнено 14.10.2026 (карточка duopulse-017)** adblock-rs: сетевая фильтрация + списки EasyList/uBO + обновление | метрика P-07 достигнута — сетевым слоем не достигнута (замер e2e/adblock/p07.mjs: 246→229 запросов до первого кадра, 93%; в сеть 246→213, 87% при цели ≤60%): EasyList+uBO режут ~15 внешних ad/telemetry-запросов, путь до первого кадра YouTube — first-party трафик плеера; YouTube-преролл сетевые списки не подавляют — закрыто скриптлетами карточки 043 (P-07-замер с ними: реклама не показана ни в одном прогоне). Решение о критерии — вопрос автору (Aila, id duopulse_017_p07_20261014, ответ: P-07 — на 2.2/gate M2) |
| 2.2 | **✅ выполнено 14.10.2026 (карточка duopulse-018)** Косметическая фильтрация в content-скрипте | главная YouTube без рекламных блоков-заглушек — **достигнуто** (e2e/adblock/cosmetic-youtube.mjs: видимых заглушек на главной и watch нет, сетка/вёрстка целы; скриншоты до/после — e2e/adblock/shots-2.2/). Механика: content/cosmetic.js (initialization_script каждой вкладки) запрашивает у Core селекторы скрытия для URL (WebMessage → adblock-rs `url_cosmetic_resources` → PostWebMessageAsString) — host-специфичные + misc-generic сразу, generic class/id — по классам/идам из DOM (первичный проход + MutationObserver-дельта); CSS-скрытие живое (SPA/поздние узлы). Ограничения: top-level документ; скриптлеты `##+js` — выполнены карточкой 043 (ниже); YouTube-преролл — видео-поток, косметикой не режется (закрыто скриптлетами 043) |
| 2.6 | **✅ выполнено 15.10.2026 (карточка duopulse-043)** Скриптлеты `##+js` (ресурсный набор uBO) | правила `##+js(...)` из EasyList/uBO исполняются в контентной вкладке — **достигнуто**. Механика: ресурсный набор uBO-скриптлетов генерируется scripts/build-adblock-resources.mjs из npm-пакета @adguard/scriptlets (родной uBO resources.txt апстрим удалил) в src-tauri/src/adblock/scriptlets-resources.json — вкомпилирован в бинарник, digest входит в метки engine.json (смена набора перестраивает кэш); `Engine::use_resources` после from_rules и после deserialize; движок собирает код в `injected_script` (function-style, try/catch), доставляется тем же WebMessage-каналом косметики, content/cosmetic.js исполняет его `<script>`-элементом в мире страницы (Trusted Types — своя политика duopulse-scriptlets, youtube-кейс). Тумблер/white-list отключают инъекции; trusted-* скриптлеты не инъенцируются (untrusted ParseOptions). Приёмка: e2e/adblock/scriptlets.mjs 11/11; cosmetic-youtube.mjs 12/12 — YouTube-преролл исчез (playerAds/adSlots = undefined, P-07: реклама 0/3 прогонов), известное ограничение — асинхронная доставка (ранние инлайн-скрипты страницы могут успеть раньше) |
| 2.3 | **✅ выполнено 14.10.2026 (карточка duopulse-019)** Спящие вкладки + исключения (звук/видео) | метрика P-04 ≈ 0% — **достигнуто** (e2e/sleep/p04.mjs: 67,6%→0,54% ядра при «шумовой» фоновой вкладке; воркер во сне заморожен, пробуждение без потери состояния). Механика: `src-tauri/src/tabs/sleep.rs` — TrySuspend/Resume (WebView2) по таймауту простоя 5 мин (`DUOPULSE_SLEEP_AFTER_SECS`, 0=выкл; скан-нить), IPC `tabs.{sleep, wake}`, `TabInfo.sleeping` в контракте; исключение «играет звук/видео» — content/media-watch.js (WebMessage → on_media), активная не спит; пробуждение — активацией/tabs.wake. Функциональный стенд e2e/sleep/run.mjs — 15/15 (замечено: подключённый CDP-отладчик контентной вкладки отменяет приостановку — состояние страниц стенд читает через document.title) |
| 2.4 | **✅ выполнено 16.10.2026 (карточка duopulse-020)** Тёплый старт + преднастройка кэшей | метрики P-01..P-03 в бюджете docs/04 §2 — **P-01 447→402 мс (≤1500), P-02 380→365 мс (≤500), P-03 оболочка duopulse.exe 48 МБ (≤250)** (релизная сборка, медианы 3 прогонов, e2e/perf/run.mjs; дельта дерева на 5 вкладках с играющим YouTube ~+806 МБ — контент в процессах WebView2, домен Chromium; трактовка «поверх WebView2» = оболочка duopulse.exe подтверждена хозяином 16.10.2026 — Aila, duopulse_020_p03_20261016, кнопка 1). Механика: кэши/профиль WebView2 живут между запусками (не чистится); свежий старт идёт лениво, как восстановление (первая вкладка материализуется по RunEvent::Ready — creation webview в setup блокировал старт цикла, −45 мс); прогрев топ-сайтов истории при простое UI (`src-tauri/src/prefetch.rs`: preconnect/dns-prefetch в хроме — все webview делят сетевой стек; DUOPULSE_PREFETCH=0 — выкл, стенды DUOPULSE_START_URL не греют); метки фаз старта `[startup]` в stderr (stores 9–12 мс — SQLite не откладываем, окно+окружение WebView2 ~330 мс — доминанта) |
| 2.5 | **✅ выполнено 16.10.2026 (карточка duopulse-021)** Страница «Диагностика»: съём и история метрик | график последних прогонов — **достигнуто** (duopulse://diagnostics: живой срез сеанса perf.snapshot — старт и фазы [startup], переключения вкладок perf:tab_switch_ms, RAM duopulse.exe, счётчики блокировщика; история прогонов P-01..P-08 в SQLite (таблица perf_runs в duopulse.db, последние 10 — docs/04 §3) со спарклайн-графиком, бюджетами и подсветкой «вне бюджета»; «Снять срез» сохраняет p01/p02/p03; пункт в главном меню; стенд e2e/perf/diagnostics.mjs 4/4). Gate M2 (полный прогон P-01..P-08, релизная сборка, эталонная машина): P-01 405 мс (≤1500), P-02 379 мс (≤500), P-03 48 МБ (≤250), P-04 0,93% ядра (≈0), P-06 0 longtask/макс 18,2 мс; открытые пункты — вопросы автору (Aila, 16.10): P-05 5 дропов/3600 кадров = 0,14%/мин при бюджете «0/мин» (M0-прецедент: 3/3149 = 0,10% принят PASS), P-08 медиана 5,9–8,7 с хуже Chrome ~4,4 с (перенаправ themeRefresh в каждом запуске — расследование CARDS/044), P-07 контрольный: реклама с блокировщиком не показана ни в одном прогоне (0/2+0/3), субъективная оценка YouTube — вопрос отправлен. **Gate M2 принят автором 16.10.2026 19:57 (Aila, duopulse_021_m2_20261016, кнопка 1: «Принять M2, P-08 починить карточкой 044 до M3»)** — этап M2 закрыт; P-08 — CARDS/044 до старта M3, ответы по P-05/YouTube-оценке подшиваются в карточку duopulse-021 |

### M3 — многоязычные субтитры v1 (центральный этап)
| # | Задача | DoD |
|---|---|---|
| 3.1 | **✅ выполнено 17.10.2026 (карточка duopulse-022)** Парсеры srt/vtt/timedtext (Rust) + фикстурные тесты | 100% фикстур проходят, границы cue корректны — **достигнуто**. Механика: `src-tauri/src/subtitles/` — единая модель `Cue` + диагностика `ParsedCues` (docs/03 §6); `mod.rs` — общая нормализация (BOM/CRLF, вырезание тегов разметки, сущности; timedtext — два прохода: YouTube экранирует дважды, `&amp;#39;` → `'`; стабильная сортировка по start; перекрытия сохраняются и диагностируются — смёржит движок показа, docs/03 §4); разбор снисходительный — битые блоки/тайминги/элементы пропускаются с предупреждением (srt/vtt — с номером строки), целиком битый файл (не-WEBVTT, битые XML/JSON) — диагностика + salvage, без паник; `srt.rs` (SubRip: номер cue опционален и не сверяется, мс через `,`/`.`, часы можно опустить), `vtt.rs` (WebVTT: NOTE/STYLE/REGION пропускаются, настройки cue игнорируются, таймстампы MM:SS.mmm, сущности; экранированный `&lt;b&gt;` — литерал), `timedtext.rs` (XML `<transcript>` start/dur в секундах + legacy `<timedtext><body><p>` t/d в мс + JSON3 с пословной склейкой `aAppend`-событий автосубтитров и пропуском служебных событий; детект формата по `{`; quick-xml); фикстуры — e2e/fixtures/subtitles/ (11, включая негативные + README); тесты cargo 92/92 (+25), fmt/clippy чисто; сервис-обвязка (IPC subtitles.*, кэш) — задачи 3.3–3.6 |
| 3.2 | **✅ выполнено 17.10.2026 (карточка duopulse-023)** content: детектор видео + каркас движка cue-таймлайна | на тест-странице overlay показывает тест-cue точно по времени — **достигнуто** (e2e/subtitles/run.mjs 21/21: границы cue, правило 150 мс при seek, смёрженные перекрытия, offset, призраки, живое воспроизведение, MutationObserver, SPA). Механика: content-слой переведён на TS-модули с бандлом — `content/{detector,engine,overlay,messaging}` + вход `duopulse-content.ts` → esbuild IIFE `content/gen/` (15 КБ / 5 КБ gzip ≤ 80; `npm run build:content`, входит в `npm run dev/build`; генерат в .gitignore как dist/, cargo требует npm-шаг до сборки); инжекция 5-м initialization_script каждой вкладки. Детектор: скан + MutationObserver (видео добавляется/уходит динамически; initialization script до разбора документа — старт по DOMContentLoaded), выбор ключевого видео по площади, опрос location.href (SPA-переходы), ключ `videoKeyFor` (yt:watch/shorts/youtu.be, прочие — url:URL+duration, docs/03 §6; уточнение ключа по loadedmetadata) → WebMessage «video» → Core эмитит `page:video_detected` (каркас с 1.1 ожил). Движок: `CueTimeline` (сортировка + смёрж цепочек перекрытий — тексты через \n, смежные не сливаются; активный cue бинарным поиском за O(log n)), `SubtitlesEngine` (часы — только `video.currentTime`; подписки timeupdate/seeked + детект программных скачков по Δt>250 мс; offset ±10 c ко всему набору; правило 150 мс docs/03 §4 — cue с меньшим остатком при скачке не показывается и не «вспыхивает» на остатке при продолжении; перерисовка только по смене набора строк). Overlay-каркас: fixed-плашка по rect видео, pointer-events:none, fade 80 мс, строки набора (1-я белая, 2-я лайм #BDFE4F — относительные размеры docs/03 §5), кегль от ширины видео (cqw); полный стиль/позиция/колесо — задача 3.4. Дорожки до IPC subtitles.* (3.3–3.6) движок получает тест-хуком (custom-события duopulse-test-track/-offset). Тесты: vitest 34 новых (38/38 — выбор cue/offset/seek, смёрж/границы таймлайна, videoKey), cargo 92/92, fmt/clippy чисто; стенд e2e/subtitles/ (testpage.html + testsrc.mp4 30 с с счётчиком кадров — визуальная сверка таймингов, скриншот shot-overlay.png)
| 3.3 | **✅ выполнено 17.10.2026 (карточка duopulse-024)** YouTube-адаптер: полный список дорожек + загрузка выбранных N (оригинал + 1–2 `tlang`-перевода или любые языки) | 10 случайных видео → наборы из 2–3 дорожек получены — **достигнуто** (e2e/youtube/run.mjs 22/22: все 10 видео дали набор «оригинал+ru+es» с cue > 0 и оверлеем; например TED af+ru+es по 417 cue, Gangnam ko(asr)+ru+es, Bohemian ar+ru+es). Механика: `content/adapters/{types,youtube}.ts` — все знания о YouTube в одном модуле (docs/03 §9), версия + цепочка путей (player-api → initial → texttrack), фикстуры записанных player-ответов — e2e/fixtures/youtube/playerResponses/ (11 видео: manual/asr/моноязычные/65-дорожечный TED, рекордер e2e/youtube/record.mjs), юнит-тесты на них без сети. Ключевые открытия (пробы на живом YouTube, окт. 2026): прямые timedtext-URL из player-ответа отдают 200 с ПУСТЫМ телом (нужен PO-токен `pot`), textTracks у плеера пуст (субтитры рендерит своим DOM-слоем), подпись sparams НЕ покрывает tlang. Рабочие пути: перехват fetch/XHR в initialization script (бандл до скриптов страницы; пустые тела тоже пишет в буфер — диагностика) снимает тела timedtext-ответов, которые сам плеер запрашивает по команде `captions.setOption track`; переводы — параллельным fetch живого URL + `&tlang=` (pot остаётся валиден, работает и после unloadModule). Живучесть транспорта (выяснена телеметрией e2e): преролл — команды уходят рекламному плееру (ждать конца `ad-showing`; серия прероллов бывает 2–3), ленивая загрузка дорожек — только у фактически играющего плеера (ждать `getPlayerState()===1`), пустой ответ (pot ещё не сгенерирован BotGuard'ом) плеер не ретраит, а повторный setOption той же дорожки — ноун-оп → между попытками перезапуск captions-модуля + пауза; серийные tlang-запросы рейт-лимитятся (HTTP 429) → бэкофф 6/12/18 с. Разбор тел — канонический в Core: `subtitles::parse_auto` (автодетект json3/XML/vtt/srt), WebMessage `parse-subtitles`/`subtitles-parsed` (reqId, cues camelCase); выбор дорожек — custom-событие `duopulse-select-tracks` / `__duopulseContent.selectTracks(ids)` (id: `yt:en`, `yt:en:asr`, `yt:en+ru`, голый код перевода → база по умолчанию — язык оригинала по `audioTracks.original`); набор привязан к videoKey (смена видео сбрасывает; in-flight загрузка не применяется к новому видео). Тесты: vitest 71/71 (+33), cargo 93/93 (+1), fmt/clippy чисто, бандл 39,6 КБ/11,3 КБ gzip ≤ 80; скриншот e2e/youtube/shot-duo.png, итог прогона run-last.json |
| 3.4 | **✅ выполнено 17.10.2026 (карточка duopulse-025)** Полный оверлей: плашка из N строк (1–3), стили строк, позиция, колесо-размер | сверка по гайду 06 §6; без миганий при коротких cue — **достигнуто** (e2e/subtitles 31/31: стили строк — вычисленные цвета/кегли/обводка 2px/радиус 6/blur 2/градиент/≤80% ширины видео; скриншот trio-плашки shot-overlay-3rows.png; смена смежного cue — тот же контейнер и узлы строк, opacity 1 без пере-fade). Механика: `content/overlay/{overlay,style}.ts` — SubtitleStyle {fontScalePct 75–300, position bottom/top, marginPct ≤25, plateOpacity} с клампами (mergeStyle/stepScale — чистые, юнит-тесты); плашка по гайду 06 §6 (градиент rgba(10,14,23,.78)→прозрачный, скругление 6px, backdrop-blur 2px; строки: оригинал #FFF/500, перевод #BDFE4F/85%, третьи+ rgba(255,255,255,.75)/75%, обводка 2px paint-order:stroke fill; разделитель строк — межстрочный отступ 0,22em, гайд линий не задаёт); позиция низ/верх флекс-выравниванием контейнера + margin, геометрия следует за видео (resize/scroll/fullscreen + ResizeObserver); кегль clamp(14px,2.6cqw,34px)×масштаб (cqw — плашка масштабируется с плеером); колесо над плашкой — ±10% (75–300%, Shift — сдвиг ±100 мс docs/03 §8): плашка pointer-events:none, попадание считается геометрически (window-capture wheel), клики по плееру проходят; дифф-обновление строк по trackId (text меняется на месте — контейнер не пересоздаётся, fade 80 мс только на появление/исчезание); гашение нативных показа платформы (docs/03 §2): `content/native-captions.ts` — generic textTracks showing→hidden с восстановлением + YouTube blankYouTubeCaptions (CSS-класс на <html>, селектор .ytp-caption-window-container знает только адаптер, docs/03 §9; CSS переживает перезапуск captions-модуля и не мешает добыче); тест-хуки duopulse-test-style/-track (массив дорожек, {clear:true}), state().style/nativeBlanked. Попутно починен стенд e2e/subtitles, сломанный задачей 3.3 (набор чистится при смене videoKey — инлайн-диспатч тест-дорожки стал гоняться с очисткой; ранер задаёт дорожку детерминированно после успокоения детектора). vitest 91/91 (+20), cargo fmt/clippy/test 93/93, tsc чисто, бандл 49,5 КБ/14,1 gzip ≤80; e2e/youtube 32/32 (+1 чек гашения: класс <html> на всех 10 видео) |
| 3.5 | **✅ выполнено 17.10.2026 (карточка duopulse-026)** Синхронизация: offset-слайдер, горячие клавиши, seek-устойчивость | скачки по таймлайну не дают «призраков» cue — **достигнуто** (e2e/subtitles 49/49: серия seek 2→13→7,5→4→14,96→10,5 с — каждый раз ровно ожидаемая реплика или пусто, хвост <150 мс подавлен; смена качества — новый src того же `<video>` и пересоздание элемента с тем же videoKey — набор дорожек не теряется, показ в такт). Механика: покадровая точность — цикл `requestVideoFrameCallback` в движке (docs/03 §4 п.1; кадр отрисован → пересчёт, время по-прежнему только `video.currentTime`; отмена кадра при detach, флаг `state().engine.frameCallback` для стендов); сдвиг ±10 с шагом 100 мс из любого источника — Shift+колесо по плашке (3.4), горячие клавиши `Alt+[`/`Alt+]` (раньше/позже, поглощают keydown, работают при активном наборе), IPC `subtitles.set_offset` (первая сервисная команда subtitles.*: bridge-хендлер → eval активной вкладки → document-событие `duopulse-set-offset`; кламп в Core и движке) — применение без перезагрузки дорожек; HUD синхронизации `content/overlay/hud.ts` (гайд 06 §6: тёмная плашка, лайм-акцент, слайдер ±10 с/шаг 100, «Сброс», автоскрытие 2,4 с, pointer-events только на HUD, край — противоположный плашке субтитров). Набор дорожек привязан к videoKey: запоминается в content-слое и переживает пересоздание `<video>` с тем же ключом (смена качества у плееров, пересоздающих элемент; детект до loadedmetadata приходит с ключом без длительности — уточнённый ключ следом, память набора не стирается); попутно починен дефект 3.2: детектор мутировал `this.current` до переэмитa — смена videoKey того же элемента (SPA-переход без пересоздания видео) не доходила до обработчика (`changed` всегда false по одной ссылке), теперь content-слой помнит ключ последней обработки. Тесты: vitest 101/101 (+10: rVFC-цикл — кадры тикают/не спамят/отменяются, seek между кадрами, frameCallback; HUD — формат «+0,3 с», шаг с клампом), cargo fmt/clippy/test 93/93, tsc чисто, бандл 58,4 КБ/16,1 gzip ≤80 |
| 3.6 | Ручные субтитры: drag&drop 1–3 файлов .srt/.vtt на любой сайт, смешивание с дорожками платформы | работает на 3 тестовых сайтах с `<video>` |
| 3.7 | Кнопка «duo» в omnibox + Alt+D + панель настроек набора (языки, источники, порядок) | сценарии docs/01 §5.1 и §5.3 проходят, включая тройной набор |
| 3.8 | E2E-прогон «10 случайных видео» + фикстуры YouTube в CI | прогон зелёный, фиксация рабочих путей адаптера |

### M4 — перевод
| # | Задача | DoD |
|---|---|---|
| 4.1 | Провайдеры перевода (интерфейс + DeepL/Google/LibreTranslate) | подменные тесты провайдеров зелёные |
| 4.2 | Батчинг cue + контекст + кэш SQLite | повторный просмотр — 0 сетевых вызовов перевода |
| 4.3 | Офлайн-деградация и бейдж «перевод недоступен» | сценарий docs/01 §5.4 проходит |

### M5 — полировка и релиз
| # | Задача | DoD |
|---|---|---|
| 5.1 | Полные настройки + экспорт/импорт профиля | переезд на чистую машину за 1 файл |
| 5.2 | Установщик (NSIS/MSI), автообновление | установка на чистой Windows, обновление канарейки |
| 5.3 | Чек-лист приёмки релиза + прогон метрик | все P-метрики в бюджете |
| 5.4 | Лицензия и README-финал | выбрана и проставлена |

### M6 — VPN и доступ к заблокированным сайтам (F-12, инкремент B)
Дизайн — docs/02 §6 (локальный роутер, fail-closed, split-tunnel). Карточки
созданы заранее — CARDS/037–042 (duopulse-010); при старте эпика сверить их
актуальность с ROADMAP и docs/02 §6.

| # | Задача | DoD |
|---|---|---|
| 6.1 | Локальный SOCKS5-роутер в Core (`vpn/router.rs`): WebView2 постоянно направлен на `127.0.0.1:<port>`, маршруты direct/upstream | с роутером в режиме off страницы грузятся как без него; отказ upstream → ошибка клиенту, а не прямой ход (fail-closed) |
| 6.2 | Клиент WireGuard (`vpn/wg.rs`, boringtun): импорт `.conf`, handshake, keepalive, roaming | подключение к серверу пользователя стабильно ≥ 30 мин; пропускная способность ≥ 100 Мбит/с на эталонной машине; ключ — в DPAPI |
| 6.3 | Split-tunnel (`vpn/rules.rs` + `vpn/dns.rs`): правила домен → маршрут, режимы off/global/split, DNS только через маршрут | заблокированный домен открывается через туннель, YouTube — напрямую, одновременно; правила переживают перезапуск; DNS-утечек нет (трассировка) |
| 6.4 | Kill-switch: разрыв туннеля не выпускает туннельный трафик в открытую | автотест: обрыв upstream при загрузке страницы — соединение закрывается, не уходит напрямую |
| 6.5 | UI VPN: индикатор-щит в Navbar, панель (тумблер, режим, сервер, правила, статистика), дисклеймер | сверка с гайдом 06; сценарий docs/01 §5.6 проходит руками |
| 6.6 | E2E маршрутные тесты: direct / tunnel / kill-switch / split-правила | автотесты зелёные, включены в CI-контур проекта |

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
- CI (GitHub Actions, после настройки remote): fmt+clippy+test, сборка Windows-артефакта
  в `builds/duopulse_<версии>_<тип>` (debug/release) — правило проекта про сборки APK
  применяется по аналогии к EXE: всегда в `builds/` с версией и типом сборки.
