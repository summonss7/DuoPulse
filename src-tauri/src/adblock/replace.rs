//! Перезапись тел сетевых ответов — подмножество опции `$replace` uBO
//! (карточка duopulse-050). Движок adblock-rs опцию `replace=` не знает
//! (NetworkFilterError::UnrecognisedOption — правило молча отбрасывается),
//! поэтому правила парсятся из СЫРЫХ текстов списков отдельным парсером, а
//! применение живёт на уровне COM-перехватчика WebView2: запрос матчится →
//! Core сам забирает ответ (самофетч тем же сетевым путём, что и WebView2 —
//! через локальный SOCKS5-роутер, чтобы IP-адрес совпадал) → замены в теле →
//! подмена ответа (`CreateWebResourceResponse` + `SetResponse`). Любой сбой
//! самофетча — дефолтное поведение WebView2 (свой сетевой запрос), т.е. слой
//! перезаписи не может «сломать» страницу хуже отсутствия.
//!
//! Поддерживаемое подмножество (живые правила uBO для YouTube, uAssets
//! 16.10.2026): `||host/path?$xhr,1p,replace=/regex/replacement/flags`,
//! `@@`-исключения; паттерн — `||`-доменный якорь (хост + поддомены,
//! буквальный префикс пути), `|`-якорь слева, голая подстрока; флаги
//! `g/i/m/s`. Опции вне подмножества (`domain=`, `match-case`, …) — правило
//! пропускается целиком (консервативно: полупонятое правило опаснее
//! пропущенного). Косметические `trusted-replace-xhr-response`/`trusted-rpfr`
//! — скриптлеты уровня страницы, сетевым слоем не парсятся.
//!
//! Назначение (журнал карточки 044): серверный SSAI-преролл YouTube не
//! подавляется клиентскими скриптлетами в принципе, а вырезание `adSlots`
//! любой клиентской формой возвращает SABR-столл. uBO решает то же самое
//! заменой `"adSlots"`→`"no_ads"` в теле ответа ДО парсинга — плеер видит
//! «рекламы нет» и сразу играет контент.

use std::io::Read;

/// Потолок тела ответа для перезаписи: XHR /player — сотни КБ, документ
/// /watch — единицы МБ; стриминг videoplayback под правила не попадает
/// (точечные пути). Превышение — отказ от перезаписи (фолббек WebView2).
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// Таймаут самофетча целиком (установка соединения + чтение тела).
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Одна замена `/regex/replacement/flags` из опции `replace=`.
#[derive(Debug, Clone)]
pub(crate) struct ReplaceOp {
    pub(crate) regex: regex::Regex,
    pub(crate) replacement: String,
    /// Флаг `g` — все вхождения (иначе только первое, семантика uBO).
    pub(crate) global: bool,
}

/// Паттерн URL-части правила (без опций).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pattern {
    /// `||host/path` — доменный якорь: хост совпадает или является поддоменом,
    /// остаток — буквальный префикс пути-с-запросом. Разделён на хост/остаток
    /// при парсинге, чтобы матчинг не строил строку на каждый запрос.
    DomainAnchored { host: String, rest: String },
    /// `|http…` — префикс от начала URL.
    LeftAnchored(String),
    /// Голая подстрока.
    Plain(String),
}

/// Разобранное `$replace`-правило.
#[derive(Debug, Clone)]
pub(crate) struct ReplaceRule {
    pattern: Pattern,
    pub(crate) ops: Vec<ReplaceOp>,
    /// `$xhr` — только XHR/fetch; `$doc` — только document; оба/ни одного —
    /// любые типы. Флаги хранятся независимо: `$xhr,doc` = любой из двух.
    want_xhr: bool,
    want_doc: bool,
    /// `1p`/`3p`; None — партия запроса не важна.
    first_party: Option<bool>,
    /// `@@`-правило: гасит совпавшие replace-правила (у uBO исключение
    /// отменяет замену на том же URL).
    pub(crate) exception: bool,
}

