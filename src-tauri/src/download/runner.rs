//! Сборка аргументов yt-dlp и разбор его stdout (карточка duopulse-118).
//! Чистые функции — покрываются юнит-тестами без сети и процессов.

/// Что скачиваем.
#[derive(Debug, Clone, PartialEq)]
pub enum MediaMode {
    /// Видео (при наличии ffmpeg — лучшее с склейкой дорожек, иначе прогрессив).
    Video,
    /// Только звук (m4a без перекодировки либо mp3 через ffmpeg).
    Audio,
}

/// Параметры одного запуска yt-dlp.
#[derive(Debug, Clone)]
pub struct RunSpec {
    pub url: String,
    pub mode: MediaMode,
    /// Максимум высоты: "best" | "1080" | "720" | "480" | "360" (для аудива — "").
    pub quality: String,
    /// mp3 требует ffmpeg; m4a — прямая дорожка без перекодировки.
    pub audio_mp3: bool,
    /// Диапазон сек (start, end) — «вырезать кусок» (--download-sections,
    /// нужен ffmpeg; рез идёт по ближайшему ключевому кадру до начала).
    pub range: Option<(f64, f64)>,
    /// Каталог назначения (существует).
    pub out_dir: String,
    /// Каталог ffmpeg для --ffmpeg-location (None — ffmpeg нет).
    pub ffmpeg_dir: Option<String>,
    /// SOCKS5-прокси приложения (роутер VPN/прокси активен).
    pub proxy: Option<String>,
    /// cookies.txt (Netscape) из профиля WebView2 — сессия YouTube приложения
    /// (без неё на «подмоченных» IP бот-чек; None — кук нет).
    pub cookies: Option<String>,
    /// Суффикс имени файла (метка диапазона, например "(1m12s-2m)").
    pub name_suffix: Option<String>,
}

/// Формат диапазона для --download-sections: `*12.5-95.0` (сек, точно).
pub fn range_arg(start: f64, end: f64) -> String {
    format!("*{start:.3}-{end:.3}")
}

/// Суффикс имени файла для диапазона: `(2m03s-5m40s)`.
pub fn range_suffix(start: f64, end: f64) -> String {
    fmt_range_part(start) + "-" + &fmt_range_part(end)
}

/// `95.4 с` → `1m35s`; часы не нужны (концерты длятся часами, но компонент
/// прост: h только при ≥1 ч).
fn fmt_range_part(sec: f64) -> String {
    let total = sec.round() as u64;
    let (h, rest) = (total / 3600, total % 3600);
    let (m, s) = (rest / 60, rest % 60);
    if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else {
        format!("{m}m{s:02}s")
    }
}

/// Шаблон вывода: имя файла с суффиксом диапазона/без.
fn output_template(spec: &RunSpec) -> String {
    let suffix = spec.name_suffix.as_deref().unwrap_or("");
    // ограничиваем длину имени — Windows потолок пути 260 символов
    format!("%(title).120B [%(id)s]{suffix}.%(ext)s")
}

/// Аргументы командной строки yt-dlp для спецификации.
pub fn build_args(spec: &RunSpec) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    a.push("--no-playlist".into());
    a.push("--newline".into());
    a.push("--no-colors".into());
    a.push("--progress".into());
    a.push("--progress-template".into());
    a.push("dl:@%(progress._percent_str)s@%(progress._speed_str)s@%(progress._eta_str)s".into());
    a.push("--print".into());
    a.push("after_move:filepath".into());
    a.push("--no-mtime".into());
    a.push("-o".into());
    a.push(format!("{}/{}", spec.out_dir.trim_end_matches('/'), output_template(spec)));
    match spec.mode {
        MediaMode::Video => {
            let q = spec.quality.trim();
            let max_h: u32 = q.parse().unwrap_or(0);
            let fmt = if max_h > 0 {
                format!("bv*[height<={max_h}]+ba/b[height<={max_h}]/b")
            } else {
                "bv*+ba/b".to_string()
            };
            a.push("-f".into());
            a.push(fmt);
        }
        MediaMode::Audio => {
            a.push("-f".into());
            if spec.audio_mp3 {
                a.push("ba/b".into());
                a.push("-x".into());
                a.push("--audio-format".into());
                a.push("mp3".into());
                a.push("--audio-quality".into());
                a.push("0".into());
            } else {
                a.push("ba[ext=m4a]/ba/b".into());
            }
        }
    }
    if let Some((s, e)) = spec.range {
        a.push("--download-sections".into());
        a.push(range_arg(s, e));
    }
    if let Some(dir) = &spec.ffmpeg_dir {
        a.push("--ffmpeg-location".into());
        a.push(dir.clone());
    }
    if let Some(p) = &spec.proxy {
        a.push("--proxy".into());
        a.push(p.clone());
    }
    if let Some(c) = &spec.cookies {
        a.push("--cookies".into());
        a.push(c.clone());
    }
    a.push(spec.url.clone());
    a
}

