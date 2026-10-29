//! Провайдеры транскрипции ASR (карточка duopulse-060): единая форма запроса
//! «WAV 16 кГц моно → сегменты с таймингами» поверх двух HTTP-семейств:
//!
//! - локальный whisper-server (whisper.cpp): `POST /inference`, multipart
//!   (`file`, `language`, `prompt`, `response_format=verbose_json`);
//! - OpenAI-совместимое облако (OpenAI / Groq / свой сервер):
//!   `POST /v1/audio/transcriptions` + `Authorization: Bearer <ключ>`
//!   (multipart `file`, `model`, `language`, `prompt`,
//!   `response_format=verbose_json`).
//!
//! Транспорт изолирован за [`AsrTransport`] (тесты — подменные ответы без
//! сети, по образцу translate/http.rs); таймаут запроса длинный — чанк
//! 5 минут на локальном whisper считается десятки секунд.

use std::time::Duration;

use crate::translate::http::{HttpResponse, TransportError};

/// Ошибка транскрипции. `retryable()` — повторять ли запрос.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsrError {
    /// Транспорт: сеть, DNS, таймаут — ретраится.
    Network(String),
    /// HTTP 429 — ретраится с паузой.
    RateLimited(String),
    /// HTTP 5xx — ретраится.
    Server(String),
    /// Ключ неверен/не передан (401/403) — не ретраится.
    Auth(String),
    /// Ответ нераспознаваем — не ретраится.
    BadResponse(String),
    /// Конфигурация неполна — не ретраится.
    Config(String),
}

impl AsrError {
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::Network(_) | Self::RateLimited(_) | Self::Server(_)
        )
    }

    pub fn message(&self) -> String {
        match self {
            Self::Network(d) => format!("сеть недоступна: {d}"),
            Self::RateLimited(d) => format!("слишком много запросов: {d}"),
            Self::Server(d) => format!("ошибка сервиса: {d}"),
            Self::Auth(d) => format!("ключ API не принят: {d}"),
            Self::BadResponse(d) => format!("неожиданный ответ: {d}"),
            Self::Config(d) => d.clone(),
        }
    }
}

impl std::fmt::Display for AsrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// Куда идти за транскрипцией.
#[derive(Debug, Clone)]
pub enum AsrEndpoint {
    /// Локальный whisper-server: base URL (`http://127.0.0.1:<port>`),
    /// путь `/inference`.
    LocalWhisper { base_url: String },
    /// OpenAI-совместимый API: base URL, ключ, имя модели (путь
    /// `/audio/transcriptions`).
    OpenAiCompatible {
        base_url: String,
        key: String,
        model: String,
    },
}

