//! Гарнитуры субтитров (карточка duopulse-068): выбор шрифта плашки помимо
//! размера. Контентный оверлей живёт в контексте просматриваемой страницы
//! (YouTube и др.), где фирменные @font-face из src/theme/fonts.css недоступны
//! (CSP страницы чужие data:-шрифты не пускает), поэтому гарнитура доставляется
//! бинарными данными: content-слой просит «font-request»'ом WebMessage'ом,
//! Core отвечает woff2-сабсетами (base64) — FontFace из ArrayBuffer сетевых
//! загрузок не делает и CSP не подчинён.
//!
//! В списке только гарнитуры с кириллическими сабсетами (критерий карточки):
//! Inter и JetBrains Mono (сабсеты cyrillic+latin, те же файлы, что и UI —
//! src/theme/fonts), плюс «system» — системная гарнитура без доставки.
//! Space Grotesk кириллицы не имеет — в выбор не входит.
//! Веса субтитров — 400/500 (словарь строк гайда 06 §6: оригинал 500,
//! перевод/третьи 400); 700 плашке не нужен.

/// Один @font-face-сабсет гарнитуры: вес, unicode-range и бинарник woff2.
pub struct FamilyFace {
    pub weight: u32,
    /// unicode-range-дескриптор как в src/theme/fonts.css (latin/cyrillic).
    pub unicode_range: &'static str,
    pub data: &'static [u8],
}

/// Допустимые значения SubtitlesStyle.fontFamily («system» — системная
/// гарнитура, без доставки шрифта).
pub const FONT_FAMILY_VALUES: [&str; 3] = ["Inter", "JetBrains Mono", "system"];

/// Значение из списка выбора (прочее — дефолт Inter при нормализации).
pub fn is_valid_family(family: &str) -> bool {
    FONT_FAMILY_VALUES.contains(&family)
}

/// unicode-range-подмножества — общие с fonts.css (latin и cyrillic).
const LATIN_RANGE: &str = "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const CYRILLIC_RANGE: &str = "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116";

/// Сабсеты гарнитуры для оверлея субтитров (400/500, cyrillic+latin);
/// «system» и неизвестные — пустой список (доставлять нечего).
pub fn family_faces(family: &str) -> Vec<FamilyFace> {
    match family {
        "Inter" => vec![
            FamilyFace {
                weight: 400,
                unicode_range: CYRILLIC_RANGE,
                data: include_bytes!("../../../src/theme/fonts/inter-cyrillic-400.woff2").as_slice(),
            },
            FamilyFace {
                weight: 400,
                unicode_range: LATIN_RANGE,
                data: include_bytes!("../../../src/theme/fonts/inter-latin-400.woff2").as_slice(),
            },
            FamilyFace {
                weight: 500,
                unicode_range: CYRILLIC_RANGE,
                data: include_bytes!("../../../src/theme/fonts/inter-cyrillic-500.woff2").as_slice(),
            },
            FamilyFace {
                weight: 500,
                unicode_range: LATIN_RANGE,
                data: include_bytes!("../../../src/theme/fonts/inter-latin-500.woff2").as_slice(),
            },
        ],
        "JetBrains Mono" => vec![
            FamilyFace {
                weight: 400,
                unicode_range: CYRILLIC_RANGE,
                data: include_bytes!("../../../src/theme/fonts/jetbrains-mono-cyrillic-400.woff2")
                    .as_slice(),
            },
            FamilyFace {
                weight: 400,
                unicode_range: LATIN_RANGE,
                data: include_bytes!("../../../src/theme/fonts/jetbrains-mono-latin-400.woff2")
                    .as_slice(),
            },
            FamilyFace {
                weight: 500,
                unicode_range: CYRILLIC_RANGE,
                data: include_bytes!("../../../src/theme/fonts/jetbrains-mono-cyrillic-500.woff2")
                    .as_slice(),
            },
            FamilyFace {
                weight: 500,
                unicode_range: LATIN_RANGE,
                data: include_bytes!("../../../src/theme/fonts/jetbrains-mono-latin-500.woff2")
                    .as_slice(),
            },
        ],
        _ => Vec::new(),
    }
}

/// base64 (стандартный алфавит с padding) — WebMessage-канал текстовый,
/// бинарники woff2 оборачиваются строкой. Крейт base64 в дереве зависимостей
/// есть (транспитивно), но напрямую не подключен — локальный энкодер проще
/// новой зависимости.
pub fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_кодирует_с_padding_и_без() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // woff2-магия «wOF2» — стабильное начало сабсета
        assert!(base64(&family_faces("Inter")[0].data).starts_with("d09G"));
    }

    #[test]
    fn список_гарнитур_только_с_кириллицей_плюс_система() {
        assert!(is_valid_family("Inter"));
        assert!(is_valid_family("JetBrains Mono"));
        assert!(is_valid_family("system"));
        assert!(!is_valid_family("Space Grotesk"));
        // У каждой не-системной гарнитуры — по 4 сабсета (400/500 × cyr/latin),
        // системная и мусор — без доставки.
        assert_eq!(family_faces("Inter").len(), 4);
        assert_eq!(family_faces("JetBrains Mono").len(), 4);
        assert!(family_faces("system").is_empty());
        assert!(family_faces("Comic Sans").is_empty());
    }
}
