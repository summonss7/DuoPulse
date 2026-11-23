// DuoPulse — мобильная обёртка (Android; этап 1 карточки duopulse-081, образец
// novagrid-058): тот же веб-бандл в системном WebView. Десктоп-бин (main.rs со
// всей логикой браузера: вкладки, блокировщик, VPN, субтитры, обновления) от
// lib НЕ зависит и сюда не входит — cdylib/staticlib нужны только мобильным
// таргетам (.so для JNI-активити из gen/android), MinGW-линкер винды их не
// строит; десктоп собирается как `cargo build --bin duopulse`, а
// `tauri android build` — наоборот, только --lib (эту развилку проверил
// novagrid-058 на той же машине/стеке).
//
// ПРИЗНАК ПЛАТФОРМЫ ДЛЯ ФРОНТЕНДА: мобильная обёртка включает
// withGlobalTauri (tauri.android.conf.json) — window.__TAURI__ есть только
// на мобильных; десктопный конфиг держит false. Фронтенд различает ветки так
// (isTauriMobile в src/mobile/platform.ts) — один веб-бандл на все платформы.
//
// Этап 2 (duopulse-082): Duo-движок — команды duo_yt_player/duo_fetch_cues/
// duo_translate_texts (src/duo_mobile.rs) для субтитров и перевода в
// мобильной ветке (кросс-доменный iframe не может fetch сам, сеть ходит
// нативно через ureq); парсеры cue — общий модуль subtitles (parse_auto,
// единый источник разбора с десктопом). Команды bridge десктопа
// (tabs.*/nav.*/subtitles.*...) на мобильных по-прежнему не регистрируются.
//
// Этап 3 (duopulse-083): OTA мобильной — команды mobile_updater (манифест
// центра Aila /updates/duopulse, APK-ассет, системная установка; десктоп
// обновляется своим tauri-plugin-updater по latest.json и манифест v2 не
// читает).
//
// Этап 6 (duopulse-112, цепочка duopulse-106): аккаунт Aila и синк на
// мобильной ветке — общее с десктопом ядро (aila.rs: вход PBKDF2, синк
// блобов appdata «passwords»/«bookmarks»; passwords/mod.rs: AES-GCM
// SQLite-хранилище), секреты — AndroidKeyStore (secrets.rs → Kotlin-хелпер
// MobileKeystoreHelper). Команды — mobile_account (login/logout/status/
// sync_now, список/копирование паролей, буфер обмена); правки закладок
// будят воркер (mobile_history). Без входа всё локально, как прежде.