/// Одна строка прогресса из stdout yt-dlp.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressLine {
    /// 0..100.
    pub percent: f64,
    /// Как отдал yt-dlp (« 12.5MiB/s»).
    pub speed: String,
    pub eta: String,
}

/// Прогресс-строки приходят шаблоном `dl:@ 42.1%@ 1.2MiB/s@ 00:31`.
pub fn parse_progress(line: &str) -> Option<ProgressLine> {
    let rest = line.trim().strip_prefix("dl:@")?;
    let mut it = rest.split('@');
    let pct = it.next()?.trim().trim_end_matches('%').trim();
    let percent: f64 = pct.parse().ok()?;
    let speed = it.next().unwrap_or("").trim().to_string();
    let eta = it.next().unwrap_or("").trim().to_string();
    Some(ProgressLine {
        percent: percent.clamp(0.0, 100.0),
        speed,
        eta,
    })
}

/// Фаза по служебной строке yt-dlp: ExtractAudio/Merger — конвертация,
/// Downloading — качание, прочее ([info] и т.п.) — None.
pub fn phase_of(line: &str) -> Option<&'static str> {
    if line.starts_with("[ExtractAudio]") || line.starts_with("[Merger]") {
        Some("convert")
    } else if line.starts_with("[download]") && !line.contains("%") {
        Some("download")
    } else {
        None
    }
}

/// Аргументы yt-dlp для скачивания ТОЛЬКО субтитров (fallback карточки
/// duopulse-118: браузерная сессия помечена ботом — плеер не играет и PO-токен
/// не выдаётся, а extraction у yt-dlp работает). --skip-download + дорожки
/// языка (ручная, иначе авто); ffmpeg готов — конвертация в srt.
pub fn build_subs_args(url: &str, lang: &str, out_dir: &str, ffmpeg_dir: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    a.push("--no-playlist".into());
    a.push("--newline".into());
    a.push("--no-colors".into());
    a.push("--skip-download".into());
    a.push("--write-subs".into());
    a.push("--write-auto-subs".into());
    a.push("--sub-langs".into());
    a.push(lang.to_string());
    a.push("--sub-format".into());
    a.push("srt/vtt/best".into());
    if ffmpeg_dir.is_some() {
        a.push("--convert-subs".into());
        a.push("srt".into());
    }
    a.push("--print".into());
    a.push("after_move:filepath".into());
    a.push("--no-mtime".into());
    a.push("-o".into());
    a.push(format!("{}/%(title).120B [%(id)s].%(ext)s", out_dir.trim_end_matches('/')));
    if let Some(dir) = ffmpeg_dir {
        a.push("--ffmpeg-location".into());
        a.push(dir.to_string());
    }
    a.push(url.to_string());
    a
}

/// Язык из trackId адаптера: «yt:en» → en; «yt:uk:asr» → uk; «yt:en+ru» →
/// en (перевод — язык базы, tlang yt-dlp не умеет); «ru» → ru; прочее — None.
pub fn subs_lang_of(track_id: &str) -> Option<String> {
    let id = track_id.trim();
    let stem = id.strip_prefix("yt:").unwrap_or(id);
    let lang = stem.split([':', '+']).next().unwrap_or("");
    (!lang.is_empty()).then(|| lang.to_string())
}

