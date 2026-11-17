//! Парсер Advanced SubStation Alpha .ass/.ssa (карточка duopulse-178,
//! продолжение задачи 3.6 — ручные файлы субтитров). Формат: секции
//! `[Script Info]` / `[V4+ Styles]` (`[V4 Styles]` у SSA) / `[Events]`,
//! реплики — строки `Dialogue:` с полями по заголовку `Format:` (порядок
//! полей берём из него — SSA `Marked` и вольности файлов не ломают разбор),
//! тайминг `H:MM:SS.cc` (сантисекунды; терпим и `HH:MM:SS,mmm`).
//!
//! Рендер v1 — упрощённый (решение в карточке duopulse-178): текст +
//! базовые теги. Override-блоки `{\…}` вырезаются; из них используется
//! только выравнивание `\an7/8/9` (легаси SSA `\a5/6/7`) — реплика верхнего
//! расположения, её startMs уходит боковым каналом `ParsedCues::
//! top_cue_starts` (Cue не меняется). `\N`/`\n` → перенос строки, `\h` →
//! nbsp; строки-рисунки (`{\p1}` … `{\p0}` — векторные команды тайпсета
//! опенингов) выбрасываются целиком, иначе команды окажутся текстом.
//! Стили `[V4+ Styles]` (гарнитура/цвет/кегль), `\pos`/`\t`/караоке `\k`
//! не рендерятся — плашка DuoPulse сохраняет фирменный вид (гайд 06 §6).
//!
//! Контракт устойчивости общий (карточка duopulse-022): битые строки
//! пропускаются с предупреждением (номер строки), разбор продолжается;
//! `Comment:` и прочие типы событий игнорируются.

use super::{finalize_cues, normalize, parse_timestamp, warn, Cue, ParseWarning, ParsedCues};

/// Разобрать .ass/.ssa целиком.
pub fn parse(input: &str) -> ParsedCues {
    let src = normalize(input);
    let mut cues: Vec<Cue> = Vec::new();
    let mut warnings: Vec<ParseWarning> = Vec::new();
    let mut top_cue_starts: Vec<i64> = Vec::new();
    let mut in_events = false;
    /// Поля `Format:` секции [Events] нижним регистром; стандартный порядок
    /// ASS — до первого Format (файлы без Format тоже встречаются).
    let mut event_fields: Vec<String> = DEFAULT_EVENT_FIELDS
        .iter()
        .map(|s| s.to_string())
        .collect();
    for (i, line) in src.lines().enumerate() {
        let line_no = i + 1;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            let section = line[1..line.len() - 1].trim().to_ascii_lowercase();
            in_events = section == "events";
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue; // строки вне «Ключ: значение» (стили [Script Info] и пр.) не наши
        };
        let key = key.trim().to_ascii_lowercase();
        if !in_events {
            continue; // Style:/Fontname:/… — v1 не рендерим (решение duopulse-178)
        }
        if key == "format" {
            event_fields = rest.split(',').map(|f| f.trim().to_ascii_lowercase()).collect();
        } else if key == "dialogue" {
            parse_dialogue(
                rest.trim_start(),
                line_no,
                &event_fields,
                &mut cues,
                &mut top_cue_starts,
                &mut warnings,
            );
        }
        // Comment:/Picture:/Sound:/Command: — не реплики, игнорируем молча
    }
    // Ключи top_cue_starts могут ссылаться на cue, выброшенные finalize
    // (пустой текст/вырожденный тайминг) — чистим по факту.
    let cues = finalize_cues(cues, &mut warnings);
    top_cue_starts.retain(|start| cues.iter().any(|c| c.start_ms == *start));
    top_cue_starts.sort_unstable();
    top_cue_starts.dedup();
    ParsedCues {
        cues,
        warnings,
        top_cue_starts,
    }
}

/// Стандартный порядок полей Dialogue ASS v4+ (SSA v4 отличается только
/// первым полем Marked вместо Layer — индексы Start/End/Text те же).
const DEFAULT_EVENT_FIELDS: [&str; 10] = [
    "layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect",
    "text",
];