pub mod duo_mobile;
pub mod mobile_jni;
pub mod mobile_open;
// Настройки — только мобильным таргетам (duopulse-138): язык UI живёт в
// Core того же вида, что на десктопе (раздел "ui" settings.json); модуль
// чистый (serde/serde_json/schemars), бин main.rs собирает его сам.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod settings;
// Язык UI мобильной ветки (duopulse-138): команда записи + init-скрипт
// webview (подробности — в шапке модуля).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod mobile_settings;
// Нативный web-оверлей (duopulse-126): поиск и прочие сайты — в приложении,
// не в системном браузере; Kotlin-хелпер MobileWebHelper + команды
// mobile_web_open/mobile_web_close.
pub mod mobile_web;
// Полный адблок в мобильной ветке (duopulse-144): движок crate::adblock
// (EasyList + uBO + quick-fixes, сетевая фильтрация/косметика/скриптлеты)
// для shouldInterceptRequest оверлея — JNI-экспорты + команды статуса и
// тумблера. Общий движок объявлен ниже (десктоп держит его бином main.rs).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod adblock;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod mobile_adblock;
pub mod mobile_private;
pub mod mobile_updater;
// Загрузка музыки с YouTube мобильной веткой (duopulse-121): чистые функции
// выбора дорожки/имени файла компилируются везде (хостовые тесты), сетевая
// команда — мобильным таргетам (как mobile_open).
pub mod mobile_download;
// Приём PDF из «Открыть с помощью» (карточка duopulse-119): Kotlin-хелпер
// MobilePdfHelper + команды mobile_pdf_take/mobile_pdf_chunk (просмотрщик
// pdf.js во фронтенде); валидатор пути — чистый, тесты на хосте.
pub mod mobile_pdf;
// Приём видео из «Открыть с помощью» (карточка duopulse-179): Kotlin-хелпер
// MobileVideoHelper + команда mobile_video_take и протокол mobilevideo
// (Range/206-куски cache/video для <video> во фронтенде).
pub mod mobile_video;
// Диагностика мобильной ветки (duopulse-164, паритет 1/8): команда
// diag_snapshot для листа «Диагностика» в меню «⋮» — версия/канал, сеанс,
// RSS, счётчики сторов и адблока. Чистые функции — везде (тесты на хосте),
// команда — мобильным таргетам (как mobile_open).
pub mod mobile_diag;
// Секреты мобильной ветки (duopulse-112): Android-бэкенд тех же save/load,
// что DPAPI десктопа (синоним по вызову — crate::secrets).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod secrets;
// Хранилище паролей (duopulse-112): тот же модуль, что в десктоп-бине
// (main.rs); платформенно-нейтрален — ключ под secrets (AndroidKeystore).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod passwords;
// Аккаунт Aila и синк (duopulse-112): общее ядро с десктопом, у десктопа
// компилируется бином (main.rs), здесь — мобильным таргетам либы.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod aila;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod mobile_account;
// Захват паролей из форм web-оверлея (duopulse-165, паритет 2/8): пейлоад
// детекта → Kotlin (MobilePassNative) → PasswordPrompts (тот же Core, что
// у десктопного бара) → событие UI; чистое ядро — в passwords/prompts.rs.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod mobile_pass;
// ASR-субтитры мобильной ветки (duopulse-167, паритет 4/8): облачный
// OpenAI-совместимый провайдер для видео без дорожек — модули asr/ (engine/
// decode/cache/config/core) общие с десктопом, конвейер мобильный (аудио
// качает фетчер iframe, чанки приходят командой; прогресс — событием).
// Десктопные pipeline/server (whisper.exe, SOCKS-роутер) сюда не входят.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod asr;
pub mod mobile_asr;
// Парсеры cue — мобильным таргетам (duopulse-082): parse_auto для duo_fetch_
// cues. На десктопе либа их не компилирует: оставалась бы тонкой (cdylib
// Windows/MinGW не тянет экспорт тяжёлых деревьев — quick-xml, ср. рецепт
// NovaGrid), десктоп-бин собирает модуль сам (main.rs).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod subtitles;
// Закладки мобильной ветки (duopulse-104): хранилище history (SQLite,
// rusqlite bundled — тот же duopulse.db, что на десктопе) + команды
// history.* в mobile_history. Тоже только мобильным таргетам: десктопные
// команды регистрирует bridge.rs в бине.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod history;
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod mobile_history;
// Фетчер фавиконов (duopulse-235): тот же модуль, что бин main.rs даёт
// десктопному history.favicon, — для значков закладок мобильной ветки
// (mobile_history::history_favicon). Тоже только мобильным таргетам —
// десктопная либа остаётся тонкой.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod favicon;
// Конфиг внешнего прокси (задача 1.8) — мобильным таргетам либы с этапа 6
// duopulse-169: типы ProxyConfig/ProxyState тянет vpn-модуль (роутер и DTO
// статуса), сам внешний прокси мобильной ветке не нужен — UI его не показывает.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod proxy;
// Тоннель-ядро WireGuard (duopulse-169, паритет 6/8): платформенно-нейтральный
// Rust из десктоп-бина (boringtun + smoltcp, парсер .conf, профили
// wg-profiles.json + секреты под Keystore-веткой secrets.rs, SOCKS5-роутер
// Direct/Upstream/Wg с fail-closed, split-правила, DNS по маршруту) — как
// mobile_adblock компилирует движок десктопа. Хост-тесты модуля гоняет бин
// main.rs (либа на Windows их не включает — тонкий cdylib).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod vpn;
// Команды тоннеля мобильной ветки (duopulse-169): импорт текста .conf,
// профили, set_enabled/status/test_connection, события vpn:state_changed и
// vpn:stats контрактом vpn.* десктопа (TS-клиент переиспользуется, этап 8).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod mobile_vpn;

/// duopulse-135: tao завершает Android-цикл через std::process::exit; exit(3)
/// гонит atexit-обработчики Chromium (WebView), которые разрушают его глобальный
/// мьютекс, пока потоки Chromium ещё им пользуются → FORTIFY abort при выходе
/// «назад» (стек: tao EventLoop::run → process::exit, abort внутри exit).
/// Подменяем `exit` в своей .so (само-интерпозия: PLT-ссылки из этой же
/// библиотеки резолвятся в её экспорт раньше libc) на прямой exit_group —
/// обработчики не запускаются, ядро срезает все потоки. Для Android-выхода из
/// приложения это и есть ожидаемая семантика.
#[cfg(target_os = "android")]
mod exit_shim {
    #[unsafe(no_mangle)]
    pub extern "C" fn exit(code: i32) -> ! {
        unsafe { libc::syscall(libc::SYS_exit_group, code) };
        unreachable!("exit_group не возвращается")
    }
}

/// Точка входа мобильной обёртки; mobile_entry_point генерирует JNI-связку
/// для Kotlin-активити из gen/android. На десктоп-таргетах не вызывается
/// (бин main.rs lib не использует — см. шапку).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(mobile)]
    mobile_run();
}

