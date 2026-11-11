//! Инструменты загрузки (карточка duopulse-118): yt-dlp + ffmpeg докачиваются
//! по требованию в профиль — тот же паттерн, что движок ASR (asr/server.rs:
//! streaming GET → .part → атомарное переименование, прогресс колбэком).
//!
//! yt-dlp (Unlicense) тянет видео/аудио с YouTube и ещё ~1800 сайтов и умеет
//! вырезать диапазон (--download-sections); ffmpeg (GPL, как и сам DuoPulse)
//! нужен yt-dlp для склейки видео+аудио дорожек, извлечения mp3 и резки по
//! диапазону. Оба — официальные «latest»-ассеты GitHub-релизов; точный адрес
//! переопределяется переменными окружения (паттерн DUOPULSE_ASR_*).

use std::io::Read;
use std::path::{Path, PathBuf};

/// Ассет yt-dlp.exe (latest-стабильный релиз). Переопределение —
/// DUOPULSE_DL_YTDLP_URL.
pub const YTDLP_URL: &str =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
/// Сборка ffmpeg от проекта yt-dlp (latest-win64-gpl, ~95 МБ zip). Переопреде-
/// ление — DUOPULSE_DL_FFMPEG_URL.
pub const FFMPEG_URL: &str =
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";
/// JS-runtime для экстрактора YouTube (карточка duopulse-118): yt-dlp с 2025
/// требует внешний движок JS (EJS) для расшифровки подписей — без него YouTube
/// отдаёт 403 на форматы. Поддержанный из коробки — deno (~40 МБ). Переопреде-
/// ление — DUOPULSE_DL_DENO_URL.
pub const DENO_URL: &str =
    "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 DuoPulse";

/// Каталог инструментов: profile/dl/bin.
pub fn bin_dir(profile: &Path) -> PathBuf {
    profile.join("dl").join("bin")
}

pub fn ytdlp_path(profile: &Path) -> PathBuf {
    bin_dir(profile).join("yt-dlp.exe")
}

pub fn ffmpeg_ready(profile: &Path) -> bool {
    bin_dir(profile).join("ffmpeg.exe").is_file()
}

pub fn ytdlp_ready(profile: &Path) -> bool {
    ytdlp_path(profile).is_file()
}

pub fn deno_ready(profile: &Path) -> bool {
    bin_dir(profile).join("deno.exe").is_file()
}

/// Скачать файл потоком с прогрессом (done/total байт) в path.part → rename.
/// Канон asr/server.rs::download_to_file, но без проверки точного размера
/// («latest»-ассеты меняются от релиза к релизу).
fn download_to_file(
    url: &str,
    dest: &Path,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(30))
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", UA)
        .call()
        .map_err(|e| format!("запрос {url}: {e}"))?;
    let total = resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok());
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("создать {}: {e}", parent.display()))?;
    }
    let part = dest.with_extension("part");
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(&part).map_err(|e| format!("создать {}: {e}", part.display()))?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("чтение {url}: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n])
            .map_err(|e| format!("запись {}: {e}", part.display()))?;
        done += n as u64;
        on_progress(done, total.unwrap_or(0));
    }
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| format!("переименовать в {}: {e}", dest.display()))?;
    Ok(())
}

