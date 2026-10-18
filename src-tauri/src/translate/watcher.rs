//! Офлайн-деградация конвейера перевода (задача 4.3, docs/03 §7; сценарий
//! docs/01 §5.4): нет сети или провайдера → набор остаётся с оригиналом и
//! переводом из кэша (облачная дорожка не строится), панель показывает бейдж
//! «перевод недоступен» — событие [`SubtitlesTranslateUnavailableEvent`].
//! Сетевые отказы повторяются сами: проба связи до провайдера каждые
//! `DUOPULSE_TRANSLATE_RETRY_MS` (5 с), конвейер перезапускается, когда сеть
//! вернулась; настройки за время ожидания могли смениться — провайдер
//! пересобирается на каждой попытке.
//!
//! Работы дедуплицируются в [`TranslationJobs`] по ключу
//! (videoKey, trackId, targetLang): повторный запрос того же языка, пока
//! работа жива, переподчиняет ответ новому запросу (второй конвейер не
//! поднимается). Работа снимается, когда вкладка ушла с видео.

use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;

use super::config::{build_provider, load_config, ApiKeys};
use super::pipeline::{
    provider_label, reply_to_tab, translate_track, ProgressReport, SubtitlesTranslateProgress,
    SubtitlesTranslateProgressEvent, TrackTranslateOutcome, TrackTranslateRequest,
};
use super::{HttpTransport, RetryPolicy, TranslateError, TranslationProvider, UreqTransport};
use crate::bridge::{self, BridgeEvent};

/// Причина бейджа «перевод недоступен» (поле reason события).
pub const REASON_OFFLINE: &str = "offline";
pub const REASON_NO_PROVIDER: &str = "no_provider";

/// Период повтора/пробы при офлайне, мс (DUOPULSE_TRANSLATE_RETRY_MS —
/// e2e-стенды ужимают; по умолчанию 5 с).
pub fn retry_poll_ms() -> u64 {
    std::env::var("DUOPULSE_TRANSLATE_RETRY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|v| *v > 0)
        .unwrap_or(5_000)
}

/// Ключ работы = намерение пользователя (видео + дорожка + язык). Провайдер
/// в ключ не входит: пока работа ждёт сеть, провайдера можно сменить в панели.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct JobKey {
    pub video_key: String,
    pub track_id: String,
    pub target_lang: String,
}

/// Адресат ответа: вкладка и reqId запроса content-слоя.
#[derive(Debug, Clone)]
pub struct ReplyTarget {
    pub tab_id: String,
    pub req_id: u64,
}

/// Зарегистрированная работа (managed state).
#[derive(Debug, Clone)]
struct JobEntry {
    target: ReplyTarget,
    request: TrackTranslateRequest,
    /// Поколение: растёт на каждом повторном запросе того же ключа —
    /// завершившийся цикл не снимает чужую (новее) работу.
    gen: u64,
}

/// Очередь переводов в работе: ключ → актуальная работа. Повторный запрос
/// того же ключа переподчиняет ответ (reparent) — конвейер не дублируется.
#[derive(Default)]
pub struct TranslationJobs {
    inner: Mutex<HashMap<JobKey, JobEntry>>,
    next_gen: std::sync::atomic::AtomicU64,
}

impl TranslationJobs {
    /// Зарегистрировать запрос: true — работа новая, вызывающий поднимает
    /// цикл (вернуло поколение); false — уже в работе, ответ переподчинён.
    pub fn submit(
        &self,
        key: JobKey,
        request: TrackTranslateRequest,
        target: ReplyTarget,
    ) -> (bool, u64) {
        let mut map = self.inner.lock().unwrap();
        let fresh = !map.contains_key(&key);
        let gen = self
            .next_gen
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        map.insert(
            key,
            JobEntry {
                target,
                request,
                gen,
            },
        );
        (fresh, gen)
    }

    /// Текущий адресат работы (None — работы нет).
    pub fn target(&self, key: &JobKey) -> Option<ReplyTarget> {
        self.inner
            .lock()
            .unwrap()
            .get(key)
            .map(|e| e.target.clone())
    }

