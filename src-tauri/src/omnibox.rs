//! Разбор ввода адресной строки (задача 1.3, docs/05 §2 `nav.resolve_omnibox`):
//! «URL (с догадкой схемы) или поисковый запрос поисковика по умолчанию».
//!
//! Решение принимает Core (не UI), чтобы omnibox-семантика была единой для
//! всех точек входа и покрывалась юнит-тестами без браузера. Результат —
//! готовый URL: UI на Enter просто зовёт `nav.navigate`.
//!
//! Поисковик по умолчанию — настройка «Поиск» задачи 5.1 (settings.json,
//! раздел "search"; словарь движков и дефолт YouTube — src/settings/mod.rs).

/// Разобранный ввод omnibox: готовый URL перехода + признак поиска.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolution {
    /// Куда идти (для запроса — поисковая ссылка).
    pub url: String,
    /// Ввод распознан как поисковый запрос (не как адрес).
    pub is_search: bool,
}

/// Разобрать ввод пользователя: адрес (с догадкой схемы) или поиск —
/// поисковик с шаблоном ссылки `prefix` (encoded-запрос дописывается в конец;
/// хендлер nav.resolve_omnibox подставляет выбранный движок из настроек).
pub fn resolve_with(input: &str, prefix: &str) -> Resolution {
    let t = input.trim();
    if has_known_scheme(t) {
        return Resolution {
            url: t.to_string(),
            is_search: false,
        };
    }
    // Адрес не содержит пробелов — проверяем до разбора хоста.
    if t.chars().any(char::is_whitespace) {
        return search(t, prefix);
    }
    let (host, _rest) = split_host_rest(t);
    if is_ipv6_literal(host) || is_local_host(host) || is_ipv4(host) || is_domain(host) {
        // localhost и IP — локальная разработка (http), прочее — https.
        let scheme = if is_local_host(host) || is_ipv4(host) || is_ipv6_literal(host) {
            "http"
        } else {
            "https"
        };
        return Resolution {
            url: format!("{scheme}://{t}"),
            is_search: false,
        };
    }
    search(t, prefix)
}

fn search(query: &str, prefix: &str) -> Resolution {
    Resolution {
        url: format!("{prefix}{}", encode_query(query)),
        is_search: true,
    }
}

/// encodeURIComponent() из JS (RFC 3986: unreserved — как есть, прочее — %XX).
fn encode_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Схемы, которые пользователь может ввести намеренно и перейти напрямую.
/// Whitelist (а не `Url::parse` по любой схеме): иначе «mailto:a@b.c» или
/// «http:foo» молча стали бы переходом по несуществующей схеме.
fn has_known_scheme(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    [
        "http://",
        "https://",
        "file://",
        "about:",
        "data:",
        "view-source:",
        "tauri://",
    ]
    .iter()
    .any(|s| lower.starts_with(s))
}

/// Отделить «хост[:порт]» от пути/запроса/фрагмента (первый из / ? #).
fn split_host_rest(t: &str) -> (&str, &str) {
    match t.find(['/', '?', '#']) {
        Some(i) => t.split_at(i),
        None => (t, ""),
    }
}

/// Отделить «:порт» (только цифры) от хоста.
fn split_port(host: &str) -> (&str, Option<&str>) {
    match host.rfind(':') {
        Some(i)
            if !host[i + 1..].is_empty() && host[i + 1..].bytes().all(|b| b.is_ascii_digit()) =>
        {
            (&host[..i], Some(&host[i + 1..]))
        }
        _ => (host, None),
    }
}

/// IPv6-литерал в квадратных скобках, возможно с портом: `[::1]:8080`.
fn is_ipv6_literal(host: &str) -> bool {
    host.starts_with('[') && host.contains(']')
}

/// localhost[:порт] — единственный хост без точки, который браузеры
/// переводят в URL (http, локальная разработка).
fn is_local_host(host: &str) -> bool {
    let (name, _) = split_port(host);
    name.eq_ignore_ascii_case("localhost")
}

/// IPv4 (возможно с портом): 4 точки-разделённые группы цифр 0–255.
fn is_ipv4(host: &str) -> bool {
    let (ip, _) = split_port(host);
    let mut parts = ip.split('.');
    (0..4).all(|_| {
        parts.next().is_some_and(|p| {
            !p.is_empty()
                && p.bytes().all(|b| b.is_ascii_digit())
                && p.parse::<u16>().is_ok_and(|n| n <= 255)
        })
    }) && parts.next().is_none()
}