impl AsrEndpoint {
    /// Полный URL запроса и заголовки (Content-Type проставляет транспорт).
    fn request(&self) -> (String, Vec<(&'static str, String)>) {
        match self {
            Self::LocalWhisper { base_url } => (
                format!("{}/inference", base_url.trim_end_matches('/')),
                Vec::new(),
            ),
            Self::OpenAiCompatible { base_url, key, .. } => (
                format!("{}/audio/transcriptions", base_url.trim_end_matches('/')),
                vec![("Authorization", format!("Bearer {key}"))],
            ),
        }
    }
}

/// Имена языков whisper (detected_language/verbose_json — «english», «russian»)
/// → ISO-коды для дорожки и UI. Незнакомое имя — как есть (lowercase):
/// новые языки whisper не должны ломать конвейер.
pub fn normalize_lang(raw: &str) -> String {
    let name = raw.trim().to_lowercase();
    let code = match name.as_str() {
        "english" => "en",
        "chinese" | "mandarin" => "zh",
        "german" => "de",
        "spanish" => "es",
        "russian" => "ru",
        "korean" => "ko",
        "french" => "fr",
        "japanese" => "ja",
        "portuguese" => "pt",
        "turkish" => "tr",
        "polish" => "pl",
        "catalan" => "ca",
        "dutch" => "nl",
        "arabic" => "ar",
        "swedish" => "sv",
        "italian" => "it",
        "indonesian" => "id",
        "hindi" => "hi",
        "finnish" => "fi",
        "vietnamese" => "vi",
        "hebrew" => "he",
        "ukrainian" => "uk",
        "greek" => "el",
        "malay" => "ms",
        "czech" => "cs",
        "romanian" => "ro",
        "danish" => "da",
        "hungarian" => "hu",
        "tamil" => "ta",
        "norwegian" | "nynorsk" => "no",
        "thai" => "th",
        "urdu" => "ur",
        "croatian" => "hr",
        "bulgarian" => "bg",
        "lithuanian" => "lt",
        "latin" => "la",
        "maori" => "mi",
        "malayalam" => "ml",
        "welsh" => "cy",
        "slovak" => "sk",
        "telugu" => "te",
        "persian" | "farsi" => "fa",
        "latvian" => "lv",
        "bengali" => "bn",
        "serbian" => "sr",
        "azerbaijani" => "az",
        "slovenian" => "sl",
        "kannada" => "kn",
        "estonian" => "et",
        "macedonian" => "mk",
        "breton" => "br",
        "basque" => "eu",
        "icelandic" => "is",
        "armenian" => "hy",
        "nepali" => "ne",
        "mongolian" => "mn",
        "bosnian" => "bs",
        "kazakh" => "kk",
        "albanian" => "sq",
        "swahili" => "sw",
        "galician" => "gl",
        "marathi" => "mr",
        "punjabi" => "pa",
        "sinhala" => "si",
        "khmer" => "km",
        "shona" => "sn",
        "yoruba" => "yo",
        "somali" => "so",
        "afrikaans" => "af",
        "occitan" => "oc",
        "georgian" => "ka",
        "belarusian" => "be",
        "tajik" => "tg",
        "sindhi" => "sd",
        "gujarati" => "gu",
        "amharic" => "am",
        "yiddish" => "yi",
        "lao" => "lo",
        "uzbek" => "uz",
        "faroese" => "fo",
        "haitian creole" => "ht",
        "pashto" => "ps",
        "turkmen" => "tk",
        "maltese" => "mt",
        _ => return name,
    };
    code.to_string()
}

/// Идентификатор движка для кэша и событий: смена модели/размера = другая
/// дорожка. Локальный — независимо от порта сервера.
pub fn engine_id(provider: crate::asr::config::AsrProviderId, openai_model: &str) -> String {
    match provider {
        crate::asr::config::AsrProviderId::Local => "local:whisper".to_string(),
        crate::asr::config::AsrProviderId::Openai => {
            format!("openai:{}", openai_model.trim())
        }
    }
}

/// Сегмент транскрипции (тайминги — секунды → миллисекути конвейером).
#[derive(Debug, Clone, PartialEq)]
pub struct AsrSegment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Разобранный ответ verbose_json обоих семейств.
#[derive(Debug, Clone, Default)]
pub struct Transcription {
    /// Язык, определённый движком (локальный whisper; облако может не отдать).
    pub detected_lang: Option<String>,
    pub segments: Vec<AsrSegment>,
}

/// POST multipart + GET health-check. Изоляция для тестов (подменный транспорт).
pub trait AsrTransport: Send + Sync {
    fn post_multipart(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<HttpResponse, TransportError>;
    fn get(&self, url: &str) -> Result<HttpResponse, TransportError>;
}

/// Живой транспорт: ureq, connect 10 с, весь запрос — до 15 минут (чанк
/// 5 минут локально считается десятки секунд, облако быстрее).
pub struct UreqAsrTransport {
    agent: ureq::Agent,
}

impl UreqAsrTransport {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(10))
                .timeout(Duration::from_secs(15 * 60))
                .build(),
        }
    }
}