impl ReplaceRule {
    /// Совпадает ли правило с запросом: URL + тип + партия. Хосты источника и
    /// цели приводятся к базовому домену (последние две метки; PSL не
    /// учитывается — целевые правила живут на youtube.com, не на TLD-границах).
    pub(crate) fn matches(&self, url: &str, request_type: &str, source_host: Option<&str>) -> bool {
        if !self.type_matches(request_type) {
            return false;
        }
        if let Some(want_1p) = self.first_party {
            let target_host = host_of(url);
            let source_host = source_host
                .map(str::to_string)
                .or_else(|| target_host.clone());
            let is_1p = match (source_host.as_deref(), target_host.as_deref()) {
                (Some(s), Some(t)) => base_domain(s) == base_domain(t),
                _ => false,
            };
            if is_1p != want_1p {
                return false;
            }
        }
        self.url_matches(url)
    }

    fn type_matches(&self, request_type: &str) -> bool {
        if !self.want_xhr && !self.want_doc {
            return true; // тип не ограничен
        }
        match request_type {
            "xhr" => self.want_xhr,
            "document" => self.want_doc,
            _ => false,
        }
    }

    fn url_matches(&self, url: &str) -> bool {
        let url = url.to_ascii_lowercase();
        match &self.pattern {
            Pattern::DomainAnchored { host, rest } => match split_url(&url) {
                Some((url_host, url_rest)) => {
                    let host_ok = url_host == *host || url_host.ends_with(&format!(".{host}"));
                    host_ok && url_rest.starts_with(rest.as_str())
                }
                None => false,
            },
            Pattern::LeftAnchored(p) => url.starts_with(p.as_str()),
            Pattern::Plain(p) => url.contains(p.as_str()),
        }
    }
}

/// Хост URL (нижний регистр) — ручной разбор: матчинг на каждом запросе,
/// tauri::Url тяжелее некуда.
pub(crate) fn host_of(url: &str) -> Option<String> {
    split_url(url).map(|(h, _)| h)
}

/// (хост, путь+запрос) из http(s)-URL; scheme://host[:port]/path?query —
/// порт отбрасывается (правила матчат хост).
fn split_url(url: &str) -> Option<(String, String)> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    // отбросить userinfo (user@host) и порт (IPv6 в URL — всегда в скобках)
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = match host.rsplit_once(':') {
        Some((h, _)) if !h.contains(']') => h,
        _ => host,
    };
    Some((host.to_string(), path.to_string()))
}

/// Базовый домен: последние две метки (www.youtube.com → youtube.com);
/// одна-две метки — весь хост. PSL не учитывается — целевые правила живут на
/// youtube.com, не на границах публичных суффиксов.
fn base_domain(host: &str) -> &str {
    match host.rsplit_once('.') {
        Some((head, _)) => match head.rfind('.') {
            Some(i) => &host[i + 1..],
            None => host,
        },
        None => host,
    }
}

// ---------------------------------------------------------------------------
// Парсинг текста списка
// ---------------------------------------------------------------------------

/// Разобрать `$replace`-правила из текста списка: строки с `replace=`;
/// неразбираемые молча пропускаются (движок adblock-rs поступает так же).
pub(crate) fn parse_replace_rules(text: &str) -> Vec<ReplaceRule> {
    text.lines().filter_map(parse_rule_line).collect()
}

fn parse_rule_line(line: &str) -> Option<ReplaceRule> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('!') || line.starts_with('#') || line.contains("##") {
        return None;
    }
    if !line.contains("replace=") {
        return None;
    }
    let (line, exception) = match line.strip_prefix("@@") {
        Some(rest) => (rest, true),
        None => (line, false),
    };
    // Разделитель паттерн/опции — последний '$' (как в adblock-rs parse_filter)
    let dollar = line.rfind('$')?;
    let raw_pattern = &line[..dollar];
    let raw_options = &line[dollar + 1..];

    let pattern = if let Some(rest) = raw_pattern.strip_prefix("||") {
        let (host, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        Pattern::DomainAnchored {
            host: host.to_ascii_lowercase(),
            rest: path.to_ascii_lowercase(),
        }
    } else if let Some(rest) = raw_pattern.strip_prefix('|') {
        Pattern::LeftAnchored(rest.to_ascii_lowercase())
    } else {
        Pattern::Plain(raw_pattern.to_ascii_lowercase())
    };

    let mut ops = Vec::new();
    let mut want_xhr = false;
    let mut want_doc = false;
    let mut first_party = None;
    for option in split_options(raw_options) {
        let option = option.as_str();
        if option == "xhr" || option == "xmlhttprequest" {
            want_xhr = true;
        } else if option == "doc" || option == "document" {
            want_doc = true;
        } else if option == "1p" || option == "first-party" {
            first_party = Some(true);
        } else if option == "3p" || option == "third-party" {
            first_party = Some(false);
        } else {
            // всё прочее — либо replace=, либо опция вне подмножества:
            // последняя означает, что правило пропускается целиком
            let value = option.strip_prefix("replace=")?;
            ops.push(parse_replace_value(value)?);
        }
    }
    if ops.is_empty() {
        return None;
    }
    Some(ReplaceRule {
        pattern,
        ops,
        want_xhr,
        want_doc,
        first_party,
        exception,
    })
}

