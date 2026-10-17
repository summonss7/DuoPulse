//! DeepL API v2 (задача 4.1, docs/03 §7): POST /v2/translate, ключ в
//! заголовке `Authorization: DeepL-Auth-Key`; тарифы free/pro отличаются
//! только хостом. Поддерживает `context` (связность терминов между пачками —
//! задача 4.2); языки — верхним регистром, EN/PT только с регионом.

use serde::Deserialize;

use super::config::{DeeplPlan, ProviderId};
use super::{
    api_message, check_limits, status_error, HttpTransport, ProviderLimits, TranslateError,
    TranslateRequest, TranslationProvider,
};

/// Хосты тарифов (docs DeepL: DeepL API Free / DeepL API Pro).
const FREE_HOST: &str = "https://api-free.deepl.com";
const PRO_HOST: &str = "https://api.deepl.com";

/// Целевые языки DeepL: коды верхним регистром; EN и PT имеют только
/// региональные варианты (EN-US/EN-GB, PT-BR/PT-PT) — голый код берём
/// американско-бразильские. Источник (source) допускает голые EN/PT — не трогаем.
pub(crate) fn deepl_target_lang(lang: &str) -> String {
    match lang.to_ascii_lowercase().as_str() {
        "en" => "EN-US".to_string(),
        "pt" => "PT-BR".to_string(),
        other => other.to_ascii_uppercase(),
    }
}

pub struct DeeplProvider {
    plan: DeeplPlan,
    key: String,
}

impl DeeplProvider {
    pub fn new(plan: DeeplPlan, key: String) -> Self {
        Self { plan, key }
    }

    fn endpoint(&self) -> String {
        let host = match self.plan {
            DeeplPlan::Free => FREE_HOST,
            DeeplPlan::Pro => PRO_HOST,
        };
        format!("{host}/v2/translate")
    }
}

#[derive(Deserialize)]
struct DeeplResponse {
    translations: Vec<DeeplTranslation>,
}

#[derive(Deserialize)]
struct DeeplTranslation {
    text: String,
}

impl TranslationProvider for DeeplProvider {
    fn id(&self) -> ProviderId {
        ProviderId::Deepl
    }

    fn limits(&self) -> ProviderLimits {
        // DeepL не документирует предел числа строк; держим консервативные
        // 50 строк / 100 КБ — батчер 4.2 режет пачки ≤ 2 КБ (docs/03 §7).
        ProviderLimits {
            max_texts: 50,
            max_bytes: 100_000,
        }
    }

