//! Фетчер фавиконов сайтов (карточка duopulse-161) для строки закладок.
//! Прежняя схема UI — `<img src="{origin}/favicon.ico">` — покрывала только
//! сайты с корневым .ico (YouTube, OLX); современные сайты часто объявляют
//! иконку только `<link rel="icon">` в HTML (SVG/PNG, произвольный путь) и
//! на корневом запросе рисуют бейдж-букву. Здесь — как в больших браузерах:
//!
//! 1. GET страницы (лимит [`HTML_LIMIT`], UA как у WebView2) → разбор
//!    `<link rel="icon|apple-touch-icon|shortcut icon" href sizes>`;
//! 2. кандидаты по убыванию заявленного размера (any = 512, без sizes = 32);
//! 3. фолбэки `/favicon.ico` и `/apple-touch-icon.png` в корне;
//! 4. скачивание (лимит [`ICON_LIMIT`]), MIME — по магии байтов с опорой на
//!    Content-Type/расширение; HTML-ответ (бот-блок, редирект на страницу)
//!    иконкой не считается;
//! 5. результат — data-URL (`data:image/…;base64,…`), кэш — таблица
//!    favicons профиля (history::HistoryStore), там же негатив-кэш.
//!
//! Сеть — тем же путём, что и WebView2: через локальный SOCKS5-роутер
//! приложения, когда он поднят (прокси/VPN), иначе напрямую.

use std::io::Read;
use std::time::Duration;

/// Браузерный UA (как у самофетча ASR): сайт отдаёт честную голову, а не
/// заглушку для ботов.
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/// Сколько HTML читать для поиска `<link>`: голова с иконками — первые
/// десятки килобайт, лимит страхует от бесконечных страниц.
const HTML_LIMIT: usize = 256 * 1024;
/// Потолок тела иконки: реальные значки ≤ 100 КБ, гиганты не нужны.
const ICON_LIMIT: usize = 256 * 1024;
/// Таймаут одного запроса: строка ждёт иконку асинхронно, но слишком
/// долгие хвосты не копим (кандидатов до четырёх).
const TIMEOUT: Duration = Duration::from_secs(6);
/// Максимум кандидатов на скачивание (парс головы + два фолбэка).
const MAX_CANDIDATES: usize = 4;

