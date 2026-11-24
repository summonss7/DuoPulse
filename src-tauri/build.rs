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
    neutral_default_manifest();
    tauri_build::build()
}

/// Дефолтный манифест CRT — тот же текст, что несёт `default-manifest.o`
/// тулчейна winlibs, но с нейтральным языком ресурса.
const DEFAULT_MANIFEST_RC: &str = r#"/* Type: 24
   Name: 1. */
LANGUAGE 0, 0

1 24 /* RT_MANIFEST */
BEGIN
  "<?xml version=""1.0"" encoding=""UTF-8"" standalone=""yes""?>\n"
  "<assembly xmlns=""urn:schemas-microsoft-com:asm.v1"" manifestVersion=""1.0"" xmlns:asmv3=""urn:schemas-microsoft-com:asm.v3"" >\n"
  " <asmv3:application>\n"
  "  <asmv3:windowsSettings xmlns=""http://schemas.microsoft.com/SMI/2016/WindowsSettings"">\n"
  "   <longPathAware>true</longPathAware>\n"
  "  </asmv3:windowsSettings>\n"
  " </asmv3:application>\n"
  " <trustInfo xmlns=""urn:schemas-microsoft-com:asm.v2"">\n"
  "  <security>\n"
  "   <requestedPrivileges>\n"
  "    <requestedExecutionLevel level=""asInvoker"" uiAccess=""false""/>\n"
  "   </requestedPrivileges>\n"
  "  </security>\n"
  " </trustInfo>\n"
  "</assembly>\n"
END
"#;

/// Убрать линкер-шум «.rsrc merge failure: multiple non-default manifests» в
/// каждой сборке windows-gnu (карточка duopulse-231). Причина: драйвер gcc
/// winlibs дописывает к линковке каждого exe свой `default-manifest.o`
/// (дефолтный манифест CRT). binutils отбрасывает его рядом с манифестом
/// приложения (tauri-build, Common-Controls v6), только если язык ресурса
/// нейтральный — а в этом тулчейне он собран с `LANGUAGE 9,1`. Получаются два
/// «не-дефолтных» манифеста с ID 1, ld ругается в stderr, rustc показывает
/// это warning'ом `linker_messages`.
///
/// Лечение — тот же манифест с `LANGUAGE 0,0`: свой default-manifest.o
/// собирается в OUT_DIR и подаётся драйверу каталогом через `-B` (endfile-
/// объекты ищутся по префиксам; `-L` их не затеняет). Системный тулчейн не
/// трогаем. Нет windres или объект не собрался — просто без лечения: шум
/// вернётся, сборка не ломается.
fn neutral_default_manifest() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.ends_with("windows-gnu") {
        return;
    }
    // Формат объекта: MinGW-w64 x86_64-тулчейн умеет собрать только эти два
    // (pe-aarch64-little его windres не поддерживает — там уходим без лечения).
    let format = match target.split('-').next() {
        Some("x86_64") => "pe-x86-64",
        Some("i686" | "i586" | "i386") => "pe-i386",
        _ => return,
    };
    let Some(out_dir) = std::env::var_os("OUT_DIR") else {
        return;
    };
    let dir = std::path::Path::new(&out_dir).join("manifest");
    let (rc, obj) = (
        dir.join("default-manifest.rc"),
        dir.join("default-manifest.o"),
    );
    if std::fs::create_dir_all(&dir).is_err() || std::fs::write(&rc, DEFAULT_MANIFEST_RC).is_err() {
        return;
    }
    // Выбор windres — как у embed-resource (ресурсы tauri-winres):
    // переопределение RC_<target> / RC_<target с подчёркиваниями> / RC,
    // иначе <target>-windres, затем windres из PATH.
    let mut candidates: Vec<String> = [
        format!("RC_{target}"),
        format!("RC_{}", target.replace('-', "_")),
        "RC".to_string(),
    ]
    .into_iter()
    .filter_map(|key| std::env::var(&key).ok())
    .filter(|value| !value.is_empty())
    .collect();
    candidates.push(format!("{target}-windres"));
    candidates.push("windres".to_string());
    let compiled = candidates.into_iter().any(|windres| {
        std::process::Command::new(windres)
            .arg("-i")
            .arg(&rc)
            .arg("-o")
            .arg(&obj)
            .arg("-O")
            .arg("coff")
            .arg("-F")
            .arg(format)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    });
    if compiled {
        let dir = dir.display().to_string().replace('\\', "/");
        println!("cargo:rustc-link-arg-bins=-B{}/", dir.trim_end_matches('/'));
    }
}
