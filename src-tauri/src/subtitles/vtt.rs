//! Парсер WebVTT (.vtt) — задача 3.1 (docs/05 §1). Заголовочный блок
//! `WEBVTT …`, блоки метаданных (`NOTE`/`STYLE`/`REGION`) пропускаются;
//! cue — необязательный идентификатор, строка тайминга
//! `[[HH:]MM:]SS.mmm --> [[HH:]MM:]SS.mmm [настройки]`, строки текста.
//!
//! Отсутствие заголовка WEBVTT и битые блоки — предупреждение, разбор
//! продолжается (правило карточки duopulse-022: не падать, диагностировать).
//! Текст: теги cue-разметки (`<c>`, `<v Имя>`…) вырезаются, сущности
//! (`&amp;`, `&lt;`, `&gt;`, `&nbsp;`, `&lrm;`, `&rlm;`) декодируются —
//! экранированный `&lt;b&gt;` остаётся литеральным `<b>`.

use super::{
    decode_entities, finalize_cues, parse_timing_line, strip_markup, Cue, ParseWarning, ParsedCues,
};

pub fn parse(input: &str) -> ParsedCues {
    let src = super::normalize(input);
    let mut cues: Vec<Cue> = Vec::new();
    let mut warnings: Vec<ParseWarning> = Vec::new();

    // Первая непустая строка должна начинаться с «WEBVTT» (дальше в ней может
    // идти произвольный текст). Нет заголовка — предупреждение, продолжаем.
    if let Some((n, first)) = src.lines().enumerate().find(|(_, l)| !l.trim().is_empty()) {
        if !first.trim_start().starts_with("WEBVTT") {
            warnings.push(ParseWarning {
                line: n + 1,
                message: "файл не начинается с WEBVTT — разбор продолжен вслепую".into(),
            });
        }
    }

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
    let Some(&(first_line, first)) = block.first() else {
        return;
    };
    // Заголовочный блок и блоки метаданных/комментариев — целиком мимо.
    let head = first.trim_start();
    if head.starts_with("WEBVTT")
        || head.starts_with("NOTE")
        || head.starts_with("STYLE")
        || head.starts_with("REGION")
    {
        return;
    }
    // Строка тайминга — первая с «-->»; до неё — идентификатор cue (игнорируется).
    let Some(t) = block.iter().position(|(_, l)| l.contains("-->")) else {
        warnings.push(ParseWarning {
            line: first_line,
            message: "блок без тайминга пропущен".into(),
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
    // Сначала теги, потом сущности: `&lt;b&gt;` становится литеральным `<b>`.
    let text = decode_entities(&strip_markup(&text), 1).trim().to_string();
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

    const SAMPLE: &str = include_str!("../../../e2e/fixtures/subtitles/sample.vtt");
    const EDGE: &str = include_str!("../../../e2e/fixtures/subtitles/vtt-edge.vtt");
    const BROKEN: &str = include_str!("../../../e2e/fixtures/subtitles/vtt-broken.vtt");

    #[test]
    fn sample_fixture_notes_styles_settings_entities() {
        let parsed = parse(SAMPLE);
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 500,
                    end_ms: 2_000,
                    text: "Hello from VTT\nwith settings ignored".into()
                },
                Cue {
                    start_ms: 4_000,
                    end_ms: 6_000,
                    text: "Second cue, short timestamps".into() // MM:SS.mmm
                },
                Cue {
                    start_ms: 3_723_400,
                    end_ms: 3_725_000,
                    text: "<b>escaped tags stay</b> & entity decoded".into()
                },
            ]
        );
    }

    #[test]
    fn edge_fixture_bom_comma_millis_overlap() {
        let parsed = parse(EDGE);
        assert_eq!(
            parsed.cues,
            vec![
                Cue {
                    start_ms: 1_000,
                    end_ms: 4_000,
                    text: "Comma millis tolerated, BOM stripped".into()
                },
                Cue {
                    start_ms: 3_000,
                    end_ms: 5_000,
                    text: "Overlaps on purpose".into()
                },
            ]
        );
        assert_eq!(parsed.warnings.len(), 1);
        assert!(parsed.warnings[0].message.contains("перекрывает"));
    }

    #[test]
    fn broken_fixture_salvages_and_diagnoses() {
        let parsed = parse(BROKEN);
        assert_eq!(
            parsed.cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "Salvaged cue despite bad header".into()
            }]
        );
        let lines: Vec<usize> = parsed.warnings.iter().map(|w| w.line).collect();
        // «random text file» диагностируется дважды: и как не-WEBVTT заголовок
        // (строка 1), и как блок без тайминга (он же первый блок).
        assert_eq!(lines, vec![1, 1, 7, 10], "{:?}", parsed.warnings);
        assert!(parsed.warnings[0].message.contains("WEBVTT"));
        assert!(parsed.warnings[1].message.contains("без тайминга"));
        assert!(parsed.warnings[2].message.contains("без тайминга"));
        assert!(parsed.warnings[3].message.contains("≤ начало"));
    }

    #[test]
    fn empty_text_cue_dropped_header_only_ok() {
        let no_text = parse("WEBVTT\n\n00:01.000 --> 00:02.000\n");
        assert!(no_text.cues.is_empty());
        assert_eq!(no_text.warnings.len(), 1);
        assert!(no_text.warnings[0].message.contains("без текста"));

        let header_only = parse("WEBVTT\n");
        assert_eq!((header_only.cues.len(), header_only.warnings.len()), (0, 0));

        let empty = parse("");
        assert_eq!((empty.cues.len(), empty.warnings.len()), (0, 0));
    }

    #[test]
    fn crlf_and_cue_voice_tags_inline() {
        let src = "WEBVTT\r\n\r\nid-1\r\n00:00:01.000 --> 00:00:02.000\r\n<v Roger>hello</v>\r\n";
        let parsed = parse(src);
        assert_eq!(
            parsed.cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "hello".into()
            }]
        );
        assert!(parsed.warnings.is_empty());
    }
}