/// Разбивка опций по ','. Значение `replace=/re/repl/flags` само содержит
/// запятые и слэши — сканер гасит `\,`/`\/` и не делит запятые внутри
/// слэш-ограждённого значения.
fn split_options(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                // экранирование переносится в значение как есть; разделителем
                // запятая быть не может
                cur.push(c);
                if let Some(next) = chars.next() {
                    cur.push(next);
                }
            }
            ',' => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// `/"adSlots"/"no_ads"/` → (regex, replacement, global). Формы: слэш-ограждённая
/// `/regex/replacement/flags` или голая подстрока (заменяется на пустую).
fn parse_replace_value(value: &str) -> Option<ReplaceOp> {
    if !value.starts_with('/') {
        // replace=foo → убрать «foo» (семантика uBO)
        let regex = regex::Regex::new(&regex::escape(value)).ok()?;
        return Some(ReplaceOp {
            regex,
            replacement: String::new(),
            global: true,
        });
    }
    let body = &value[1..];
    let mut regex_src = String::new();
    let mut replacement = String::new();
    let mut flags = String::new();
    // Секции: regex до незкранированного '/', replacement до следующего,
    // остаток — флаги.
    let mut section = 0;
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let next = chars.next()?;
            // `\/` и `\,` — синтаксические экранирования ABP: в regex-секции
            // `\/` валиден и в regex-крейте, оставляем; в replacement
            // раскрываем (там бэкслэш не экранирует)
            match (section, next) {
                (1, '/') => replacement.push('/'),
                (1, ',') => replacement.push(','),
                (1, '\\') => replacement.push('\\'),
                _ => {
                    let dst = match section {
                        0 => &mut regex_src,
                        1 => &mut replacement,
                        _ => &mut flags,
                    };
                    dst.push('\\');
                    dst.push(next);
                }
            }
            continue;
        }
        if c == '/' {
            section += 1;
            if section > 2 {
                return None; // третий слэш внутри флагов — мусор
            }
            continue;
        }
        let dst = match section {
            0 => &mut regex_src,
            1 => &mut replacement,
            _ => &mut flags,
        };
        dst.push(c);
    }
    if section != 2 {
        return None; // неполные /re/repl/flags
    }
    let mut global = false;
    let mut case_insensitive = false;
    let mut multi_line = false;
    let mut dot_all = false;
    for f in flags.chars() {
        match f {
            'g' => global = true,
            'i' => case_insensitive = true,
            'm' => multi_line = true,
            's' => dot_all = true,
            _ => return None, // неизвестный флаг — правило пропускаем
        }
    }
    let regex = regex::RegexBuilder::new(&regex_src)
        .case_insensitive(case_insensitive)
        .multi_line(multi_line)
        .dot_matches_new_line(dot_all)
        .build()
        .ok()?;
    Some(ReplaceOp {
        regex,
        replacement,
        global,
    })
}

/// Применить цепочку замен к телу. Не-UTF-8 тело возвращается нетронутым
/// (замены текстовые). Возвращает (тело, изменилось ли что-то).
pub(crate) fn apply_ops(body: &[u8], ops: &[ReplaceOp]) -> (Vec<u8>, bool) {
    if body.is_empty() {
        return (Vec::new(), false);
    }
    let Ok(text) = std::str::from_utf8(body) else {
        return (body.to_vec(), false);
    };
    let mut changed = false;
    let mut current = text.to_string();
    for op in ops {
        let next = if op.global {
            op.regex.replace_all(&current, op.replacement.as_str())
        } else {
            op.regex.replacen(&current, 1, op.replacement.as_str())
        };
        if next != current {
            changed = true;
        }
        current = next.into_owned();
    }
    (current.into_bytes(), changed)
}

// ---------------------------------------------------------------------------
// Самофетч + перезапись (вызов из фоновой нити COM-перехватчика)
// ---------------------------------------------------------------------------