/// Одна строка `Dialogue:`: поля по event_fields (Text — последнее, запятые
/// внутри текста сохраняет splitn), тайминг → cue, текст — чистка тегов.
fn parse_dialogue(
    rest: &str,
    line_no: usize,
    event_fields: &[String],
    cues: &mut Vec<Cue>,
    top_cue_starts: &mut Vec<i64>,
    warnings: &mut Vec<ParseWarning>,
) {
    let count = event_fields.len().max(2);
    let parts: Vec<&str> = rest.splitn(count, ',').collect();
    let field = |name: &str| -> Option<&str> {
        event_fields
            .iter()
            .position(|f| f == name)
            .and_then(|i| parts.get(i).copied())
    };
    let Some(start) = field("start").and_then(parse_timestamp) else {
        warnings.push(warn(line_no, "Dialogue без валидного начала — пропущена"));
        return;
    };
    let Some(end) = field("end").and_then(parse_timestamp) else {
        warnings.push(warn(line_no, "Dialogue без валидного конца — пропущена"));
        return;
    };
    // Текст — последнее поле Format (в ASS/SSA всегда последнее); файлах без
    // поля Text берём хвост строки как есть.
    let raw_text = field("text").unwrap_or_else(|| parts.last().copied().unwrap_or(""));
    let (text, top) = clean_text(raw_text);
    if text.trim().is_empty() {
        return; // рисунок {\p} или пустая реплика — не cue (молча: в опенингах их сотни)
    }
    if top {
        top_cue_starts.push(start);
    }
    cues.push(Cue {
        start_ms: start,
        end_ms: end,
        text,
    });
}

/// Чистка текста реплики: override-блоки `{\…}` вырезаются (из них берём
/// только выравнивание `\an7/8/9`, легаси `\a5/6/7` → верх), `\N`/`\n` →
/// перенос, `\h` → nbsp; рисунки (`{\p1}`…`{\p0}`) — текст между ними
/// выбрасывается. Возврат — (текст, верхнее ли расположение).
fn clean_text(raw: &str) -> (String, bool) {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::with_capacity(raw.len());
    let mut top = false;
    let mut drawing = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '{' {
            // Блок до парной `}` (без переноса); непарная — литерал (как libass)
            let Some(rel) = chars[i + 1..].iter().position(|&x| x == '}') else {
                out.push(c);
                i += 1;
                continue;
            };
            let block: String = chars[i + 1..i + 1 + rel].iter().collect();
            // \an — нумпад: 7/8/9 верх (последний тег в строке выигрывает)
            if let Some(n) = tag_u32(&block, "\\an") {
                top = (7..=9).contains(&n);
            }
            // легаси SSA \a: 5/6/7 — верх (лево/центр/право)
            if let Some(n) = tag_u32(&block, "\\a") {
                if (5..=7).contains(&n) {
                    top = true;
                }
            }
            if let Some(n) = tag_u32(&block, "\\p") {
                drawing = n != 0;
            }
            i += rel + 2;
            continue;
        }
        if drawing {
            i += 1;
            continue; // команды рисунка — не текст
        }
        if c == '\\' {
            match chars.get(i + 1) {
                Some('N') | Some('n') => {
                    out.push('\n');
                    i += 2;
                    continue;
                }
                Some('h') => {
                    out.push('\u{A0}');
                    i += 2;
                    continue;
                }
                _ => {} // прочие внетеговые `\x` — литерал
            }
        }
        out.push(c);
        i += 1;
    }
    (out, top)
}

