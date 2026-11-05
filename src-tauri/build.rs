fn main() {
    // Момент сборки (карточка duopulse-074: «версия + дата сборки» в шапке
    // браузера): unix-секунды через rustc-env — фронтенд форматирует локальной
    // датой (bridge-команда app.build_info). Смена значения пересобирает
    // зависящие ящики; триггеры перезапуска скрипта — сам скрипт и файлы,
    // которые меняет каждый релиз (версия), чтобы релизная дата не протухала.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("cargo:rustc-env=DUOPULSE_BUILD_UNIX={ts}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