/// Докачать yt-dlp.exe, если его нет. Прогресс — байтами (total=0 — неизвестен).
pub fn ensure_ytdlp(
    profile: &Path,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, String> {
    let path = ytdlp_path(profile);
    if path.is_file() {
        return Ok(path);
    }
    let url = std::env::var("DUOPULSE_DL_YTDLP_URL").unwrap_or_else(|_| YTDLP_URL.into());
    download_to_file(&url, &path, on_progress)?;
    Ok(path)
}

/// Докачать deno.exe (JS-runtime экстрактора YouTube), если его нет: в архиве
/// один deno.exe в корне.
pub fn ensure_deno(profile: &Path, on_progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    if deno_ready(profile) {
        return Ok(());
    }
    let dir = bin_dir(profile);
    std::fs::create_dir_all(&dir).map_err(|e| format!("создать {}: {e}", dir.display()))?;
    let url = std::env::var("DUOPULSE_DL_DENO_URL").unwrap_or_else(|_| DENO_URL.into());
    let zip_path = dir.join("deno-download.zip.part");
    download_to_file(&url, &zip_path, on_progress)?;
    let unpack = || -> Result<(), String> {
        let file = std::fs::File::open(&zip_path).map_err(|e| format!("открыть zip: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| format!("запись zip #{i}: {e}"))?;
            if entry.name().replace('\\', "/") != "deno.exe" {
                continue;
            }
            let dest = dir.join("deno.exe.part2");
            let mut out = std::fs::File::create(&dest).map_err(|e| format!("создать deno.exe: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("распаковать deno.exe: {e}"))?;
            drop(out);
            let final_path = dir.join("deno.exe");
            let _ = std::fs::remove_file(&final_path);
            std::fs::rename(&dest, &final_path)
                .map_err(|e| format!("переименовать deno.exe: {e}"))?;
        }
        Ok(())
    };
    let res = unpack();
    let _ = std::fs::remove_file(&zip_path);
    res?;
    if !deno_ready(profile) {
        return Err("в архиве нет deno.exe".into());
    }
    Ok(())
}

/// Докачать ffmpeg.exe/ffprobe.exe из zip-сборки, если их нет. Из архива
/// достаём только два бинарника (лежат в bin/ корня архива; путь в записи не
/// важен — сверяем по имени файла, zip-slip исключён: имена плоские).
pub fn ensure_ffmpeg(profile: &Path, on_progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    if ffmpeg_ready(profile) {
        return Ok(());
    }
    let dir = bin_dir(profile);
    std::fs::create_dir_all(&dir).map_err(|e| format!("создать {}: {e}", dir.display()))?;
    let url = std::env::var("DUOPULSE_DL_FFMPEG_URL").unwrap_or_else(|_| FFMPEG_URL.into());
    let zip_path = dir.join("ffmpeg-download.zip.part");
    download_to_file(&url, &zip_path, on_progress)?;
    let unpack = || -> Result<(), String> {
        let file = std::fs::File::open(&zip_path).map_err(|e| format!("открыть zip: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("zip: {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip
                .by_index(i)
                .map_err(|e| format!("запись zip #{i}: {e}"))?;
            let name = entry.name().replace('\\', "/");
            let base = name.rsplit('/').next().unwrap_or("");
            if base != "ffmpeg.exe" && base != "ffprobe.exe" {
                continue;
            }
            let dest = dir.join(base).with_extension("part2");
            let mut out =
                std::fs::File::create(&dest).map_err(|e| format!("создать {base}: {e}"))?;
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("распаковать {base}: {e}"))?;
            drop(out);
            let final_path = dir.join(base);
            // занятый процессом файл (повторная докачка) не роняет распаковку
            let _ = std::fs::remove_file(&final_path);
            std::fs::rename(&dest, &final_path)
                .map_err(|e| format!("переименовать {base}: {e}"))?;
        }
        Ok(())
    };
    let res = unpack();
    let _ = std::fs::remove_file(&zip_path);
    res?;
    if !ffmpeg_ready(profile) {
        return Err("в архиве нет ffmpeg.exe".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_and_paths() {
        assert!(YTDLP_URL.starts_with("https://"));
        assert!(FFMPEG_URL.starts_with("https://"));
        let profile = Path::new("P");
        assert_eq!(ytdlp_path(profile), Path::new("P/dl/bin/yt-dlp.exe"));
        assert_eq!(bin_dir(profile).join("ffmpeg.exe"), Path::new("P/dl/bin/ffmpeg.exe"));
        assert!(!ytdlp_ready(profile));
        assert!(!ffmpeg_ready(profile));
    }

    #[test]
    fn ensure_ytdlp_skips_existing() {
        let dir = std::env::temp_dir().join(format!("duopulse-dl-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("dl/bin")).unwrap();
        std::fs::write(dir.join("dl/bin/yt-dlp.exe"), b"stub").unwrap();
        let mut calls = 0;
        let path = ensure_ytdlp(&dir, &mut |_, _| {
            calls += 1;
        })
        .unwrap();
        assert_eq!(path, dir.join("dl/bin/yt-dlp.exe"));
        assert_eq!(calls, 0, "готовый инструмент не качается");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