/// Похоже ли на итоговый путь (строка после --print after_move:filepath).
pub fn is_filepath_line(line: &str) -> bool {
    let t = line.trim();
    t.len() > 3
        && !t.starts_with('[')
        && !t.starts_with("dl:@")
        && (t.starts_with(r"\\") || t.as_bytes()[1] == b':' || t.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(mode: MediaMode) -> RunSpec {
        RunSpec {
            url: "https://www.youtube.com/watch?v=abc".into(),
            mode,
            quality: "720".into(),
            audio_mp3: false,
            range: None,
            out_dir: "D:/Загрузки".into(),
            ffmpeg_dir: Some("D:/P/dl/bin".into()),
            proxy: None,
            cookies: None,
            name_suffix: None,
        }
    }

    #[test]
    fn args_video_with_quality_and_ffmpeg() {
        let a = build_args(&spec(MediaMode::Video));
        assert!(a.contains(&"-f".into()) && a.contains(&"bv*[height<=720]+ba/b[height<=720]/b".into()));
        assert!(a.contains(&"--ffmpeg-location".into()));
        assert!(a.windows(2).any(|w| w[0] == "-o" && w[1].starts_with("D:/Загрузки/%(title).120B [%(id)s].%(ext)s")));
        assert_eq!(a.last().unwrap(), "https://www.youtube.com/watch?v=abc");
        assert!(a.contains(&"--no-playlist".into()));
    }

    #[test]
    fn args_best_video_without_ffmpeg() {
        let s = RunSpec {
            quality: "best".into(),
            ffmpeg_dir: None,
            ..spec(MediaMode::Video)
        };
        let a = build_args(&s);
        assert!(a.contains(&"bv*+ba/b".into()));
        assert!(!a.contains(&"--ffmpeg-location".into()));
    }

    #[test]
    fn args_audio_m4a_and_mp3() {
        let a = build_args(&spec(MediaMode::Audio));
        assert!(a.contains(&"ba[ext=m4a]/ba/b".into()));
        assert!(!a.contains(&"-x".into()));
        let mp3 = build_args(&RunSpec {
            audio_mp3: true,
            ..spec(MediaMode::Audio)
        });
        assert!(mp3.contains(&"-x".into()) && mp3.contains(&"mp3".into()));
    }

    #[test]
    fn args_range_and_suffix_and_proxy() {
        let s = RunSpec {
            range: Some((72.5, 340.0)),
            name_suffix: Some(format!("({})", range_suffix(72.5, 340.0))),
            proxy: Some("socks5://127.0.0.1:1080".into()),
            ..spec(MediaMode::Video)
        };
        let a = build_args(&s);
        assert!(a.contains(&"*72.500-340.000".into()));
        assert_eq!(range_suffix(72.5, 340.0), "1m13s-5m40s"); // 72.5 → 73 с
        assert!(a.windows(2).any(|w| w[0] == "-o" && w[1].contains("[%(id)s](1m13s-5m40s)")));
        assert!(a.windows(2).any(|w| w[0] == "--proxy" && w[1] == "socks5://127.0.0.1:1080"));
        // часы в суффиксе
        assert_eq!(range_suffix(3725.0, 7325.0), "1h02m05s-2h02m05s");
    }

    #[test]
    fn parse_progress_line() {
        let p = parse_progress("dl:@  42.1%@ 1.25MiB/s@ 00:31").unwrap();
        assert_eq!(p.percent, 42.1);
        assert_eq!(p.speed, "1.25MiB/s");
        assert_eq!(p.eta, "00:31");
        // Unknown по скорости/ета и мусор — не прогресс
        assert_eq!(parse_progress("dl:@ 100.0%").unwrap().percent, 100.0);
        assert!(parse_progress("[download] 42.1% of ~10.00MiB").is_none());
        assert!(parse_progress("dl:@ N/A@ Unknown@ Unknown").is_none());
        // кламп
        assert_eq!(parse_progress("dl:@ 150.0%@ @ ").unwrap().percent, 100.0);
    }

    #[test]
    fn subs_args_and_lang_of() {
        // duopulse-118: фолбэк субтитров — только дорожки, без видео
        let a = build_subs_args(
            "https://www.youtube.com/watch?v=abc",
            "en",
            "D:/Загрузки",
            Some("D:/P/dl/bin"),
        );
        assert!(a.contains(&"--skip-download".into()));
        assert!(a.contains(&"--write-subs".into()) && a.contains(&"--write-auto-subs".into()));
        assert!(a.windows(2).any(|w| w[0] == "--sub-langs" && w[1] == "en"));
        assert!(a.contains(&"--convert-subs".into()) && a.contains(&"srt".into()));
        assert!(a.windows(2).any(|w| w[0] == "-o" && w[1].contains("[%(id)s].%(ext)s")));
        let no_ffmpeg = build_subs_args("u", "ru", "D:/x", None);
        assert!(!no_ffmpeg.contains(&"--convert-subs".into()));

        assert_eq!(subs_lang_of("yt:en"), Some("en".into()));
        assert_eq!(subs_lang_of("yt:uk:asr"), Some("uk".into()));
        assert_eq!(subs_lang_of("yt:en+ru"), Some("en".into())); // перевод — язык базы
        assert_eq!(subs_lang_of("ru"), Some("ru".into()));
        assert_eq!(subs_lang_of(""), None);
        assert_eq!(subs_lang_of("yt:en:asr:2"), Some("en".into()));
    }

    #[test]
    fn phase_and_filepath_detection() {
        assert_eq!(phase_of("[ExtractAudio] Destination: x.mp3"), Some("convert"));
        assert_eq!(phase_of("[Merger] Merging formats into \"x.mp4\""), Some("convert"));
        assert_eq!(phase_of("[download] Destination: x.f137.mp4"), Some("download"));
        assert_eq!(phase_of("[download]  42.1% of ~10.00MiB"), None);
        assert_eq!(phase_of("[info] abc: Downloading webpage"), None);
        assert!(is_filepath_line(r"D:\Загрузки\Песня [abc].mp4"));
        assert!(is_filepath_line("D:/x.mp4"));
        assert!(!is_filepath_line("dl:@ 42.1%@ @ "));
        assert!(!is_filepath_line("[download] Destination: x"));
        assert!(!is_filepath_line("Deleting original file"));
    }
}
