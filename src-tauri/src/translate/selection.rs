//! Перевод выделенного текста (карточка duopulse-098, расширение duopulse-116):
//! пункт «Перевести выделение» в нативном контекстном меню страницы (src/
//! translate_menu.rs, WebView2 ContextMenuRequested) → бабл перевода у
//! выделения в content-слое (content/translate-select.ts; выбор источника и
//! ДОСКОЛЬКИ языков — WebMessage «translate-selection» в main.rs).
//!
//! Движок — бесплатный эндпоинт Google Translate (translate_a/single,
//! client=gtx): без ключа API, как расширения Chrome. Разовые переводы
//! вручную выделенных фрагментов; пачки субтитров остаются на настроенном
//! провайдере задачи 4.1 (ключ, лимиты) — это разные сценарии. Транспорт —
//! общий [`HttpTransport`] (тесты — без сети на mock-ответах).
//!
//! Лимиты бесплатного gtx (duopulse-116: «второй запрос — слишком много
//! запросов»): сервис режет по IP охотно, а быстрые повторы только
//! продлевают блок. Поэтому [`SelectionEngine`] держит сессию-состояние:
//! кэш повторных фрагментов (тот же текст — без сети), одну неторопливую
//! повторную попытку на 429 и общий кулдаун после исчерпания — следующие
//! запросы падают сразу с подсказкой «подождите N с», не дёргая сервис.

use std::sync::Mutex;
use std::time::Duration;

use super::http::HttpTransport;
use super::{status_error, RetryPolicy, TranslateError};

/// Максимум символов выделения (GET-запрос с текстом в URL; большее —
/// ошибка TooLarge, бабл покажет подсказку сократить фрагмент).
pub const MAX_SELECTION_CHARS: usize = 1500;

/// Максимум целевых языков одного перевода (duopulse-116): больше — чипы
/// не влезают в бабл, а gtx-лимит расходуется в разы быстрее.
pub const MAX_SELECTION_TARGETS: usize = 4;

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

/// Нормализовать источник: "" → "auto" (автоопределение).
fn norm_source(lang: &str) -> String {
    let s = norm_lang(lang);
    if s.is_empty() {
        "auto".into()
    } else {
        s
    }
}

/// Почистить список целевых языков: нормализация, дубликаты, лимит
/// количества. Пустой список — ошибка конфигурации.
pub fn norm_targets(targets: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in targets {
        let t = norm_lang(t);
        if !t.is_empty() && !out.contains(&t) {
            out.push(t);
            if out.len() >= MAX_SELECTION_TARGETS {
                break;
            }
        }
    }
    out
}

/// Подпись пункта меню «Перевести выделение»: источник → цели, авто —
/// короткая форма «на …»; больше двух языков — «+N» (меню не растягиваем).
pub fn selection_menu_label(source: &str, targets: &[String]) -> String {
    let langs = if targets.len() > 2 {
        let shown: Vec<&str> = targets.iter().take(2).map(String::as_str).collect();
        format!("{} +{}", shown.join(", "), targets.len() - 2)
    } else {
        targets.join(", ")
    };
    let source = norm_source(source);
    if source == "auto" {
        format!("Перевести выделение (на {langs})")
    } else {
        format!("Перевести выделение ({source} → {langs})")
    }
}

/// Сессия-кулдаун gtx: до этого момента запросы не уходят в сеть вовсе —
/// честная подсказка вместо трёх безнадёжных попыток (duopulse-116).
fn remaining_secs(until: std::time::Instant) -> u64 {
    until.saturating_duration_since(std::time::Instant::now()).as_secs().max(1)
}

/// Движок перевода выделений с сессионным состоянием: кэш фрагментов +
/// кулдаун gtx. Один на приложение (translate_menu.rs); тесты строят свой.
pub struct SelectionEngine {
    /// Кэш «источник|цель|текст» → перевод (конец — самые свежие).
    cache: Mutex<Vec<(String, SelectionTranslation)>>,
    /// Момент, до которого gtx просил подождать (после исчерпания ретраев).
    cooldown_until: Mutex<Option<std::time::Instant>>,
    /// Пауза перед единственным повтором на 429 (тесты — 0/1 мс).
    retry429_ms: u64,
    /// Длина кулдауна после исчерпания, с (тесты — короче).
    cooldown_secs: u64,
}