    /// Снять работу безусловно (вкладка ушла с видео — ответ некому).
    pub fn cancel(&self, key: &JobKey) {
        self.inner.lock().unwrap().remove(key);
    }

    /// Завершить работу своего поколения. Если за время финального ответа
    /// пришёл новый запрос того же ключа — работа не снята, вернём её
    /// (поколение + запрос): вызывающий поднимает цикл заново (гонка
    /// «финальный ответ ∥ повторный запрос»).
    fn retire(&self, key: &JobKey, gen: u64) -> Option<(u64, TrackTranslateRequest)> {
        let mut map = self.inner.lock().unwrap();
        match map.get(key) {
            Some(e) if e.gen == gen => {
                map.remove(key);
                None
            }
            Some(e) => Some((e.gen, e.request.clone())),
            None => None,
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }
}

/// Что делать с отказом конвейера (docs/03 §7 «деградация»).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// Сеть/DNS/таймаут — бейдж «повторим сам» + ожидание и автоповтор.
    AwaitNetwork,
    /// Остальное (конфиг, ключ, квота, ответ) — бейдж/ошибка без повтора.
    Terminal,
}

pub fn failure_kind(err: &TranslateError) -> FailureKind {
    match err {
        TranslateError::Network(_) => FailureKind::AwaitNetwork,
        _ => FailureKind::Terminal,
    }
}

/// Хост и порт из URL эндпоинта (для пробы связи): scheme://host[:port]/…,
/// порт по умолчанию 80 (http) / 443 (https), IPv6 — в скобках. Не URL или
/// нет хоста → None — пробу не делаем, пусть решает сам конвейер.
pub fn endpoint_socket(endpoint: &str) -> Option<(String, u16)> {
    let (scheme, rest) = endpoint.split_once("://")?;
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = if let Some(inner) = authority.strip_prefix('[') {
        let end = inner.find(']')?;
        let port = inner[end + 1..].strip_prefix(':')?;
        (inner[..end].to_string(), port.parse().ok()?)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
                (h.to_string(), p.parse().ok()?)
            }
            _ => (authority.to_string(), default_port),
        }
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port))
}

/// Проба связи до провайдера: TCP-коннект с таймаутом 2 с — дёшево и без
/// трафика API; DNS/маршрут не поднялись → «сети нет». Self-hosted
/// LibreTranslate на локальном адресе пробуется тем же коннектом.
pub fn endpoint_online(endpoint: &str) -> bool {
    let Some((host, port)) = endpoint_socket(endpoint) else {
        return true; // не разобрали адрес — пусть решает конвейер
    };
    let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else {
        return false;
    };
    let addrs: Vec<_> = addrs.collect();
    if addrs.is_empty() {
        return false;
    }
    addrs
        .iter()
        .any(|a| TcpStream::connect_timeout(a, Duration::from_secs(2)).is_ok())
}

/// Сторона событий цикла: прод — [`AppWatchSink`] (события контракта +
/// document-ответ вкладке), тесты — журнал вызовов.
pub trait WatchSink {
    /// Провайдер пересобрался (настройки сменили, пока ждали сеть).
    fn provider_changed(&mut self, _provider: &str) {}
    /// Прогресс конвейера (после каждой пачки / кэш-хит).
    fn progress(&mut self, report: ProgressReport);
    /// Бейдж «перевод недоступен»: reason offline|no_provider, will_retry —
    /// Core повторит сам (панель держит бейдж, пока true).
    fn unavailable(&mut self, reason: &str, detail: &str, will_retry: bool);
    /// Готово: переведённая дорожка уходит вкладке (сетка таймингов исходной).
    fn done(&mut self, outcome: &TrackTranslateOutcome, name: &str);
    /// Терминальный отказ. `badge_shown` — бейдж «недоступен» уже показан
    /// (no_provider): статус-ошибка панели не нужна, перебьёт бейдж.
    fn failed(&mut self, detail: String, badge_shown: bool);
}