#[cfg(mobile)]
fn mobile_run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Язык UI (duopulse-138): window.__DUOPULSE_UI_LANG__ до скриптов
        // страницы — src/i18n читает его синхронно при загрузке модуля.
        // У окон из конфига init-скрипта нет, этот хук Builder-а уходит во
        // все webview (main-frame initialization_scripts, tauri-2.12).
        .append_invoke_initialization_script(mobile_settings::ui_lang_init_script())
        // Видео из «Открыть с помощью» (duopulse-179): файлы cache/video
        // отдаёт <video> фронтенда с поддержкой перемотки (Range → 206);
        // на Android URL вида http://mobilevideo.localhost/… (wry-маппинг
        // кастомных протоколов), хендлер получает mobilevideo://localhost/…
        .register_uri_scheme_protocol("mobilevideo", mobile_video::serve)
        .manage(duo_mobile::DuoManaged::default())
        // Хранилище закладок (duopulse-104): SQLite в filesDir/profile —
        // открыть до старта окна; недоступный каталог/диск роняют запуск с
        // внятной причиной (как десктопный main.rs).
        .setup(|app| {
            use std::sync::Arc;
            use tauri::Manager;
            let dir = mobile_history::profile_dir()?;
            // Маршрутизация трафика приложения (duopulse-170, паритет 7/8):
            // роутер процесса — SOCKS5 для фетчей Core (duo-субтитры,
            // ASR-облако) и HTTP-листенер CONNECT/absolute-form для WebView
            // (androidx.webkit ProxyController, MobileProxyHelper). Стартовая
            // политика Direct — как WebView2 десктопа, режим меняет тумблер
            // тоннеля (mobile_vpn) без перезапуска. Не поднялся — деградация
            // в журнал старта, трафик остаётся прямым.
            let router = match vpn::router::Router::start() {
                Ok(router) => Some(router),
                Err(e) => {
                    eprintln!("[vpn] роутер приложения не поднялся: {e} — трафик прямой");
                    None
                }
            };
            // Диагностика (duopulse-164): старт сеанса — до открытия окна,
            // «время сеанса» снимка честное с самого запуска.
            mobile_diag::init();
            // Split-правила VPN (duopulse-171): общий стор с роутером — правки
            // команд видны соединениям сразу; персист vpn/split-rules.json.
            // Сохранённый режим поднимет mobile_vpn_restore на старте UI.
            mobile_vpn::init_rules(&dir);
            // Полный адблок оверлея (duopulse-144): движок из кэша прошлой
            // сессии публикуется сразу, списки досматривает фоновая нить;
            // JNI-вызовы MobileAdblockNative падают в этот же синглтон
            mobile_adblock::init(&dir);
            // закладки — как в 104; пароли и аккаунт Aila — этап 6 (112):
            // открываются до старта окна; недоступный каталог роняет запуск
            // с внятной причиной (как десктопный main.rs)
            let history = Arc::new(
                history::HistoryStore::open(&dir)
                    .map_err(|e| format!("открыть {}: {e}", dir.display()))?,
            );
            let passwords = Arc::new(
                passwords::PasswordStore::open(&dir).map_err(|e| format!("открыть пароли: {e}"))?,
            );
            let account = Arc::new(aila::AilaAccount::new(&dir));
            // Кэш ASR-дорожек (duopulse-167): та же таблица asr_tracks в
            // duopulse.db, что на десктопе — повторный просмотр видео без
            // сети (airplane mode) получает дорожку из кэша.
            let asr_cache = Arc::new(
                asr::cache::AsrCache::open(&dir)
                    .map_err(|e| format!("открыть кэш ASR: {e}"))?,
            );
            // Пароли из форм web-оверлея (duopulse-165): состояние бара —
            // общий PasswordPrompts; статика mobile_pass даёт JNI-вызовам
            // (MobilePassNative) тот же стор и эмиттер событий UI.
            mobile_pass::init(app.handle().clone(), Arc::clone(&passwords));
            // Закладки из меню web-оверлея (duopulse-193): тот же HistoryStore
            // и воркер синка Aila, что у команд history.* — JNI-вызовам
            // (MobileBookmarksNative) отдаём статику.
            mobile_history::jni::init(Arc::clone(&history), Arc::clone(&account));
            // восстановленный вход — первый синк сразу (как main.rs этапа 4):
            // протухшая сессия всплывёт первым же кругом (401 → ошибка статуса)
            if account.restore() {
                account.schedule_sync();
            }
            account.start_worker(Arc::clone(&passwords), Arc::clone(&history));
            app.manage(history);
            app.manage(passwords);
            app.manage(account);
            app.manage(asr_cache);
            app.manage(Arc::new(mobile_asr::cmd::AsrManaged::default()));
            app.manage(router); // Option<Router> — mobile_vpn переключает маршрут
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            duo_mobile::net::duo_yt_player,
            duo_mobile::net::duo_fetch_cues,
            duo_mobile::net::duo_translate_texts,
            duo_mobile::net::duo_translate_selection,
            mobile_updater::updater_check,
            mobile_updater::updater_download,
            mobile_updater::updater_install,
            mobile_open::mobile_open_url,
            mobile_web::mobile_web_open,
            mobile_web::mobile_web_close,
            mobile_web::mobile_web_header_ping,
            mobile_adblock::mobile_adblock_status,
            mobile_adblock::mobile_adblock_set_enabled,
            mobile_private::mobile_private_cleanup,
            mobile_settings::mobile_ui_lang_set,
            mobile_download::cmd::duo_mobile_formats,
            mobile_download::cmd::duo_download_begin,
            mobile_download::cmd::duo_download_append,
            mobile_download::cmd::duo_download_finish,
            mobile_download::cmd::duo_download_finish_mux,
            mobile_download::cmd::duo_download_abort,
            mobile_download::cmd::duo_download_subtitle,
            mobile_pdf::mobile_pdf_take,
            mobile_pdf::mobile_pdf_chunk,
            mobile_video::mobile_video_take,
            mobile_diag::diag_snapshot,
            // Тоннель WireGuard (duopulse-169, паритет 6/8): ядро без UI —
            // команды зеркалят контракт vpn.* десктопа для переиспользования
            // TS-клиента (события vpn:state_changed/vpn:stats — те же).
            mobile_vpn::mobile_vpn_import_profile,
            mobile_vpn::mobile_vpn_list_profiles,
            mobile_vpn::mobile_vpn_remove_profile,
            mobile_vpn::mobile_vpn_use_profile,
            mobile_vpn::mobile_vpn_set_enabled,
            mobile_vpn::mobile_vpn_status,
            mobile_vpn::mobile_vpn_test_connection,
            // Правила и режимы (duopulse-171, паритет 8/8): split-правила,
            // режимы off/global/split, SAF-пикер .conf и восстановление
            // сохранённого тоннеля на старте UI.
            mobile_vpn::mobile_vpn_set_mode,
            mobile_vpn::mobile_vpn_get_rules,
            mobile_vpn::mobile_vpn_add_rule,
            mobile_vpn::mobile_vpn_remove_rule,
            mobile_vpn::mobile_vpn_pick_conf,
            mobile_vpn::mobile_vpn_restore,
            #[cfg(debug_assertions)]
            mobile_download::cmd::duo_debug_save_music,
            mobile_history::history_bookmark_add,
            mobile_history::history_bookmark_remove,
            mobile_history::history_bookmark_update,
            mobile_history::history_bookmark_list,
            mobile_history::history_visit,
            mobile_history::history_list,
            mobile_history::history_delete_urls,
            mobile_history::history_delete_range,
            mobile_history::history_group_list,
            mobile_history::history_group_add,
            mobile_history::history_group_move,
            mobile_history::history_group_rename,
            mobile_history::history_group_remove,
            mobile_history::history_group_set_sort,
            mobile_history::history_group_toggle_bookmark,
            mobile_history::history_bookmark_move,
            // Фавикон сайта для значков закладок (duopulse-235): паритет
            // десктопного history.favicon, фетч — favicon.rs мобильной либы.
            mobile_history::history_favicon,
            mobile_account::aila_status,
            mobile_account::aila_login,
            mobile_account::aila_logout,
            mobile_account::aila_sync_now,
            mobile_account::mobile_passwords_list,
            mobile_account::mobile_passwords_reveal,
            mobile_account::mobile_clipboard_copy,
            mobile_pass::mobile_password_incognito,
            mobile_pass::mobile_password_candidate,
            mobile_pass::mobile_password_resolve,
            // ASR-субтитры (duopulse-167 облако; duopulse-168 локальный
            // whisper): настройки (ключ — Keystore, провайдер local/cloud),
            // менеджер моделей ggml и конвейер (start/append/finish/cancel).
            mobile_asr::cmd::asr_get_settings,
            mobile_asr::cmd::asr_set_settings,
            mobile_asr::cmd::asr_model_download,
            mobile_asr::cmd::asr_model_delete,
            mobile_asr::cmd::subtitles_asr_start,
            mobile_asr::cmd::subtitles_asr_audio_append,
            mobile_asr::cmd::subtitles_asr_audio_finish,
            mobile_asr::cmd::subtitles_asr_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить DuoPulse (мобильная ветка)");
}
