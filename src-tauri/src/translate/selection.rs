//! Перевод выделенного текста (карточка duopulse-098): пункт «Перевести
//! выделение» в нативном контекстном меню страницы (src/translate_menu.rs,
//! WebView2 ContextMenuRequested) → бабл перевода у выделения в content-слое
//! (content/translate-select.ts; смена языка в баббле — WebMessage
//! «translate-selection» в main.rs).
//!
//! Движок — бесплатный эндпоинт Google Translate (translate_a/single,
//! client=gtx): без ключа API, как расширения Chrome. Разовые переводы
//! вручную выделенных фрагментов; пачки субтитров остаются на настроенном
//! провайдере задачи 4.1 (ключ, лимиты) — это разные сценарии. Транспорт —
//! общий [`HttpTransport`] (тесты — без сети на mock-ответах).

use super::http::HttpTransport;
use super::{status_error, RetryPolicy, TranslateError};

/// Максимум символов выделения (GET-запрос с текстом в URL; большее —
/// ошибка TooLarge, бабл покажет подсказку сократить фрагмент).
pub const MAX_SELECTION_CHARS: usize = 1500;

const GTX_ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";

/// Результат перевода выделения.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectionTranslation {
    /// Определённый язык оригинала ("en"; "" — сервис не сказал).
    pub detected: String,
    /// Переведённый текст.
    pub text: String,
}

/// Процент-кодирование query-значения ( everything не [A-Za-z0-9-_.~] ):
/// внешних ящиков не тянем, текст идёт в URL GET-запроса.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// Код языка: trim + нижний регистр (gtx принимает ru, en, pt-br…).
fn norm_lang(lang: &str) -> String {
    lang.trim().to_ascii_lowercase()
}

