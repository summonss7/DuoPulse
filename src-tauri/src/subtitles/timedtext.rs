//! Парсер YouTube timedtext — задача 3.1 (docs/05 §1). Два формата ответа
//! `api/timedtext`:
//!
//! - XML: современный `<transcript><text start="…" dur="…">` (секунды с
//!   дробью) и старый `<timedtext><body><p t="…" d="…">` (миллисекунды).
//!   Внутри текста — теги (`<font>`) и сущности, которые YouTube экранирует
//!   дважды (`&amp;#39;` → `'`): декодируем два прохода, затем вырезаем теги.
//! - JSON3 (`fmt=json3`): `events[].{tStartMs, dDurationMs, segs[].utf8}`.
//!   События без `segs` — служебные (окна/формат), пропускаются тихо;
//!   события с `aAppend` — пословный режим автосубтитров: текст приклеивается
//!   к предыдущему cue, конец — самый поздний из склеенных.
//!
//! Формат выбирается по первому непробельному символу: `{` — JSON3, иначе XML.
//! Битые элементы/XML/JSON — предупреждение, разбор продолжается.

use super::{decode_entities, finalize_cues, strip_markup, Cue, ParseWarning, ParsedCues};
use quick_xml::events::BytesStart;
use quick_xml::events::Event;
use quick_xml::Reader;

pub fn parse(input: &str) -> ParsedCues {
    // BOM — не whitespace для trim_start, снимаем явно.
    let head = input.trim_start_matches('\u{FEFF}').trim_start();
    if head.starts_with('{') {
        parse_json3(input)
    } else {
        parse_xml(input)
    }
}

/// Тайминги элемента-строки, разложенные по формату атрибутов.
struct Timings {
    start_ms: i64,
    end_ms: i64,
}

pub fn parse_xml(input: &str) -> ParsedCues {
    let src = super::normalize(input);
    let mut reader = Reader::from_str(&src);
    let mut cues: Vec<Cue> = Vec::new();
    let mut warnings: Vec<ParseWarning> = Vec::new();
    // Открытый элемент-строка: тайминги + накопленный текст. Вложенные теги
    // (`<font>` внутри текста) не закрывают строку — считаем глубину.
    let mut open: Option<(Timings, String)> = None;
    let mut nested = 0usize;
    let mut n = 0usize;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                if is_line(&e) {
                    n += 1;
                    if let Some(t) = timings_of(&e, n, &mut warnings) {
                        open = Some((t, String::new()));
                        nested = 0;
                    }
                } else if open.is_some() {
                    nested += 1;
                }
            }
            Ok(Event::Empty(e)) => {
                if is_line(&e) {
                    n += 1;
                    // Самозакрытый элемент текста не содержит: пустой cue
                    // уйдёт на пост-фильтр finalize_cues с диагностикой.
                    if let Some(t) = timings_of(&e, n, &mut warnings) {
                        cues.push(Cue {
                            start_ms: t.start_ms,
                            end_ms: t.end_ms,
                            text: String::new(),
                        });
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if let Some((_, text)) = open.as_mut() {
                    text.push_str(&String::from_utf8_lossy(&t.into_inner()));
                }
            }
            Ok(Event::CData(t)) => {
                if let Some((_, text)) = open.as_mut() {
                    text.push_str(&String::from_utf8_lossy(&t.into_inner()));
                }
            }
            Ok(Event::End(e)) => {
                if matches!(e.name().as_ref(), b"text" | b"p") && open.is_some() && nested == 0 {
                    let (t, raw) = open.take().expect("open.is_some() проверен выше");
                    cues.push(finished_cue(t, &raw));
                } else if open.is_some() {
                    nested = nested.saturating_sub(1);
                }
            }
            Ok(Event::Eof) => break,
            Err(err) => {
                warnings.push(ParseWarning {
                    line: 0,
                    message: format!("битый XML ({err}) — взято то, что разобралось"),
                });
                break;
            }
            // Decl/Comment/PI/DocType — мимо
            Ok(_) => {}
        }
    }
    // Незакрытый элемент в конце файла — забираем накопленное как есть.
    if let Some((t, raw)) = open.take() {
        cues.push(finished_cue(t, &raw));
    }
    let cues = finalize_cues(cues, &mut warnings);
    ParsedCues { cues, warnings }
}

/// Элемент-строка субтитра: `text` (современный формат) или `p` (старый).
fn is_line(e: &BytesStart<'_>) -> bool {
    matches!(e.name().as_ref(), b"text" | b"p")
}

fn finished_cue(t: Timings, raw: &str) -> Cue {
    let text = strip_markup(&decode_entities(raw, 2)).trim().to_string();
    Cue {
        start_ms: t.start_ms,
        end_ms: t.end_ms,
        text,
    }
}

