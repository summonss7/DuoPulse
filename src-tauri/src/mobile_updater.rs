// OTA мобильной DuoPulse из центра Aila (этап 3 карточки duopulse-083,
// зонтичная aila-370; концепция — D:\Scheduler\UPDATES-SYSTEM.md §§3–5;
// эталон — NovaGrid novagrid-063): манифест v2 того же канала
// /updates/duopulse, ассет для установки — APK. Цикл: тихая проверка при
// старте (калитка 10 минут во фронтенде, образец lecards-027) → баннер
// «⬆ Доступна версия X» → скачивание в cacheDir со сверкой sha256 (событие
// прогресса «duopulse:mobile-updater-progress») → системная установка:
// Android-логику (appop REQUEST_INSTALL_PACKAGES, настройки
// MANAGE_UNKNOWN_APP_SOURCES, FileProvider шаблона gen/android + Intent
// ACTION_VIEW «application/vnd.android.package-archive») ведёт Kotlin-хелпер
// MobileUpdateHelper.kt, Rust вызывает один статический метод — прямой
// JNI-путь установки ронял поток на NovaGrid (NoSuchMethodError
// Application.getPackageManager, зонд эмулятора novagrid-063). Недоступный
// центр деградирует молча — «не удалось проверить» не ошибка (§5).
//
// Отличие от NovaGrid: сеть — ureq, а не reqwest (duopulse-082 уже ходит им
// в мобильную ветке с rustls и вшитыми webpki-roots — грабля NovaGrid с
// rustls-platform-verifier на Android сюда не переносится, отдельный
// TLS-клиент не нужен). ureq синхронный: команды-функции (как duo_*),
// скачивание читает into_reader() потоками и троттлит события на ~256 КиБ.
//
// Живой телефон (duopulse-101): мобильные сети рвут TCP без FIN/RST — read()
// висел вечно («скачано 6 из 8 МБ» и баннер замер), поэтому у агента стоит
// таймаут чтения, а скачивание — до 5 попыток с докачкой Range (CDN канала
// отдаёт Accept-Ranges: bytes): обрыв на середине не начинает 8 МБ с нуля.
// Целый скачанный файл (sha256 совпал) переиспользуется — повторное
// «Обновить» после разрешения источника не качает заново.
//
// Десктоп-обновления не трогаем: бин main.rs ездит на tauri-plugin-updater
// (latest.json, minisign) и манифест v2 не читает — ветки не пересекаются.
//
// Модуль компилируется всеми таргетами (структуры/выбор ассета/тесты —
// хостовые), JNI-часть — только Android.

use serde::{Deserialize, Serialize};

#[cfg(target_os = "android")]
use sha2::{Digest, Sha256};
#[cfg(target_os = "android")]
use std::io::{Read, Write};
#[cfg(target_os = "android")]
use std::path::PathBuf;
#[cfg(target_os = "android")]
use tauri::{AppHandle, Emitter};

/// Тот же канал и то же окружение-переопределение, что у десктопного
/// updater.rs (DUOPULSE_UPDATE_BASE — база канала; живая проверка подменяет
/// манифест, форма адреса — /manifest.json).
#[cfg(target_os = "android")]
fn manifest_url() -> String {
    let base = std::env::var("DUOPULSE_UPDATE_BASE")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty() && !v.contains(' '))
        .unwrap_or_else(|| "https://aila.skillcoin.pp.ua/updates/duopulse".into());
    format!("{base}/manifest.json")
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version_name: String,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<UpdateAsset>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// "latest" | "available" | "network-error" | "bad-manifest"
    pub status: String,
    pub current: String,
    pub latest: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    /// APK-ассет канала; есть только при доступном обновлении
    pub asset: Option<UpdateAsset>,
    pub error: Option<String>,
}

