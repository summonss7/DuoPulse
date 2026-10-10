# Протокол испытаний M0 — спайк движка Tauri 2 + WebView2 против YouTube

Карточка: duopulse-003 · Даты прогонов: 08.10.2026 16:31 (4K) и 08.10.2026 16:56–17:05 (полный протокол).
Машина: Windows 10.0.26200, WebView2 = Edge/Chromium 154. Приложение: `npm run tauri dev`
(Tauri 2 unstable — multi-webview, webview2-com 0.39). Управление проверками — CDP
(порт 9222, скрипт `e2e/tools/cdp.mjs`), скриншоты лежат рядом в `e2e/m0-results/`.

## Сводка результатов

| # | Проверка | Результат | Доказательство |
|---|---|---|---|
| 1 | Сборка и запуск `cargo tauri dev` | **PASS** — окно открывается, UI-полоса + webview с youtube.com | `console-log.txt` («Running target\debug\duopulse.exe») |
| 2 | YouTube 1080p60 без дропов кадров | **PASS** — 1920x1080, дропы 3/3149 = **0.10 %**, мгновенно ~60 fps | `1080p60-playback.png`, `console-log.txt` |
| 3 | YouTube 4K (2160p60) | **PASS** — 3840x2160, дропы 5/5512 = **0.09 %** | `4k-playback.png` |
| 4 | DRM: Widevine EME | **PASS** — `com.widevine.alpha` доступен | `console-log.txt` |
| 5 | DRM-ролик 1: Sintel (Widevine), Shaka demo | **PLAYS** — MediaKeys созданы, лицензия получена, 0/235 дропов, кадр рендерится | `drm-widevine-sintel.png`, `drm-widevine-playback.png` |
| 6 | DRM-ролик 2: Multi-DRM (Axinom), Shaka demo | **PLAYS** — 1252x720 PLAYING, 0 дропов, err: none | `drm-multidrm-axinom.png` |
| 7 | YouTube Music (без входа) | **PLAYS** — трек 1080x608, 0/497 дропов | `ytmusic-playback.png` |
| 8 | Аппаратное декодирование | **PASS** — H.264 и VP9 1080p60 `powerEfficient=true` | `console-log.txt` |
| 9 | Инжекция content-скрипта в каждый документ | **PASS** — метка в консоли на youtube.com, watch-странице, about:blank-iframe, shaka-demo, music.youtube.com | `console-log.txt` |
| 10 | Сетевой перехват (WebResourceRequested) | **PASS** — проба `/duopulse_block_test_probe` → 403 + `X-DuoPulse-Block: 1` на всех http(s)-страницах | `console-log.txt`, бейдж на скриншотах |

## Детали по блокам

### Видео YouTube (эпик 0.2)
Ролик Big Buck Bunny 60fps (`watch?v=aqz-KE-bpKQ`). При загрузке YouTube сам выбрал 2160p60
(3840x2160, дропы 5/5512 = 0.09 % — прогон 16:31). Качество принудительно переключено на
`hd1080` через плеер YouTube: стабильные 1920x1080 при ~60 fps, 3 дропа на 3149 кадров (0.10 %).
Дропов, видимых глазом, нет; бейдж мониторинга (`getVideoPlaybackQuality`) на скриншотах.

### DRM (эпик 0.2)
- `navigator.requestMediaKeySystemAccess('com.widevine.alpha')` → OK: Widevine-CDM в WebView2 есть.
- Sintel (Widevine, шифрование cenc) — Shaka Player сам создал MediaKeys, открыл временную
  сессию, получил лицензию; видео декодируется и рендерится (0 дропов). Сюжетные кадры видны
  на скриншоте, DRM-ошибок нет.
- Multi-DRM (Axinom: Widevine+PlayReady одновременно) — играет, 0 дропов.
- YouTube Music без подписки — трек играет с рекламной моделью бесплатного тира, 0 дропов.
- **Ограничение:** эксклюзивный Premium-контент YouTube не проверен — нужен аккаунт Premium.
  Технический риск (отсутствие Widevine в WebView2) снят: CDM есть, лицензии выдаются,
  зашифрованный контент декодируется. Остаточная проверка — вручную на M1/M5 при наличии аккаунта.
- **Дополнение 08.10.2026 (карточка duopulse-005, blocked):** аккаунт Premium так и не
  появился — остаточная проверка отложена до его появления. Уточнён её объём: программа
  YouTube Originals ликвидирована (анонс 01.2022, свёртывание к 2023–2024), премиум-
  эксклюзивов в прежнем смысле не осталось. Реалистичный чек при появлении аккаунта:
  вход с подпиской → обычный ролик (нет рекламы, доступен «повышенный битрейт 1080p»),
  YouTube Music в режиме Premium, members-only/ранний доступ при наличии. Все сценарии
  идут по уже проверенному пути Widevine EME → лицензия → декодер; решение GO от этого
  не зависит.
- Вывод по DRM: **играет** (не «частично» и не «не играет»).

### Инжекция скрипта (эпик 0.3)
`WebviewBuilder::initialization_script` (в WebView2 → `AddScriptToExecuteOnDocumentCreatedAsync`)
выполняет `content/m0-spike.js` в каждом новом документе. Метка `[DuoPulse M0] content script
injected: <URL>` зафиксирована в консоли для: youtube.com (главная), watch-страницы, служебных
about:blank-документов внутри iframes, стороннего сайта shaka-demo и music.youtube.com.
Скрипт без зависимостей, один IIFE (docs/02 §4).

### Сетевой перехват (эпик 0.3)
Нативный COM-обработчик `AddWebResourceRequestedFilter("*", ALL)` + `add_WebResourceRequested`
(src-tauri/src/main.rs, `install_request_blocker`). Ответ на пробу: 403 «Blocked by DuoPulse»
с заголовком `X-DuoPulse-Block: 1`. Тот же tauri-обработчик `on_web_resource_request` наружные
http(s)-запросы не видит — поэтому перехват сделан на COM-уровне; это же путь для adblock (M2).
Нюанс: в песочницах `about:srcdoc`/`about:blank` внутри iframe проба получает 403, но заголовок
из ответа JS-ом оттуда не читается (CORS-изоляция origin 'null') — на реальных страницах
перехват подтверждён везде.

## Решение: **GO** на Tauri 2 + WebView2

Все пункты gate-критерия M0 из ROADMAP выполнены: YouTube играет стабильно (1080p60 и 4K,
< 0.15 % дропов), скрипт инжектится в каждый документ, сетевые фильтры срабатывают, DRM
(Widevine) работает. Переход на Electron не требуется. Зафиксировано в ROADMAP.md (раздел
«Изменения плана»).