/// Разбор атрибутов строки: `text` — start/dur в секундах (дробь), `p` —
/// t/d в миллисекундах. Чего-то нет или не разбирается — предупреждение
/// и `None` (элемент пропущен, разбор продолжается).
fn timings_of(e: &BytesStart<'_>, n: usize, warnings: &mut Vec<ParseWarning>) -> Option<Timings> {
    let legacy = e.name().as_ref() == b"p";
    let secs = |v: &str| {
        v.trim()
            .parse::<f64>()
            .ok()
            .filter(|s| s.is_finite() && *s >= 0.0)
            .map(|s| (s * 1000.0).round() as i64)
    };
    let msecs = |v: &str| v.trim().parse::<i64>().ok().filter(|v| *v >= 0);
    let mut start: Option<i64> = None;
    let mut dur: Option<i64> = None;
    for attr in e.attributes().flatten() {
        let key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
        let value = decode_entities(&String::from_utf8_lossy(&attr.value), 1);
        let parsed = if legacy { msecs(&value) } else { secs(&value) };
        match (legacy, key.as_str()) {
            (false, "start") | (true, "t") => start = start.or(parsed),
            (false, "dur") | (true, "d") => dur = dur.or(parsed),
            _ => {}
        }
    }
    match (start, dur) {
        (None, _) => {
            warnings.push(ParseWarning {
                line: 0,
                message: format!("элемент #{n}: не разобран атрибут start — строка пропущена"),
            });
            None
        }
        (Some(_), None) => {
            warnings.push(ParseWarning {
                line: 0,
                message: format!("элемент #{n}: не разобран атрибут dur — строка пропущена"),
            });
            None
        }
        (Some(s), Some(d)) => Some(Timings {
            start_ms: s,
            end_ms: s.saturating_add(d),
        }),
    }
}

