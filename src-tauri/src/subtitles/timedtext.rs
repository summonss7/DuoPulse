//! Парсер YouTube timedtext — задача 3.1 (docs/05 §1). Два формата ответа
//! `api/timedtext`:
//!
//! - XML: современный `<transcript><text start="…" dur="…">` (секунды с
//!   дробью) и старый `<timedtext><body><p t="…" d="…">` (миллисекунды).
//!   Внутри текста — теги (`<font>`) и сущности, которые YouTube экранирует
//!   дважды (`&amp;#39;` → `'`): декодируем два прохода, затем вырезаем теги.
//! - JSON3 (`fmt=json3`): `events[].{tStartMs, dDurationMs, segs[].utf8}`.
//!   События без `segs` — служебные (окна/формат), пропускаются тихо;
//!   события с `aAppend` — пословный режим автосубтитров (карточки
//!   duopulse-094, duopulse-113): слово появляется в момент речи, на
//!   экране всегда ОДНА строка — набираемая; завершённая (уже проговорённая)
//!   строка держится только до первого слова следующей, стопки строк нет.
//!   Дорожка без `aAppend` (ручные дорожки и часть сессий автодорожек —
//!   состав событий ASR варьируется, duopulse-200/209): ручное событие —
//!   cue своей длительности (многострочные диалоги стеком); ASR-события
//!   режутся на строки по пословному `tOffsetMs` сегментов (или поровну
//!   по длительности окна), концы зажаты соседями — иначе перекрытия
//!   длительностей склеивались движком показа в cue на всё окно/клип.
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
    ParsedCues { cues, warnings, top_cue_starts: Vec::new() }
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
    let mut warnings: Vec<ParseWarning> = Vec::new();
    // normalize снимает BOM (serde_json его не принимает) и CRLF.
    let value: serde_json::Value = match serde_json::from_str(&super::normalize(input)) {
        Ok(v) => v,
        Err(err) => {
            warnings.push(ParseWarning {
                line: 0,
                message: format!("битый JSON3 ({err})"),
            });
            return ParsedCues {
                cues: Vec::new(),
                warnings,
                top_cue_starts: Vec::new(),
            };
        }
    };
    let Some(events) = value.get("events").and_then(|v| v.as_array()) else {
        warnings.push(ParseWarning {
            line: 0,
            message: "нет массива events — дорожка пуста".into(),
        });
        return ParsedCues {
            cues: Vec::new(),
            warnings,
            top_cue_starts: Vec::new(),
        };
    };
    // Контентные события: текст + тайминги; служебные (без segs) пропускаются.
    let mut content: Vec<Json3Event> = Vec::new();
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
        let seg_list: Vec<Json3Seg> = segs
            .iter()
            .filter_map(|s| {
                let utf8 = s.get("utf8").and_then(|v| v.as_str())?;
                Some(Json3Seg {
                    offset_ms: s.get("tOffsetMs").and_then(|v| v.as_i64()),
                    utf8: utf8.to_string(),
                })
            })
            .collect();
        content.push(Json3Event {
            start_ms,
            dur_ms: event
                .get("dDurationMs")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            append: truthy(event.get("aAppend")),
            // wWinId на контентном событии — маркер ASR-окна автодорожки
            // (у событий ручных дорожек его нет).
            window: event.get("wWinId").is_some(),
            segs: seg_list,
        });
    }
    let cues = if content.iter().any(|e| e.append) {
        parse_json3_rolling(&content)
    } else {
        parse_json3_plain(&content)
    };
    let cues = finalize_cues(cues, &mut warnings);
    ParsedCues { cues, warnings, top_cue_starts: Vec::new() }
}

/// Сегмент события JSON3: текст + пословный тайминг автодорожек
/// (`tOffsetMs` — offset от начала события; у ручных дорожек его нет).
struct Json3Seg {
    offset_ms: Option<i64>,
    utf8: String,
}

/// Контентное событие JSON3 (текст события = склейка utf8 его segs).
struct Json3Event {
    start_ms: i64,
    dur_ms: i64,
    append: bool,
    /// Событие принадлежит ASR-окну (wWinId): автодорожка, не ручной диалог.
    window: bool,
    segs: Vec<Json3Seg>,
}

