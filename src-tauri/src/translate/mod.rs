//! Провайдеры машинного перевода (задача 4.1, docs/03 §7): перевод массива
//! строк (cue-тексты субтитров) с языка на язык через API пользователя.
//!
//! Интерфейс [`TranslationProvider`] — лимиты пачки, типизированные ошибки,
//! ретраи ([`translate_with_retries`]); реализации: DeepL (deepl.rs),
//! Google Translate v2 (google.rs), self-hosted LibreTranslate (libre.rs).
//! Выбор провайдера — панель «Перевод» настроек субтитров (ключ "translate"
//! в settings.json, ключи API — DPAPI, config.rs).
//!
//! HTTP изолирован за [`HttpTransport`] — тесты провайдеров подменные, без
//! сети (mock-ответы http.rs). Конвейер перевода дорожек (батчинг ≤ 2 КБ,
//! контекст пачек, SQLite-кэш, событие прогресса) — pipeline.rs (задача 4.2);
//! офлайн-деградация и бейдж «перевод недоступен» — 4.3.

mod config;
mod deepl;
mod google;
mod http;
mod libre;
pub(crate) mod pipeline;

pub use config::{
    save_settings, settings_view, test_provider, ProviderId, TranslateConfig, TranslateSettings,
};
pub use http::{HttpTransport, UreqTransport};
pub use pipeline::{handle_translate_request, SubtitlesTranslateProgress};

use std::time::Duration;

/// Запрос пачки строк. Пачку собирает батчер задачи 4.2 (≤ 2 КБ текста,
/// docs/03 §7); здесь — единая форма для всех провайдеров.
#[derive(Debug, Clone, PartialEq)]
pub struct TranslateRequest {
    /// Строки пачки (одна строка — текст одного cue, переносы внутри).
    pub texts: Vec<String>,
    /// Язык оригинала, "" — автоопределение (Google/LibreTranslate).
    pub source_lang: String,
    /// Целевой язык, код нижним регистром ("ru", "en", "pt-br").
    pub target_lang: String,
    /// Последняя строка предыдущей пачки — контекст связности терминов
    /// (DeepL `context`, docs/03 §7); провайдеры без поддержки игнорируют.
    pub context_before: Option<String>,
}

impl TranslateRequest {
    /// Суммарная длина текстов пачки, байт.
    pub fn texts_bytes(&self) -> usize {
        self.texts.iter().map(|t| t.len()).sum()
    }
}

/// Ограничения пачки провайдера: батчер 4.2 режет cue-таблицу по ним ДО
/// запроса (превышение в translate_batch — защитная ошибка TooLarge).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderLimits {
    /// Максимум строк в одном запросе.
    pub max_texts: usize,
    /// Максимум суммарной длины текстов, байт.
    pub max_bytes: usize,
}

/// Ошибка перевода. `retryable()` — ретраит ли исполнитель пачку.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranslateError {
    /// Транспорт: сеть, DNS, таймаут — ретраится.
    Network(String),
    /// HTTP 429 (rate limit) — ретраится с паузой.
    RateLimited(String),
    /// HTTP 5xx — ретраится.
    Server(String),
    /// Ключ неверен/не передан (401/403) — не ретраится.
    Auth(String),
    /// Квота исчерпана (DeepL 456, Google daily limit) — не ретраится.
    Quota(String),
    /// Пачка больше лимитов провайдера — не ретраится (делит батчер 4.2).
    TooLarge(String),
    /// Неподдерживаемая пара языков — не ретраится.
    UnsupportedLang(String),
    /// Ответ нераспознаваем (формат/количество) — не ретраится.
    BadResponse(String),
    /// Конфигурация неполна: нет ключа, не задан адрес — не ретраится.
    Config(String),
}

impl TranslateError {
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Network(_) | Self::RateLimited(_) | Self::Server(_)
        )
    }

    /// Человекочитаемое описание (статус «Проверить» панели, журнал).
    pub fn message(&self) -> String {
        match self {
            Self::Network(d) => format!("сеть недоступна: {d}"),
            Self::RateLimited(d) => format!("слишком много запросов: {d}"),
            Self::Server(d) => format!("ошибка сервиса: {d}"),
            Self::Auth(d) => format!("ключ API не принят: {d}"),
            Self::Quota(d) => format!("квота исчерпана: {d}"),
            Self::TooLarge(d) => format!("пачка слишком велика: {d}"),
            Self::UnsupportedLang(d) => format!("язык не поддерживается: {d}"),
            Self::BadResponse(d) => format!("неожиданный ответ: {d}"),
            Self::Config(d) => d.clone(),
        }
    }
}