/// Внешние эффекты цикла: прод — очередь+liveness, TCP-проба, sleep; тесты
/// подменяют скриптами (без сети и ожиданий).
pub struct WatchHooks<'a> {
    /// Работа ещё актуальна? None — снята (вкладка ушла с видео): тишина.
    pub alive: &'a mut dyn FnMut() -> Option<ReplyTarget>,
    /// Проба связи до эндпоинта провайдера (true — сеть есть). Аргумент —
    /// String: замыкание с &str не коэрцится в dyn (HRTB).
    pub probe: &'a mut dyn FnMut(String) -> bool,
    /// Пауза между пробами (прод — thread::sleep на период повтора).
    pub wait: &'a mut dyn FnMut(),
}

/// Чем закончился цикл (диагностика/тесты).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchOutcome {
    /// Перевод готов (или отдан кэшем).
    Done,
    /// Терминальный отказ — бейдж/ошибка без автоповтора.
    Terminal,
    /// Работу сняли (вкладка ушла с видео) — молча.
    Dropped,
}

/// Один цикл перевода с офлайн-деградацией: попытка конвейера → Network-отказ
/// → бейдж + ожидание + проба → новая попытка (провайдер пересобирается).
/// Конфиг-отказ (выключен/нет ключа) и терминальные ошибки конвейера —
/// бейдж/ошибка без повтора.
fn watch_loop(
    provider_factory: &mut dyn FnMut() -> Result<Box<dyn TranslationProvider>, TranslateError>,
    transport: &dyn HttpTransport,
    cache: &crate::subtitles::cache::TranslationsCache,
    request: &TrackTranslateRequest,
    policy: &RetryPolicy,
    sink: &mut dyn WatchSink,
    hooks: &mut WatchHooks<'_>,
) -> WatchOutcome {
    loop {
        if (hooks.alive)().is_none() {
            return WatchOutcome::Dropped;
        }
        let provider = match provider_factory() {
            Ok(p) => p,
            // Выключен или нет ключа (Config) — бейдж «перевод недоступен»
            // без автоповтора (статус-ошибка не нужна — перебьёт бейдж):
            // включит/сохранит — панель спросит снова.
            Err(e) => {
                let message = e.message();
                sink.unavailable(REASON_NO_PROVIDER, &message, false);
                sink.failed(message, true);
                return WatchOutcome::Terminal;
            }
        };
        sink.provider_changed(provider.id().as_str());
        let name = format!(
            "{} → {}",
            provider_label(provider.id()),
            request.target_lang
        );
        let endpoint = provider.endpoint();
        let mut on_progress = |r: ProgressReport| sink.progress(r);
        let run = translate_track(
            provider.as_ref(),
            transport,
            cache,
            request,
            policy,
            &mut on_progress,
        );
        match run {
            Ok(outcome) => {
                sink.done(&outcome, &name);
                return WatchOutcome::Done;
            }
            Err(e) => match failure_kind(&e) {
                FailureKind::Terminal => {
                    let message = e.message();
                    sink.failed(message, false);
                    return WatchOutcome::Terminal;
                }
                FailureKind::AwaitNetwork => {
                    // Бейдж «повторим сам»: набор живёт с оригиналом (облачная
                    // дорожка не строится), пробуем, пока сеть не появится.
                    let message = e.message();
                    sink.unavailable(REASON_OFFLINE, &message, true);
                    loop {
                        (hooks.wait)();
                        if (hooks.alive)().is_none() {
                            return WatchOutcome::Dropped;
                        }
                        if (hooks.probe)(endpoint.clone()) {
                            break; // сеть появилась — новая попытка сверху
                        }
                    }
                }
            },
        }
    }
}

// --- событие subtitles:translate_unavailable (контракт v5, docs/05 §2) ------

/// Бейдж «перевод недоступен» (задача 4.3, docs/03 §7): панель показывает
/// его в строке статуса конвейера; will_retry=true — Core повторяет сам,
/// финал придёт обычным subtitles:translate_progress.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesTranslateUnavailable {
    pub tab_id: String,
    pub video_key: String,
    pub track_id: String,
    pub target_lang: String,
    /// offline | no_provider (выключен/нет ключа).
    pub reason: String,
    /// Человекочитаемое описание (журнал/подсказка бейджа).
    pub detail: String,
    /// true — Core повторит сам при появлении сети (бейдж держится).
    pub will_retry: bool,
}

