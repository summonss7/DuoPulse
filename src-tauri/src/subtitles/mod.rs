//! Модель и парсеры форматов субтитров (задача 3.1, карточка duopulse-022,
//! docs/05 §1 `src/subtitles/`; модель данных — docs/03 §6). Сервис-обвязка
//! (IPC `subtitles.*`, SQLite-кэш) — задачи 3.3–3.6, поэтому из рантайма
//! модуль пока не вызывается.
//!
//! Единая модель — [`Cue`]; парсеры — [`srt`], [`vtt`], [`timedtext`].
//! Контракт устойчивости (карточка duopulse-022): битый вход НЕ валит
//! парсер — повреждённые cue/блоки пропускаются с предупреждением, разбор
//! продолжается. Перекрытия cue сохраняются и диагностируются: пересекающиеся
//! интервалы смёржит движок показа (docs/03 §4).
//!
//! Общая нормализация: BOM (U+FEFF) и CRLF/CR убираются до разбора; текст
//! cue — строки, соединённые `\n`, с обрезкой краёв; теги разметки (`<i>`,
//! `<font>`, `<v Имя>`…) вырезаются; XML-сущности декодируются (YouTube
//! timedtext — два прохода: апстрим экранирует дважды, `&amp;#39;` → `'`);
//! результат стабильно отсортирован по `start_ms`.
#![allow(dead_code)] // парсеры — фикстурные тесты (duopulse-022); сервис — задача 3.7

pub mod cache;
pub mod service;
pub mod srt;
pub mod timedtext;
pub mod vtt;

use serde::{Deserialize, Serialize};

/// Автодетект формата по содержимому (задача 3.3: YouTube-адаптер присылает
/// тела timedtext/json3; формат выбирает платформа, разбирает Core — единый
/// источник логики): `{` — JSON3 timedtext, `<` — XML timedtext, `WEBVTT` —
/// WebVTT, остальное — SubRip.
pub fn parse_auto(input: &str) -> ParsedCues {
    let t = input.trim_start();
    if t.starts_with('{') || t.starts_with('<') {
        timedtext::parse(input)
    } else if normalize(input).starts_with("WEBVTT") {
        vtt::parse(input)
    } else {
        srt::parse(input)
    }
}

// --- задача 3.6: ручные файлы .srt/.vtt (docs/03 §3.2) ------------------------

/// Ручной файл субтитров, прочитанный с диска: имя (без каталога — его видит
/// пользователь в панели/диагностике) + итог канонического разбора.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualFileTrack {
    pub name: String,
    pub cues: Vec<Cue>,
    pub warnings: Vec<ParseWarning>,
}

/// Лимит размера файла — тот же, что у WebMessage-разбора дорожек (main.rs).
const MANUAL_FILE_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Прочитать и разобрать ручной файл субтитров (панельный путь задачи 3.6,
/// IPC `subtitles.load_file`): чтение UTF-8 с диска (Windows-1251 — v1.1,
/// docs/03 §3.2), разбор — канонический `parse_auto` (задача 3.1). Ошибки —
/// текстом для панели (файл недоступен/не UTF-8/слишком большой).
pub fn read_manual_file(path: &std::path::Path) -> Result<ManualFileTrack, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("файл недоступен: {e}"))?;
    if !meta.is_file() {
        return Err("это не файл".to_string());
    }
    if meta.len() > MANUAL_FILE_MAX_BYTES {
        return Err(format!("файл {} КБ — сверх лимита 4 МБ", meta.len() / 1024));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|_| "файл не в UTF-8 (Windows-1251 — v1.1, docs/03 §3.2)".to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parsed = parse_auto(&text);
    Ok(ManualFileTrack {
        name,
        cues: parsed.cues,
        warnings: parsed.warnings,
    })
}