/// Числовое сравнение x.y[.z…] — как у десктопного updater (суффиксы
/// обрезаются, недостающий хвост — 0).
pub(crate) fn version_lt(a: &str, b: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| {
                let digits: String = p.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse().unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

/// APK для установки: из assets канала (windows-файлы и фиды той же версии
/// пропускаем). Эмуляторные x86-сборки не предлагаем — только arm64 или
/// универсальное имя без abi в названии (канал публикует универсальный APK:
/// он же работает и на эмуляторе живой проверки).
pub(crate) fn pick_apk(assets: &[UpdateAsset]) -> Option<&UpdateAsset> {
    assets
        .iter()
        .filter(|a| a.name.to_ascii_lowercase().ends_with(".apk"))
        .filter(|a| {
            let n = a.name.to_ascii_lowercase();
            !(n.contains("x86") || n.contains("armeabi-v7a"))
        })
        .max_by_key(|a| {
            // предпочитаем явный arm64 над именем без abi
            let n = a.name.to_ascii_lowercase();
            if n.contains("arm64") || n.contains("aarch64") {
                1
            } else {
                0
            }
        })
}

// ── Android: сеть, скачивание, установка ───────────────────────────────────

/// Таймаут одного read(): зависший без FIN/RST сокет (мобильная сеть, VPN)
/// ошибкается, а не висит вечно. 30 с без единого байта — соединение мертво.
#[cfg(target_os = "android")]
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Сколько попыток скачать с докачкой: обрывы на живом телефоне бывают
/// серией (duopulse-101 — 6/8 и 1/8 МБ), каждая следующая продолжает с места.
#[cfg(target_os = "android")]
const MAX_ATTEMPTS: u32 = 5;

/// Агент OTA: таймауты соединения и чтения — общий timeout() агента duobrain
/// (20 с) разорвал бы длинное скачивание, поток читает команда.
#[cfg(target_os = "android")]
fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(READ_TIMEOUT)
        .build()
}

#[cfg(target_os = "android")]
/// Проверить канал и сравнить версии. Err не возвращает — недоступный
/// центр это статус, а не поломка (тихая деградация, UPDATES-SYSTEM §5).
#[tauri::command]
pub fn updater_check() -> UpdateCheck {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let mut r = UpdateCheck {
        status: "network-error".into(),
        current: current.clone(),
        latest: None,
        notes: None,
        published_at: None,
        asset: None,
        error: None,
    };
    let resp = match agent()
        .get(&manifest_url())
        .set("User-Agent", crate::duo_mobile::USER_AGENT)
        .call()
    {
        Ok(resp) => resp,
        Err(ureq::Error::Status(code, resp)) => {
            let _ = resp.into_reader();
            r.error = Some(format!("HTTP {code}"));
            return r;
        }
        Err(e) => {
            r.error = Some(e.to_string());
            return r;
        }
    };
    if resp.status() != 200 {
        r.error = Some(format!("HTTP {}", resp.status()));
        return r;
    }
    let body = match resp.into_string() {
        Ok(b) => b,
        Err(e) => {
            r.error = Some(format!("чтение манифеста: {e}"));
            return r;
        }
    };
    let m: Manifest = match serde_json::from_str(&body) {
        Ok(m) => m,
        Err(e) => {
            r.status = "bad-manifest".into();
            r.error = Some(e.to_string());
            return r;
        }
    };
    r.latest = Some(m.version_name.clone());
    r.notes = m.notes;
    r.published_at = m.published_at;
    if version_lt(current.as_str(), m.version_name.as_str()) {
        r.status = "available".into();
        r.asset = pick_apk(&m.assets).cloned();
        // канала без APK мобильному нечего ставить — показываем как «последняя»,
        // иначе баннер повиснет с кнопкой, которой нечего скачивать
        if r.asset.is_none() {
            r.status = "latest".into();
        }
    } else {
        r.status = "latest".into();
    }
    r
}

#[cfg(target_os = "android")]
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

/// Каталог скачивания: cacheDir/updates — FileProvider шаблона шарит
/// cache-path (file_paths.xml), подкаталог ограничивает раздачу одним APK
/// обновления.
#[cfg(target_os = "android")]
fn updates_dir() -> Result<PathBuf, String> {
    let base = android_cache_dir()?;
    let dir = base.join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cache: {e}"))?;
    Ok(dir)
}

#[cfg(any(target_os = "android", test))]
/// Как поступить с ответом на запрос с Range: 206 — сервер докачивает с
/// запрошенного байта, остальное (200 — Range проигнорирован, 416 — диапазон
/// невалиден) — качать с нуля.
pub(crate) enum ResumeAction {
    Append,
    Restart,
}

#[cfg(any(target_os = "android", test))]
pub(crate) fn resume_action(status: u16, asked_range: bool) -> ResumeAction {
    if status == 206 && asked_range {
        ResumeAction::Append
    } else {
        ResumeAction::Restart
    }
}

#[cfg(target_os = "android")]
/// Файл уже лежит целый (sha256 совпал)? Таким переиспользуем скачанное:
/// повторное «Обновить» после разрешения источника или сбой установки
/// не требуют новых 8 МБ.
fn file_matches(dest: &std::path::Path, sha256: &str) -> bool {
    let Ok(mut f) = std::fs::File::open(dest) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(sha256)
}

#[cfg(target_os = "android")]
#[tauri::command]
/// Скачать APK в cacheDir с событиями «duopulse:mobile-updater-progress» и
/// сверкой sha256 из манифеста. Обрывы не фатальны: до MAX_ATTEMPTS попыток
/// с докачкой Range (206 → append, 200/416 → с нуля), таймаут чтения
/// READ_TIMEOUT оживляет зависшие сокеты. Исчерпаны попытки или ошибка
/// диска — недокачанное удаляется, полу-файлы не выживают. Хост манифеста
/// уже проверен при updater_check, здесь дополнительно сверяем схему https
/// (URL приходит от фронтенда).
pub fn updater_download(
    app: AppHandle,
    url: String,
    sha256: String,
    size: u64,
) -> Result<String, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("некорректный URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("только https, получено {}", parsed.scheme()));
    }
    let name = url.rsplit('/').next().unwrap_or("duopulse-update.apk");
    let dest = updates_dir()?.join(name);
    if file_matches(&dest, &sha256) {
        return Ok(dest.to_string_lossy().into_owned());
    }
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut total = size;
    let mut last_emit: u64 = u64::MAX;
    let mut last_err = String::new();
    let emit = |downloaded: u64, total: u64, last_emit: &mut u64| {
        let _ = app.emit(
            "duopulse:mobile-updater-progress",
            DownloadProgress { downloaded, total },
        );
        *last_emit = downloaded;
    };
    'attempts: for attempt in 1..=MAX_ATTEMPTS {
        let mut request = agent().get(&url).set("User-Agent", crate::duo_mobile::USER_AGENT);
        if downloaded > 0 {
            request = request.set("Range", format!("bytes={downloaded}-").as_str());
        }
        let resp = match request.call() {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("сеть: {e}");
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue 'attempts;
            }
        };
        let status = resp.status();
        let content_len = resp
            .header("Content-Length")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let mut file = match resume_action(status, downloaded > 0) {
            ResumeAction::Append => {
                // докачка: Content-Length — остаток, файл открываем на дописывание
                total = total.max(downloaded + content_len);
                std::fs::OpenOptions::new()
                    .append(true)
                    .open(&dest)
                    .map_err(|e| format!("temp: {e}"))?
            }
            ResumeAction::Restart => {
                if status != 200 {
                    // 416 (диапазон невалиден) и прочие статусы — попробуем
                    // с нуля на следующей попытке; за CDN бывают transient 5xx
                    last_err = format!("HTTP {status}");
                    downloaded = 0;
                    hasher = Sha256::new();
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue 'attempts;
                }
                total = total.max(content_len);
                downloaded = 0;
                hasher = Sha256::new();
                std::fs::File::create(&dest).map_err(|e| format!("temp: {e}"))?
            }
        };
        let mut reader = resp.into_reader();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                // обрыв/таймаут чтения: часть остаётся на диске и в хеше,
                // следующая попытка докачает с этого байта
                Err(e) => {
                    last_err = format!("download: {e}");
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue 'attempts;
                }
            };
            hasher.update(&buf[..n]);
            if let Err(e) = file.write_all(&buf[..n]) {
                // ошибка диска ретраями не лечится
                let _ = std::fs::remove_file(&dest);
                return Err(format!("write: {e}"));
            }
            downloaded += n as u64;
            // троттлинг: событие на ~256 КиБ (и в конце)
            if last_emit == u64::MAX || downloaded.saturating_sub(last_emit) >= 256 * 1024 {
                emit(downloaded, total, &mut last_emit);
            }
        }
        drop(file);
        emit(downloaded, total, &mut last_emit);
        let got = format!("{:x}", hasher.finalize());
        if got.eq_ignore_ascii_case(&sha256) {
            return Ok(dest.to_string_lossy().into_owned());
        }
        // EOF, но хеш не тот — поток оборван «аккуратно»; качаем с нуля
        last_err = format!("sha256 mismatch: expected {sha256}, got {got}");
        downloaded = 0;
        hasher = Sha256::new();
    }
    let _ = std::fs::remove_file(&dest);
    Err(format!("скачивание не удалось за {MAX_ATTEMPTS} попыток: {last_err}"))
}

