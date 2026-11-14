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
        .manage(duo_mobile::DuoManaged::default())
        // Хранилище закладок (duopulse-104): SQLite в filesDir/profile —
        // открыть до старта окна; недоступный каталог/диск роняют запуск с
        // внятной причиной (как десктопный main.rs).
        .setup(|app| {
            use std::sync::Arc;
            use tauri::Manager;
            let dir = mobile_history::profile_dir()?;
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
            // восстановленный вход — первый синк сразу (как main.rs этапа 4):
            // протухшая сессия всплывёт первым же кругом (401 → ошибка статуса)
            if account.restore() {
                account.schedule_sync();
            }
            account.start_worker(Arc::clone(&passwords), Arc::clone(&history));
            app.manage(history);
            app.manage(passwords);
            app.manage(account);
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
            #[cfg(debug_assertions)]
            mobile_download::cmd::duo_debug_save_music,
            mobile_history::history_bookmark_add,
            mobile_history::history_bookmark_remove,
            mobile_history::history_bookmark_update,
            mobile_history::history_bookmark_list,
            mobile_history::history_group_list,
            mobile_history::history_group_add,
            mobile_history::history_group_move,
            mobile_history::history_group_rename,
            mobile_history::history_group_remove,
            mobile_history::history_group_set_sort,
            mobile_history::history_group_toggle_bookmark,
            mobile_history::history_bookmark_move,
            mobile_account::aila_status,
            mobile_account::aila_login,
            mobile_account::aila_logout,
            mobile_account::aila_sync_now,
            mobile_account::mobile_passwords_list,
            mobile_account::mobile_passwords_reveal,
            mobile_account::mobile_clipboard_copy,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить DuoPulse (мобильная ветка)");
}
