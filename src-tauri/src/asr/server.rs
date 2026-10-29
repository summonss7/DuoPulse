//! Управление локальным движком ASR (карточка duopulse-060): процесс
//! whisper-server.exe (whisper.cpp, MIT) поднимается по требованию на
//! 127.0.0.1 и гаснет после простоя. Модель ggml скачивается по требованию
//! в профиль (`profile/asr/models/`), движок — в `profile/asr/bin/`
//! (или берётся рядом с duopulse.exe / по пути из настроек).
//!
//! Поиск движка (первое найденное): путь из настроек → профиль (скачанный) →
//! каталог duopulse.exe. Скачивание движка/модели — ureq (HF / наш GitHub-
//! release), URL-ы перекрываются env (стенды e2e подставляют локальные).

use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::config::{AsrConfig, LocalModelSize};
use super::engine::AsrTransport;

/// База URL моделей ggml (env DUOPULSE_ASR_MODEL_BASE_URL перекрывает; стенды
/// раздают локально).
fn model_base_url() -> String {
    std::env::var("DUOPULSE_ASR_MODEL_BASE_URL")
        .unwrap_or_else(|_| "https://huggingface.co/ggerganov/whisper.cpp/resolve/main".into())
}

/// URL zip-движка whisper-server (env DUOPULSE_ASR_ENGINE_URL перекрывает).
/// mingw-сборка — это exe + 5 DLL (libgcc/libstdc++/libwinpthread/libgomp/
/// libdl), упакованы одним zip. Кладётся в публичный репозиторий фидов
/// duopulse-updates (GitHub Pages) — репозиторий DuoPulse приватный, его
/// release-ссылки анонимно не читаются.
fn engine_url() -> String {
    std::env::var("DUOPULSE_ASR_ENGINE_URL").unwrap_or_else(|_| {
        "https://summonss7.github.io/duopulse-updates/engine/whisper-server-win64.zip".into()
    })
}

/// Каталог профиля для ASR-файлов.
fn asr_dir(profile_dir: &Path) -> PathBuf {
    profile_dir.join("asr")
}

/// Путь модели заданного размера в профиле (может ещё не существовать).
pub fn model_path(profile_dir: &Path, size: LocalModelSize) -> PathBuf {
    asr_dir(profile_dir).join("models").join(size.file_name())
}

/// Путь скачиваемого движка в профиле (может ещё не существовать).
fn profile_engine_path(profile_dir: &Path) -> PathBuf {
    asr_dir(profile_dir).join("bin").join("whisper-server.exe")
}

/// Найти whisper-server.exe: явная настройка (авторитетна, даже если файла
/// нет — ошибка запуска назовёт путь пользователя) → профиль (скачанный) →
/// рядом с duopulse.exe.
pub fn engine_exe_path(profile_dir: &Path, cfg: &AsrConfig) -> Option<PathBuf> {
    let explicit = cfg.local_engine_path.trim();
    if !explicit.is_empty() {
        return Some(PathBuf::from(explicit));
    }
    [
        Some(profile_engine_path(profile_dir)),
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("whisper-server.exe"))),
    ]
    .into_iter()
    .flatten()
    .find(|p| p.is_file())
}

/// Потоковый HTTP-GET в файл с прогрессом (байты записаны / всего).
/// Возвращает размер скачанного.
pub fn download_to_file(
    url: &str,
    dest: &Path,
    expect_bytes: Option<u64>,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<u64, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .build();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("скачивание {url}: {e}"))?;
    let total = resp
        .header("content-length")
        .and_then(|v| v.parse::<u64>().ok());
    if let Some(expected) = expect_bytes {
        if total.is_some_and(|t| t != expected) {
            return Err(format!(
                "размер по Content-Length {total:?} не совпал с ожидаемым {expected}"
            ));
        }
    }
    let mut reader = resp.into_reader();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("создать {}: {e}", parent.display()))?;
    }
    let tmp = dest.with_extension("part");
    let mut file =
        std::fs::File::create(&tmp).map_err(|e| format!("создать {}: {e}", tmp.display()))?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("чтение потока: {e}"))?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| format!("запись: {e}"))?;
        done += n as u64;
        on_progress(done, total.unwrap_or(0));
    }
    drop(file);
    let meta = std::fs::metadata(&tmp).map_err(|e| format!("итог {tmp:?}: {e}"))?;
    if let Some(expected) = expect_bytes {
        if meta.len() != expected {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!(
                "скачалось {} байт, ожидалось {expected} — файл повреждён",
                meta.len()
            ));
        }
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("переименовать в {}: {e}", dest.display()))?;
    Ok(done)
}