/// Иконка сайта: Some(data-URL) или None («иконки нет», негатив-кэш).
pub fn fetch_data_url(page_url: &str, socks_port: Option<u16>) -> Option<String> {
    let base = match url::Url::parse(page_url) {
        Ok(u) if u.scheme() == "https" || u.scheme() == "http" => u,
        _ => return None, // внутренние страницы (duopulse://) и мусор
    };
    let mut builder = ureq::AgentBuilder::new()
        .timeout(TIMEOUT)
        .timeout_connect(Duration::from_secs(4));
    if let Some(port) = socks_port {
        let proxy = ureq::Proxy::new(format!("socks5://127.0.0.1:{port}")).ok()?;
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();

    // Кандидаты: <link> из головы страницы (крупнейшие первыми) + корневые
    // фолбэки. Дедуп — Set не нужен, дубликаты отсекает проверка в цикле.
    let mut links = page_icon_links(&agent, &base);
    let origin = base.origin().ascii_serialization();
    links.push(format!("{origin}/favicon.ico"));
    links.push(format!("{origin}/apple-touch-icon.png"));
    let mut tried: Vec<String> = Vec::new();
    for link in links {
        if tried.iter().any(|t| t == &link) || tried.len() >= MAX_CANDIDATES {
            continue;
        }
        tried.push(link.clone());
        if let Some(data) = download_icon(&agent, &link) {
            return Some(data);
        }
    }
    None
}

/// `<link rel=…>` страницы по убыванию приоритета: заявленный размер (any —
/// вектор, считаем 512), apple-touch-icon — 180, без sizes — 32. Пусто —
/// страница не отдалась или иконок не объявляет (остаются фолбэки).
fn page_icon_links(agent: &ureq::Agent, base: &url::Url) -> Vec<String> {
    let resp = match agent
        .get(base.as_str())
        .set("User-Agent", UA)
        .set("Accept", "text/html,application/xhtml+xml")
        .call()
    {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    // база для относительных href — конечный адрес после редиректов
    let final_url = match url::Url::parse(resp.get_url()) {
        Ok(u) => u,
        Err(_) => base.clone(),
    };
    let mut html = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut reader = resp.into_reader();
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                html.extend_from_slice(&chunk[..n]);
                if html.len() >= HTML_LIMIT {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let html = String::from_utf8_lossy(&html);
    let mut found: Vec<(u32, String)> = Vec::new();
    for tag in link_tags(&html) {
        let (rel, href, sizes) = tag_attrs(&tag);
        let rel = rel.to_ascii_lowercase();
        // rel может быть составным: "shortcut icon"; stylesheet отсекаем
        let tokens: Vec<&str> = rel.split_whitespace().collect();
        if tokens.iter().any(|t| *t == "stylesheet") || !tokens.iter().any(|t| t.contains("icon"))
        {
            continue;
        }
        let priority = if tokens.iter().any(|t| *t == "apple-touch-icon") {
            180
        } else {
            parse_sizes(&sizes).unwrap_or(32)
        };
        if let Ok(u) = final_url.join(&href) {
            if u.scheme() == "http" || u.scheme() == "https" {
                found.push((priority, u.to_string()));
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, u)| u).collect()
}

/// Вырезать `<link …>`/`<LINK …>` из HTML (голова страницы; сканер без
/// HTML-парсера — атрибуты иконок однострочны, экранирования в них нет).
fn link_tags(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(start) = lower[from..].find("<link") {
        let start = from + start;
        // граница имени: за «<link» — пробел, слэш или '>', не «<linked…»
        let after = bytes.get(start + 5);
        let boundary = matches!(after, None | Some(b'/') | Some(b'>'))
            || after.is_some_and(|b| b.is_ascii_whitespace());
        // конец тега — первый '>' (самозакрытие / обычный)
        if let Some(end) = lower[start..].find('>') {
            if boundary {
                out.push(html[start..start + end].to_string());
            }
            from = start + end;
        } else {
            break;
        }
    }
    out
}

/// Значения атрибутов rel/href/sizes тега (без учёта порядка; кавычки
/// одинарные/двойные или без кавычек). Индексы lower и tag совпадают —
/// to_ascii_lowercase не меняет длину.
fn tag_attrs(tag: &str) -> (String, String, String) {
    let mut rel = String::new();
    let mut href = String::new();
    let mut sizes = String::new();
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for name in ["rel", "href", "sizes"] {
        let mut from = 0;
        while let Some(pos) = lower[from..].find(name) {
            let pos = from + pos;
            from = pos + name.len();
            // граница имени: начало тега/пробел перед
            let before_ok = pos == 0 || bytes[pos - 1].is_ascii_whitespace();
            if !before_ok {
                continue;
            }
            let mut j = from;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j >= bytes.len() || bytes[j] != b'=' {
                continue;
            }
            j += 1;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            let rest = &tag[j..];
            let val = match rest.chars().next() {
                Some(q @ ('"' | '\'')) => rest[1..].find(q).map_or(
                    rest[1..].to_string(),
                    |e| rest[1..1 + e].to_string(),
                ),
                _ => rest.find(char::is_whitespace).map_or(
                    rest.to_string(),
                    |e| rest[..e].to_string(),
                ),
            };
            match name {
                "rel" => rel = val,
                "href" => href = val,
                _ => sizes = val,
            }
        }
    }
    (rel, href, sizes)
}

/// Ширина из sizes="32x32" / "any" / "180x180 …": any (вектор) — 512.
fn parse_sizes(sizes: &str) -> Option<u32> {
    let first = sizes.split_whitespace().next()?;
    if first.eq_ignore_ascii_case("any") {
        return Some(512);
    }
    let w = first.split(['x', 'X']).next()?.trim();
    w.parse::<u32>().ok()
}

/// Скачать кандидата и собрать data-URL; None — не иконка (HTML/мусор/404,
/// перебор продолжается следующим кандидатом).
fn download_icon(agent: &ureq::Agent, link: &str) -> Option<String> {
    let resp = agent
        .get(link)
        .set("User-Agent", UA)
        .set("Accept", "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8")
        .call()
        .ok()?;
    let ctype = resp.content_type().to_ascii_lowercase();
    if ctype.starts_with("text/html") {
        return None; // бот-блок/редирект на страницу — не иконка
    }
    let mut body = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let mut reader = resp.into_reader();
    loop {
        let n = reader.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
        if body.len() > ICON_LIMIT {
            return None;
        }
    }
    if body.is_empty() {
        return None;
    }
    let mime = sniff_mime(&body, &ctype, link)?;
    Some(format!("data:{mime};base64,{}", base64(&body)))
}

/// MIME иконки: магия байтов → Content-Type → расширение адреса. None —
/// не похоже на картинку (текст, бинарник неизвестного формата).
fn sniff_mime(body: &[u8], ctype: &str, link: &str) -> Option<&'static str> {
    if body.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if body.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if body.starts_with(&[0x00, 0x00, 0x01, 0x00]) {
        return Some("image/x-icon");
    }
    // SVG может начинаться с BOM/пробелов/<?xml/<svg
    let head = String::from_utf8_lossy(&body[..body.len().min(512)]).trim_start().to_string();
    if head.starts_with('<') && (head.contains("<svg") || head.contains("<?xml")) {
        return Some("image/svg+xml");
    }
    if ctype.starts_with("image/") {
        return leak_mime(ctype);
    }
    let path = link.split(['?', '#']).next().unwrap_or("");
    match path.rsplit('.').next().unwrap_or("") {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

/// Content-Type → статический MIME (без параметров вроде charset): чужие
/// lifetime не протекают в data-URL.
fn leak_mime(ctype: &str) -> Option<&'static str> {
    let base = ctype.split(';').next()?.trim();
    match base {
        "image/png" => Some("image/png"),
        "image/gif" => Some("image/gif"),
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/webp" => Some("image/webp"),
        "image/svg+xml" => Some("image/svg+xml"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("image/x-icon"),
        "image/avif" => Some("image/avif"),
        "image/bmp" => Some("image/bmp"),
        _ => None,
    }
}

/// Стандартный base64 с паддингом (без внешнего крейта; проверено тестами
/// на векторе RFC 4648).
fn base64(data: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn link_tags_case_insensitive_and_attrs() {
        let html = r#"<head><LINK REL="shortcut icon" HREF='/a.ico'>
            <link rel='apple-touch-icon' sizes='180x180' href="touch.png">
            <link rel=stylesheet href='x.css'><link rel='icon' type='image/svg+xml' href=s.svg></head>"#;
        let tags = link_tags(html);
        assert_eq!(tags.len(), 4);
        let (_, href, _) = tag_attrs(&tags[0]);
        assert_eq!(href, "/a.ico");
        let (rel, href, sizes) = tag_attrs(&tags[1]);
        assert_eq!(rel, "apple-touch-icon");
        assert_eq!(href, "touch.png");
        assert_eq!(sizes, "180x180");
        // rel=stylesheet отсеивается уровнем выше; без-кавычный href читается
        let (_, href, _) = tag_attrs(&tags[3]);
        assert_eq!(href, "s.svg");
    }

    #[test]
    fn sizes_priority() {
        assert_eq!(parse_sizes("32x32"), Some(32));
        assert_eq!(parse_sizes("any"), Some(512));
        assert_eq!(parse_sizes("192x192 96x96"), Some(192));
        assert_eq!(parse_sizes(""), None);
    }

    #[test]
    fn mime_by_magic_and_fallbacks() {
        assert_eq!(sniff_mime(&[0x89, b'P', b'N', b'G', 1, 2, 3], "", ""), Some("image/png"));
        assert_eq!(
            sniff_mime(&[0x00, 0x00, 0x01, 0x00, 1, 2], "", "https://x/y"),
            Some("image/x-icon")
        );
        assert_eq!(
            sniff_mime(b"<?xml version='1.0'?><svg xmlns='u'></svg>", "", "u"),
            Some("image/svg+xml")
        );
        assert_eq!(sniff_mime(b"\x01\x02\x03", "", "https://a/img.png"), Some("image/png"));
        assert_eq!(sniff_mime(b"\x01\x02\x03", "text/html", "u"), None);
        assert_eq!(sniff_mime(b"\x01\x02\x03", "", "u"), None);
    }

    /// Живой прогон (не в CI): как в-duopulse-161 — реальные сайты, хост
    /// стенда за зарубежным выходом; `cargo test favicon_live -- --ignored`.
    #[test]
    #[ignore]
    fn favicon_live_modern_sites() {
        for url in [
            "https://github.com/",
            "https://ru.wikipedia.org/",
            "https://habr.com/",
            "https://www.youtube.com/",
        ] {
            let icon = fetch_data_url(url, None);
            let icon = icon.unwrap_or_else(|| panic!("{url}: иконка не найдена"));
            assert!(icon.starts_with("data:image/"), "{url}: {icon}");
            assert!(icon.len() < 300_000, "{url}: гигантская иконка");
        }
    }
}