/// Значение числового тега `\имя<цифры>` в блоке override (`\an8` → 8);
/// отрицательные/дробные значения тегов не бывает у интересующих нас тегов.
fn tag_u32(block: &str, name: &str) -> Option<u32> {
    let mut from = 0;
    while let Some(rel) = block[from..].find(name) {
        let digits_start = from + rel + name.len();
        let digits: String = block[digits_start..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(v) = digits.parse() {
            return Some(v);
        }
        from = digits_start;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\u{FEFF}[Script Info]\r\nTitle: тест\r\nPlayResX: 1920\r\n\r\n[V4+ Styles]\r\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\r\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\r\n\r\n[Events]\r\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\r\n";

    fn ass(events: &[&str]) -> String {
        let mut s = String::from(SAMPLE);
        for e in events {
            s.push_str("Dialogue: ");
            s.push_str(e);
            s.push_str("\r\n");
        }
        s
    }

    #[test]
    fn basic_dialogue_text_and_timing() {
        let out = parse(&ass(&["0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Привет, мир{\\i1}!{\\i0}"]));
        assert_eq!(
            out.cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 3_500,
                text: "Привет, мир!".into(),
            }]
        );
        assert!(out.warnings.is_empty());
        assert!(out.top_cue_starts.is_empty());
    }

    #[test]
    fn tags_newline_nbsp_and_strip() {
        let out = parse(&ass(&[
            "0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\fs28\\c&HFFFFFF&}первая строка\\Nвторая{\\r} строка",
            "0,0:00:03.00,0:00:04.00,Default,,0,0,0,,слово\\hврозянк5, \\nперенос",
            "0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\pos(960,1000)}знак у позиции",
        ]));
        assert_eq!(out.cues[0].text, "первая строка\nвторая строка");
        assert_eq!(out.cues[1].text, "слово\u{A0}врозянк5, \nперенос");
        assert_eq!(out.cues[2].text, "знак у позиции"); // \pos не рендерим, текст жив
        assert!(out.top_cue_starts.is_empty());
    }

    #[test]
    fn top_alignment_an_and_legacy_ssa() {
        let out = parse(&ass(&[
            "0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}Заголовок серии",
            "0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\an2}диалог снизу",
            "0,0:00:05.00,0:00:06.00,Default,,0,0,0,,{\\a6}легаси-верх (SSA)",
            "0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\an9}{\\an2}последний тег выигрывает",
        ]));
        assert_eq!(out.top_cue_starts, vec![1_000, 5_000]); // \an9→\an2 отменил верх
        assert_eq!(out.cues.len(), 4);
    }

    #[test]
    fn drawings_dropped_karaoke_stripped() {
        let out = parse(&ass(&[
            "{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}",
            "0,0:00:01.00,0:00:05.00,Default,,0,0,0,,{\\k20}ка{\\k30}ра{\\k50}оке",
            "0,0:00:06.00,0:00:07.00,Default,,0,0,0,,{\\p1\\an8}m 0 0 l 9 9{\\p0}текст после рисунка",
        ]));
        // строка-рисунок без тайминга полей не имеет — это Dialogue-поля: первый
        // элемент тут реально «0,0:00:…» отсутствует, пропустится как битый
        // (проверяется ниже отдельно); здесь — чистые случаи:
        assert_eq!(out.cues.len(), 2, "{:?}", out.cues);
        assert_eq!(out.cues[0].text, "караоке"); // \k вырезан, текст цел
        assert_eq!(out.cues[1].text, "текст после рисунка");
        // \an8 относится к строке целиком (у libass выравнивание — свойство
        // события): реплика с хвостом после рисунка — верхняя
        assert_eq!(out.top_cue_starts, vec![6_000]);
    }

    #[test]
    fn drawing_only_line_is_not_a_cue() {
        // Рисунок как полноценная Dialogue-строка (типовой опенинг): вся строка —
        // команды, после чистки пусто → cue нет, предупреждений-потопа нет.
        let out = parse(&ass(&[
            "0,0:00:01.00,0:00:05.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}",
        ]));
        assert!(out.cues.is_empty());
        assert!(out.warnings.is_empty());
    }

    #[test]
    fn comments_and_other_events_ignored() {
        let mut src = ass(&["0,0:00:01.00,0:00:02.00,Default,,0,0,0,,живая реплика"]);
        src.push_str("Comment: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,закомментированная\r\n");
        src.push_str("Picture: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,картинка\r\n");
        let out = parse(&src);
        assert_eq!(out.cues.len(), 1);
        assert_eq!(out.cues[0].text, "живая реплика");
    }

    #[test]
    fn ssa_v4_marked_format_and_missing_format() {
        // SSA v4: поле Marked вместо Layer — порядок полей по Format
        let ssa = "[Script Info]\n\
                   \n\
                   [V4 Styles]\n\
                   Format: Name, Fontname, Fontsize\n\
                   Style: Default,Arial,20\n\
                   \n\
                   [Events]\n\
                   Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
                   Dialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,диалог SSA";
        let out = parse(ssa);
        assert_eq!(
            out.cues,
            vec![Cue {
                start_ms: 1_000,
                end_ms: 2_000,
                text: "диалог SSA".into(),
            }]
        );
        // Файл без Format в [Events] — стандартный порядок ASS
        let noformat = "[Script Info]\n\n[Events]\n\
                        Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,без Format";
        assert_eq!(parse(noformat).cues.len(), 1);
    }

    #[test]
    fn timestamps_centiseconds_and_lenient() {
        let out = parse(&ass(&[
            "0,0:00:01.05,0:00:02.00,Default,,0,0,0,,сантисекунды", // .05 = 50 мс
            "0,1:02:03.400,1:02:04.000,Default,,0,0,0,,часы", // H:MM:SS.mmm тоже терпим
        ]));
        assert_eq!(out.cues[0].start_ms, 1_050);
        assert_eq!(out.cues[1].start_ms, 3_723_400);
    }

    #[test]
    fn broken_dialogues_warn_and_continue() {
        let out = parse(&ass(&[
            "0,не-время,0:00:02.00,Default,,0,0,0,,битое начало",
            "0,0:00:03.00,тоже-битое,Default,,0,0,0,,битый конец",
            "0,0:00:05.00,0:00:06.00,Default,,0,0,0,,живая",
        ]));
        assert_eq!(out.cues.len(), 1);
        assert_eq!(out.cues[0].text, "живая");
        assert_eq!(out.warnings.len(), 2);
        assert!(out.warnings.iter().all(|w| w.line > 0));
    }

    #[test]
    fn commas_inside_text_preserved() {
        let out = parse(&ass(&["0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Запятые, внутри, текста — целы"]));
        assert_eq!(out.cues[0].text, "Запятые, внутри, текста — целы");
    }

    #[test]
    fn top_start_dropped_when_cue_filtered() {
        // Верхняя реплика с вырожденным таймингом уходит из finalize — ключ
        // top_cue_starts на неё ссылаться не должен.
        let out = parse(&ass(&[
            "0,0:00:05.00,0:00:05.00,Default,,0,0,0,,{\\an8}нулевая длительность",
            "0,0:00:01.00,0:00:02.00,Default,,0,0,0,,обычная",
        ]));
        assert_eq!(out.cues.len(), 1);
        assert!(out.top_cue_starts.is_empty());
    }

    #[test]
    fn real_world_libass_samples() {
        // libass compare/test sub1: {\t(\frz+180)}A — анимация вырезается
        let sub1 = "\u{FEFF}[Script Info]\nPlayResX: 320\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Aileron,200,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,8,0,5,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:04.00,Default,,0,0,0,,{\\t(\\frz+180)}A\n";
        let out = parse(sub1);
        assert_eq!(
            out.cues,
            vec![Cue {
                start_ms: 0,
                end_ms: 4_000,
                text: "A".into(),
            }]
        );
    }

    #[test]
    fn fixture_sample_ass_light_anime_release() {
        // e2e/fixtures/subtitles/sample.ass — «лёгкий» аниме-релиз: знаки
        // \an8, \pos, караоке {\k}, fade, рисунок {\p}, Comment, стили.
        let out = parse(include_str!("../../../e2e/fixtures/subtitles/sample.ass"));
        assert_eq!(out.cues.len(), 6, "{:?}", out.cues);
        assert_eq!(out.cues[0].text, "ШКОЛА АРИСУ — эпизод 1"); // {\i} вырезаны
        assert_eq!(out.cues[1].text, "Табличка у входа"); // \pos вырезан
        assert_eq!(out.cues[2].text, "Привет! Давно не виделись.\nКак дела?");
        assert_eq!(out.cues[3].text, "Всё\u{A0}отлично, спасибо"); // \h → nbsp
        assert_eq!(out.cues[4].text, "опэнинг — караоке и fade не рендерим, текст цел");
        assert_eq!(out.cues[5].text, "Конец серии\nскоро продолжение");
        assert_eq!(out.top_cue_starts, vec![1_000, 16_000]); // {\an8}-знаки
        // Знак (1–3 с) и табличка (1,5–3,5 с) нарочно перекрываются — это
        // диагноз перекрытия (движок показа смёржит), не ошибка разбора.
        assert!(out.warnings.iter().all(|w| w.message.contains("перекрывает")), "{:?}", out.warnings);
    }

    #[test]
    fn parse_auto_routes_ass_by_script_info() {
        let parsed = super::super::parse_auto(&ass(&["0,0:00:01.00,0:00:02.00,Default,,0,0,0,,автодетект"]));
        assert_eq!(parsed.cues.len(), 1);
        assert_eq!(parsed.cues[0].text, "автодетект");
        // SRT-подобный вход по-прежнему идёт в SubRip (не в ass по «[»)
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nhi\n";
        assert_eq!(super::super::parse_auto(srt).cues.len(), 1);
    }
}