impl Default for UreqAsrTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl AsrTransport for UreqAsrTransport {
    fn post_multipart(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Vec<u8>,
    ) -> Result<HttpResponse, TransportError> {
        let request = self.agent.post(url).set(
            "Content-Type",
            &format!("multipart/form-data; boundary={}", BOUNDARY),
        );
        let mut request = request;
        for (name, value) in headers {
            request = request.set(name, value);
        }
        let response = match request.send_bytes(&body) {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                return Ok(HttpResponse { status: code, body });
            }
            Err(e) => return Err(TransportError(format!("{e}"))),
        };
        let status = response.status();
        let body = response
            .into_string()
            .map_err(|e| TransportError(format!("чтение ответа: {e}")))?;
        Ok(HttpResponse { status, body })
    }

    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        let response = match self.agent.get(url).call() {
            Ok(r) => r,
            Err(ureq::Error::Status(code, r)) => {
                let body = r.into_string().unwrap_or_default();
                return Ok(HttpResponse { status: code, body });
            }
            Err(e) => return Err(TransportError(format!("{e}"))),
        };
        let status = response.status();
        let body = response
            .into_string()
            .map_err(|e| TransportError(format!("чтение ответа: {e}")))?;
        Ok(HttpResponse { status, body })
    }
}

/// Граница multipart-тела (тесты проверяют её в записанных запросах).
pub const BOUNDARY: &str = "duopulse-asr-7f3a1c";

/// Собрать multipart/form-data тело: текстовые поля + файл WAV.
pub fn build_multipart(fields: &[(&str, &str)], file: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, value) in fields {
        out.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        out.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
        );
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    out.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n",
    );
    out.extend_from_slice(b"Content-Type: audio/wav\r\n\r\n");
    out.extend_from_slice(file);
    out.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    out
}

fn status_error(status: u16, detail: String) -> AsrError {
    match status {
        401 | 403 => AsrError::Auth(format!("HTTP {status}: {detail}")),
        429 => AsrError::RateLimited(format!("HTTP {status}: {detail}")),
        s if (500..600).contains(&s) => AsrError::Server(format!("HTTP {s}: {detail}")),
        s => AsrError::BadResponse(format!("HTTP {s}: {detail}")),
    }
}

/// Текст ошибки из тела (`{"error":{"message":…}}` / `{"error":"…"}`).
fn api_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(200).collect())
}

/// Один запрос транскрипции без ретраев: собрать multipart, отправить,
/// разобрать verbose_json (сегменты с таймингами; пустой текст сегмента —
/// пропущен, как и сегменты без таймингов).
pub fn transcribe_once(
    transport: &dyn AsrTransport,
    endpoint: &AsrEndpoint,
    wav: &[u8],
    lang: &str,
    prompt: Option<&str>,
) -> Result<Transcription, AsrError> {
    let (url, headers) = endpoint.request();
    let mut fields: Vec<(&str, String)> = Vec::new();
    if let AsrEndpoint::OpenAiCompatible { model, .. } = endpoint {
        fields.push(("model", model.clone()));
    }
    if !lang.is_empty() {
        fields.push(("language", lang.to_string()));
    }
    if let Some(p) = prompt {
        if !p.is_empty() {
            fields.push(("prompt", p.to_string()));
        }
    }
    fields.push(("response_format", "verbose_json".to_string()));
    let owned: Vec<(&str, &str)> = fields.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let body = build_multipart(&owned, wav);

    let resp = transport
        .post_multipart(&url, &headers, body)
        .map_err(|e| AsrError::Network(e.0))?;
    if resp.status != 200 {
        return Err(status_error(resp.status, api_message(&resp.body)));
    }
    parse_verbose_json(&resp.body)
}