#[derive(Debug, Clone)]
pub struct SubtitlesTranslateUnavailableEvent;

impl BridgeEvent for SubtitlesTranslateUnavailableEvent {
    const NAME: &'static str = "subtitles:translate_unavailable";
    type Payload = SubtitlesTranslateUnavailable;
}

// --- прод-обвязка -------------------------------------------------------------

/// Прод-цикл одной работы (запуск — spawn_blocking из pipeline.rs).
/// liveness: работа в очереди И вкладка всё ещё показывает то же видео
/// (снапшот сервиса состояния) — иначе работа снимается молча.
pub fn watch_run(
    app: tauri::AppHandle,
    jobs: Arc<TranslationJobs>,
    key: JobKey,
    request: TrackTranslateRequest,
    gen: u64,
) {
    let mut gen = gen;
    let mut request = request;
    loop {
        let app_alive = app.clone();
        let jobs_alive = jobs.clone();
        let key_alive = key.clone();
        let mut alive = move || -> Option<ReplyTarget> {
            let target = jobs_alive.target(&key_alive)?;
            let video = app_alive
                .state::<crate::subtitles::service::SubtitlesService>()
                .snapshot(&target.tab_id)
                .video_key;
            if video.as_deref() != Some(key_alive.video_key.as_str()) {
                eprintln!(
                    "[translate] работа снята: вкладка {} ушла с видео {}",
                    target.tab_id, key_alive.video_key
                );
                jobs_alive.cancel(&key_alive);
                return None;
            }
            Some(target)
        };

        let dir = crate::proxy::profile_dir();
        let dir_probe = crate::proxy::profile_dir();
        // Конвейер выключен в панели — честный Config-отказ (как в 4.2):
        // бейдж no_provider без автоповтора, пока пользователь не включит.
        let mut provider_factory = move || {
            let cfg = load_config(&dir);
            if !cfg.enabled {
                return Err(TranslateError::Config(
                    "облачный перевод выключен — включите в панели «Перевод»".into(),
                ));
            }
            build_provider(&cfg, &ApiKeys::load(&dir))
        };
        let transport = UreqTransport::new();
        let cache = app
            .state::<Arc<crate::subtitles::cache::TranslationsCache>>()
            .inner()
            .clone();
        let mut sink = AppWatchSink {
            app: app.clone(),
            jobs: jobs.clone(),
            key: key.clone(),
            provider: String::new(),
        };
        // Проба строится из ТЕКУЩЕГО конфига (подсказка попытки игнорируется):
        // пока ждали сеть, провайдера/адрес могли сменить в панели. Конфиг
        // неполон/выключен — «сеть есть»: попытка сама честно откажет.
        let mut probe = move |_hint: String| -> bool {
            let cfg = load_config(&dir_probe);
            if !cfg.enabled {
                return true;
            }
            match build_provider(&cfg, &ApiKeys::load(&dir_probe)) {
                Ok(p) => endpoint_online(&p.endpoint()),
                Err(_) => true,
            }
        };
        let mut hooks = WatchHooks {
            alive: &mut alive,
            probe: &mut probe,
            wait: &mut || std::thread::sleep(Duration::from_millis(retry_poll_ms())),
        };
        let _outcome = watch_loop(
            &mut provider_factory,
            &transport,
            &cache,
            &request,
            &RetryPolicy::default(),
            &mut sink,
            &mut hooks,
        );
        // Гонка «финальный ответ ∥ повторный запрос того же ключа»: если
        // пришёл новый запрос — обслуживаем его новым циклом.
        if let Some((new_gen, new_request)) = jobs.retire(&key, gen) {
            eprintln!("[translate] ключ {key:?}: за финалом пришёл повторный запрос — новый цикл");
            gen = new_gen;
            request = new_request;
            continue;
        }
        return;
    }
}