impl Json3Event {
    /// Склейка текста segs (порядок исходный, «\n» сохранены).
    fn text(&self) -> String {
        self.segs.iter().map(|s| s.utf8.as_str()).collect()
    }
}

/// Дорожка БЕЗ aAppend (ручные дорожки и часть сессий автодорожек —
/// карточки duopulse-200/209: состав событий ASR варьируется от сессии
/// к сессии). Три случая:
///
/// - События с пословным `tOffsetMs` (ASR): каждая СТРОКА события —
///   самостоятельный cue; конец строки — начало следующей строки или
///   следующего события, НЕ длительность окна (`dDurationMs` окна/фразы
///   перекрывает соседей — движок показа склеил бы цепочку в один cue
///   на всё окно: текст «застывал» на минуты, duopulse-209).
/// - ASR-окно (wWinId) без оффсетов: строки режут длительность события
///   поровну — иначе «окно» музыкальной секции висело весь клип
///   (587 знаков / 22 строки одним cue, duopulse-200).
/// - Ручные дорожки (без оффсетов и wWinId): событие — один cue своей
///   длительности, многострочные диалоги — стеком, как нативный плеер.
fn parse_json3_plain(content: &[Json3Event]) -> Vec<Cue> {
    let mut cues: Vec<Cue> = Vec::new();
    for (i, ev) in content.iter().enumerate() {
        let next_start = content.get(i + 1).map(|e| e.start_ms);
        let ev_end = ev.start_ms.saturating_add(ev.dur_ms);
        if !ev.segs.iter().any(|s| s.offset_ms.is_some()) {
            let text = ev.text();
            if !ev.window || !text.contains('\n') {
                // Ручная дорожка/однострочное событие — как раньше.
                cues.push(Cue {
                    start_ms: ev.start_ms,
                    end_ms: ev_end,
                    text,
                });
                continue;
            }
            // ASR-окно без пословного тайминга: поровну по строкам
            // (нулевая длительность — как есть, пост-фильтр отбросит).
            if ev.dur_ms > 0 {
                let lines: Vec<&str> =
                    text.split('\n').filter(|l| !l.trim().is_empty()).collect();
                let n = lines.len().max(1) as i64;
                let step = (ev.dur_ms + n - 1) / n;
                let mut start = ev.start_ms;
                for line in lines {
                    let end = start.saturating_add(step).min(ev_end);
                    cues.push(Cue {
                        start_ms: start,
                        end_ms: end,
                        text: line.to_string(),
                    });
                    start = end;
                }
            } else {
                cues.push(Cue {
                    start_ms: ev.start_ms,
                    end_ms: ev_end,
                    text,
                });
            }
            continue;
        }
        // Пословный тайминг: строки события со своим временем. Оффсет
        // строки — tOffsetMs её первого сегмента (нет у первого —
        // наследуется от предыдущего известного).
        let mut lines: Vec<(i64, String)> = Vec::new();
        let mut cur_off: Option<i64> = None;
        let mut cur = String::new();
        for seg in &ev.segs {
            let parts: Vec<&str> = seg.utf8.split('\n').collect();
            for (k, part) in parts.iter().enumerate() {
                if k == 0 {
                    if cur_off.is_none() {
                        cur_off = seg.offset_ms;
                    }
                    cur.push_str(part);
                } else {
                    if !cur.trim().is_empty() {
                        lines.push((cur_off.unwrap_or(0), cur.clone()));
                    }
                    cur.clear();
                    // Строка начинается с этого сегмента, если он принёс
                    // текст; голый «\n» — только разрыв: оффсет возьмётся
                    // от первого слова новой строки (как в rolling-ветке).
                    cur_off = if part.is_empty() { None } else { seg.offset_ms };
                    cur.push_str(part);
                }
            }
        }
        if !cur.trim().is_empty() {
            lines.push((cur_off.unwrap_or(0), cur.clone()));
        }
        for (j, (off, line)) in lines.iter().enumerate() {
            let start = ev.start_ms.saturating_add(*off);
            let mut end = match lines.get(j + 1) {
                // Конец строки — начало следующей строки события…
                Some((next_off, _)) => ev.start_ms.saturating_add(*next_off),
                // …последней — конец события, но не дальше соседа-события
                // (перекрытия окон склеивались движком в мега-cue).
                None => ev_end.max(start + 1),
            };
            if let Some(ns) = next_start {
                end = end.min(ns);
            }
            cues.push(Cue {
                start_ms: start,
                end_ms: end,
                text: line.clone(),
            });
        }
    }
    cues
}