pub fn parse_json3(input: &str) -> ParsedCues {
    let mut cues: Vec<Cue> = Vec::new();
    let mut warnings: Vec<ParseWarning> = Vec::new();
    // normalize снимает BOM (serde_json его не принимает) и CRLF.
    let value: serde_json::Value = match serde_json::from_str(&super::normalize(input)) {
        Ok(v) => v,
        Err(err) => {
            warnings.push(ParseWarning {
                line: 0,
                message: format!("битый JSON3 ({err})"),
            });
            return ParsedCues { cues, warnings };
        }
    };
    let Some(events) = value.get("events").and_then(|v| v.as_array()) else {
        warnings.push(ParseWarning {
            line: 0,
            message: "нет массива events — дорожка пуста".into(),
        });
        return ParsedCues { cues, warnings };
    };
    for (i, event) in events.iter().enumerate() {
        let Some(start_ms) = event.get("tStartMs").and_then(|v| v.as_i64()) else {
            // Без segs — служебное событие (окна/формат), тихо мимо; с segs,
            // но без tStartMs — диагностируем.
            if event.get("segs").is_some() {
                warnings.push(ParseWarning {
                    line: 0,
                    message: format!("событие #{i} без tStartMs — пропущено"),
                });
            }
            continue;
        };
        let Some(segs) = event.get("segs").and_then(|v| v.as_array()) else {
            continue;
        };
        let text: String = segs
            .iter()
            .filter_map(|s| s.get("utf8").and_then(|v| v.as_str()))
            .collect();
        let end_ms = start_ms.saturating_add(
            event
                .get("dDurationMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
        );
        if truthy(event.get("aAppend")) {
            // Пословный режим автосубтитров: приклеиваем к предыдущему cue,
            // конец — самый поздний из склеенных событий.
            match cues.last_mut() {
                Some(prev) => {
                    prev.text.push_str(&text);
                    prev.end_ms = prev.end_ms.max(end_ms);
                }
                None => cues.push(Cue {
                    start_ms,
                    end_ms,
                    text,
                }),
            }
        } else {
            cues.push(Cue {
                start_ms,
                end_ms,
                text,
            });
        }
    }
    let cues = finalize_cues(cues, &mut warnings);
    ParsedCues { cues, warnings }
}

fn truthy(v: Option<&serde_json::Value>) -> bool {
    match v {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) != 0,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const XML: &str = include_str!("../../../e2e/fixtures/subtitles/timedtext.xml");
    const XML_LEGACY: &str = include_str!("../../../e2e/fixtures/subtitles/timedtext-legacy.xml");
    const XML_BROKEN: &str = include_str!("../../../e2e/fixtures/subtitles/timedtext-broken.xml");
    const JSON3: &str = include_str!("../../../e2e/fixtures/subtitles/timedtext.json3");
    const JSON3_BROKEN: &str =
        include_str!("../../../e2e/fixtures/subtitles/timedtext-broken.json3");

    #[test]
    fn xml_transcript_fixture_entities_and_newlines() {
        let parsed = parse_xml(XML);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 1_280,
                    end_ms: 3_680,
                    text: "Hello & welcome!".into()
                },
                Cue {
                    start_ms: 4_000,
                    end_ms: 6_500,
                    text: "Line one\nLine two".into() // перенос внутри <text>
                },
                Cue {
                    start_ms: 7_200,
                    end_ms: 9_200,
                    text: "It's double-encoded".into() // &amp;#39; → ' (два прохода)
                },
                Cue {
                    start_ms: 9_800,
                    end_ms: 10_800,
                    text: "styled inside".into() // экранированный <font> вырезан
                },
            ]
        );
    }

    #[test]
    fn xml_legacy_fixture_t_d_milliseconds() {
        let parsed = parse_xml(XML_LEGACY);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 1_000,
                    end_ms: 3_000,
                    text: "Legacy first".into()
                },
                Cue {
                    start_ms: 3_500,
                    end_ms: 5_000,
                    text: "Legacy second".into()
                },
            ]
        );
    }

    #[test]
    fn xml_broken_fixture_diagnoses_and_salvages() {
        let parsed = parse_xml(XML_BROKEN);
        assert_eq!(parsed.cues.len(), 1, "{:?}", parsed.cues);
        assert_eq!(
            parsed.cues[0],
            Cue {
                start_ms: 3_000,
                end_ms: 4_000,
                text: "незакрытый элемент".into() // незакрытый <text> — взяли как есть
            }
        );
        // Четвёртое предупреждение — сам незакрытый документ (quick-xml
        // проверяет парность тегов): диагностика + salvaged cue.
        assert_eq!(parsed.warnings.len(), 4, "{:?}", parsed.warnings);
        assert!(parsed.warnings[0].message.contains("dur"));
        assert!(parsed.warnings[1].message.contains("start"));
        assert!(parsed.warnings[2].message.contains("start"));
        assert!(parsed.warnings[3].message.contains("битый XML"));
    }

    #[test]
    fn json3_fixture_appends_merged_service_events_skipped() {
        let parsed = parse_json3(JSON3);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 0,
                    end_ms: 6_000, // конец пословных приклеек: max(3000, 4000+2000)
                    text: "hello world".into()
                },
                Cue {
                    start_ms: 6_000,
                    end_ms: 8_500, // max(6000+2500, 7000+1000)
                    text: "Second line\ncontinued".into()
                },
            ]
        );
    }

    #[test]
    fn json3_broken_is_warning_not_panic() {
        let parsed = parse_json3(JSON3_BROKEN);
        assert!(parsed.cues.is_empty());
        assert_eq!(parsed.warnings.len(), 1);
        assert!(parsed.warnings[0].message.contains("битый JSON3"));
    }

    #[test]
    fn format_detection_by_first_char() {
        assert_eq!(parse(JSON3).cues, parse_json3(JSON3).cues);
        assert_eq!(parse(XML).cues, parse_xml(XML).cues);
        // BOM не мешает детекции JSON3
        let bom_json = format!("\u{FEFF}{}", JSON3.trim());
        assert_eq!(parse(&bom_json).cues, parse_json3(JSON3).cues);
    }

    #[test]
    fn json3_edge_cases_inline() {
        // нет массива events
        let no_events = parse_json3("{\"foo\":1}");
        assert!(no_events.cues.is_empty());
        assert!(no_events.warnings[0].message.contains("events"));

        // событие с segs, но без tStartMs — диагностируется
        let no_start =
            parse_json3("{\"events\":[{\"dDurationMs\":100,\"segs\":[{\"utf8\":\"x\"}]}]}");
        assert!(no_start.cues.is_empty());
        assert!(no_start.warnings[0].message.contains("tStartMs"));

        // пустой текст — пост-фильтр с диагностикой
        let empty_text = parse_json3(
            "{\"events\":[{\"tStartMs\":0,\"dDurationMs\":500,\"segs\":[{\"utf8\":\"  \"}]}]}",
        );
        assert!(empty_text.cues.is_empty());
        assert!(empty_text.warnings[0].message.contains("пустой текст"));

        // без dDurationMs — нулевая длительность, диагностика
        let no_dur = parse_json3("{\"events\":[{\"tStartMs\":0,\"segs\":[{\"utf8\":\"x\"}]}]}");
        assert!(no_dur.cues.is_empty());
        assert!(no_dur.warnings[0].message.contains("≤ начало"));
    }

    #[test]
    fn xml_empty_input_is_silent() {
        let parsed = parse_xml("");
        assert_eq!((parsed.cues.len(), parsed.warnings.len()), (0, 0));
        let parsed = parse("");
        assert_eq!((parsed.cues.len(), parsed.warnings.len()), (0, 0));
    }
}
