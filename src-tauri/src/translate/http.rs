//! HTTP-слой провайдеров перевода (задача 4.1): провайдеры изолированы от
//! конкретного HTTP-клиента интерфейсом [`HttpTransport`] — юнит-тесты гоняют
//! их на подменных ответах без сети ([`MockTransport`]). Живой транспорт —
//! ureq (как обновление списков блокировщика, задача 2.1): блокирующие
//! вызовы из spawn_blocking-контекста (команда translate.test, батчер 4.2).

use super::TranslateError;

#[cfg(test)]
use std::sync::Mutex;

/// Минимальный ответ, нужный провайдерам: статус + тело.
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Ошибка транспорта (сеть/DNS/таймаут) → ретраимая Network-ошибка перевода.
pub struct TransportError(pub String);

impl From<TransportError> for TranslateError {
    fn from(e: TransportError) -> Self {
        TranslateError::Network(e.0)
    }
}

/// POST JSON-тела с заголовками. Реализации: [`UreqTransport`] (сеть),
/// [`MockTransport`] (тесты, без сети).
pub trait HttpTransport: Send + Sync {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &serde_json::Value,
    ) -> Result<HttpResponse, TransportError>;

    /// GET-запрос без заголовков (перевод выделения, gtx-эндпоинт,
    /// selection.rs). Транспорты без GET могут оставить дефолт — внятная
    /// сетевая ошибка вместо паники.
    fn get(&self, _url: &str) -> Result<HttpResponse, TransportError> {
        Err(TransportError("GET не поддерживается транспортом".into()))
    }
}

/// Живой транспорт: ureq-агент с таймаутами (connect 10 с, всего 30 с —
/// genug для пачек ≤ 2 КБ субтитров, docs/03 §7).
pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    pub fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(30))
                .build(),
        }
    }
}

impl Default for UreqTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport for UreqTransport {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &serde_json::Value,
    ) -> Result<HttpResponse, TransportError> {
        let mut request = self.agent.post(url).set("Content-Type", "application/json");
        for (name, value) in headers {
            request = request.set(name, value);
        }
        // HTTP-ошибки (4xx/5xx) — НЕ транспортные: ureq отдаёт ответ внутри
        // Err::Status, статус в типизированные ошибки маппируют провайдеры.
        let response = match request.send_string(&body.to_string()) {
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
        // как в post_json: HTTP-ошибки (4xx/5xx) — не транспортные
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

/// Подменный транспорт для тестов провайдеров (без сети): очередь заготовленных
/// ответов выдаётся по одному на запрос; запросы фиксируются для проверок.
#[cfg(test)]
pub(crate) struct MockTransport {
    responses: Mutex<Vec<Result<HttpResponse, TransportError>>>,
    pub calls: Mutex<Vec<RecordedRequest>>,
}

/// Зафиксированный запрос mock-транспорта (проверки URL/заголовков/тела).
#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct RecordedRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: serde_json::Value,
}

#[cfg(test)]
impl MockTransport {
    pub fn new() -> Self {
        Self {
            responses: Mutex::new(Vec::new()),
            calls: Mutex::new(Vec::new()),
        }
    }

    /// Заготовить успешный ответ (статус + JSON-тело).
    pub fn push_ok(&self, status: u16, body: &str) {
        self.responses.lock().unwrap().push(Ok(HttpResponse {
            status,
            body: body.to_string(),
        }));
    }

    /// Заготовить транспортный отказ (сеть).
    pub fn push_err(&self, message: &str) {
        self.responses
            .lock()
            .unwrap()
            .push(Err(TransportError(message.to_string())));
    }

    /// Все зафиксированные запросы (порядок вызовов).
    pub fn recorded(&self) -> Vec<RecordedRequest> {
        self.calls.lock().unwrap().clone()
    }
}

#[cfg(test)]
impl Default for MockTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl HttpTransport for MockTransport {
    fn post_json(
        &self,
        url: &str,
        headers: &[(&str, &str)],
        body: &serde_json::Value,
    ) -> Result<HttpResponse, TransportError> {
        self.calls.lock().unwrap().push(RecordedRequest {
            url: url.to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            body: body.clone(),
        });
        let mut queue = self.responses.lock().unwrap();
        if queue.is_empty() {
            panic!("mock: запрос без заготовленного ответа");
        }
        queue.remove(0)
    }

    fn get(&self, url: &str) -> Result<HttpResponse, TransportError> {
        self.calls.lock().unwrap().push(RecordedRequest {
            url: url.to_string(),
            headers: Vec::new(),
            body: serde_json::Value::Null,
        });
        let mut queue = self.responses.lock().unwrap();
        if queue.is_empty() {
            panic!("mock: запрос без заготовленного ответа");
        }
        queue.remove(0)
    }
}