/// Результат самофетча с применёнными заменами — материал для
/// `CreateWebResourceResponse` в main.rs.
#[derive(Debug)]
pub(crate) struct RewrittenResponse {
    pub(crate) status: u16,
    pub(crate) reason: String,
    /// Заголовки ответа (кроме контентных/хоп-заголовков — их собирает
    /// вызывающий код: Content-Length ставится по итоговому телу).
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
    /// Хотя бы одна замена реально изменила тело.
    pub(crate) changed: bool,
}

/// Заголовки запроса, которые не переносятся в самофетч: адресные (клиент
/// ставит сам), кодирование (ответ нужен БЕЗ сжатия — замены текстовые) и
/// хоп-заголовки туннеля.
fn skip_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "content-length"
            | "accept-encoding"
            | "connection"
            | "keep-alive"
            | "proxy-connection"
            | "proxy-authorization"
            | "transfer-encoding"
            | "expect"
    )
}

fn skip_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "content-length"
            | "content-encoding"
            | "transfer-encoding"
            | "connection"
            | "keep-alive"
            | "upgrade"
    )
}

/// Выполнить запрос и вернуть переписанный ответ. None — любой сбой: сеть,
/// редирект-цепочка, превышение потолка тела (вызывающий код отвечает
/// фолбэком — дефолтный сетевой запрос WebView2).
///
/// `socks_port` — порт локального SOCKS5-роутера (задача 6.1): WebView2 ходит
/// в сеть только через него (прямые/туннельные маршруты решает роутер), самофетч
/// идёт тем же путём — IP-адрес и куки сессии согласованы с остальным трафиком
/// плеера. None — роутера нет, соединение напрямую.
pub(crate) fn fetch_and_rewrite(
    method: &str,
    url: &str,
    request_headers: &[(String, String)],
    request_body: Option<&[u8]>,
    ops: &[ReplaceOp],
    socks_port: Option<u16>,
) -> Option<RewrittenResponse> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout(FETCH_TIMEOUT)
        .redirects(0); // редиректы отдаём как есть — WebView2 отработает сам
    if let Some(port) = socks_port {
        let proxy = ureq::Proxy::new(format!("socks5://127.0.0.1:{port}")).ok()?;
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();

    let mut request = agent.request(method, url);
    for (name, value) in request_headers {
        if !skip_request_header(name) {
            request = request.set(name, value);
        }
    }
    let response = match request_body {
        Some(bytes) => request.send_bytes(bytes),
        None => request.call(),
    }
    .ok()?;

    let status = response.status();
    let reason = response.status_text().to_string();
    let mut headers = Vec::new();
    for name in response.headers_names() {
        if skip_response_header(&name) {
            continue;
        }
        for value in response.all(&name) {
            headers.push((name.clone(), value.to_string()));
        }
    }
    let mut body = Vec::new();
    response
        .into_reader()
        .take(MAX_BODY_BYTES as u64 + 1)
        .read_to_end(&mut body)
        .ok()?;
    if body.len() > MAX_BODY_BYTES {
        return None;
    }
    let (body, changed) = apply_ops(&body, ops);
    Some(RewrittenResponse {
        status,
        reason,
        headers,
        body,
        changed,
    })
}