#[cfg(target_os = "android")]
/// Системная установка скачанного APK. Возвращает "started" (открыт
/// установщик) или "needs-permission" (открыты настройки — пользователь
/// разрешает источник и жмёт «Обновить» снова). Отказы хелпера
/// ("file-gone"/"error: …") прокидываются как Err.
#[tauri::command]
pub fn updater_install(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("downloaded file is gone: {path}"));
    }
    match install_apk(&src)? {
        s if s == "file-gone" || s.starts_with("error:") => Err(s),
        s => Ok(s),
    }
}

// ── JNI: установка через системный установщик Android ────────────────────

#[cfg(target_os = "android")]
mod jni_install {
    // JNI-примитивы (with_jni/jstr/call_obj/app_class) — общие в
    // crate::mobile_jni (выделены в duopulse-085), здесь только логика
    // установки APK.
    use crate::mobile_jni::{app_class, call_obj, call_string, jstr, with_jni};
    use jni::objects::JString;
    use std::path::Path;

    /// cacheDir приложения (getCacheDir контекста).
    pub fn cache_dir() -> Result<std::path::PathBuf, String> {
        with_jni(|env, context| {
            let dir = call_obj(env, context, "getCacheDir", "()Ljava/io/File;")?;
            let s = call_string(env, &dir, "getAbsolutePath", "()Ljava/lang/String;")?;
            Ok(Path::new(&s).to_path_buf())
        })
    }