impl Default for SelectionEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl SelectionEngine {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(Vec::new()),
            cooldown_until: Mutex::new(None),
            retry429_ms: 5000,
            cooldown_secs: 120,
        }
    }

    /// Движок с компактными таймингами (юнит-тесты без реальных пауз).
    pub fn with_timings(retry429_ms: u64, cooldown_secs: u64) -> Self {
        Self {
            retry429_ms,
            cooldown_secs,
            ..Self::new()
        }
    }

    /// Перевести фрагмент: кэш → кулдаун → gtx с одной неторопливой
    /// повторной попыткой на 429; сеть/5xx — обычная политика ретраев.
    pub fn translate(
        &self,
        transport: &dyn HttpTransport,
        text: &str,
        source_lang: &str,
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
        let source = norm_source(source_lang);
        let target = norm_lang(target_lang);
        if target.is_empty() {
            return Err(TranslateError::Config("язык перевода не задан".into()));
        }
        let key = format!("{source}|{target}|{text}");
        if let Some(hit) = self.cache_get(&key) {
            return Ok(hit); // повторный фрагмент — без сети и без лимитов
        }
        if let Some(until) = *self.cooldown_until.lock().unwrap() {
            if until > std::time::Instant::now() {
                let secs = remaining_secs(until);
                return Err(TranslateError::RateLimited(format!(
                    "бесплатный сервис перевода просит подождать ~{secs} с (лимит запросов)"
                )));
            }
        }
        let url = format!(
            "{GTX_ENDPOINT}?client=gtx&sl={source}&tl={target}&dt=t&q={}",
            urlencode(text)
        );
        let policy = RetryPolicy::default();
        let mut attempt: u32 = 1;
        let mut rate_limited_once = false;
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
                Ok(t) => {
                    // сервис снова отвечает — блок снят
                    *self.cooldown_until.lock().unwrap() = None;
                    self.cache_put(key.clone(), t.clone());
                    return Ok(t);
                }
                Err(e) => {
                    // 429 — не бить быстро: один повтор через паузу, затем
                    // общий кулдаун с подсказкой (быстрые повторы только
                    // продлевают блок бесплатного эндпоинта).
                    let retry = if matches!(e, TranslateError::RateLimited(_)) {
                        if rate_limited_once || self.retry429_ms == 0 {
                            let until =
                                std::time::Instant::now() + Duration::from_secs(self.cooldown_secs);
                            *self.cooldown_until.lock().unwrap() = Some(until);
                            false
                        } else {
                            rate_limited_once = true;
                            std::thread::sleep(Duration::from_millis(self.retry429_ms));
                            true
                        }
                    } else if e.retryable() && attempt < policy.max_attempts {
                        let delay = policy.delay_ms(attempt);
                        if delay > 0 {
                            std::thread::sleep(Duration::from_millis(delay));
                        }
                        attempt += 1;
                        true
                    } else {
                        false
                    };
                    if !retry {
                        return Err(e);
                    }
                }
            }
        }
    }

    fn cache_get(&self, key: &str) -> Option<SelectionTranslation> {
        self.cache
            .lock()
            .unwrap()
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    fn cache_put(&self, key: String, value: SelectionTranslation) {
        const CACHE_CAP: usize = 32;
        let mut cache = self.cache.lock().unwrap();
        cache.retain(|(k, _)| k != &key);
        cache.push((key, value));
        while cache.len() > CACHE_CAP {
            cache.remove(0);
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
    fn over_limit_rejected_before_network() {
        let t = MockTransport::new();
        let long = "x".repeat(MAX_SELECTION_CHARS + 1);
        let err = SelectionEngine::new()
            .translate(&t, &long, "auto", "ru")
            .unwrap_err();
        assert!(matches!(err, TranslateError::TooLarge(_)), "{err:?}");
        assert!(t.recorded().is_empty()); // сеть не трогали
    }

    #[test]
    fn normalizes_langs_and_builds_url() {
        let t = MockTransport::new();
        t.push_ok(200, &ok_body());
        let out = SelectionEngine::new()
            .translate(&t, "  hello world  ", " EN ", " RU ")
            .unwrap();
        assert_eq!(out.text, "Привет, мир!");
        let call = &t.recorded()[0];
        assert!(call.url.contains("tl=ru"), "{}", call.url);
        assert!(call.url.contains("sl=en"), "{}", call.url);
        assert!(call.url.contains("q=hello%20world"), "{}", call.url);
        assert!(call.url.contains("client=gtx"), "{}", call.url);
    }

    #[test]
    fn empty_source_means_auto_in_url() {
        let t = MockTransport::new();
        t.push_ok(200, &ok_body());
        SelectionEngine::new()
            .translate(&t, "hi", "", "ru")
            .unwrap();
        assert!(t.recorded()[0].url.contains("sl=auto"));
    }

    #[test]
    fn cache_answers_repeat_without_network() {
        let t = MockTransport::new();
        t.push_ok(200, &ok_body());
        let engine = SelectionEngine::new();
        let first = engine.translate(&t, "hi", "auto", "ru").unwrap();
        let second = engine.translate(&t, "hi", "auto", "ru").unwrap();
        assert_eq!(first, second);
        assert_eq!(t.recorded().len(), 1); // второй раз — из кэша
        // другой язык — мимо кэша, нужен новый ответ
        t.push_ok(200, &ok_body());
        engine.translate(&t, "hi", "auto", "ro").unwrap();
        assert_eq!(t.recorded().len(), 2);
    }

    #[test]
    fn rate_limited_retries_once_slowly_then_succeeds() {
        let t = MockTransport::new();
        t.push_ok(429, "{}");
        t.push_ok(200, &ok_body());
        let out = SelectionEngine::with_timings(1, 120)
            .translate(&t, "hi", "auto", "ru")
            .unwrap();
        assert_eq!(out.text, "Привет, мир!");
        assert_eq!(t.recorded().len(), 2); // одна пауза-повтор, не три
    }

    #[test]
    fn rate_limited_sets_cooldown_and_next_fails_fast() {
        let t = MockTransport::new();
        t.push_ok(429, "{}");
        let engine = SelectionEngine::with_timings(0, 120);
        let err = engine.translate(&t, "hi", "auto", "ru").unwrap_err();
        assert!(matches!(err, TranslateError::RateLimited(_)), "{err:?}");
        // следующий запрос (другой текст) — сразу с подсказкой, без сети
        let err2 = engine.translate(&t, "other", "auto", "ru").unwrap_err();
        assert!(
            matches!(err2, TranslateError::RateLimited(ref d) if d.contains("подождать")),
            "{err2:?}"
        );
        assert_eq!(t.recorded().len(), 1);
    }

    #[test]
    fn success_clears_cooldown() {
        let t = MockTransport::new();
        t.push_ok(429, "{}");
        let engine = SelectionEngine::with_timings(0, 1);
        assert!(engine.translate(&t, "hi", "auto", "ru").is_err());
        // кулдаун истёк по часам — сеть снова пробуется, успех снимает его
        std::thread::sleep(Duration::from_millis(1100));
        t.push_ok(200, &ok_body());
        engine.translate(&t, "fresh", "auto", "ru").unwrap();
        t.push_ok(429, "{}"); // кулдаун снят успехом — снова доходит до сети
        assert!(engine.translate(&t, "again", "auto", "ru").is_err());
        assert_eq!(t.recorded().len(), 3);
    }

    #[test]
    fn fatal_http_error_no_retry() {
        let t = MockTransport::new();
        t.push_ok(400, "bad");
        let err = SelectionEngine::new()
            .translate(&t, "hi", "auto", "ru")
            .unwrap_err();
        assert!(matches!(err, TranslateError::BadResponse(_)), "{err:?}");
        assert_eq!(t.recorded().len(), 1);
    }

    #[test]
    fn network_error_is_retryable_then_fails() {
        let t = MockTransport::new();
        t.push_err("timeout");
        t.push_err("timeout");
        t.push_err("timeout");
        let err = SelectionEngine::new()
            .translate(&t, "hi", "auto", "ru")
            .unwrap_err();
        assert!(matches!(err, TranslateError::Network(_)), "{err:?}");
        assert_eq!(t.recorded().len(), 3); // default-политика: 3 попытки
    }

    #[test]
    fn empty_and_no_lang_are_config_errors() {
        let t = MockTransport::new();
        assert!(matches!(
            SelectionEngine::new().translate(&t, "   ", "auto", "ru"),
            Err(TranslateError::Config(_))
        ));
        assert!(matches!(
            SelectionEngine::new().translate(&t, "hi", "auto", " "),
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
        let err = SelectionEngine::new()
            .translate(&NoGet, "hi", "auto", "ru")
            .unwrap_err();
        assert!(matches!(err, TranslateError::Network(_)), "{err:?}");
    }

    #[test]
    fn norm_targets_dedups_caps_and_normalizes() {
        let out = norm_targets(&[" RU ".into(), "ru".into(), "ro".into(), "".into()]);
        assert_eq!(out, vec!["ru".to_string(), "ro".to_string()]);
        let many: Vec<String> = (0..6).map(|i| format!("l{i}")).collect();
        assert_eq!(norm_targets(&many).len(), MAX_SELECTION_TARGETS);
    }

    #[test]
    fn menu_label_forms() {
        assert_eq!(
            selection_menu_label("auto", &["ru".into()]),
            "Перевести выделение (на ru)"
        );
        assert_eq!(
            selection_menu_label("", &["ru".into(), "ro".into()]),
            "Перевести выделение (на ru, ro)"
        );
        assert_eq!(
            selection_menu_label("en", &["ru".into(), "ro".into()]),
            "Перевести выделение (en → ru, ro)"
        );
        assert_eq!(
            selection_menu_label("en", &["ru".into(), "ro".into(), "de".into()]),
            "Перевести выделение (en → ru, ro +1)"
        );
    }
}