    fn translate_batch(
        &self,
        transport: &dyn HttpTransport,
        req: &TranslateRequest,
    ) -> Result<Vec<String>, TranslateError> {
        check_limits(req, &self.limits(), "DeepL")?;
        let mut body = serde_json::json!({
            "text": req.texts,
            "target_lang": deepl_target_lang(&req.target_lang),
        });
        if !req.source_lang.trim().is_empty() {
            body["source_lang"] = serde_json::json!(req.source_lang.to_ascii_uppercase());
        }
        if let Some(context) = req.context_before.as_deref().filter(|c| !c.is_empty()) {
            body["context"] = serde_json::json!(context);
        }
        let response = transport.post_json(
            &self.endpoint(),
            &[("Authorization", &format!("DeepL-Auth-Key {}", self.key))],
            &body,
        )?;
        if response.status != 200 {
            let detail = api_message(&response.body);
            return Err(status_error(response.status, detail, "DeepL"));
        }
        let parsed: DeeplResponse = serde_json::from_str(&response.body)
            .map_err(|e| TranslateError::BadResponse(format!("DeepL: разбор ответа: {e}")))?;
        let out: Vec<String> = parsed.translations.into_iter().map(|t| t.text).collect();
        if out.len() != req.texts.len() {
            return Err(TranslateError::BadResponse(format!(
                "DeepL: {} переводов на {} строк",
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
            context_before: None,
        }
    }

    #[test]
    fn request_shape_free_and_pro_hosts() {
        let t = MockTransport::new();
        let free = DeeplProvider::new(DeeplPlan::Free, "k-free".into());
        t.push_ok(
            200,
            r#"{"translations":[{"text":"Привет"},{"text":"Мир"}]}"#,
        );
        let out = free
            .translate_batch(&t, &req(&["Hello", "World"], "en", "ru"))
            .unwrap();
        assert_eq!(out, vec!["Привет".to_string(), "Мир".to_string()]);

        let call = &t.recorded()[0];
        assert_eq!(call.url, "https://api-free.deepl.com/v2/translate");
        assert!(
            call.headers
                .iter()
                .any(|(k, v)| k == "Authorization" && v == "DeepL-Auth-Key k-free"),
            "{:?}",
            call.headers
        );
        assert_eq!(call.body["target_lang"], "RU");
        assert_eq!(call.body["source_lang"], "EN");
        assert_eq!(call.body["text"][0], "Hello");

        let pro = DeeplProvider::new(DeeplPlan::Pro, "k".into());
        t.push_ok(200, r#"{"translations":[{"text":"x"}]}"#);
        pro.translate_batch(&t, &req(&["y"], "", "ru")).unwrap();
        let call = &t.recorded()[1];
        assert_eq!(call.url, "https://api.deepl.com/v2/translate");
        assert!(
            call.body.get("source_lang").is_none(),
            "пустой источник → автоопределение (поля нет)"
        );
    }

    #[test]
    fn target_lang_regional_variants() {
        assert_eq!(deepl_target_lang("ru"), "RU");
        assert_eq!(deepl_target_lang("en"), "EN-US");
        assert_eq!(deepl_target_lang("pt"), "PT-BR");
        assert_eq!(deepl_target_lang("pt-br"), "PT-BR");
        assert_eq!(deepl_target_lang("EN-gb"), "EN-GB");
    }

    #[test]
    fn context_passed_when_present() {
        let t = MockTransport::new();
        let p = DeeplProvider::new(DeeplPlan::Free, "k".into());
        let mut r = req(&["Term"], "en", "ru");
        r.context_before = Some("previous cue".into());
        t.push_ok(200, r#"{"translations":[{"text":"Термин"}]}"#);
        p.translate_batch(&t, &r).unwrap();
        assert_eq!(t.recorded()[0].body["context"], "previous cue");

        // пустой контекст — поля нет
        let mut r2 = req(&["Term"], "en", "ru");
        r2.context_before = Some(String::new());
        t.push_ok(200, r#"{"translations":[{"text":"Термин"}]}"#);
        p.translate_batch(&t, &r2).unwrap();
        assert!(t.recorded()[1].body.get("context").is_none());
    }

    #[test]
    fn error_mapping_by_status() {
        type Case = (u16, &'static str, fn(&TranslateError) -> bool);
        let cases: &[Case] = &[
            (
                403,
                r#"{"message":"Wrong key"}"#,
                |e| matches!(e, TranslateError::Auth(d) if d.contains("Wrong key")),
            ),
            (429, "{}", |e| matches!(e, TranslateError::RateLimited(_))),
            (
                456,
                r#"{"message":"Quota exceeded"}"#,
                |e| matches!(e, TranslateError::Quota(d) if d.contains("Quota")),
            ),
            (413, "{}", |e| matches!(e, TranslateError::TooLarge(_))),
            (500, "{}", |e| matches!(e, TranslateError::Server(_))),
            (503, "oops", |e| matches!(e, TranslateError::Server(_))),
        ];
        for (status, body, check) in cases {
            let t = MockTransport::new();
            t.push_ok(*status, body);
            let p = DeeplProvider::new(DeeplPlan::Free, "k".into());
            let err = p.translate_batch(&t, &req(&["x"], "", "ru")).unwrap_err();
            assert!(check(&err), "status {status}: {err:?}");
            assert_eq!(err.retryable(), matches!(status, 429 | 500 | 503));
        }
    }

    #[test]
    fn transport_error_is_network() {
        let t = MockTransport::new();
        t.push_err("dns");
        let p = DeeplProvider::new(DeeplPlan::Free, "k".into());
        let err = p.translate_batch(&t, &req(&["x"], "", "ru")).unwrap_err();
        assert!(
            matches!(err, TranslateError::Network(ref d) if d.contains("dns")),
            "{err:?}"
        );
        assert!(err.retryable());
    }

    #[test]
    fn broken_json_and_count_mismatch() {
        let t = MockTransport::new();
        t.push_ok(200, "not json");
        let p = DeeplProvider::new(DeeplPlan::Free, "k".into());
        assert!(matches!(
            p.translate_batch(&t, &req(&["x"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));

        let t2 = MockTransport::new();
        t2.push_ok(200, r#"{"translations":[{"text":"a"}]}"#);
        assert!(matches!(
            p.translate_batch(&t2, &req(&["x", "y"], "", "ru")),
            Err(TranslateError::BadResponse(_))
        ));
    }

    #[test]
    fn oversize_batch_rejected_before_request() {
        let t = MockTransport::new();
        let p = DeeplProvider::new(DeeplPlan::Free, "k".into());
        let many: Vec<String> = (0..51).map(|i| i.to_string()).collect();
        let r = TranslateRequest {
            texts: many,
            source_lang: String::new(),
            target_lang: "ru".into(),
            context_before: None,
        };
        assert!(matches!(
            p.translate_batch(&t, &r),
            Err(TranslateError::TooLarge(_))
        ));
        assert!(t.recorded().is_empty(), "в сеть не ходили");
    }
}