/// Прод-реализация WatchSink: прогресс/бейдж — события контракта (активная
/// вкладка фильтрует по tabId), итог — document-событие
/// duopulse-translate-track eval'ом (паттерн задачи 3.6, как в 4.2).
struct AppWatchSink {
    app: tauri::AppHandle,
    jobs: Arc<TranslationJobs>,
    key: JobKey,
    provider: String,
}

impl AppWatchSink {
    /// Адресат мог переподчиниться (повторный запрос) — берём на каждый эмит.
    fn current(&self) -> Option<ReplyTarget> {
        self.jobs.target(&self.key)
    }

    fn emit_progress(
        &self,
        tab: &str,
        done: u32,
        total: u32,
        from_cache: bool,
        phase: &str,
        error: Option<String>,
    ) {
        let _ = bridge::emit::<SubtitlesTranslateProgressEvent>(
            &self.app,
            &SubtitlesTranslateProgress {
                tab_id: tab.to_string(),
                video_key: self.key.video_key.clone(),
                track_id: self.key.track_id.clone(),
                target_lang: self.key.target_lang.clone(),
                provider: self.provider.clone(),
                done,
                total,
                from_cache,
                phase: phase.to_string(),
                error,
            },
        );
    }
}

impl WatchSink for AppWatchSink {
    fn provider_changed(&mut self, provider: &str) {
        self.provider = provider.to_string();
    }

    fn progress(&mut self, report: ProgressReport) {
        let Some(target) = self.current() else {
            return;
        };
        self.emit_progress(
            &target.tab_id,
            report.done as u32,
            report.total.max(report.done) as u32,
            report.from_cache,
            "translating",
            None,
        );
    }

    fn unavailable(&mut self, reason: &str, detail: &str, will_retry: bool) {
        let Some(target) = self.current() else {
            return;
        };
        eprintln!(
            "[translate] недоступен ({reason}): {detail}{}",
            if will_retry {
                " — ждём сеть"
            } else {
                ""
            }
        );
        let _ = bridge::emit::<SubtitlesTranslateUnavailableEvent>(
            &self.app,
            &SubtitlesTranslateUnavailable {
                tab_id: target.tab_id.clone(),
                video_key: self.key.video_key.clone(),
                track_id: self.key.track_id.clone(),
                target_lang: self.key.target_lang.clone(),
                reason: reason.to_string(),
                detail: detail.to_string(),
                will_retry,
            },
        );
    }

    fn done(&mut self, outcome: &TrackTranslateOutcome, name: &str) {
        let Some(target) = self.current() else {
            return;
        };
        eprintln!(
            "[translate] готово: {} cue, {} пачек, {}",
            outcome.cues.len(),
            outcome.batches,
            if outcome.from_cache {
                "из кэша (сети не было)"
            } else {
                "сеть"
            },
        );
        self.emit_progress(
            &target.tab_id,
            outcome.cues.len() as u32,
            outcome.cues.len() as u32,
            outcome.from_cache,
            "done",
            None,
        );
        let cues_json: Vec<serde_json::Value> = outcome
            .cues
            .iter()
            .map(
                |c| serde_json::json!({ "startMs": c.start_ms, "endMs": c.end_ms, "text": c.text }),
            )
            .collect();
        let detail = serde_json::json!({
            "reqId": target.req_id,
            "ok": true,
            "cues": cues_json,
            "name": name,
            "fromCache": outcome.from_cache,
        });
        reply_to_tab(&self.app, &target.tab_id, &detail);
    }