/// Разбор verbose_json: `{text, segments:[{start,end,text}], detected_language}`.
pub fn parse_verbose_json(body: &str) -> Result<Transcription, AsrError> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|e| AsrError::BadResponse(format!("не JSON: {e}")))?;
    let detected_lang = v["detected_language"]
        .as_str()
        .or_else(|| v["language"].as_str())
        .map(str::to_string);
    let Some(segs) = v["segments"].as_array() else {
        // формально допустим text без segments — но для субтитров нужны тайминги
        return Err(AsrError::BadResponse("в ответе нет segments".into()));
    };
    let mut segments = Vec::with_capacity(segs.len());
    for s in segs {
        let (Some(start), Some(end), Some(text)) =
            (s["start"].as_f64(), s["end"].as_f64(), s["text"].as_str())
        else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() || end <= start {
            continue;
        }
        segments.push(AsrSegment {
            start_ms: (start * 1000.0).round() as i64,
            end_ms: (end * 1000.0).round() as i64,
            text: text.to_string(),
        });
    }
    if segments.is_empty() {
        return Err(AsrError::BadResponse(
            "речь не распознана (0 сегментов)".into(),
        ));
    }
    Ok(Transcription {
        detected_lang,
        segments,
    })
}

/// Ретраи: до 3 попыток (сеть/429/5xx), пауза 400 мс → 800 мс.
pub fn transcribe(
    transport: &dyn AsrTransport,
    endpoint: &AsrEndpoint,
    wav: &[u8],
    lang: &str,
    prompt: Option<&str>,
) -> Result<Transcription, AsrError> {
    let mut attempt = 1;
    loop {
        match transcribe_once(transport, endpoint, wav, lang, prompt) {
            Ok(t) => return Ok(t),
            Err(e) if e.retryable() && attempt < 3 => {
                std::thread::sleep(Duration::from_millis(400 * attempt as u64));
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Подменный транспорт: очередь ответов (или ошибок) + журнал запросов.
    struct MockAsrTransport {
        responses: Mutex<Vec<Result<HttpResponse, TransportError>>>,
        pub calls: Mutex<Vec<(String, Vec<u8>)>>,
    }

    impl MockAsrTransport {
        fn new() -> Self {
            Self {
                responses: Mutex::new(Vec::new()),
                calls: Mutex::new(Vec::new()),
            }
        }
        fn push_ok(&self, status: u16, body: &str) {
            self.responses.lock().unwrap().push(Ok(HttpResponse {
                status,
                body: body.into(),
            }));
        }
    }

    impl AsrTransport for MockAsrTransport {
        fn post_multipart(
            &self,
            url: &str,
            _headers: &[(&str, String)],
            body: Vec<u8>,
        ) -> Result<HttpResponse, TransportError> {
            self.calls.lock().unwrap().push((url.to_string(), body));
            let mut q = self.responses.lock().unwrap();
            if q.is_empty() {
                panic!("скрипт ответов исчерпан");
            }
            q.remove(0)
        }
        fn get(&self, _url: &str) -> Result<HttpResponse, TransportError> {
            Err(TransportError("get не ждётся в тестах post".into()))
        }
    }

    const VERBOSE: &str = r#"{"task":"transcribe","language":"en","text":" hello world",
        "segments":[{"id":0,"start":0.0,"end":1.96,"text":" hello"},
                    {"id":1,"start":1.96,"end":3.5,"text":"   "},
                    {"id":2,"start":3.5,"end":4.0,"text":"world"}],
        "detected_language":"en","detected_language_probability":0.99}"#;

    fn local() -> AsrEndpoint {
        AsrEndpoint::LocalWhisper {
            base_url: "http://127.0.0.1:18099".into(),
        }
    }

    fn openai() -> AsrEndpoint {
        AsrEndpoint::OpenAiCompatible {
            base_url: "https://api.openai.com/v1".into(),
            key: "sk-test".into(),
            model: "whisper-1".into(),
        }
    }

    #[test]
    fn local_request_shape_and_parse() {
        let t = MockAsrTransport::new();
        t.push_ok(200, VERBOSE);
        let out = transcribe_once(&t, &local(), b"RIFF...", "en", None).unwrap();
        assert_eq!(out.detected_lang.as_deref(), Some("en"));
        // пустой сегмент выпущен
        assert_eq!(out.segments.len(), 2);
        assert_eq!(out.segments[0].text, "hello");
        assert_eq!(out.segments[1].start_ms, 3_500);
        let (url, body) = &t.calls.lock().unwrap()[0];
        assert_eq!(url, "http://127.0.0.1:18099/inference");
        let text = String::from_utf8_lossy(body);
        assert!(
            text.contains(&format!("--{BOUNDARY}\r\n")),
            "граница в теле"
        );

        assert!(text.contains("name=\"language\"\r\n\r\nen"));
        assert!(text.contains("name=\"response_format\"\r\n\r\nverbose_json"));
        assert!(text.contains("filename=\"audio.wav\""));
        assert!(
            !text.contains("name=\"model\""),
            "локальному модель не нужна"
        );
    }

    #[test]
    fn openai_request_has_auth_model_and_prompt() {
        let t = MockAsrTransport::new();
        t.push_ok(200, VERBOSE);
        transcribe_once(&t, &openai(), b"RIFF...", "", Some("tail of previous")).unwrap();
        let (url, body) = &t.calls.lock().unwrap()[0];
        assert_eq!(url, "https://api.openai.com/v1/audio/transcriptions");
        let text = String::from_utf8_lossy(body);
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-1"));
        assert!(text.contains("name=\"prompt\"\r\n\r\ntail of previous"));
        assert!(
            !text.contains("name=\"language\""),
            "пустой язык не отсылается"
        );
    }

    #[test]
    fn error_mapping_and_retries() {
        let t = MockAsrTransport::new();
        t.push_ok(401, r#"{"error":{"message":"bad key"}}"#);
        let err = transcribe(&t, &openai(), b"RIFF", "en", None).unwrap_err();
        assert!(matches!(err, AsrError::Auth(_)), "{err:?}");
        assert_eq!(t.calls.lock().unwrap().len(), 1, "Auth не ретраится");

        let t2 = MockAsrTransport::new();
        t2.push_ok(500, "{\"error\":\"boom\"}");
        t2.push_ok(429, "{\"error\":\"slow\"}");
        t2.push_ok(200, VERBOSE);
        let out = transcribe(&t2, &local(), b"RIFF", "en", None).unwrap();
        assert_eq!(out.segments.len(), 2);
        assert_eq!(t2.calls.lock().unwrap().len(), 3, "5xx и 429 ретраятся");
    }

    #[test]
    fn bad_bodies_are_rejected() {
        assert!(parse_verbose_json("не json").is_err());
        assert!(parse_verbose_json(r#"{"text":"no segments"}"#).is_err());
        assert!(
            parse_verbose_json(r#"{"segments":[{"start":1,"end":2}]}"#).is_err(),
            "нет текста — нет сегментов → честная ошибка"
        );
    }

    #[test]
    fn engine_id_distinguishes_models() {
        use crate::asr::config::AsrProviderId;
        assert_eq!(engine_id(AsrProviderId::Local, "base"), "local:whisper");
        assert_eq!(
            engine_id(AsrProviderId::Openai, "whisper-1"),
            "openai:whisper-1"
        );
    }

    #[test]
    fn normalize_lang_whisper_names_to_codes() {
        assert_eq!(normalize_lang("english"), "en");
        assert_eq!(normalize_lang(" Russian "), "ru");
        assert_eq!(normalize_lang("ukrainian"), "uk");
        assert_eq!(normalize_lang("haitian creole"), "ht");
        // незнакомое/уже код — как есть
        assert_eq!(normalize_lang("klingon"), "klingon");
        assert_eq!(normalize_lang("EN"), "en");
        assert_eq!(normalize_lang(""), "");
    }
}
