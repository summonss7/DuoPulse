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

pub mod duo_mobile;
pub mod mobile_updater;
// Парсеры cue — мобильным таргетам (duopulse-082): parse_auto для duo_fetch_
// cues. На десктопе либа их не компилирует: оставалась бы тонкой (cdylib
// Windows/MinGW не тянет экспорт тяжёлых деревьев — quick-xml, ср. рецепт
// NovaGrid), десктоп-бин собирает модуль сам (main.rs).
#[cfg(any(target_os = "android", target_os = "ios"))]
pub mod subtitles;

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
        .manage(duo_mobile::DuoManaged::default())
        .invoke_handler(tauri::generate_handler![
            duo_mobile::net::duo_yt_player,
            duo_mobile::net::duo_fetch_cues,
            duo_mobile::net::duo_translate_texts,
            mobile_updater::updater_check,
            mobile_updater::updater_download,
            mobile_updater::updater_install,
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить DuoPulse (мобильная ветка)");
}