    /// Установка — через Kotlin-хелпер gen/android (MobileUpdateHelper.install):
    /// проверку appop, настройки источника, FileProvider и Intent ведёт Kotlin,
    /// из Rust один статический вызов (меньше JNI-поверхности; прямой JNI-путь
    /// падал на GetMethodID «Application.getPackageManager» — NoSuchMethodError,
    /// живой зонд эмулятора novagrid-063). Возврат хелпера — как у команды
    /// updater_install: 'started' | 'needs-permission' | 'file-gone' | 'error: …'.
    pub fn install(apk: &Path) -> Result<String, String> {
        let path = apk.to_string_lossy().into_owned();
        with_jni(|env, context| {
            let helper = app_class(env, context, "dev.duopulse.mobile.MobileUpdateHelper")?;
            let jpath = jstr(env, &path)?;
            let r = env
                .call_static_method(
                    &helper,
                    "install",
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[context.into(), (&jpath).into()],
                )
                .map_err(|e| format!("helper: {e}"))?
                .l()
                .map_err(|e| format!("helper: {e}"))?;
            let js = JString::from(r);
            env.get_string(&js)
                .map(|s| s.to_string_lossy().into_owned())
                .map_err(|e| format!("helper str: {e}"))
        })
    }
}

#[cfg(target_os = "android")]
use jni_install as jni_impl;

#[cfg(target_os = "android")]
fn android_cache_dir() -> Result<PathBuf, String> {
    jni_impl::cache_dir()
}

#[cfg(target_os = "android")]
fn install_apk(apk: &std::path::Path) -> Result<String, String> {
    jni_impl::install(apk)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> UpdateAsset {
        UpdateAsset {
            name: name.into(),
            url: format!("https://example.invalid/{name}"),
            size: None,
            sha256: None,
        }
    }

    #[test]
    fn version_compare() {
        assert!(version_lt("0.1.7", "0.1.8"));
        assert!(version_lt("1.9", "1.10.0")); // числа, не строки
        assert!(!version_lt("1.30.0", "1.30.0"));
        assert!(!version_lt("1.31.0-beta", "1.31.0")); // суффикс обрезается
    }

    #[test]
    fn picks_apk_ignores_windows_and_x86() {
        let assets = vec![
            asset("DuoPulse_0.1.8_x64-setup.exe"),
            asset("DuoPulse_0.1.8_x64-setup.exe.sig"),
            asset("latest.json"),
            asset("latest-canary.json"),
            asset("DuoPulse-0.1.8-x86_64-release.apk"),
            asset("DuoPulse-0.1.8-arm64-v8a-release.apk"),
        ];
        let picked = pick_apk(&assets).expect("arm64 apk must be picked");
        assert_eq!(picked.name, "DuoPulse-0.1.8-arm64-v8a-release.apk");
    }

    #[test]
    fn picks_universal_apk_when_no_abi_named() {
        let assets = vec![
            asset("DuoPulse_0.1.8_x64-setup.exe"),
            asset("DuoPulse-0.1.8-android-release.apk"),
        ];
        let picked = pick_apk(&assets).expect("universal apk must be picked");
        assert_eq!(picked.name, "DuoPulse-0.1.8-android-release.apk");
    }

    #[test]
    fn no_apk_means_no_asset() {
        let assets = vec![asset("DuoPulse_0.1.8_x64-setup.exe"), asset("latest.json")];
        assert!(pick_apk(&assets).is_none());
    }

    #[test]
    fn resume_action_decisions() {
        // 206 на запрос с Range — докачиваем
        assert!(matches!(resume_action(206, true), ResumeAction::Append));
        // 200 — Range проигнорирован (нет докачки), качаем с нуля
        assert!(matches!(resume_action(200, true), ResumeAction::Restart));
        // без Range любой ответ — с нуля
        assert!(matches!(resume_action(200, false), ResumeAction::Restart));
        assert!(matches!(resume_action(206, false), ResumeAction::Restart));
        // 416 — сервер счёл диапазон невалидным, качаем с нуля
        assert!(matches!(resume_action(416, true), ResumeAction::Restart));
    }
}