impl std::fmt::Display for TranslateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Провайдер машинного перевода: один объект — один сервис с его ключом.
/// Реализации синхронны (блокирующий HTTP транспорта); вызов из async-кода —
/// через spawn_blocking (команда translate.test, батчер 4.2).
pub trait TranslationProvider: Send + Sync {
    /// Идентификатор настроек: чей ключ API/эндпоинт используется.
    fn id(&self) -> ProviderId;
    /// Лимиты пачки для батчера.
    fn limits(&self) -> ProviderLimits;
    /// Перевести пачку — один HTTP-запрос без ретраев (обёртка — ниже).
    fn translate_batch(
        &self,
        transport: &dyn HttpTransport,
        req: &TranslateRequest,
    ) -> Result<Vec<String>, TranslateError>;
}

/// Политика ретраев: до `max_attempts` попыток, пауза между ними растёт
/// экспоненциально от `base_delay_ms` (400 → 800 → 1600 мс).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_ms: 400,
        }
    }
}

impl RetryPolicy {
    /// Пауза перед повторной попыткой (1-индексированная), мс; сдвиг ограничен,
    /// чтобы не переполнить u64 на больших max_attempts.
    pub fn delay_ms(&self, attempt: u32) -> u64 {
        self.base_delay_ms
            .saturating_mul(1u64 << attempt.saturating_sub(1).min(16))
    }
}

