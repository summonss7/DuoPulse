//! Парсер SubRip (.srt) — задача 3.1 (docs/05 §1). Блок между пустыми
//! строками: необязательный номер cue, строка тайминга `HH:MM:SS,mmm -->
//! HH:MM:SS,mmm`, строки текста.
//!
//! Разбор снисходительный: номер может отсутствовать и не сверяется (дубли/
//! пропуски — норма рукодельных файлов), миллисекунды через запятую или
//! точку, часы можно опустить, BOM и CRLF допускаются; битые блоки
//! пропускаются с предупреждением (с номером строки), разбор продолжается.

use super::{finalize_cues, parse_timing_line, strip_markup, Cue, ParseWarning, ParsedCues};

pub fn parse(input: &str) -> ParsedCues {
    let src = super::normalize(input);
    let mut cues: Vec<Cue> = Vec::new();
    let mut warnings: Vec<ParseWarning> = Vec::new();
    let mut block: Vec<(usize, &str)> = Vec::new();
    for (i, line) in src.lines().enumerate() {
        if line.trim().is_empty() {
            parse_block(&block, &mut cues, &mut warnings);
            block.clear();
        } else {
            block.push((i + 1, line));
        }
    }
    parse_block(&block, &mut cues, &mut warnings);
    let cues = finalize_cues(cues, &mut warnings);
    ParsedCues { cues, warnings }
}

/// Один блок файла: строки `(номер, текст)` до первой пустой.
fn parse_block(block: &[(usize, &str)], cues: &mut Vec<Cue>, warnings: &mut Vec<ParseWarning>) {
    if block.is_empty() {
        return;
    }
    // Строка тайминга — первая с «-->»; всё до неё — номер cue (игнорируется).
    let Some(t) = block.iter().position(|(_, l)| l.contains("-->")) else {
        let body: String = block.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
        if body.trim().chars().all(|c| c.is_ascii_digit()) {
            return; // одиночный номер без блока — артефакт редакторов, не диагностируем
        }
        warnings.push(ParseWarning {
            line: block[0].0,
            message: "блок без строки тайминга пропущен".into(),
        });
        return;
    };
    let Some((start_ms, end_ms)) = parse_timing_line(block[t].1) else {
        warnings.push(ParseWarning {
            line: block[t].0,
            message: format!(
                "не разобрать тайминг «{}» — блок пропущен",
                block[t].1.trim()
            ),
        });
        return;
    };
    let text: String = block[t + 1..]
        .iter()
        .map(|(_, l)| *l)
        .collect::<Vec<_>>()
        .join("\n");
    let text = strip_markup(&text).trim().to_string();
    if text.is_empty() {
        warnings.push(ParseWarning {
            line: block[t].0,
            message: "cue без текста пропущен".into(),
        });
        return;
    }
    if end_ms <= start_ms {
        warnings.push(ParseWarning {
            line: block[t].0,
            message: format!(
                "битый тайминг (конец {} мс ≤ начало {} мс) — cue пропущен",
                end_ms, start_ms
            ),
        });
        return;
    }
    cues.push(Cue {
        start_ms,
        end_ms,
        text,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../../../e2e/fixtures/subtitles/sample.srt");
    const EDGE: &str = include_str!("../../../e2e/fixtures/subtitles/srt-edge.srt");
    const BROKEN: &str = include_str!("../../../e2e/fixtures/subtitles/srt-broken.srt");

    #[test]
    fn sample_fixture_cue_boundaries() {
        let parsed = parse(SAMPLE);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 1_000,
                    end_ms: 3_500,
                    text: "Hello, world!\nFirst subtitle line two".into()
                },
                Cue {
                    start_ms: 4_000,
                    end_ms: 6_000,
                    text: "Styled text & more".into() // <i> вырезан, & — литерал
                },
                Cue {
                    start_ms: 62_250,
                    end_ms: 64_750,
                    text: "Финальная реплика".into()
                },
            ]
        );
    }

    #[test]
    fn edge_fixture_bom_dot_millis_no_index_overlap() {
        let parsed = parse(EDGE);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 10_000,
                    end_ms: 12_000,
                    text: "Edge one".into()
                },
                Cue {
                    start_ms: 11_500,
                    end_ms: 13_000,
                    text: "Overlapping cue without index".into()
                },
            ]
        );
        // перекрытие сохранено и продиагностировано (смёржит движок показа)
        assert_eq!(parsed.warnings.len(), 1);
        assert!(parsed.warnings[0].message.contains("перекрывает"));
    }

    #[test]
    fn broken_fixture_never_panics_and_diagnoses() {
        let parsed = parse(BROKEN);
        assert_eq!(
            parsed.cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 3_000,
                text: "Good cue".into()
            }]
        );
        let lines: Vec<usize> = parsed.warnings.iter().map(|w| w.line).collect();
        assert_eq!(lines, vec![6, 10, 13, 16], "{:?}", parsed.warnings);
        assert!(parsed.warnings[0].message.contains("≤ начало"));
        assert!(parsed.warnings[1].message.contains("не разобрать тайминг"));
        assert!(parsed.warnings[2].message.contains("без строки тайминга"));
        assert!(parsed.warnings[3].message.contains("без текста"));
    }

    #[test]
    fn empty_and_garbage_inputs() {
        let empty = parse("");
        assert_eq!((empty.cues.len(), empty.warnings.len()), (0, 0));

        let stray_number = parse("42\n");
        assert_eq!(
            (stray_number.cues.len(), stray_number.warnings.len()),
            (0, 0)
        );

        let text_only = parse("просто текст без таймингов");
        assert_eq!(text_only.cues.len(), 0);
        assert_eq!(text_only.warnings.len(), 1);
        assert!(text_only.warnings[0]
            .message
            .contains("без строки тайминга"));
    }

    #[test]
    fn crlf_line_endings_and_bom_inline() {
        let src = "\u{FEFF}1\r\n00:00:01,000 --> 00:00:02,000\r\nCRLF текст\r\n";
        let parsed = parse(src);
        assert_eq!(
            parsed.cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "CRLF текст".into()
            }]
        );
        assert!(parsed.warnings.is_empty());
    }
}