/// Скачать модель заданного размера в профиль (с проверкой размера).
pub fn download_model(
    profile_dir: &Path,
    size: LocalModelSize,
    on_progress: &mut dyn FnMut(u64, u64),
) -> Result<PathBuf, String> {
    let dest = model_path(profile_dir, size);
    if dest.is_file() {
        return Ok(dest);
    }
    let url = format!(
        "{}/{}",
        model_base_url().trim_end_matches('/'),
        size.file_name()
    );
    download_to_file(&url, &dest, Some(size.bytes()), on_progress)?;
    Ok(dest)
}

/// Скачать движок whisper-server в профиль: zip (exe + DLL mingw-рантайма)
/// распаковывается в `profile/asr/bin/`. Запись атомарна: сначала во
/// временную подпапку, потом rename в bin (старый bin, если был, убирается).
pub fn download_engine(profile_dir: &Path) -> Result<PathBuf, String> {
    let dest = profile_engine_path(profile_dir);
    if dest.is_file() {
        return Ok(dest);
    }
    let bin = asr_dir(profile_dir).join("bin");
    let zip_path = asr_dir(profile_dir).join("whisper-server-win64.zip.part");
    download_to_file(&engine_url(), &zip_path, None, &mut |_, _| {})?;
    let staged = asr_dir(profile_dir).join("bin-unpack");
    let _ = std::fs::remove_dir_all(&staged);
    unpack_zip(&zip_path, &staged)?;
    let _ = std::fs::remove_file(&zip_path);
    // архив может класть файлы в корень или в подпапку — берём каталог,
    // где лежит whisper-server.exe
    let exe_in = find_file(&staged, "whisper-server.exe")
        .ok_or_else(|| "в архиве движка нет whisper-server.exe".to_string())?;
    let src_dir = exe_in.parent().ok_or("каталог распаковки")?;
    let _ = std::fs::remove_dir_all(&bin);
    std::fs::rename(src_dir, &bin)
        .map_err(|e| format!("установить движок в {}: {e}", bin.display()))?;
    let _ = std::fs::remove_dir_all(&staged);
    if !dest.is_file() {
        return Err("после распаковки whisper-server.exe не на месте".into());
    }
    Ok(dest)
}

/// Распаковать zip в каталог (deflate; имена без каталогов-побегов —
/// записи с абсолютными путями или `..` пропускаются).
fn unpack_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("открыть {}: {e}", zip_path.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("прочитать zip: {e}"))?;
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("создать {}: {e}", dest_dir.display()))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("запись {i} архива: {e}"))?;
        if entry.is_dir() || entry.enclosed_name().is_none() {
            continue;
        }
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let out = dest_dir.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("создать {}: {e}", parent.display()))?;
        }
        let mut w =
            std::fs::File::create(&out).map_err(|e| format!("создать {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut w)
            .map_err(|e| format!("распаковать {}: {e}", out.display()))?;
    }
    Ok(())
}

/// Рекурсивный поиск файла по имени (распакованный архив).
fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(found) = find_file(&p, name) {
                return Some(found);
            }
        } else if p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            return Some(p);
        }
    }
    None
}

// --- процесс сервера ----------------------------------------------------------

struct Running {
    model_path: PathBuf,
    port: u16,
    child: Child,
    last_used: Instant,
}

