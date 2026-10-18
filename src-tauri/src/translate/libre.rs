//! Self-hosted LibreTranslate (задача 4.1, docs/03 §7 приоритет 3): POST
//! {base}/translate, ключ (если сервер требует) — в теле `api_key`. Языки
//! нижним регистром; q принимает массив строк (LibreTranslate ≥ 1.3), ответ
//! `translatedText` — массив (на строку-запрос — строка). Источник "auto" —
//! автоопределение. Контекста нет — игнорируем.

use super::config::ProviderId;
use super::{
    api_message, check_limits, status_error, HttpTransport, ProviderLimits, TranslateError,
    TranslateRequest, TranslationProvider,
};

/// Языки LibreTranslate — нижним регистром; пустой источник → "auto".
pub(crate) fn libre_lang(lang: &str) -> String {
    let lowered = lang.trim().to_ascii_lowercase();
    if lowered.is_empty() {
        "auto".to_string()
    } else {
        lowered
    }
}

pub struct LibreProvider {
    /// Base URL (http(s)://host[:port]), без хвостового «/».
    base_url: String,
    api_key: Option<String>,
}

impl LibreProvider {
    pub fn new(base_url: &str, api_key: Option<String>) -> Self {
        // хвостовые «/» срезаем и здесь: build_provider нормализует конфиг,
        // но провайдер не должен зависеть от дисциплины вызова
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
        }
    }
}

impl TranslationProvider for LibreProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Libretranslate
    }

    fn limits(&self) -> ProviderLimits {
        // Дефолт charLimit инстансов — 5000/строку; по строкам держим 50.
        ProviderLimits {
            max_texts: 50,
            max_bytes: 50_000,
        }
    }

    fn endpoint(&self) -> String {
        format!("{}/translate", self.base_url)
    }

    fn translate_batch(
        &self,
        transport: &dyn HttpTransport,
        req: &TranslateRequest,
    ) -> Result<Vec<String>, TranslateError> {
        check_limits(req, &self.limits(), "LibreTranslate")?;
        let mut body = serde_json::json!({
            "q": req.texts,
            "source": libre_lang(&req.source_lang),
            "target": libre_lang(&req.target_lang),
            "format": "text",
        });
        if let Some(key) = self.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
            body["api_key"] = serde_json::json!(key);
        }
        let response = transport.post_json(&self.endpoint(), &[], &body)?;
        if response.status != 200 {
            let detail = api_message(&response.body);
            // LibreTranslate различает 400 (пара языков; тело — {"error":"…"})
            // и 401/403 (ключ), карта статусов покрывает остальные
            let lowered = detail.to_ascii_lowercase();
            return Err(match response.status {
                400 if lowered.contains("language") || lowered.contains("not supported") => {
                    TranslateError::UnsupportedLang(format!("LibreTranslate: {detail}"))
                }
                _ => status_error(response.status, detail, "LibreTranslate"),
            });
        }
        // translatedText: массив при массиве q (наш случай); строка —
        // старые сборки с одиночным q, принимаем для одного текста.
        let parsed: serde_json::Value = serde_json::from_str(&response.body).map_err(|e| {
            TranslateError::BadResponse(format!("LibreTranslate: разбор ответа: {e}"))
        })?;
        match &parsed["translatedText"] {
            serde_json::Value::Array(items) => {
                let out: Option<Vec<String>> = items
                    .iter()
                    .map(|v| v.as_str().map(str::to_string))
                    .collect();
                let out = out.ok_or_else(|| {
                    TranslateError::BadResponse("LibreTranslate: не-строки в translatedText".into())
                })?;
                if out.len() != req.texts.len() {
                    return Err(TranslateError::BadResponse(format!(
                        "LibreTranslate: {} переводов на {} строк",
                        out.len(),
                        req.texts.len()
                    )));
                }
                Ok(out)
            }
            serde_json::Value::String(s) if req.texts.len() == 1 => Ok(vec![s.clone()]),
            _ => Err(TranslateError::BadResponse(
                "LibreTranslate: нет translatedText".into(),
            )),
        }
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
            context_before: None,
        }
    }

    #[test]
    fn request_shape_url_key_body() {
        let t = MockTransport::new();
        let p = LibreProvider::new("http://lt.local:5055/", Some("lt-key".into()));
        t.push_ok(200, r#"{"translatedText":["Привет","Мир"]}"#);
        let out = p
            .translate_batch(&t, &req(&["Hello", "World"], "", "RU"))
            .unwrap();
        assert_eq!(out, vec!["Привет".to_string(), "Мир".to_string()]);

        let call = &t.recorded()[0];
        assert_eq!(call.url, "http://lt.local:5055/translate");
        assert_eq!(call.body["source"], "auto", "пустой источник → auto");
        assert_eq!(call.body["target"], "ru");
        assert_eq!(call.body["format"], "text");
        assert_eq!(call.body["api_key"], "lt-key");
        assert_eq!(call.body["q"][0], "Hello");
        assert!(call.body.get("context").is_none());
    }

    #[test]
    fn no_key_field_when_absent() {
        let t = MockTransport::new();
        let p = LibreProvider::new("http://lt.local", None);
        t.push_ok(200, r#"{"translatedText":["x"]}"#);
        p.translate_batch(&t, &req(&["y"], "en", "ru")).unwrap();
        assert!(t.recorded()[0].body.get("api_key").is_none());
    }

    #[test]
    fn single_string_response_accepted_for_single_text() {
        let t = MockTransport::new();
        let p = LibreProvider::new("http://lt.local", None);
        t.push_ok(
            200,
            r#"{"translatedText":"Привет","detectedLanguage":{"confidence":1.0,"language":"en"}}"#,
        );
        let out = p.translate_batch(&t, &req(&["Hello"], "", "ru")).unwrap();
        assert_eq!(out, vec!["Привет".to_string()]);
    }

    #[test]
    fn error_mapping() {
        // 401 — ключ обязателен/неверен
        let t = MockTransport::new();
        t.push_ok(401, r#"{"message":"Invalid API key"}"#);
        let p = LibreProvider::new("http://lt.local", Some("bad".into()));
        let err = p.translate_batch(&t, &req(&["x"], "", "ru")).unwrap_err();
        assert!(
            matches!(err, TranslateError::Auth(ref d) if d.contains("Invalid API key")),
            "{err:?}"
        );

        // 400 c неподдерживаемым языком — тело LibreTranslate {"error":"…"}
        let t = MockTransport::new();
        t.push_ok(400, r#"{"error":"*zz is not supported"}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::UnsupportedLang(_))
        ));

        // прочий 400 — общий BadResponse
        let t = MockTransport::new();
        t.push_ok(400, r#"{"message":"request body invalid"}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));

        // 429/5xx — ретраимые
        for (status, retryable) in [(429u16, true), (503u16, true)] {
            let t = MockTransport::new();
            t.push_ok(status, "{}");
            let err = p.translate_batch(&t, &req(&["x"], "", "ru")).unwrap_err();
            assert_eq!(err.retryable(), retryable, "status {status}: {err:?}");
        }
    }

    #[test]
    fn count_mismatch_and_missing_field() {
        let t = MockTransport::new();
        t.push_ok(200, r#"{"translatedText":["a"]}"#);
        let p = LibreProvider::new("http://lt.local", None);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x", "y"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));

        let t = MockTransport::new();
        t.push_ok(200, r#"{"error":"boom"}"#);
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));
    }
}