/// Перевести выделение через бесплатный gtx-эндпоинт с ретраями
/// (сетевые/5xx/429 — та же политика, что у провайдеров 4.1).
pub fn translate_selection(
    transport: &dyn HttpTransport,
    text: &str,
    target_lang: &str,
) -> Result<SelectionTranslation, TranslateError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(TranslateError::Config("выделение пустое".into()));
    }
    if text.chars().count() > MAX_SELECTION_CHARS {
        return Err(TranslateError::TooLarge(format!(
            "фрагмент длиннее {MAX_SELECTION_CHARS} символов — сократите выделение"
        )));
    }
    let target = norm_lang(target_lang);
    if target.is_empty() {
        return Err(TranslateError::Config("язык перевода не задан".into()));
    }
    let url = format!(
        "{GTX_ENDPOINT}?client=gtx&sl=auto&tl={target}&dt=t&q={}",
        urlencode(text)
    );
    let policy = RetryPolicy::default();
    let mut attempt: u32 = 1;
    loop {
        let outcome = transport.get(&url);
        let parsed = match outcome {
            Ok(resp) => match resp.status {
                200 => parse_gtx(&resp.body),
                s => Err(status_error(s, resp.body, "gtx")),
            },
            Err(e) => Err(TranslateError::from(e)),
        };
        match parsed {
            Ok(t) => return Ok(t),
            Err(e) if e.retryable() && attempt < policy.max_attempts => {
                let delay = policy.delay_ms(attempt);
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Разбор тела gtx: `[[["Привет","hello",null,null,…],…],…,"en",…]` —
/// сегменты перевода (конкатенация [0] каждого), детект — элемент [2].
/// Формат нестабилен — разбор снисходительный, но битое тело честно
/// BadResponse (молчаливый пустой перевод хуже ошибки).
pub fn parse_gtx(body: &str) -> Result<SelectionTranslation, TranslateError> {
    let v: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| TranslateError::BadResponse(format!("gtx: не JSON: {e}")))?;
    let segments = v
        .as_array()
        .and_then(|a| a.first())
        .and_then(|first| first.as_array())
        .ok_or_else(|| TranslateError::BadResponse("gtx: нет массива сегментов".into()))?;
    let mut text = String::new();
    for seg in segments {
        let piece = seg
            .as_array()
            .and_then(|s| s.first())
            .and_then(|p| p.as_str());
        if let Some(p) = piece {
            text.push_str(p);
        }
    }
    if text.trim().is_empty() {
        return Err(TranslateError::BadResponse("gtx: пустой перевод".into()));
    }
    let detected = v
        .as_array()
        .and_then(|a| a.get(2))
        .and_then(|l| l.as_str())
        .unwrap_or("")
        .to_string();
    Ok(SelectionTranslation { detected, text })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::{HttpResponse, MockTransport, TransportError};

    /// Реальная форма gtx: resp[0] — массив пар [перевод, оригинал, …],
    /// по одной на предложение; детект — resp[2].
    fn ok_body() -> String {
        r#"[[["Привет, ","hello, ",null,null,1],["мир!","world!",null,null,1]],null,"en",null,null,null,1,null,null,[]]"#.into()
    }

    #[test]
    fn urlencode_leaves_unreserved_and_encodes_rest() {
        assert_eq!(urlencode("aZ09-_.~"), "aZ09-_.~");
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
        assert_eq!(urlencode("ж"), "%D0%B6");
    }

    #[test]
    fn parse_gtx_joins_segments_and_takes_detected() {
        // пары [перевод, оригинал] — конкатенация переводов
        let body = r#"[[["Привет, ","hello, "],["мир!","world!"]],null,"en",["en"]]"#;
        let t = parse_gtx(body).unwrap();
        assert_eq!(t.text, "Привет, мир!");
        assert_eq!(t.detected, "en");
    }

    #[test]
    fn parse_gtx_multi_sentence_pairs() {
        let t = parse_gtx(&ok_body()).unwrap();
        assert_eq!(t.text, "Привет, мир!");
        assert_eq!(t.detected, "en");
    }

    #[test]
    fn parse_gtx_rejects_broken_bodies() {
        assert!(parse_gtx("not json").is_err());
        assert!(parse_gtx("[]").is_err());
        assert!(parse_gtx("[[[]],null,\"en\"]").is_err()); // сегментов без текста
        assert!(parse_gtx("[[[]],null,\"en\"]")
            .unwrap_err()
            .message()
            .contains("перевод"));
    }

    #[test]
    fn selection_over_limit_rejected_before_network() {
        let t = MockTransport::new();
        let long = "x".repeat(MAX_SELECTION_CHARS + 1);
        let err = translate_selection(&t, &long, "ru").unwrap_err();
        assert!(matches!(err, TranslateError::TooLarge(_)), "{err:?}");
        assert!(t.recorded().is_empty()); // сеть не трогали
    }

    #[test]
    fn selection_normalizes_lang_and_builds_url() {
        let t = MockTransport::new();
        t.push_ok(200, &ok_body());
        let out = translate_selection(&t, "  hello world  ", " RU ").unwrap();
        assert_eq!(out.text, "Привет, мир!");
        let call = &t.recorded()[0];
        assert!(call.url.contains("tl=ru"), "{}", call.url);
        assert!(call.url.contains("q=hello%20world"), "{}", call.url);
        assert!(call.url.contains("client=gtx"), "{}", call.url);
    }

    #[test]
    fn selection_retries_on_429_then_succeeds() {
        let t = MockTransport::new();
        t.push_ok(429, "{}");
        t.push_ok(200, &ok_body());
        let out = translate_selection(&t, "hi", "ru").unwrap();
        assert_eq!(out.text, "Привет, мир!");
        assert_eq!(t.recorded().len(), 2);
    }

    #[test]
    fn selection_fatal_http_error_no_retry() {
        let t = MockTransport::new();
        t.push_ok(400, "bad");
        let err = translate_selection(&t, "hi", "ru").unwrap_err();
        assert!(matches!(err, TranslateError::BadResponse(_)), "{err:?}");
        assert_eq!(t.recorded().len(), 1);
    }

    #[test]
    fn selection_network_error_is_retryable_then_fails() {
        let t = MockTransport::new();
        t.push_err("timeout");
        t.push_err("timeout");
        t.push_err("timeout");
        let err = translate_selection(&t, "hi", "ru").unwrap_err();
        assert!(matches!(err, TranslateError::Network(_)), "{err:?}");
        assert_eq!(t.recorded().len(), 3); // default-политика: 3 попытки
    }

    #[test]
    fn selection_empty_and_no_lang_are_config_errors() {
        let t = MockTransport::new();
        assert!(matches!(
            translate_selection(&t, "   ", "ru"),
            Err(TranslateError::Config(_))
        ));
        assert!(matches!(
            translate_selection(&t, "hi", " "),
            Err(TranslateError::Config(_))
        ));
    }

    #[test]
    fn transport_get_default_unsupported() {
        // Транспорт без GET (например, тестовый NoTransport мод. 4.1) —
        // внятная сетевая ошибка, не паника.
        struct NoGet;
        impl HttpTransport for NoGet {
            fn post_json(
                &self,
                _url: &str,
                _headers: &[(&str, &str)],
                _body: &serde_json::Value,
            ) -> Result<HttpResponse, TransportError> {
                unreachable!()
            }
        }
        let err = translate_selection(&NoGet, "hi", "ru").unwrap_err();
        assert!(matches!(err, TranslateError::Network(_)), "{err:?}");
    }
}
