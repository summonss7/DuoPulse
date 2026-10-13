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
│   ├── duopulse-content.ts         # вход IIFE-бандла (≤ 80 КБ gzip)
│   ├── detector/                   # поиск <video>, MutationObserver
│   ├── adapters/
│   │   ├── types.ts                # интерфейс Adapter { listTracks(), version, paths[] }
│   │   ├── youtube.ts              # дорожки из player-ответа (+fallback TextTrack)
│   │   └── file.ts                 # ручные .srt/.vtt через Core
│   ├── engine/                     # cue-таймлайн, бинарный поиск, offset
│   ├── overlay/                    # плашка «оригинал/перевод», стили, позиция
│   └── messaging/                  # канал до Core
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

**Статус (13.10.2026, задачи 1.1–1.4 выполнены — карточки duopulse-011/012/013/014).**
`bridge` реализован: единственный источник контракта — Rust-типы
`src-tauri/src/bridge.rs` (schemars); из них генерируется `bridge/contract.json`
(JSON Schema draft-07, версионируется в git, версия контракта — поле `version`),
из него — TS-типы `src/bridge/gen/types.ts` (`npm run gen:bridge`). Ручные правки
генерённого исключены тестами с обеих сторон (cargo `contract_file_is_up_to_date`,
vitest `src/bridge/client.test.ts` — команды и события). Словарь v2:
команды `bridge.version`,
`tabs.{list, open, close, reopen, activate}` (менеджер вкладок — задача 1.2,
`src-tauri/src/tabs/`), `nav.{navigate, go_back, go_forward, reload}` (действуют
на активную вкладку), `nav.{resolve_omnibox, focus_page}` + `history.search`
(задача 1.3: разбор ввода omnibox — `src-tauri/src/omnibox.rs`, подсказки —
FTS5-индекс `src-tauri/src/history/`), `history.{visit, list, delete_urls,
delete_range, bookmark_add, bookmark_remove, bookmark_update, bookmark_list}`
(задача 1.4: SQLite-хранилище `duopulse.db` в профиле — docs/02 §8; визиты
пишет Core из on_page_load вкладок, дедуп 60 с, заголовок подтягивается из
on_title; list — агрегат по URL для страницы управления),
`settings.{get, set}`, `vpn.{set_enabled, status, test_connection}`,
`app.restart`; событие `tabs:updated` (снапшот списка вкладок после любого
изменения — им перерисовывается таб-бар `src/chrome/tabbar.ts`,
omnibox-подсказки — `src/chrome/omnibox.ts`) и события-каркас `page:loaded`,
`page:video_detected` (эмит — M3), `vpn:state_changed` (M6). Имена событий —
через `:` (словарь `домен:событие`): tauri 2 разрешает в именах событий только
alnum/`-`/`/`/`:`/`_`, точечные имена не доставлялись (переименование — bump
контракта v1→v2 в задаче 1.2; имена команд с точками не затронуты — в tauri
идёт snake_case-хендлер из поля "handler"). Прокси-инкремент A мигрирован:
`proxy_*` → `settings.{get, set}` + `vpn.{set_enabled, status, test_connection}`
+ `app.restart`; состояние vpn — `off/on/error`, при WireGuard (M6) расширится
до словаря выше с bump версии. Типы событий для Content-слоя —
`content/messaging/events.ts`. Внутренние страницы (задача 1.4): адрес
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
(чек-лист приёмки таб-бара — [e2e/tabs/CHECKLIST.md](../e2e/tabs/CHECKLIST.md)).

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
| 2.1 | adblock-rs: сетевая фильтрация + списки EasyList/uBO + обновление | метрика P-07 достигнута |
| 2.2 | Косметическая фильтрация в content-скрипте | главная YouTube без рекламных блоков-заглушек |
| 2.3 | Спящие вкладки + исключения (звук/видео) | метрика P-04 ≈ 0% |
| 2.4 | Тёплый старт + преждекватная настройка кэшей | метрики P-01..P-03 в бюджете docs/04 §2 |
| 2.5 | Страница «Диагностика»: съём и история метрик | график последних прогонов |

### M3 — многоязычные субтитры v1 (центральный этап)
| # | Задача | DoD |
|---|---|---|
| 3.1 | Парсеры srt/vtt/timedtext (Rust) + фикстурные тесты | 100% фикстур проходят, границы cue корректны |
| 3.2 | content: детектор видео + каркас движка cue-таймлайна | на тест-странице overlay показывает тест-cue точно по времени |
| 3.3 | YouTube-адаптер: полный список дорожек + загрузка выбранных N (оригинал + 1–2 `tlang`-перевода или любые языки) | 10 случайных видео → наборы из 2–3 дорожек получены |
| 3.4 | Оверлей: плашка из N строк (1–3), стили строк, позиция, колесо-размер | сверки по гайду; без миганий при коротких cue |
| 3.5 | Синхронизация: offset-слайдер, горячие клавиши, seek-устойчивость | скачки по таймлайну не дают «призраков» cue |
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
- TS/JS: `pnpm`, strict-режим `tsc`, `eslint`, `vitest` (content-движок), `playwright`
  (E2E, где драйвер позволяет).
- CI (GitHub Actions, после настройки remote): fmt+clippy+test, сборка Windows-артефакта
  в `builds/duopulse_<версии>_<тип>` (debug/release) — правило проекта про сборки APK
  применяется по аналогии к EXE: всегда в `builds/` с версией и типом сборки.