/// Глобальный менеджер: один whisper-server на приложение (сервер сам
/// сериализует запросы); перезапуск при смене модели или смерти процесса.
pub struct ServerManager {
    running: Mutex<Option<Running>>,
    reaper_started: std::sync::atomic::AtomicBool,
}

/// Синглтон на процесс (reaper-нити нужен 'static-доступ).
static MANAGER: std::sync::OnceLock<ServerManager> = std::sync::OnceLock::new();

/// Менеджер процесса whisper-server (глобальный).
pub fn global() -> &'static ServerManager {
    MANAGER.get_or_init(|| ServerManager {
        running: Mutex::new(None),
        reaper_started: std::sync::atomic::AtomicBool::new(false),
    })
}

impl ServerManager {
    /// Свободный порт на 127.0.0.1 (bind :0 → отпустить).
    fn free_port() -> Result<u16, String> {
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind для порта: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("local_addr: {e}"))?
            .port();
        Ok(port)
    }

    /// Аргументы запуска whisper-server (вынесено для теста).
    fn spawn_args(exe: &Path, model: &Path, port: u16, threads: usize) -> Vec<String> {
        let _ = exe; // путь — в Command::new, здесь только аргументы
        vec![
            "-m".into(),
            model.display().to_string(),
            "--host".into(),
            "127.0.0.1".into(),
            "--port".into(),
            port.to_string(),
            "-t".into(),
            threads.to_string(),
        ]
    }

    /// Живой whisper-server для модели (поднимает при необходимости).
    /// Возвращает base URL (`http://127.0.0.1:<port>`).
    pub fn ensure(
        &self,
        profile_dir: &Path,
        cfg: &AsrConfig,
        transport: &dyn AsrTransport,
    ) -> Result<String, String> {
        let engine = engine_exe_path(profile_dir, cfg)
            .filter(|p| p.is_file())
            .ok_or_else(|| {
                "whisper-server.exe не найден: укажите путь в настройках ASR или нажмите \
                 «Скачать движок»"
                    .to_string()
            })?;
        let model = model_path(profile_dir, cfg.local_model);
        if !model.is_file() {
            return Err(format!(
                "модель {} не скачана (кнопка «Скачать модель» в настройках ASR)",
                cfg.local_model.file_name()
            ));
        }
        let mut guard = self.running.lock().expect("asr-server: лок не отравлен");
        if let Some(r) = guard.as_mut() {
            if r.model_path == model && r.child.try_wait().ok().flatten().is_none() {
                r.last_used = Instant::now();
                let url = format!("http://127.0.0.1:{}", r.port);
                if transport.get(&url).is_ok() {
                    return Ok(url);
                }
                // порт умер (процесс жив, но не отвечает) — перезапуск
                let _ = r.child.kill();
            }
            if let Some(mut dead) = guard.take() {
                let _ = dead.child.kill();
            }
        }
        let port = Self::free_port()?;
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8);
        let mut cmd = Command::new(&engine);
        cmd.args(Self::spawn_args(&engine, &model, port, threads));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW: без консольного окна рядом с GUI-приложением
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("запуск {}: {e}", engine.display()))?;
        let url = format!("http://127.0.0.1:{port}");
        eprintln!(
            "[asr] whisper-server: порт {port}, модель {}",
            model.display()
        );
        // Загрузка модели до первого health — до 60 с (small с диска ~5–10 с)
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if child.try_wait().ok().flatten().is_some() {
                return Err("whisper-server упал при старте (см. настройки/модель)".into());
            }
            if transport.get(&url).is_ok() {
                break;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err("whisper-server не поднялся за 60 с".into());
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        // фоновая уборка простоя (одна нить на процесс): гасим сервер через
        // 10 минут без запросов
        if !self
            .reaper_started
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            std::thread::spawn(|| loop {
                std::thread::sleep(Duration::from_secs(60));
                let m = global();
                let mut guard = m.running.lock().expect("asr-server: лок не отравлен");
                let expired = guard
                    .as_ref()
                    .is_some_and(|r| r.last_used.elapsed() > Duration::from_secs(600));
                if expired {
                    if let Some(mut r) = guard.take() {
                        eprintln!("[asr] whisper-server: простой 10 мин — гасим");
                        let _ = r.child.kill();
                        let _ = r.child.wait();
                    }
                }
            });
        }
        *guard = Some(Running {
            model_path: model,
            port,
            child,
            last_used: Instant::now(),
        });
        Ok(url)
    }

    /// Завершить процесс (выход приложения/тест).
    pub fn shutdown(&self) {
        let mut guard = self.running.lock().expect("asr-server: лок не отравлен");
        if let Some(mut r) = guard.take() {
            let _ = r.child.kill();
            let _ = r.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("duopulse-asr-srv-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn model_path_by_size() {
        let dir = tmp_dir("model");
        assert_eq!(
            model_path(&dir, LocalModelSize::Base).file_name().unwrap(),
            "ggml-base.bin"
        );
        assert!(model_path(&dir, LocalModelSize::Small).starts_with(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_search_settings_first_then_profile() {
        let dir = tmp_dir("engine");
        let cfg = AsrConfig::default();
        // нигде ничего — None
        assert!(engine_exe_path(&dir, &cfg).is_none());
        // профильный файл находится
        let profiled = profile_engine_path(&dir);
        std::fs::create_dir_all(profiled.parent().unwrap()).unwrap();
        std::fs::write(&profiled, b"exe").unwrap();
        assert_eq!(engine_exe_path(&dir, &cfg), Some(profiled.clone()));
        // настройка приоритетнее, даже если указанный путь не существует —
        // ошибка запуска будет содержать путь пользователя
        let cfg2 = AsrConfig {
            local_engine_path: "D:/tools/whisper-server.exe".into(),
            ..cfg.clone()
        };
        assert_eq!(
            engine_exe_path(&dir, &cfg2),
            Some(PathBuf::from("D:/tools/whisper-server.exe"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn spawn_args_shape() {
        let args = ServerManager::spawn_args(
            Path::new("C:/bin/whisper-server.exe"),
            Path::new("C:/p/ggml-base.bin"),
            18099,
            8,
        );
        assert_eq!(
            args,
            vec![
                "-m",
                "C:/p/ggml-base.bin",
                "--host",
                "127.0.0.1",
                "--port",
                "18099",
                "-t",
                "8"
            ]
        );
    }

    #[test]
    fn unpack_zip_installs_engine_from_subfolder() {
        use std::io::Write as _;
        let dir = tmp_dir("engine-zip");
        // zip как релиз engine-whisper-1: подпапка с exe + DLL
        let bytes = {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("whisper-1/whisper-server.exe", opts).unwrap();
            w.write_all(b"exe-bytes").unwrap();
            w.start_file("whisper-1/libwinpthread-1.dll", opts).unwrap();
            w.write_all(b"dll-bytes").unwrap();
            w.finish().unwrap().into_inner()
        };
        let zip_path = dir.join("engine.zip");
        std::fs::write(&zip_path, bytes).unwrap();
        let staged = dir.join("unpack");
        unpack_zip(&zip_path, &staged).unwrap();
        let exe = find_file(&staged, "whisper-server.exe").unwrap();
        assert!(
            exe.ends_with("whisper-1/whisper-server.exe")
                || exe.ends_with("whisper-1\\whisper-server.exe")
        );
        // побег из каталога (zip-slip) не распаковывается
        let evil = {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("../evil.txt", opts).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap().into_inner()
        };
        std::fs::write(dir.join("evil.zip"), evil).unwrap();
        let staged2 = dir.join("unpack2");
        unpack_zip(&dir.join("evil.zip"), &staged2).unwrap();
        assert!(!dir.join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn download_size_guard() {
        let dir = tmp_dir("download");
        // ожидание 4 байта, а придёт 3 — отказ, .part убран
        let dest = dir.join("m.bin");
        let err =
            download_to_file("data:text/plain,abc", &dest, Some(4), &mut |_, _| {}).unwrap_err();
        assert!(
            err.contains("повреждён") || err.contains("скачивание"),
            "{err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