/// Пословный режим автосубтитров (aAppend, карточки duopulse-094, duopulse-113):
/// слова приходят отдельными событиями с пословным таймингом, «\n» в segs —
/// конец строки. На экране всегда одна строка — набираемая (слово появляется
/// в момент речи); завершённая строка уже проговорена и держится только до
/// первого слова следующей (пауза между фразами), стопки «старая над новой»
/// больше нет — пожелание Артёма (duopulse-113; до этого показывали последние
/// две строки прокруткой, как нативный плеер — duopulse-094). Каждый content-cue
/// — «что видно сейчас» (конец — начало следующего события), cue без смены
/// текста продлевают предыдущий. Раньше (до duopulse-094) все слова
/// приклеивались в один гигантский cue на всё окно — плашка закрывала экран.
fn parse_json3_rolling(content: &[Json3Event]) -> Vec<Cue> {
    let mut cues: Vec<Cue> = Vec::new();
    // Набираемая строка (пословный хвост без переноса) и последняя завершённая
    // («\n») — её показываем в паузе, пока не началась следующая.
    let mut held = String::new();
    let mut cur = String::new();

    let commit = |held: &mut String, cur: &mut String| {
        let line = cur.trim().to_string();
        cur.clear();
        if !line.is_empty() {
            *held = line;
        }
    };

    for (i, ev) in content.iter().enumerate() {
        // Неприклеиваемое событие посреди строки — новое окно показа: строку
        // завершаем, текст события начинает следующую.
        if !ev.append && !cur.trim().is_empty() {
            commit(&mut held, &mut cur);
        }
        let text = ev.text();
        let parts: Vec<&str> = text.split('\n').collect();
        for (pi, part) in parts.iter().enumerate() {
            cur.push_str(part);
            if pi + 1 < parts.len() {
                commit(&mut held, &mut cur);
            }
        }
        // Видна одна строка: набираемая, пуста — завершённая (пауза между фразами).
        let visible = match cur.trim() {
            "" => held.as_str(),
            head => head,
        };
        if visible.is_empty() {
            continue;
        }
        // Показ тикает до следующего события; последнее — своей длительностью.
        let end_ms = match content.get(i + 1) {
            Some(next) => next.start_ms,
            None => ev.start_ms.saturating_add(ev.dur_ms.max(1)),
        };
        match cues.last_mut() {
            // Текст не сменился (например, событие-«\n») — только продлеваем.
            Some(prev) if prev.text == visible => prev.end_ms = prev.end_ms.max(end_ms),
            _ => {
                if end_ms > ev.start_ms {
                    cues.push(Cue {
                        start_ms: ev.start_ms,
                        end_ms,
                        text: visible.to_string(),
                    });
                }
            }
        }
    }
    cues
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
    const ASR_JSON3: &str = include_str!("../../../e2e/fixtures/subtitles/timedtext-asr.json3");
    const JSON3_BROKEN: &str =
        include_str!("../../../e2e/fixtures/subtitles/timedtext-broken.json3");
    /// Живое тело дорожки ro:asr (клип lITL-sPvlQk, веб-сессия 22.11,
    /// duopulse-209): вариант с aAppend — пословный rolling.
    const LIVE_RO_ASR_JSON3: &str =
        include_str!("../../../e2e/fixtures/subtitles/timedtext-ro-asr-live.json3");

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
    fn json3_fixture_rolling_progressive_service_events_skipped() {
        let parsed = parse_json3(JSON3);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 0,
                    end_ms: 4_000, // до следующего пословного события
                    text: "hello".into()
                },
                Cue {
                    start_ms: 4_000,
                    end_ms: 6_000,
                    text: "hello world".into()
                },
                // Строка «Second line\n» пришла целиком: завершённая видна
                // до начала следующей (пауза), без стопки строк
                Cue {
                    start_ms: 6_000,
                    end_ms: 7_000,
                    text: "Second line".into()
                },
                Cue {
                    start_ms: 7_000,
                    end_ms: 8_000, // последнее событие — своей длительностью
                    text: "continued".into()
                },
            ]
        );
    }

    #[test]
    fn json3_asr_fixture_rolling_single_line_word_by_word() {
        // Карточки duopulse-094/113: пословные автосубтитры показываются
        // ОДНОЙ строкой — набираемое слово в момент речи, завершённая строка
        // (уже проговорённая) не висит над новой, а держится лишь до первого
        // слова следующей фразы (события-«\n» продлевают показ).
        let parsed = parse_json3(ASR_JSON3);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 470,
                    end_ms: 1_080,
                    text: "we've".into()
                },
                // событие-«\n» (1330) не сменило текст — показ продлен до «a»
                Cue {
                    start_ms: 1_080,
                    end_ms: 1_680,
                    text: "we've got".into()
                },
                Cue {
                    start_ms: 1_680,
                    end_ms: 2_000,
                    text: "a".into()
                },
                // событие-«\n» (5000) продлило фразу до слова «next»
                Cue {
                    start_ms: 2_000,
                    end_ms: 5_300,
                    text: "a problem".into()
                },
                Cue {
                    start_ms: 5_300,
                    end_ms: 5_800,
                    text: "next".into()
                },
                Cue {
                    start_ms: 5_800,
                    end_ms: 6_200,
                    text: "next phrase".into()
                },
                Cue {
                    start_ms: 6_200,
                    end_ms: 6_800,
                    text: "next phrase here".into()
                },
            ]
        );
        // На экране всегда одна строка — уже проговоренное не показывается.
        for cue in &parsed.cues {
            assert!(!cue.text.contains('\n'), "{:?}", cue.text);
        }
    }

    #[test]
    fn json3_plain_asr_window_with_offsets_splits_lines() {
        // duopulse-209: сессия без aAppend отдаёт ASR «окнами» — событие
        // несёт строки целиком, dDurationMs перекрывает соседей. Строки
        // обязаны стать самостоятельными cue: конец — начало следующей
        // строки/события, а не длительность окна.
        let parsed = parse_json3(
            "{\"events\":[
              {\"tStartMs\":1000,\"dDurationMs\":9000,\"wWinId\":1,\"segs\":[
                {\"utf8\":\">> prima\",\"tOffsetMs\":0},
                {\"utf8\":\" linie\",\"tOffsetMs\":1500},
                {\"utf8\":\"\\n\",\"tOffsetMs\":3000},
                {\"utf8\":\"a doua\",\"tOffsetMs\":3200},
                {\"utf8\":\" linie\",\"tOffsetMs\":4200},
                {\"utf8\":\"\\n a treia\",\"tOffsetMs\":5000}]},
              {\"tStartMs\":8000,\"dDurationMs\":2000,\"wWinId\":1,\"segs\":[
                {\"utf8\":\"next\",\"tOffsetMs\":0}]}]}",
        );
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 1_000,
                    end_ms: 4_200, // начало строки 2, не конец окна (10 c)
                    text: ">> prima linie".into()
                },
                Cue {
                    start_ms: 4_200,
                    end_ms: 6_000, // начало строки 3
                    text: "a doua linie".into()
                },
                Cue {
                    start_ms: 6_000,
                    end_ms: 8_000, // min(конец события 10 c, сосед 8 c)
                    text: "a treia".into()
                },
                Cue {
                    start_ms: 8_000,
                    end_ms: 10_000,
                    text: "next".into()
                },
            ],
            "{:?}",
            parsed.cues
        );
        // Перекрытий нет — движок показа не склеит цепочку в мега-cue.
        for w in &parsed.warnings {
            assert!(!w.message.contains("перекрывает"), "{:?}", parsed.warnings);
        }
    }

    #[test]
    fn json3_plain_asr_phrases_clamped_to_next_event() {
        // Вариант «фразы» (живое тело 22.11): события без aAppend, segs
        // с пословным tOffsetMs, dDurationMs фраз залезает на соседа —
        // до фикса движок склеивал их тексты через \n в cue на всё окно.
        let parsed = parse_json3(
            "{\"events\":[
              {\"tStartMs\":0,\"dDurationMs\":7680,\"wWinId\":1,\"segs\":[
                {\"utf8\":\">> nu\",\"tOffsetMs\":0},
                {\"utf8\":\" ne-am\",\"tOffsetMs\":160},
                {\"utf8\":\" mai\",\"tOffsetMs\":400},
                {\"utf8\":\" iubit,\",\"tOffsetMs\":640}]},
              {\"tStartMs\":2080,\"dDurationMs\":5000,\"wWinId\":1,\"segs\":[
                {\"utf8\":\"nu ne-am mai sunat.\",\"tOffsetMs\":0}]}]}",
        );
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 0,
                    end_ms: 2_080, // зажат началом соседа, не 7 680
                    text: ">> nu ne-am mai iubit,".into()
                },
                Cue {
                    start_ms: 2_080,
                    end_ms: 7_080,
                    text: "nu ne-am mai sunat.".into()
                },
            ],
            "{:?}",
            parsed.cues
        );
    }

    #[test]
    fn json3_plain_manual_multiline_stays_one_cue() {
        // Ручные дорожки (нет wWinId/tOffsetMs): двухстрочный диалог —
        // один cue стеком, как нативный плеер (регресс-охрана фикса 209).
        let parsed = parse_json3(
            "{\"events\":[{\"tStartMs\":1000,\"dDurationMs\":2000,\"segs\":[
              {\"utf8\":\"— Привет\\n— Здравствуйте\"}]}]}",
        );
        assert_eq!(parsed.cues.len(), 1);
        assert_eq!(parsed.cues[0].text, "— Привет\n— Здравствуйте");
    }

    #[test]
    fn json3_plain_window_without_offsets_even_split() {
        // duopulse-200: окно музсекции одним событием без пословного
        // тайминга (587 знаков / 22 строки) — режем длительность поровну,
        // чтобы текст не висел весь клип.
        let parsed = parse_json3(
            "{\"events\":[{\"tStartMs\":0,\"dDurationMs\":9000,\"wWinId\":1,\"segs\":[
              {\"utf8\":\"[muzică]\\nlasă-mă\\npleacă\"}]}]}",
        );
        assert_eq!(
            parsed.cues,
            vec![
                Cue { start_ms: 0, end_ms: 3_000, text: "[muzică]".into() },
                Cue { start_ms: 3_000, end_ms: 6_000, text: "lasă-mă".into() },
                Cue { start_ms: 6_000, end_ms: 9_000, text: "pleacă".into() },
            ],
            "{:?}",
            parsed.cues
        );
    }

    #[test]
    fn json3_live_ro_asr_body_rolling_not_regressed() {
        // Живое тело дорожки ro:asr клипа lITL-sPvlQk (веб-сессия 22.11,
        // захват e2e-пробником duopulse-209): сессия с aAppend — пословный
        // rolling. Фикс 209 не должен его менять: одна строка на cue,
        // начало — не убывает, гигантских cue нет.
        let parsed = parse_json3(LIVE_RO_ASR_JSON3);
        assert!(parsed.cues.len() > 40, "cues={}", parsed.cues.len());
        let mut prev_start = i64::MIN;
        for cue in &parsed.cues {
            assert!(!cue.text.contains('\n'), "{:?}", cue.text);
            assert!(cue.text.chars().count() < 240, "гигантский cue: {:?}", cue.text);
            assert!(cue.start_ms >= prev_start, "не монотонно: {:?}", parsed.cues);
            prev_start = cue.start_ms;
        }
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
