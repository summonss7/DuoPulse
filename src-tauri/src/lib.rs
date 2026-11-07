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
// Этап 1 — каркас: тонкий WebView с окном из tauri.android.conf.json и плагин
// dialog (нативные пикеры; этап 2 — выбор файла своих субтитров). Команды
// bridge десктопа (tabs.*/nav.*/subtitles.*...) на мобильных не
// регистрируются — мобильная ветка UI их не зовёт.

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
        .run(tauri::generate_context!())
        .expect("не удалось запустить DuoPulse (мобильная ветка)");
}