/// Перевести пачку с ретраями: сетевые ошибки, rate limit и 5xx повторяются
/// по политике (пауза между попытками), прочие возвращаются сразу.
pub fn translate_with_retries(
    provider: &dyn TranslationProvider,
    transport: &dyn HttpTransport,
    req: &TranslateRequest,
    policy: &RetryPolicy,
) -> Result<Vec<String>, TranslateError> {
    let mut attempt: u32 = 1;
    loop {
        match provider.translate_batch(transport, req) {
            Ok(translations) => return Ok(translations),
            Err(e) if e.retryable() && attempt < policy.max_attempts => {
                let delay = policy.delay_ms(attempt);
                if delay > 0 {
                    std::thread::sleep(Duration::from_millis(delay));
                }
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

/// Текст ошибки API из тела ответа: `{"message": …}` (DeepL, LibreTranslate),
/// `{"error": {"message": …}}` (Google), `{"error": "…"}` (LibreTranslate);
/// не разобралось — начало тела как есть.
pub(super) fn api_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v["message"]
                .as_str()
                .or_else(|| v["error"]["message"].as_str())
                .or_else(|| v["error"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// Общая карта HTTP-статусов провайдеров (специфика — поверх в провайдерах:
/// Google различает невалидный ключ и квоту в 400/403 по тексту ошибки).
pub(super) fn status_error(status: u16, detail: String, who: &str) -> TranslateError {
    match status {
        401 | 403 => TranslateError::Auth(format!("{who}: {detail}")),
        429 => TranslateError::RateLimited(format!("{who}: {detail}")),
        456 => TranslateError::Quota(format!("{who}: {detail}")),
        413 => TranslateError::TooLarge(format!("{who}: {detail}")),
        400 | 404 | 406 | 422 => TranslateError::BadResponse(format!("{who}: {detail}")),
        s if (500..600).contains(&s) => TranslateError::Server(format!("{who}: {detail}")),
        s => TranslateError::BadResponse(format!("{who}: неожиданный статус {s}: {detail}")),
    }
}

/// Проверка лимитов пачки (общая всем провайдерам): превышение — TooLarge.
pub(super) fn check_limits(
    req: &TranslateRequest,
    limits: &ProviderLimits,
    who: &str,
) -> Result<(), TranslateError> {
    if req.texts.len() > limits.max_texts {
        return Err(TranslateError::TooLarge(format!(
            "{who}: {} строк > лимита {}",
            req.texts.len(),
            limits.max_texts
        )));
    }
    let bytes = req.texts_bytes();
    if bytes > limits.max_bytes {
        return Err(TranslateError::TooLarge(format!(
            "{who}: {bytes} байт > лимита {}",
            limits.max_bytes
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::{HttpResponse, TransportError};
    use std::sync::Mutex;

    /// Провайдер-заглушка: скрипт ответов по попыткам (тестируем ретраи).
    struct Scripted {
        script: Mutex<std::vec::IntoIter<Result<Vec<String>, TranslateError>>>,
    }

    impl Scripted {
        fn new(script: Vec<Result<Vec<String>, TranslateError>>) -> Self {
            Self {
                script: Mutex::new(script.into_iter()),
            }
        }
    }

    impl TranslationProvider for Scripted {
        fn id(&self) -> ProviderId {
            ProviderId::Deepl
        }
        fn limits(&self) -> ProviderLimits {
            ProviderLimits {
                max_texts: 50,
                max_bytes: 100_000,
            }
        }
        fn translate_batch(
            &self,
            _transport: &dyn HttpTransport,
            _req: &TranslateRequest,
        ) -> Result<Vec<String>, TranslateError> {
            self.script
                .lock()
                .unwrap()
                .next()
                .unwrap_or_else(|| panic!("скрипт ответов исчерпан"))
        }
    }

    struct NoTransport;
    impl HttpTransport for NoTransport {
        fn post_json(
            &self,
            _url: &str,
            _headers: &[(&str, &str)],
            _body: &serde_json::Value,
        ) -> Result<HttpResponse, TransportError> {
            unreachable!("Scripted не ходит в транспорт")
        }
    }

    fn req(texts: &[&str]) -> TranslateRequest {
        TranslateRequest {
            texts: texts.iter().map(|s| s.to_string()).collect(),
            source_lang: "en".into(),
            target_lang: "ru".into(),
            context_before: None,
        }
    }

    fn ok(v: Vec<String>) -> Result<Vec<String>, TranslateError> {
        Ok(v)
    }

    #[test]
    fn retryable_taxonomy() {
        assert!(TranslateError::Network("x".into()).retryable());
        assert!(TranslateError::RateLimited("x".into()).retryable());
        assert!(TranslateError::Server("x".into()).retryable());
        for e in [
            TranslateError::Auth("x".into()),
            TranslateError::Quota("x".into()),
            TranslateError::TooLarge("x".into()),
            TranslateError::UnsupportedLang("x".into()),
            TranslateError::BadResponse("x".into()),
            TranslateError::Config("x".into()),
        ] {
            assert!(!e.retryable(), "{e:?} не ретраится");
        }
    }

    #[test]
    fn retries_exhaust_on_retryable_then_fail() {
        let p = Scripted::new(vec![
            Err(TranslateError::Network("таймаут".into())),
            Err(TranslateError::RateLimited("429".into())),
            Err(TranslateError::Network("снова".into())),
        ]);
        let zero = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 0,
        };
        let err = translate_with_retries(&p, &NoTransport, &req(&["hi"]), &zero).unwrap_err();
        assert!(matches!(err, TranslateError::Network(_)), "{err:?}");
    }

    #[test]
    fn retries_succeed_on_second_attempt() {
        let p = Scripted::new(vec![
            Err(TranslateError::Server("502".into())),
            ok(vec!["привет".into()]),
        ]);
        let zero = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 0,
        };
        let out = translate_with_retries(&p, &NoTransport, &req(&["hi"]), &zero).unwrap();
        assert_eq!(out, vec!["привет".to_string()]);
    }

    #[test]
    fn no_retry_on_fatal_errors() {
        // Auth возвращается первой же попыткой — ключ не примут и на второй.
        let p = Scripted::new(vec![Err(TranslateError::Auth("403".into()))]);
        let zero = RetryPolicy {
            max_attempts: 5,
            base_delay_ms: 0,
        };
        let err = translate_with_retries(&p, &NoTransport, &req(&["hi"]), &zero).unwrap_err();
        assert!(matches!(err, TranslateError::Auth(_)), "{err:?}");
    }

    #[test]
    fn retry_delays_grow_exponentially() {
        let p = RetryPolicy {
            max_attempts: 4,
            base_delay_ms: 400,
        };
        assert_eq!(p.delay_ms(1), 400);
        assert_eq!(p.delay_ms(2), 800);
        assert_eq!(p.delay_ms(3), 1600);
        // сдвиг ограничен — не переполняется на больших номерах попыток
        let big = RetryPolicy {
            max_attempts: 30,
            base_delay_ms: u64::MAX,
        };
        assert!(big.delay_ms(30) > 0);
    }

    #[test]
    fn limits_reject_oversized_batches() {
        let limits = ProviderLimits {
            max_texts: 2,
            max_bytes: 5,
        };
        assert!(check_limits(&req(&["a", "b"]), &limits, "T").is_ok());
        let too_many = check_limits(&req(&["a", "b", "c"]), &limits, "T");
        assert!(
            matches!(too_many, Err(TranslateError::TooLarge(ref d)) if d.contains("строк")),
            "{too_many:?}"
        );
        let too_big = check_limits(&req(&["aaaa", "bbbb"]), &limits, "T");
        assert!(
            matches!(too_big, Err(TranslateError::TooLarge(ref d)) if d.contains("байт")),
            "{too_big:?}"
        );
    }

    #[test]
    fn api_message_extraction() {
        assert_eq!(api_message(r#"{"message":"Wrong key"}"#), "Wrong key");
        assert_eq!(
            api_message(r#"{"error":{"message":"API key not valid"}}"#),
            "API key not valid"
        );
        assert_eq!(
            api_message(r#"{"error":"*zz is not supported"}"#),
            "*zz is not supported"
        );
        assert_eq!(api_message("plain text"), "plain text");
        assert_eq!(api_message(""), "");
    }

    #[test]
    fn status_error_mapping() {
        assert!(matches!(
            status_error(403, "k".into(), "X"),
            TranslateError::Auth(_)
        ));
        assert!(matches!(
            status_error(429, "k".into(), "X"),
            TranslateError::RateLimited(_)
        ));
        assert!(matches!(
            status_error(456, "k".into(), "X"),
            TranslateError::Quota(_)
        ));
        assert!(matches!(
            status_error(503, "k".into(), "X"),
            TranslateError::Server(_)
        ));
        assert!(matches!(
            status_error(400, "k".into(), "X"),
            TranslateError::BadResponse(_)
        ));
    }
}