    fn failed(&mut self, detail: String, badge_shown: bool) {
        let Some(target) = self.current() else {
            return;
        };
        eprintln!("[translate] ошибка: {detail}");
        if !badge_shown {
            self.emit_progress(&target.tab_id, 0, 0, false, "error", Some(detail.clone()));
        }
        let fail = serde_json::json!({ "reqId": target.req_id, "ok": false, "error": detail });
        reply_to_tab(&self.app, &target.tab_id, &fail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subtitles::cache::TranslationsCache;
    use crate::subtitles::Cue;
    use crate::translate::http::MockTransport;
    use crate::translate::libre::LibreProvider;

    fn cue(text: &str, start: i64) -> Cue {
        Cue {
            start_ms: start,
            end_ms: start + 1_500,
            text: text.into(),
        }
    }

    fn request() -> TrackTranslateRequest {
        TrackTranslateRequest {
            video_key: "yt:v1".into(),
            track_id: "yt:en".into(),
            source_lang: "en".into(),
            target_lang: "ru".into(),
            cues: vec![cue("hello", 0), cue("world", 2_000)],
        }
    }

    fn libre_reply(items: &[&str]) -> String {
        let out: Vec<String> = items.iter().map(|s| format!("⟪ru⟫{s}")).collect();
        format!(
            r#"{{"translatedText":{}}}"#,
            serde_json::to_string(&out).unwrap()
        )
    }

    #[test]
    fn failure_kind_taxonomy() {
        assert_eq!(
            failure_kind(&TranslateError::Network("нет маршрута".into())),
            FailureKind::AwaitNetwork
        );
        for e in [
            TranslateError::RateLimited("429".into()),
            TranslateError::Server("502".into()),
            TranslateError::Auth("401".into()),
            TranslateError::Quota("456".into()),
            TranslateError::Config("нет ключа".into()),
            TranslateError::BadResponse("битое тело".into()),
        ] {
            assert_eq!(failure_kind(&e), FailureKind::Terminal, "{e:?}");
        }
    }

    #[test]
    fn endpoint_socket_parsing() {
        assert_eq!(
            endpoint_socket("https://api-free.deepl.com/v2/translate"),
            Some(("api-free.deepl.com".into(), 443))
        );
        assert_eq!(
            endpoint_socket("http://127.0.0.1:8897/lt/translate"),
            Some(("127.0.0.1".into(), 8897))
        );
        assert_eq!(
            endpoint_socket("http://lt.local/translate"),
            Some(("lt.local".into(), 80))
        );
        assert_eq!(
            endpoint_socket("http://user:pw@lt.local:5000/translate"),
            Some(("lt.local".into(), 5000))
        );
        assert_eq!(
            endpoint_socket("http://[::1]:5000/translate"),
            Some(("::1".into(), 5000))
        );
        // не URL / без хоста — проба не строится (решает конвейер)
        assert_eq!(endpoint_socket("localhost:5000"), None);
        assert_eq!(endpoint_socket("http:///translate"), None);
        assert_eq!(endpoint_socket(""), None);
    }

    #[test]
    fn jobs_submit_reparents_and_retires() {
        let jobs = TranslationJobs::default();
        let (spawned, gen1) = jobs.submit(
            JobKey {
                video_key: "yt:v1".into(),
                track_id: "yt:en".into(),
                target_lang: "ru".into(),
            },
            request(),
            ReplyTarget {
                tab_id: "t1".into(),
                req_id: 1,
            },
        );
        assert!(spawned, "первый запрос поднимает цикл");
        assert_eq!(jobs.len(), 1);

        // тот же ключ пока работа жива — reparent, второго цикла нет
        let (spawned2, gen2) = jobs.submit(
            JobKey {
                video_key: "yt:v1".into(),
                track_id: "yt:en".into(),
                target_lang: "ru".into(),
            },
            request(),
            ReplyTarget {
                tab_id: "t2".into(),
                req_id: 7,
            },
        );
        assert!(!spawned2);
        assert!(gen2 > gen1, "поколение растёт");
        assert_eq!(jobs.len(), 1, "дубля нет");
        let target = jobs.target(&JobKey {
            video_key: "yt:v1".into(),
            track_id: "yt:en".into(),
            target_lang: "ru".into(),
        });
        assert_eq!(
            target.map(|t| (t.tab_id, t.req_id)),
            Some(("t2".to_string(), 7)),
            "ответ переподчинён новому запросу"
        );

        // retire чужого поколения работу не снимает — вернёт новую
        let newer = jobs.retire(
            &JobKey {
                video_key: "yt:v1".into(),
                track_id: "yt:en".into(),
                target_lang: "ru".into(),
            },
            gen1,
        );
        assert!(newer.is_some(), "гонка «финал ∥ повторный запрос» видна");
        assert!(newer.is_some_and(|(g, _)| g == gen2));
        assert_eq!(jobs.len(), 1);
        // retire своего поколения снимает
        assert!(jobs
            .retire(
                &JobKey {
                    video_key: "yt:v1".into(),
                    track_id: "yt:en".into(),
                    target_lang: "ru".into()
                },
                gen2
            )
            .is_none());
        assert_eq!(jobs.len(), 0);
    }

    /// Журнал вызовов sink (порядок событий цикла в тестах).
    #[derive(Default)]
    struct Journal {
        events: Vec<String>,
        provider: String,
    }

    impl WatchSink for Journal {
        fn provider_changed(&mut self, provider: &str) {
            self.provider = provider.into();
        }
        fn progress(&mut self, r: ProgressReport) {
            self.events.push(format!("progress:{}:{}", r.done, r.total));
        }
        fn unavailable(&mut self, reason: &str, _detail: &str, will_retry: bool) {
            self.events
                .push(format!("unavailable:{reason}:{}", will_retry));
        }
        fn done(&mut self, outcome: &TrackTranslateOutcome, _name: &str) {
            self.events.push(format!("done:{}", outcome.cues.len()));
        }
        fn failed(&mut self, detail: String, badge_shown: bool) {
            self.events.push(format!("failed:{badge_shown}:{detail}"));
        }
    }

    /// Запустить цикл на scripted-провайдере (фабрика отдаёт готовые
    /// провайдеры поверх ОДНОГО mock-транспорта — очередь ответов общая).
    fn scripted_provider(
        base_url: &'static str,
    ) -> impl FnMut() -> Result<Box<dyn TranslationProvider>, TranslateError> {
        move || Ok(Box::new(LibreProvider::new(base_url, None)) as Box<dyn TranslationProvider>)
    }

    #[test]
    fn offline_then_online_retries_and_completes() {
        let cache = TranslationsCache::open_in_memory().unwrap();
        let t = MockTransport::new();
        // попытка 1: сеть отваливается все 3 ретрая политики
        t.push_err("нет маршрута");
        t.push_err("нет маршрута");
        t.push_err("нет маршрута");
        // попытка 2 (сеть появилась): пачка уходит, перевод готов
        t.push_ok(200, &libre_reply(&["hello", "world"]));

        let mut sink = Journal::default();
        let mut probes = 0usize;
        let mut alive = || {
            Some(ReplyTarget {
                tab_id: "t1".into(),
                req_id: 1,
            })
        };
        let mut probe = |_endpoint: String| {
            probes += 1;
            probes > 1 // первая проба — ещё офлайн, вторая — сеть появилась
        };
        let mut waits = 0usize;
        let mut wait = || waits += 1;
        let mut hooks = WatchHooks {
            alive: &mut alive,
            probe: &mut probe,
            wait: &mut wait,
        };
        let mut factory = scripted_provider("http://libre.test");
        let outcome = watch_loop(
            &mut factory,
            &t,
            &cache,
            &request(),
            &RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 0,
            },
            &mut sink,
            &mut hooks,
        );
        assert_eq!(outcome, WatchOutcome::Done);
        assert_eq!(waits, 2, "две паузы: офлайн-ожидание и первая проба");
        assert_eq!(
            sink.events,
            vec![
                "unavailable:offline:true".to_string(),
                "progress:2:2".to_string(),
                "done:2".to_string(),
            ],
            "бейдж с автоповтором → прогресс → готово"
        );
        assert_eq!(t.recorded().len(), 4, "3 отказа + успешная пачка");
        assert!(!cache.is_empty(), "перевод записан в кэш");
        assert_eq!(sink.provider, "libretranslate");
    }

    #[test]
    fn terminal_error_no_retry_no_badge_with_retry() {
        let cache = TranslationsCache::open_in_memory().unwrap();
        let t = MockTransport::new();
        // 403 на первую же попытку — Auth не ретраится вовсе
        t.push_ok(403, r#"{"error":"ключ не принят"}"#);
        let mut sink = Journal::default();
        let mut alive = || {
            Some(ReplyTarget {
                tab_id: "t1".into(),
                req_id: 1,
            })
        };
        let mut probe_calls = 0;
        let mut probe = |_| {
            probe_calls += 1;
            true
        };
        let mut waits = 0;
        let mut wait = || waits += 1;
        let mut hooks = WatchHooks {
            alive: &mut alive,
            probe: &mut probe,
            wait: &mut wait,
        };
        let mut factory = scripted_provider("http://libre.test");
        let outcome = watch_loop(
            &mut factory,
            &t,
            &cache,
            &request(),
            &RetryPolicy::default(),
            &mut sink,
            &mut hooks,
        );
        assert_eq!(outcome, WatchOutcome::Terminal);
        assert_eq!(waits, 0, "терминальный отказ не ждёт сеть");
        assert_eq!(probe_calls, 0);
        assert_eq!(
            sink.events,
            vec!["failed:false:ключ API не принят: LibreTranslate: ключ не принят".to_string()],
            "обычная ошибка панели (бейджа с автоповтором нет)"
        );
    }

    #[test]
    fn no_provider_badge_without_retry() {
        let cache = TranslationsCache::open_in_memory().unwrap();
        let t = MockTransport::new();
        let mut sink = Journal::default();
        let mut alive = || {
            Some(ReplyTarget {
                tab_id: "t1".into(),
                req_id: 1,
            })
        };
        let mut probe = |_| true;
        let mut waits = 0;
        let mut wait = || waits += 1;
        let mut hooks = WatchHooks {
            alive: &mut alive,
            probe: &mut probe,
            wait: &mut wait,
        };
        let mut factory = || -> Result<Box<dyn TranslationProvider>, TranslateError> {
            Err(TranslateError::Config("нет ключа DeepL".into()))
        };
        let outcome = watch_loop(
            &mut factory,
            &t,
            &cache,
            &request(),
            &RetryPolicy::default(),
            &mut sink,
            &mut hooks,
        );
        assert_eq!(outcome, WatchOutcome::Terminal);
        assert_eq!(waits, 0, "сети не ждём — ждём действия пользователя");
        assert_eq!(
            sink.events,
            vec![
                "unavailable:no_provider:false".to_string(),
                "failed:true:нет ключа DeepL".to_string(),
            ],
            "бейдж уже показан — статус-ошибка панели не дублируется"
        );
        assert_eq!(t.recorded().len(), 0, "в сеть не ходили");
    }

    #[test]
    fn dropped_job_exits_silently() {
        let cache = TranslationsCache::open_in_memory().unwrap();
        let t = MockTransport::new();
        t.push_err("сеть пропала");
        t.push_err("сеть пропала");
        t.push_err("сеть пропала");
        let mut sink = Journal::default();
        // после первого отказа работу снимают (вкладка ушла с видео)
        let mut alive_calls = 0usize;
        let mut alive = || {
            alive_calls += 1;
            if alive_calls <= 1 {
                Some(ReplyTarget {
                    tab_id: "t1".into(),
                    req_id: 1,
                })
            } else {
                None
            }
        };
        let mut probe = |_| true;
        let mut wait = || {};
        let mut hooks = WatchHooks {
            alive: &mut alive,
            probe: &mut probe,
            wait: &mut wait,
        };
        let mut factory = scripted_provider("http://libre.test");
        let outcome = watch_loop(
            &mut factory,
            &t,
            &cache,
            &request(),
            &RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 0,
            },
            &mut sink,
            &mut hooks,
        );
        assert_eq!(outcome, WatchOutcome::Dropped);
        assert_eq!(
            sink.events,
            vec!["unavailable:offline:true".to_string()],
            "бейдж успел уйти, повтора и ответа нет — тишина"
        );
    }
}