/// Домен: ≥2 непустых меток из букв/цифр/`-`/`_` через точки, TLD начинается
/// с буквы (отсекает «2.5» и прочие числа с точками; юникод-домены — да,
/// url-крейт сам закодирует их в punycode).
fn is_domain(host: &str) -> bool {
    let (name, _) = split_port(host);
    let labels: Vec<&str> = name.split('.').collect();
    labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty()
                && l.chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
        })
        && labels
            .last()
            .is_some_and(|l| l.chars().next().is_some_and(char::is_alphabetic))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Дефолтный движок (YouTube) — префикс из настроек задачи 5.1.
    const YT: &str = "https://www.youtube.com/results?search_query=";

    fn url(input: &str) -> String {
        resolve_with(input, YT).url
    }

    fn is_search(input: &str) -> bool {
        resolve_with(input, YT).is_search
    }

    #[test]
    fn full_urls_pass_through() {
        assert_eq!(url("https://example.com/"), "https://example.com/");
        assert_eq!(url("  http://a.b/c?d=e  "), "http://a.b/c?d=e");
        assert_eq!(url("file:///C:/temp/x.html"), "file:///C:/temp/x.html");
        assert_eq!(url("about:blank"), "about:blank");
        assert!(!is_search("https://example.com/"));
    }

    #[test]
    fn bare_domains_get_https() {
        assert_eq!(url("youtube.com"), "https://youtube.com");
        assert_eq!(
            url("youtube.com/watch?v=x"),
            "https://youtube.com/watch?v=x"
        );
        assert_eq!(
            url("ru.wikipedia.org/wiki/Поиск"),
            "https://ru.wikipedia.org/wiki/Поиск"
        );
        assert_eq!(url("мой-сайт.рф"), "https://мой-сайт.рф");
        assert!(!is_search("youtube.com"));
    }

    #[test]
    fn localhost_and_ips_get_http() {
        assert_eq!(url("localhost"), "http://localhost");
        assert_eq!(url("LOCALHOST:3000"), "http://LOCALHOST:3000");
        assert_eq!(url("localhost:3000/admin"), "http://localhost:3000/admin");
        assert_eq!(url("127.0.0.1"), "http://127.0.0.1");
        assert_eq!(url("192.168.1.5:8080/x"), "http://192.168.1.5:8080/x");
        assert_eq!(url("[::1]:8080"), "http://[::1]:8080");
    }

    #[test]
    fn search_queries_go_to_engine() {
        assert!(is_search("как дела"));
        assert!(is_search("что такое rust"));
        assert!(is_search("foo bar.baz")); // пробел — запрос, не хост
        assert!(is_search("rust lang"));
    }

    #[test]
    fn colon_without_known_scheme_is_search() {
        // домен с портом — адрес (как в Chrome), прочие «схемы» — запрос
        assert!(!is_search("example.com:8080"));
        assert_eq!(url("example.com:8080"), "https://example.com:8080");
        assert!(is_search("http:foo")); // схема без // — не URL
        assert!(is_search("mailto:a@b.c"));
    }

    #[test]
    fn numbers_with_dots_are_search() {
        assert!(is_search("2.5"));
        assert!(is_search("1.2.3.4.5"));
        assert!(is_search("3,14"));
    }

    #[test]
    fn query_is_percent_encoded() {
        assert_eq!(
            url("кот && 100%"),
            "https://www.youtube.com/results?search_query=%D0%BA%D0%BE%D1%82%20%26%26%20100%25"
        );
    }

    // --- задача 5.1: поисковик по умолчанию — настройка -----------------------

    #[test]
    fn search_engine_prefix_from_settings() {
        // настройка «Поиск» → префикс движка; адреса от двигателя не зависят
        let g = resolve_with("как дела", "https://www.google.com/search?q=");
        assert!(g.is_search);
        assert_eq!(
            g.url,
            "https://www.google.com/search?q=%D0%BA%D0%B0%D0%BA%20%D0%B4%D0%B5%D0%BB%D0%B0"
        );
        let ddg = resolve_with("rust lang", "https://duckduckgo.com/?q=");
        assert_eq!(ddg.url, "https://duckduckgo.com/?q=rust%20lang");
        assert_eq!(
            resolve_with("youtube.com", "https://www.google.com/search?q=").url,
            "https://youtube.com",
            "адрес не зависит от поисковика"
        );
        // дефолтная семантика не изменилась
        assert_eq!(
            url("кот && 100%"),
            "https://www.youtube.com/results?search_query=%D0%BA%D0%BE%D1%82%20%26%26%20100%25"
        );
    }
}