// ---------------------------------------------------------------------------
// Тесты (loopback-стенд — без внешней сети)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Дословные правила живого uBO filters.txt (uAssets 16.10.2026).
    const LIVE_YOUTUBE: [&str; 8] = [
        "||www.youtube.com/playlist?list=$xhr,1p,replace=/\"adPlacements\"/\"no_ads\"/",
        "||www.youtube.com/playlist?list=$xhr,1p,replace=/\"adSlots\"/\"no_ads\"/",
        "||www.youtube.com/watch?$xhr,1p,replace=/\"adPlacements\"/\"no_ads\"/",
        "||www.youtube.com/watch?$xhr,1p,replace=/\"adSlots\"/\"no_ads\"/",
        "||www.youtube.com/youtubei/v1/player?$xhr,1p,replace=/\"adPlacements\"/\"no_ads\"/",
        "||www.youtube.com/youtubei/v1/player?$xhr,1p,replace=/\"adSlots\"/\"no_ads\"/",
        "||youtube.com/youtubei/v1/get_watch?$xhr,1p,replace=/\"adPlacements\"/\"no_ads\"/",
        "||youtube.com/youtubei/v1/get_watch?$xhr,1p,replace=/\"adSlots\"/\"no_ads\"/",
    ];

    fn player_rule() -> ReplaceRule {
        parse_rule_line(LIVE_YOUTUBE[5]).expect("правило /player разбирается")
    }

    #[test]
    fn parses_live_youtube_rules() {
        let rules: Vec<ReplaceRule> = LIVE_YOUTUBE
            .iter()
            .filter_map(|l| parse_rule_line(l))
            .collect();
        assert_eq!(rules.len(), 8, "все живые правила разбираются");
        for r in &rules {
            assert!(!r.exception);
            assert!(r.want_xhr && !r.want_doc, "$xhr,1p");
            assert_eq!(r.first_party, Some(true));
        }
        let r = player_rule();
        assert_eq!(
            r.pattern,
            Pattern::DomainAnchored {
                host: "www.youtube.com".into(),
                rest: "/youtubei/v1/player?".into()
            }
        );
        let op = &r.ops[0];
        assert_eq!(op.regex.as_str(), "\"adSlots\"");
        assert_eq!(op.replacement, "\"no_ads\"");
        assert!(!op.global, "без /g — только первое вхождение");
    }

    #[test]
    fn matches_player_playlist_watch_urls() {
        let rules: Vec<ReplaceRule> = LIVE_YOUTUBE
            .iter()
            .filter_map(|l| parse_rule_line(l))
            .collect();
        let xhr_from_yt = ("xhr", Some("www.youtube.com"));
        // player с query — да; без query (паттерн требует '?') — нет
        assert!(rules.iter().any(|r| r.matches(
            "https://www.youtube.com/youtubei/v1/player?key=AIzaSy&prettyPrint=false",
            xhr_from_yt.0,
            xhr_from_yt.1
        )));
        assert!(!rules.iter().any(|r| r.matches(
            "https://www.youtube.com/youtubei/v1/player",
            xhr_from_yt.0,
            xhr_from_yt.1
        )));
        // get_watch: ||youtube.com покрывает www-поддомен
        assert!(rules.iter().any(|r| r.matches(
            "https://www.youtube.com/youtubei/v1/get_watch?prettyPrint=false",
            xhr_from_yt.0,
            xhr_from_yt.1
        )));
        // watch SPA-навигация XHR-ём
        assert!(rules.iter().any(|r| r.matches(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            xhr_from_yt.0,
            xhr_from_yt.1
        )));
        // playlist
        assert!(rules.iter().any(|r| r.matches(
            "https://www.youtube.com/playlist?list=PLtest",
            xhr_from_yt.0,
            xhr_from_yt.1
        )));
        // чужой хост — нет
        assert!(!rules.iter().any(|r| r.matches(
            "https://example.com/youtubei/v1/player?x=1",
            xhr_from_yt.0,
            xhr_from_yt.1
        )));
        // 3p-источник (referer example.com) — правило 1p не действует
        assert!(!rules.iter().any(|r| r.matches(
            "https://www.youtube.com/watch?v=x",
            "xhr",
            Some("example.com")
        )));
        // document-запрос под $xhr-правило не попадает
        assert!(!rules.iter().any(|r| r.matches(
            "https://www.youtube.com/watch?v=x",
            "document",
            Some("www.youtube.com")
        )));
    }

    #[test]
    fn doc_rule_matches_document_requests() {
        let r = parse_rule_line("||www.youtube.com/watch?$doc,1p,replace=/\"adSlots\"/\"no_ads\"/")
            .expect("правило разбирается");
        assert!(r.matches(
            "https://www.youtube.com/watch?v=x",
            "document",
            Some("www.youtube.com")
        ));
        assert!(!r.matches(
            "https://www.youtube.com/watch?v=x",
            "xhr",
            Some("www.youtube.com")
        ));
        assert!(!r.matches(
            "https://m.youtube.com/watch?v=x",
            "document",
            Some("m.youtube.com")
        ));
    }

    #[test]
    fn exception_rule_cancels() {
        let rules = parse_replace_rules(concat!(
            "||a.test/x$xhr,replace=/foo/bar/,\n",
            "@@||a.test/x$xhr,replace=/foo/bar/,1p\n",
        ));
        assert_eq!(rules.len(), 2);
        assert!(rules[1].exception);
        assert!(rules[0].matches("https://a.test/x", "xhr", Some("a.test")));
        assert!(rules[1].matches("https://a.test/x", "xhr", Some("a.test")));
    }

    #[test]
    fn unsupported_options_skip_rule() {
        // domain= вне подмножества — правило целиком пропускается
        assert!(parse_rule_line(
            "||facebook.com/api/graphql/$xhr,replace=/a/b/,domain=web.facebook.com"
        )
        .is_none());
        // косметика и комментарии не парсятся
        assert!(parse_rule_line("www.youtube.com##+js(trusted-rpfr, x, y, player?)").is_none());
        assert!(parse_rule_line("! comment $xhr,replace=/a/b/").is_none());
        // неполное значение replace
        assert!(parse_rule_line("||a.test/$xhr,replace=/broken").is_none());
    }

    #[test]
    fn value_forms_plain_and_flags() {
        // голая подстрока → замена на пустую, глобально
        let r = parse_rule_line("||a.test/x$replace=ads").expect("разбирается");
        assert!(r.ops[0].global);
        assert_eq!(r.ops[0].replacement, "");
        let (body, changed) = apply_ops(b"ads-ads-x", &r.ops);
        assert!(changed);
        assert_eq!(String::from_utf8(body).unwrap(), "--x");
        // флаги g/i; пустая замена — // между слэшами
        let r = parse_rule_line(r"||a.test/x$replace=/AD//i").expect("разбирается");
        assert!(!r.ops[0].global);
        let (body, changed) = apply_ops(b"ad AD ad", &r.ops);
        assert!(changed);
        assert_eq!(
            String::from_utf8(body).unwrap(),
            " AD ad",
            "только первое, без регистра"
        );
        // экранированные запятые/слэши в значении
        let r = parse_rule_line(r"||a.test/x$replace=/a\,b\/c/x\,y/").expect("разбирается");
        assert!(
            r.ops[0].regex.is_match("a,b/c"),
            "{}",
            r.ops[0].regex.as_str()
        );
        assert_eq!(r.ops[0].replacement, "x,y");
        // неизвестный флаг
        assert!(parse_rule_line("||a.test/x$replace=/a/b/q").is_none());
    }

    #[test]
    fn apply_ops_first_vs_global_and_binary() {
        let r = parse_rule_line(r#"||a.test/x$replace=/"k"/"v"/"#).expect("разбирается");
        let (body, changed) = apply_ops(br#"{"k":1},{"k":2}"#, &r.ops);
        assert!(changed);
        assert_eq!(String::from_utf8(body).unwrap(), r#"{"v":1},{"k":2}"#);
        let g = parse_rule_line(r#"||a.test/x$replace=/"k"/"v"/g"#).expect("разбирается");
        let (body, _) = apply_ops(r#"{"k":1},{"k":2}"#.as_bytes(), &g.ops);
        assert_eq!(String::from_utf8(body).unwrap(), r#"{"v":1},{"v":2}"#);
        // двоичное тело не меняется и возвращается как есть
        let bin: Vec<u8> = vec![0xff, 0xfe, 0x00, 0x01];
        let (body, changed) = apply_ops(&bin, &g.ops);
        assert!(!changed);
        assert_eq!(body, bin);
        // пустое тело — пустое
        let (body, changed) = apply_ops(&[], &g.ops);
        assert!(!changed && body.is_empty());
    }

    #[test]
    fn parse_whole_list_text() {
        let rules = parse_replace_rules(concat!(
            "! Title: uBlock filters\n",
            "||ads.example.com^\n",
            "||www.youtube.com/youtubei/v1/player?$xhr,1p,replace=/\"adSlots\"/\"no_ads\"/\n",
            "example.com##.ad\n",
        ));
        assert_eq!(rules.len(), 1);
    }

    // --- самофетч: loopback HTTP-стенд ---------------------------------------

    /// Одноразовый HTTP-сервер: отвечает фиксированным сырым ответом, пишет
    /// принятый запрос (для проверки переноса заголовков/тела).
    fn one_shot_server(raw_response: &str) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<u8>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen_clone = std::sync::Arc::clone(&seen);
        let raw = raw_response.to_string();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut buf = Vec::new();
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
                // читаем заголовки + тело (Content-Length)
                let mut chunk = [0u8; 4096];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            let head_end =
                                buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
                            if let Some(h) = head_end {
                                let head = String::from_utf8_lossy(&buf[..h]).to_string();
                                let cl = head
                                    .lines()
                                    .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                                    .and_then(|l| l.split(':').nth(1))
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                                    .unwrap_or(0);
                                if buf.len() >= h + cl {
                                    break;
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                *seen_clone.lock().unwrap() = buf;
                let _ = stream.write_all(raw.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, seen)
    }

    #[test]
    fn fetch_rewrites_body_and_filters_headers() {
        let body = r#"{"adSlots":[{"wo":1}],"playabilityStatus":{"status":"OK"}}"#;
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nSet-Cookie: PREF=AL\r\n\r\n{}",
            body.len(),
            body
        );
        let (port, seen) = one_shot_server(&raw);
        let rules: Vec<ReplaceRule> = LIVE_YOUTUBE
            .iter()
            .filter_map(|l| parse_rule_line(l))
            .collect();
        let ops: Vec<ReplaceOp> = rules.iter().flat_map(|r| r.ops.clone()).collect();
        let resp = fetch_and_rewrite(
            "GET",
            &format!("http://127.0.0.1:{port}/youtubei/v1/player?x=1"),
            &[
                ("Accept".into(), "*/*".into()),
                ("Accept-Encoding".into(), "gzip".into()),
            ],
            None,
            &ops,
            None,
        )
        .expect("самофетч ок");
        assert_eq!(resp.status, 200);
        assert_eq!(resp.reason, "OK");
        let text = String::from_utf8(resp.body.clone()).unwrap();
        assert!(text.contains(r#""no_ads""#), "{text}");
        assert!(!text.contains("adSlots"));
        assert!(resp.changed);
        // заголовки перенесены, контентные — нет
        assert!(resp
            .headers
            .iter()
            .any(|(n, v)| n == "content-type" && v == "application/json"));
        assert!(resp
            .headers
            .iter()
            .any(|(n, v)| n == "set-cookie" && v == "PREF=AL"));
        assert!(!resp.headers.iter().any(|(n, _)| n == "content-length"));
        // запрос ушёл со сжатием ureq (gzip-фича: прозрачная декомпрессия,
        // content-encoding ответа срезаем) и с перенесённым Accept
        let req = String::from_utf8(seen.lock().unwrap().clone()).unwrap();
        assert!(req.starts_with("GET /youtubei/v1/player?x=1 HTTP/1.1"));
        assert!(req.to_ascii_lowercase().contains("accept: */*"));
        assert!(
            req.to_ascii_lowercase().contains("accept-encoding: gzip"),
            "ureq просит gzip — тело качается сжатым: {req}"
        );
    }

    #[test]
    fn fetch_forwards_post_body_and_method() {
        let raw = "HTTP/1.1 204 No Content\r\n\r\n";
        let (port, seen) = one_shot_server(raw);
        let resp = fetch_and_rewrite(
            "POST",
            &format!("http://127.0.0.1:{port}/player"),
            &[("Content-Type".into(), "application/json".into())],
            Some(br#"{"context":{"client":"web"}}"#),
            &[],
            None,
        )
        .expect("самофетч ок");
        assert_eq!(resp.status, 204);
        assert!(resp.body.is_empty());
        assert!(!resp.changed);
        let req = String::from_utf8(seen.lock().unwrap().clone()).unwrap();
        assert!(req.starts_with("POST /player HTTP/1.1"));
        assert!(req.contains(r#"{"context"#));
        assert!(req
            .to_ascii_lowercase()
            .contains("content-type: application/json"));
    }

    #[test]
    fn fetch_redirect_passes_through() {
        let raw = "HTTP/1.1 302 Found\r\nLocation: https://example.test/x\r\n\r\n";
        let (port, _) = one_shot_server(raw);
        let resp = fetch_and_rewrite(
            "GET",
            &format!("http://127.0.0.1:{port}/watch?v=1"),
            &[],
            None,
            &[],
            None,
        )
        .expect("редирект без следования — просто ответ");
        assert_eq!(resp.status, 302);
        assert!(resp
            .headers
            .iter()
            .any(|(n, v)| n == "location" && v == "https://example.test/x"));
    }

    #[test]
    fn fetch_failure_returns_none() {
        // порт без слушателя — TCP отказ, самофетч честно говорит None
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(fetch_and_rewrite(
            "GET",
            &format!("http://127.0.0.1:{port}/x"),
            &[],
            None,
            &[],
            None
        )
        .is_none());
    }
}
