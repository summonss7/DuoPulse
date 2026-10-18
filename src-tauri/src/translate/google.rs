//! Google Cloud Translation API v2 basic (задача 4.1, docs/03 §7):
//! POST /language/translate/v2, ключ в заголовке `x-goog-api-key` (не в
//! query — не светится в логах). Языки — нижним регистром; источник можно
//! опустить (автоопределение). Контекста нет — игнорируем (docs/03 §7
//! оставляет контекст возможностью провайдера).

use serde::Deserialize;

use super::config::ProviderId;
use super::{
    api_message, check_limits, status_error, HttpTransport, ProviderLimits, TranslateError,
    TranslateRequest, TranslationProvider,
};

const ENDPOINT: &str = "https://translation.googleapis.com/language/translate/v2";

/// Языки Google — нижним регистром (ru, en, pt-BR валидны и так).
pub(crate) fn google_lang(lang: &str) -> String {
    lang.trim().to_ascii_lowercase()
}

pub struct GoogleProvider {
    key: String,
}

impl GoogleProvider {
    pub fn new(key: String) -> Self {
        Self { key }
    }
}

#[derive(Deserialize)]
struct GoogleResponse {
    #[serde(rename = "data")]
    data: GoogleData,
}

#[derive(Deserialize)]
struct GoogleData {
    #[serde(rename = "translations")]
    translations: Vec<GoogleTranslation>,
}

#[derive(Deserialize)]
struct GoogleTranslation {
    #[serde(rename = "translatedText")]
    translated_text: String,
}

/// Специфика Google поверх общей карты статусов: «API key not valid»
/// приходит с 400 (не 401/403), дневная квота — с 403.
fn status_error_google(status: u16, detail: String) -> TranslateError {
    let lowered = detail.to_ascii_lowercase();
    match (status, lowered.as_str()) {
        (400, d) if d.contains("api key not valid") => {
            TranslateError::Auth(format!("Google: {detail}"))
        }
        (403, d) if d.contains("daily limit") || d.contains("quota") => {
            TranslateError::Quota(format!("Google: {detail}"))
        }
        (400, d) if d.contains("language") || d.contains("target") => {
            TranslateError::UnsupportedLang(format!("Google: {detail}"))
        }
        _ => status_error(status, detail, "Google"),
    }
}

impl TranslationProvider for GoogleProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Google
    }

    fn limits(&self) -> ProviderLimits {
        // Google v2: до 128 строк q за запрос, 5000 символов на строку.
        ProviderLimits {
            max_texts: 128,
            max_bytes: 100_000,
        }
    }

    fn endpoint(&self) -> String {
        ENDPOINT.to_string()
    }

    fn translate_batch(
        &self,
        transport: &dyn HttpTransport,
        req: &TranslateRequest,
    ) -> Result<Vec<String>, TranslateError> {
        check_limits(req, &self.limits(), "Google")?;
        let mut body = serde_json::json!({
            "q": req.texts,
            "target": google_lang(&req.target_lang),
            "format": "text",
        });
        if !req.source_lang.trim().is_empty() {
            body["source"] = serde_json::json!(google_lang(&req.source_lang));
        }
        let response = transport.post_json(ENDPOINT, &[("x-goog-api-key", &self.key)], &body)?;
        if response.status != 200 {
            let detail = api_message(&response.body);
            return Err(status_error_google(response.status, detail));
        }
        let parsed: GoogleResponse = serde_json::from_str(&response.body)
            .map_err(|e| TranslateError::BadResponse(format!("Google: разбор ответа: {e}")))?;
        let out: Vec<String> = parsed
            .data
            .translations
            .into_iter()
            .map(|t| t.translated_text)
            .collect();
        if out.len() != req.texts.len() {
            return Err(TranslateError::BadResponse(format!(
                "Google: {} переводов на {} строк",
                out.len(),
                req.texts.len()
            )));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::translate::http::MockTransport;

    fn req(texts: &[&str], source: &str, target: &str) -> TranslateRequest {
        TranslateRequest {
            texts: texts.iter().map(|s| s.to_string()).collect(),
            source_lang: source.into(),
            target_lang: target.into(),
            context_before: Some("ignored".into()), // Google контекст не поддерживает
        }
    }

    #[test]
    fn request_shape_key_in_header() {
        let t = MockTransport::new();
        let p = GoogleProvider::new("g-key".into());
        t.push_ok(
            200,
            r#"{"data":{"translations":[{"translatedText":"Привет"},{"translatedText":"Мир"}]}}"#,
        );
        let out = p
            .translate_batch(&t, &req(&["Hello", "World"], "", "RU"))
            .unwrap();
        assert_eq!(out, vec!["Привет".to_string(), "Мир".to_string()]);

        let call = &t.recorded()[0];
        assert_eq!(call.url, ENDPOINT);
        assert!(
            call.headers
                .iter()
                .any(|(k, v)| k == "x-goog-api-key" && v == "g-key"),
            "{:?}",
            call.headers
        );
        assert!(!call.url.contains("key="), "ключ не в query");
        assert_eq!(call.body["target"], "ru");
        assert_eq!(call.body["format"], "text");
        assert_eq!(call.body["q"][1], "World");
        assert!(
            call.body.get("source").is_none(),
            "пустой источник → автоопределение"
        );
        assert!(
            call.body.get("context").is_none(),
            "контекст не отправляется"
        );
    }

    #[test]
    fn explicit_source_lowercase() {
        let t = MockTransport::new();
        let p = GoogleProvider::new("g".into());
        t.push_ok(200, r#"{"data":{"translations":[{"translatedText":"x"}]}}"#);
        p.translate_batch(&t, &req(&["y"], "EN", "ru")).unwrap();
        assert_eq!(t.recorded()[0].body["source"], "en");
    }

    #[test]
    fn error_specifics_key_quota_language() {
        // невалидный ключ приходит с 400
        let t = MockTransport::new();
        t.push_ok(400, r#"{"error":{"message":"API key not valid. ..."}}"#);
        let p = GoogleProvider::new("bad".into());
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::Auth(_))
        ));

        // дневная квота — 403
        let t = MockTransport::new();
        t.push_ok(403, r#"{"error":{"message":"Daily Limit Exceeded"}}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::Quota(_))
        ));

        // прочий 403 — аутентификация
        let t = MockTransport::new();
        t.push_ok(403, r#"{"error":{"message":"Permission denied"}}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::Auth(_))
        ));

        // неподдерживаемый язык — 400 c упоминанием language/target
        let t = MockTransport::new();
        t.push_ok(400, r#"{"error":{"message":"Invalid language pair"}}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::UnsupportedLang(_))
        ));

        // rate limit и 5xx — как общая карта
        let t = MockTransport::new();
        t.push_ok(429, "{}");
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::RateLimited(_))
        ));
        let t = MockTransport::new();
        t.push_ok(500, "{}");
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::Server(_))
        ));
    }

    #[test]
    fn broken_json_and_count_mismatch() {
        let t = MockTransport::new();
        t.push_ok(200, "[]");
        let p = GoogleProvider::new("g".into());
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));

        let t = MockTransport::new();
        t.push_ok(200, r#"{"data":{"translations":[{"translatedText":"a"}]}}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x", "y"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));
    }
}