/// Единица субтитра — docs/03 §6 (`Cue { startMs, endMs, text }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cue {
    pub start_ms: i64,
    pub end_ms: i64,
    /// Строки cue соединены `\n`; разметка и сущности нормализованы парсером.
    pub text: String,
}

/// Неблокирующая проблема разбора: элемент пропущен/сохранён с диагнозом,
/// парсер продолжил работу.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParseWarning {
    /// 1-based строка источника; 0 — к файлу целиком (пост-диагностика
    /// по уже собранному списку: перекрытия, порядковые номера).
    pub line: usize,
    pub message: String,
}

/// Итог разбора дорожки: cue (отсортированы по start) + диагностика.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedCues {
    pub cues: Vec<Cue>,
    pub warnings: Vec<ParseWarning>,
}

/// BOM и переводы Windows → LF до разбора (все парсеры).
pub(crate) fn normalize(input: &str) -> String {
    let s = input.strip_prefix('\u{FEFF}').unwrap_or(input);
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// Пост-обработка списка cue: отброс вырожденных (пустой текст, конец ≤
/// начало — с диагностикой; сюда доходит в основном timedtext, чей элемент
/// нельзя привязать к строке, — srt/vtt фильтруют то же самое на месте, со
/// строками источника), стабильная сортировка по start, предупреждения о
/// перекрытиях (движок показа смёржит, docs/03 §4).
pub(crate) fn finalize_cues(cues: Vec<Cue>, warnings: &mut Vec<ParseWarning>) -> Vec<Cue> {
    let mut kept: Vec<Cue> = Vec::with_capacity(cues.len());
    for (n, mut cue) in cues.into_iter().enumerate() {
        cue.text = cue.text.trim().to_string();
        if cue.text.is_empty() {
            warnings.push(warn(
                0,
                format!("строка #{}: пустой текст — пропущена", n + 1),
            ));
        } else if cue.end_ms <= cue.start_ms {
            warnings.push(warn(
                0,
                format!(
                    "строка #{}: конец {} мс ≤ начало {} мс — пропущена",
                    n + 1,
                    cue.end_ms,
                    cue.start_ms
                ),
            ));
        } else {
            kept.push(cue);
        }
    }
    kept.sort_by_key(|c| (c.start_ms, c.end_ms));
    let mut max_end = i64::MIN;
    for cue in &kept {
        if cue.start_ms < max_end {
            warnings.push(warn(
                0,
                format!(
                    "cue с началом {} мс перекрывает предыдущие (макс. конец {} мс) — движок показа смёржит",
                    cue.start_ms, max_end
                ),
            ));
        }
        max_end = max_end.max(cue.end_ms);
    }
    kept
}

fn warn(line: usize, message: impl Into<String>) -> ParseWarning {
    ParseWarning {
        line,
        message: message.into(),
    }
}

/// Строка тайминга `A --> B [настройки]`: таймстампы с обеих сторон `-->`;
/// настройки WebVTT (align/line/position…) после B игнорируются.
pub(crate) fn parse_timing_line(line: &str) -> Option<(i64, i64)> {
    let (left, right) = line.split_once("-->")?;
    let start = parse_timestamp(left.split_whitespace().next()?)?;
    let end = parse_timestamp(right.split_whitespace().next()?)?;
    Some((start, end))
}

/// Таймстамп `[[HH:]MM:]SS[.,mmm]`: часы можно опустить (для WebVTT это
/// норма по спецификации, для SubRip — частая вольность файлов), дробная
/// часть через точку или запятую (WebVTT/SubRip), 1–3 цифры миллисекунд
/// (`.5` = 500 мс). Битое значение — `None` (вызывающий диагностирует).
pub(crate) fn parse_timestamp(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if !s.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let (head, millis) = match s.rsplit_once(['.', ',']) {
        Some((h, m)) if !m.is_empty() && m.bytes().all(|b| b.is_ascii_digit()) => (h, millis_of(m)),
        _ => (s, 0),
    };
    let parts: Vec<&str> = head.split(':').collect();
    if parts.len() < 2
        || parts.len() > 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let (h, m, sec) = match parts[..] {
        [m, s] => ("0", m, s),
        [h, m, s] => (h, m, s),
        _ => return None,
    };
    let to_ms = |p: &str| p.parse::<u64>().ok();
    let total = to_ms(h)?
        .checked_mul(3_600_000)?
        .checked_add(to_ms(m)?.checked_mul(60_000)?)?
        .checked_add(to_ms(sec)?.checked_mul(1_000)?)?
        .checked_add(millis)?
        .min(i64::MAX as u64);
    Some(total as i64)
}

/// Дробная часть секунды в мс: `5` → 500, `45` → 450, `123` → 123,
/// свыше трёх цифр — первые три.
fn millis_of(digits: &str) -> u64 {
    let take: String = digits.chars().take(3).collect();
    let value: u64 = take.parse().unwrap_or(0);
    match digits.len() {
        1 => value * 100,
        2 => value * 10,
        _ => value,
    }
}

/// Вырезание тегов разметки (`<i>`, `<font …>`, `<v Имя>`…). Тег не может
/// переноситься через `\n`; `<` без парного `>` — литеральный текст.
pub(crate) fn strip_markup(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            if let Some(rel) = chars[i + 1..].iter().position(|&c| c == '>') {
                if !chars[i + 1..i + 1 + rel].contains(&'\n') {
                    i += rel + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Декодирование XML/HTML-сущностей: именованные (amp/lt/gt/quot/apos/nbsp/
/// lrm/rlm) и числовые (`&#39;`, `&#x27;`). `rounds` — проходы: YouTube
/// timedtext экранирует дважды (`&amp;#39;` → `'` — два прохода), WebVTT
/// достаточно одного; неизвестная последовательность `&…;` — литерал.
pub(crate) fn decode_entities(text: &str, rounds: usize) -> String {
    let mut cur = text.to_string();
    for _ in 0..rounds {
        let next = decode_entities_once(&cur);
        if next == cur {
            break;
        }
        cur = next;
    }
    cur
}

fn decode_entities_once(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if text.as_bytes()[i] == b'&' {
            let tail = &text[i + 1..];
            // «&…;» не длиннее 10 символов, без переносов и вложенного «&»
            if let Some(end) = tail.find(';') {
                let name = &tail[..end];
                if end > 0
                    && end <= 10
                    && !name.contains(|c: char| c == '&' || c == '\n' || c.is_whitespace())
                {
                    if let Some(decoded) = entity(name) {
                        out.push_str(&decoded);
                        i += 1 + end + 1;
                        continue;
                    }
                }
            }
        }
        // Границы UTF-8 не спорят: '&' — ASCII, срез начинается с начала символа
        let ch = text[i..].chars().next().expect("непустой хвост строки");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn entity(name: &str) -> Option<String> {
    let decoded = match name {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        "nbsp" => "\u{00A0}".to_string(),
        "lrm" => "\u{200E}".to_string(),
        "rlm" => "\u{200F}".to_string(),
        _ if name.starts_with('#') => {
            let digits = &name[1..];
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse::<u32>().ok()?,
            };
            char::from_u32(code)?.to_string()
        }
        _ => return None,
    };
    Some(decoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_hh_mm_ss_variants() {
        assert_eq!(parse_timestamp("00:00:01,000"), Some(1_000));
        assert_eq!(parse_timestamp("00:00:01.000"), Some(1_000));
        assert_eq!(parse_timestamp("01:02:03.400"), Some(3_723_400));
        assert_eq!(parse_timestamp("00:04.000"), Some(4_000)); // MM:SS.mmm — WebVTT
        assert_eq!(parse_timestamp("01:23"), Some(83_000)); // MM:SS без мс
        assert_eq!(parse_timestamp("0:00:01.5"), Some(1_500)); // 1–3 цифры мс
        assert_eq!(parse_timestamp(" 00:00:02,750 "), Some(2_750));
    }

    #[test]
    fn timestamps_broken_are_none() {
        assert_eq!(parse_timestamp(""), None);
        assert_eq!(parse_timestamp("-00:00:01,000"), None);
        assert_eq!(parse_timestamp("xx:00:05,000"), None);
        assert_eq!(parse_timestamp("00:00:01,abc"), None);
        assert_eq!(parse_timestamp("1:2:3.4.5"), None);
        assert_eq!(parse_timestamp("1234"), None); // число без ':' — не таймстамп
        assert_eq!(
            parse_timestamp(&format!("{}:00:00,000", u64::MAX)),
            None // переполнение часов — None, не паника
        );
    }

    #[test]
    fn timing_line_splits_arrow_and_ignores_settings() {
        assert_eq!(
            parse_timing_line("00:00:01,000 --> 00:00:03,000"),
            Some((1_000, 3_000))
        );
        assert_eq!(
            parse_timing_line("00:00.500 --> 00:02.000 align:start position:10%"),
            Some((500, 2_000))
        );
        assert_eq!(parse_timing_line("no arrow here"), None);
        assert_eq!(parse_timing_line("00:01.000 --> "), None);
    }

    #[test]
    fn entities_decode_named_and_numeric() {
        assert_eq!(decode_entities("a&amp;b", 1), "a&b");
        assert_eq!(decode_entities("&lt;b&gt; &#1040;&#x41;", 1), "<b> АA");
        assert_eq!(
            decode_entities("&nbsp;&lrm;&rlm;&quot;&apos;", 1),
            "\u{A0}\u{200E}\u{200F}\"'"
        );
        assert_eq!(decode_entities("&nope; a & b", 1), "&nope; a & b"); // неизвестная — литерал
        assert_eq!(decode_entities("a&amp;#39;b", 1), "a&#39;b"); // первый проход
        assert_eq!(decode_entities("a&amp;#39;b", 2), "a'b"); // двойное экранирование YouTube
    }

    #[test]
    fn markup_tags_stripped_stray_lt_kept() {
        assert_eq!(strip_markup("<i>a</i> b"), "a b");
        assert_eq!(strip_markup("<v Roger>hi</v>"), "hi");
        assert_eq!(strip_markup("a < b и 3 < 5"), "a < b и 3 < 5");
        assert_eq!(strip_markup("no tags"), "no tags");
        assert_eq!(strip_markup("<font color=\"#CCC\">x</font>"), "x");
    }

    #[test]
    fn normalize_strips_bom_and_cr() {
        assert_eq!(normalize("\u{FEFF}1\nx"), "1\nx");
        assert_eq!(normalize("a\r\nb\rc"), "a\nb\nc");
        assert_eq!(normalize("plain"), "plain");
    }

    #[test]
    fn parse_auto_dispatches_by_content() {
        // JSON3 (YouTube, адаптер 3.3): детект по «{»
        let json3 = r#"{"wireMagic":"ga3","events":[{"tStartMs":1000,"dDurationMs":1500,"segs":[{"utf8":"привет"}]}]}"#;
        assert_eq!(
            parse_auto(json3).cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 2_500,
                text: "привет".into(),
            }]
        );
        // XML timedtext: детект по «<»
        let xml = "<transcript><text start=\"1.0\" dur=\"1.5\">hi</text></transcript>";
        assert_eq!(parse_auto(xml).cues.len(), 1);
        // WebVTT / SubRip — по маркерам
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi\n";
        assert_eq!(parse_auto(vtt).cues.len(), 1);
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nhi\n";
        assert_eq!(parse_auto(srt).cues.len(), 1);
        // пустое/мусорное — не паника, пустой итог с диагностикой
        assert!(parse_auto("").cues.is_empty());
        assert!(parse_auto("мусор").cues.is_empty());
    }

    #[test]
    fn finalize_sorts_drops_and_warns_overlaps() {
        let cues = vec![
            Cue {
                start_ms: 5_000,
                end_ms: 6_000,
                text: "b".into(),
            },
            Cue {
                start_ms: 1_000,
                end_ms: 4_000,
                text: "a".into(),
            },
            Cue {
                start_ms: 3_000,
                end_ms: 3_500,
                text: "  ".into(),
            }, // пустой после trim
            Cue {
                start_ms: 7_000,
                end_ms: 7_000,
                text: "zero".into(),
            }, // нулевая длительность
            Cue {
                start_ms: 3_500,
                end_ms: 4_500,
                text: "c".into(),
            }, // перекрытие с «a»
        ];
        let mut warnings = Vec::new();
        let kept = finalize_cues(cues, &mut warnings);
        let starts: Vec<i64> = kept.iter().map(|c| c.start_ms).collect();
        assert_eq!(starts, vec![1_000, 3_500, 5_000]);
        assert!(warnings.iter().any(|w| w.message.contains("пустой текст")));
        assert!(warnings.iter().any(|w| w.message.contains("≤ начало")));
        assert!(warnings.iter().any(|w| w.message.contains("перекрывает")));
    }

    // --- задача 3.6: чтение ручного файла с диска (subtitles.load_file) ------

    /// Временный файл с содержимым — путь для read_manual_file.
    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "duopulse-subtitles-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("создать temp-каталог");
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("записать temp-файл");
        path
    }

    #[test]
    fn read_manual_file_srt_from_disk() {
        let srt = b"1\n00:00:01,000 --> 00:00:03,000\nhello\n";
        let path = temp_file("movie.en.srt", srt);
        let track = read_manual_file(&path).expect("файл читается");
        assert_eq!(track.name, "movie.en.srt");
        assert_eq!(track.cues.len(), 1);
        assert_eq!(track.cues[0].text, "hello");
        assert!(track.warnings.is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn read_manual_file_rejects_non_utf8_and_oversize_and_missing() {
        // Windows-1251 «привет» — не UTF-8: внятный отказ (v1.1 — детект)
        let win1251 = [0xEF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2];
        let path = temp_file("cp1251.srt", &win1251);
        let err = read_manual_file(&path).expect_err("не UTF-8 — ошибка");
        assert!(err.contains("UTF-8"), "текст ошибки: {err}");
        std::fs::remove_file(&path).ok();

        let big = vec![b'x'; (MANUAL_FILE_MAX_BYTES + 1) as usize];
        let path = temp_file("big.srt", &big);
        let err = read_manual_file(&path).expect_err("сверх лимита — ошибка");
        assert!(err.contains("лимита"), "текст ошибки: {err}");
        std::fs::remove_file(&path).ok();

        let err = read_manual_file(std::path::Path::new("Z:/нет/такого/файла.srt"))
            .expect_err("нет файла — ошибка");
        assert!(err.contains("недоступен"), "текст ошибки: {err}");
    }

    #[test]
    fn read_manual_file_empty_is_not_an_error() {
        // Файл без единого валидного cue — это итог разбора (0 cue + диагностика),
        // а не ошибка чтения: панель покажет предупреждения, не «файл недоступен».
        // Полностью пустой файл парсер молчит (философия 3.1 «пустой вход —
        // тишина»), поэтому мусорный блок без тайминга — диагностика есть.
        let path = temp_file("garbage.srt", b"not a subtitle file\njust text lines\n");
        let track = read_manual_file(&path).expect("чтение ок");
        assert!(track.cues.is_empty());
        assert!(!track.warnings.is_empty());
        std::fs::remove_file(&path).ok();

        let path = temp_file("blank.srt", b"\n\n\n");
        let track = read_manual_file(&path).expect("чтение ок");
        assert!(track.cues.is_empty());
        assert!(track.warnings.is_empty());
        std::fs::remove_file(&path).ok();
    }
}
