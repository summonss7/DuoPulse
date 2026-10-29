//! Конвейер ASR (карточка duopulse-060): WebMessage `{"duopulse":"asr-begin",
//! reqId, videoKey, url, lang}` из content-слоя (он добыл URL аудио в
//! контексте страницы — адаптер YouTube / src «голого» видео) → самофетч
//! аудио тем же сетевым путём, что и WebView2 (SOCKS5-роутер, прецедент
//! adblock/replace.rs) → декод PCM 16 кГц моно (symphonia) → чанки ≤ 5 мин →
//! движок ([`AsrEndpoint`]: локальный whisper-server / OpenAI-совместимое
//! облако) → cue-дорожка → кэш [`AsrCache`] → событие
//! `subtitles:asr_progress` и ответ content-слою document-событием
//! `duopulse-asr-track` eval'ом вкладки (паттерн translate-track, 4.2).
//!
//! Отмена — поколениями: [`AsrJobs`] хранит generation на вкладку; новый
//! запрос или `subtitles.asr_cancel` поднимает generation, старый конвейер
//! видит рассинхрон на границе фаз и молча останавливается (вкладка могла
//! уйти с видео — результат всё равно не применился бы).

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

use crate::bridge::BridgeEvent;
use crate::subtitles::Cue;

use super::cache::{now_ms, AsrCache};
use super::config::{AsrConfig, AsrProviderId};
use super::decode::{chunk_pcm, pcm_to_wav, TARGET_RATE};
use super::engine::{transcribe, AsrEndpoint, AsrError, AsrTransport, UreqAsrTransport};
use super::server;

/// Потолок скачиваемого аудио, байт (аудио 48 кбит/с ≈ 21 МБ/час — с запасом
/// на качество; больше — честный отказ, см. docs/03 §3.3-ASR).
pub const AUDIO_MAX_BYTES: usize = 250 * 1024 * 1024;

/// Таймаут скачивания аудио.
const AUDIO_FETCH_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Максимальная длина prompt-контекста между чанками (хвост предыдущего
/// текста — связность терминов на стыке чанков).
const PROMPT_TAIL_CHARS: usize = 200;

// --- события контракта ---------------------------------------------------------

/// Событие subtitles:asr_progress — панель показывает «Распознавание…»
/// по фазам: model (скачивание модели, done/total — байты), audio (скачивание
/// аудио, байты), decode (без счётчиков), transcribe (done/total — чанки),
/// done, error.
pub struct SubtitlesAsrProgressEvent;

#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesAsrProgress {
    pub tab_id: String,
    pub video_key: String,
    /// Движок конвейера: "local:whisper" / "openai:<model>".
    pub engine: String,
    /// model | audio | decode | transcribe | done | error.
    pub phase: String,
    pub done: u32,
    pub total: u32,
    /// Дорожка отдана из кэша — сети не было.
    pub from_cache: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BridgeEvent for SubtitlesAsrProgressEvent {
    const NAME: &'static str = "subtitles:asr_progress";
    type Payload = SubtitlesAsrProgress;
}

// --- отмена поколениями --------------------------------------------------------

/// Поколения задач по вкладкам: bumps отменяют работающий конвейер.
#[derive(Default)]
pub struct AsrJobs {
    gens: Mutex<HashMap<String, u64>>,
}

impl AsrJobs {
    /// Новое поколение вкладки (старая работа, если была, видит рассинхрон).
    pub fn bump(&self, tab_id: &str) -> u64 {
        let mut gens = self.gens.lock().expect("asr-jobs: лок не отравлен");
        let next = gens.get(tab_id).copied().unwrap_or(0) + 1;
        gens.insert(tab_id.to_string(), next);
        next
    }

    /// Всё ещё актуально ли поколение (границы фаз).
    pub fn is_current(&self, tab_id: &str, gen: u64) -> bool {
        self.gens
            .lock()
            .expect("asr-jobs: лок не отравлен")
            .get(tab_id)
            .copied()
            .unwrap_or(0)
            == gen
    }
}

// --- чистое ядро (тесты на mock-транспорте) ------------------------------------

/// Транскрибировать PCM-чанки: чанк → WAV → движок; тайминги чанков
/// сдвигаются на смещение чанка; prompt — хвост предыдущего текста.
/// Возвращает cues и определённый язык (язык первого чанка; пустой — если
/// движок не отдал).
pub fn transcribe_pcm(
    transport: &dyn AsrTransport,
    endpoint: &AsrEndpoint,
    chunks: &[&[i16]],
    lang: &str,
    mut on_chunk: impl FnMut(usize, usize),
) -> Result<(Vec<Cue>, String), AsrError> {
    let mut cues: Vec<Cue> = Vec::new();
    let mut prompt: Option<String> = None;
    let mut detected = String::new();
    let total = chunks.len();
    for (i, chunk) in chunks.iter().enumerate() {
        let wav = pcm_to_wav(chunk);
        let out = transcribe(transport, endpoint, &wav, lang, prompt.as_deref())?;
        if detected.is_empty() {
            if let Some(l) = &out.detected_lang {
                // whisper отдаёт язык именем («english») — дорожке нужен код
                detected = super::engine::normalize_lang(l);
            }
        }
        let offset_ms = (i as i64) * super::decode::CHUNK_SECS as i64 * 1000;
        prompt = out
            .segments
            .last()
            .map(|s| {
                s.text
                    .chars()
                    .rev()
                    .take(PROMPT_TAIL_CHARS)
                    .collect::<Vec<_>>()
            })
            .map(|mut c| {
                c.reverse();
                c.into_iter().collect()
            });
        for seg in out.segments {
            cues.push(Cue {
                start_ms: seg.start_ms + offset_ms,
                end_ms: seg.end_ms + offset_ms,
                text: seg.text,
            });
        }
        on_chunk(i + 1, total);
    }
    Ok((cues, detected))
}

// --- самофетч аудио ------------------------------------------------------------

/// Скачать аудио по URL тем же сетевым путём, что и WebView2 (SOCKS5-роутер,
/// None — роутера нет). Потолок [`AUDIO_MAX_BYTES`].
pub fn fetch_audio(url: &str, socks_port: Option<u16>) -> Result<Vec<u8>, String> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout(AUDIO_FETCH_TIMEOUT)
        .timeout_connect(Duration::from_secs(15));
    if let Some(port) = socks_port {
        let proxy =
            ureq::Proxy::new(format!("socks5://127.0.0.1:{port}")).map_err(|e| e.to_string())?;
        builder = builder.proxy(proxy);
    }
    let agent = builder.build();
    let resp = agent
        .get(url)
        .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36")
        .call()
        .map_err(|e| format!("скачивание аудио: {e}"))?;
    let mut reader = resp.into_reader();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut chunk)
            .map_err(|e| format!("чтение аудио: {e}"))?;
        if n == 0 {
            break;
        }
        if buf.len() + n > AUDIO_MAX_BYTES {
            return Err(format!(
                "аудио больше {} МБ — сверх лимита",
                AUDIO_MAX_BYTES / (1024 * 1024)
            ));
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

// --- WebMessage-обработчик -----------------------------------------------------

/// Достать порт SOCKS5-роутера приложения (None — роутера нет).
fn router_port(app: &tauri::AppHandle) -> Option<u16> {
    app.try_state::<Option<crate::vpn::router::Router>>()
        .and_then(|r| r.inner().as_ref().map(crate::vpn::router::Router::port))
}

fn profile_dir(_app: &tauri::AppHandle) -> std::path::PathBuf {
    // каталог профиля един для всего Core (docs/02 §8): %APPDATA%/DuoPulse/profile
    crate::proxy::profile_dir()
}

/// Эндпоинт по настройкам (движок+модель+ключ). Модель при выборе локального
/// провайдера докачивается при необходимости (фаза «model»).
fn build_endpoint(
    app: &tauri::AppHandle,
    cfg: &AsrConfig,
    transport: &dyn AsrTransport,
    tab: &AsrJobCtx,
) -> Result<AsrEndpoint, String> {
    let dir = profile_dir(app);
    match cfg.provider {
        AsrProviderId::Local => {
            if !server::model_path(&dir, cfg.local_model).is_file() {
                emit_progress(app, tab, "model", 0, 0, false, None);
                server::download_model(&dir, cfg.local_model, &mut |done, total| {
                    emit_progress(app, tab, "model", done as u32, total as u32, false, None);
                })?;
            }
            let base = server::global().ensure(&dir, cfg, transport)?;
            Ok(AsrEndpoint::LocalWhisper { base_url: base })
        }
        AsrProviderId::Openai => {
            let key = super::config::load_api_key(&dir)
                .filter(|k| !k.trim().is_empty())
                .ok_or_else(|| "нет ключа API — сохраните в настройках ASR (облако)".to_string())?;
            Ok(AsrEndpoint::OpenAiCompatible {
                base_url: cfg.openai_base_url.trim().trim_end_matches('/').to_string(),
                key,
                model: cfg.openai_model.trim().to_string(),
            })
        }
    }
}

/// Контекст задачи для событий.
struct AsrJobCtx {
    tab_id: String,
    video_key: String,
    engine: String,
}

fn emit_progress(
    app: &tauri::AppHandle,
    ctx: &AsrJobCtx,
    phase: &str,
    done: u32,
    total: u32,
    from_cache: bool,
    error: Option<String>,
) {
    let _ = crate::bridge::emit::<SubtitlesAsrProgressEvent>(
        app,
        &SubtitlesAsrProgress {
            tab_id: ctx.tab_id.clone(),
            video_key: ctx.video_key.clone(),
            engine: ctx.engine.clone(),
            phase: phase.to_string(),
            done,
            total,
            from_cache,
            error,
        },
    );
}

/// cue в camelCase для document-события content-слою (asrTrackFrom ждёт
/// startMs/endMs; паттерн translate-track watcher.rs).
fn cues_json(cues: &[Cue]) -> Vec<serde_json::Value> {
    cues.iter()
        .map(|c| serde_json::json!({ "startMs": c.start_ms, "endMs": c.end_ms, "text": c.text }))
        .collect()
}

/// Ответ content-слою: document-событие duopulse-asr-track eval'ом на главном
/// потоке (паттерн translate-track, задача 4.2).
fn reply_to_tab(app: &tauri::AppHandle, tab_id: &str, detail: &serde_json::Value) {
    let Some(wv) = app.get_webview(tab_id) else {
        return;
    };
    let Ok(detail_json) = serde_json::to_string(detail) else {
        return;
    };
    let mut js =
        String::from("document.dispatchEvent(new CustomEvent('duopulse-asr-track',{detail:");
    js.push_str(&detail_json);
    js.push_str("}))");
    let app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        let _ = wv.eval(&js);
    }) {
        eprintln!("[asr] доставка ответа вкладке {tab_id}: {e}");
    }
}

/// WebMessage «asr-begin» (main.rs): разбор, кэш, запуск конвейера в
/// spawn_blocking. Вызывается на потоке COM-хендлера — без блокировок.
pub fn handle_asr_begin(app: &tauri::AppHandle, tab_id: &str, msg: &serde_json::Value) {
    let Some(req_id) = msg["reqId"].as_u64() else {
        return;
    };
    let url = msg["url"].as_str().unwrap_or_default().to_string();
    let video_key = msg["videoKey"].as_str().unwrap_or_default().to_string();
    let lang = msg["lang"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let video_key_of = || msg["videoKey"].as_str().unwrap_or_default().to_string();
    let engine_of = || "local:whisper".to_string();
    let fail_now = |reason: String| {
        eprintln!("[asr] отказ: {reason}");
        // панель узнаёт отказ событием прогресса (phase error); content-слою
        // ответ дополнительно уходит document-событием (вкладка могла уйти)
        let ctx = AsrJobCtx {
            tab_id: tab_id.to_string(),
            video_key: video_key_of(),
            engine: engine_of(),
        };
        emit_progress(app, &ctx, "error", 0, 0, false, Some(reason.clone()));
        reply_to_tab(
            app,
            tab_id,
            &serde_json::json!({ "reqId": req_id, "ok": false, "error": reason }),
        );
    };
    if video_key.is_empty() {
        fail_now("запрос неполный: нет videoKey".into());
        return;
    }
    if url.is_empty() {
        fail_now("аудио этого видео недоступно для распознавания (адаптер не дал URL)".into());
        return;
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        fail_now("адрес аудио должен быть http(s)".into());
        return;
    }
    let cfg = super::config::load_config(&profile_dir(app));
    if !cfg.enabled {
        fail_now("распознавание речи выключено в настройках".into());
        return;
    }
    // Идентификатор движка зависит от провайдера; для кэша достаточно
    // предсказуемой части (локальный — независимо от порта).
    let engine_id = super::engine::engine_id(cfg.provider, &cfg.openai_model);
    let ctx = AsrJobCtx {
        tab_id: tab_id.to_string(),
        video_key: video_key.clone(),
        engine: engine_id.clone(),
    };
    // кэш: повторный просмотр того же видео тем же движком — без сети
    let cache_hit = app
        .try_state::<AsrCache>()
        .and_then(|c| c.get(&video_key, &engine_id, &lang, now_ms()));
    if let Some((cues, cached_lang)) = cache_hit {
        eprintln!("[asr] кэш-хит: {video_key} ({})", cues.len());
        emit_progress(
            app,
            &ctx,
            "done",
            cues.len() as u32,
            cues.len() as u32,
            true,
            None,
        );
        reply_to_tab(
            app,
            tab_id,
            &serde_json::json!({
                "reqId": req_id, "ok": true, "fromCache": true,
                "lang": cached_lang, "cues": cues_json(&cues), "engine": engine_id,
            }),
        );
        return;
    }
    let jobs = app.state::<std::sync::Arc<AsrJobs>>().inner().clone();
    let gen = jobs.bump(tab_id);
    eprintln!("[asr] запрос: video={video_key} → {engine_id} ({url}, tab {tab_id})");
    let app = app.clone();
    let tab = AsrJobCtx {
        tab_id: tab_id.to_string(),
        video_key,
        engine: engine_id,
    };
    tauri::async_runtime::spawn_blocking(move || {
        run_job(app, jobs, tab, req_id, url, lang, gen);
    });
}

fn run_job(
    app: tauri::AppHandle,
    jobs: std::sync::Arc<AsrJobs>,
    ctx: AsrJobCtx,
    req_id: u64,
    url: String,
    lang: String,
    gen: u64,
) {
    let fail = |reason: String| {
        eprintln!("[asr] ошибка: {reason}");
        emit_progress(&app, &ctx, "error", 0, 0, false, Some(reason.clone()));
        reply_to_tab(
            &app,
            &ctx.tab_id,
            &serde_json::json!({
                "reqId": req_id, "ok": false, "error": reason,
            }),
        );
    };
    let transport = UreqAsrTransport::new();
    let cfg = super::config::load_config(&profile_dir(&app));
    let endpoint = match build_endpoint(&app, &cfg, &transport, &ctx) {
        Ok(e) => e,
        Err(e) => return fail(e),
    };
    if !jobs.is_current(&ctx.tab_id, gen) {
        return;
    }
    // скачивание аудио
    emit_progress(&app, &ctx, "audio", 0, 0, false, None);
    let socks = router_port(&app);
    let bytes = match fetch_audio(&url, socks) {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    if !jobs.is_current(&ctx.tab_id, gen) {
        return;
    }
    // декод
    emit_progress(&app, &ctx, "decode", 0, 0, false, None);
    let pcm = match super::decode::decode_to_pcm16k_mono(&bytes) {
        Ok(p) => p,
        Err(e) => return fail(format!("декодирование аудио: {e}")),
    };
    drop(bytes);
    if !jobs.is_current(&ctx.tab_id, gen) {
        return;
    }
    let secs = pcm.len() as f64 / TARGET_RATE as f64;
    eprintln!("[asr] аудио {secs:.0} с, {} чанков", chunk_pcm(&pcm).len());
    // транскрипция
    emit_progress(
        &app,
        &ctx,
        "transcribe",
        0,
        chunk_pcm(&pcm).len() as u32,
        false,
        None,
    );
    let app_for_progress = app.clone();
    let ctx_for_progress = AsrJobCtx {
        tab_id: ctx.tab_id.clone(),
        video_key: ctx.video_key.clone(),
        engine: ctx.engine.clone(),
    };
    let result = transcribe_pcm(
        &transport,
        &endpoint,
        &chunk_pcm(&pcm),
        &lang,
        |done, total| {
            emit_progress(
                &app_for_progress,
                &ctx_for_progress,
                "transcribe",
                done as u32,
                total as u32,
                false,
                None,
            );
        },
    );
    let (cues, detected) = match result {
        Ok(r) => r,
        Err(e) => return fail(e.message()),
    };
    if !jobs.is_current(&ctx.tab_id, gen) {
        return;
    }
    let out_lang = if lang.is_empty() { detected } else { lang };
    if let Some(cache) = app.try_state::<AsrCache>() {
        // пишем под итоговый язык: повторный просмотр (в т.ч. с lang="") найдёт
        cache.put(&ctx.video_key, &ctx.engine, &out_lang, &cues, now_ms());
    }
    eprintln!(
        "[asr] готово: {} cue, язык {out_lang} ({})",
        cues.len(),
        ctx.video_key
    );
    emit_progress(
        &app,
        &ctx,
        "done",
        cues.len() as u32,
        cues.len() as u32,
        false,
        None,
    );
    reply_to_tab(
        &app,
        &ctx.tab_id,
        &serde_json::json!({
            "reqId": req_id, "ok": true, "fromCache": false,
            "lang": out_lang, "cues": cues_json(&cues), "engine": ctx.engine,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::engine::AsrSegment;

    /// Тихий PCM (5 секунд нуля).
    fn silence(secs: u32) -> Vec<i16> {
        vec![0i16; secs as usize * TARGET_RATE as usize]
    }

    #[test]
    fn transcribe_pcm_offsets_chunks_and_carries_prompt() {
        use crate::asr::engine::AsrTransport;
        use crate::translate::http::HttpResponse;
        use std::sync::Mutex;

        struct Scripted {
            bodies: Mutex<Vec<serde_json::Value>>,
            pub calls: Mutex<Vec<Vec<u8>>>,
        }
        impl AsrTransport for Scripted {
            fn post_multipart(
                &self,
                _url: &str,
                _headers: &[(&str, String)],
                body: Vec<u8>,
            ) -> Result<HttpResponse, crate::translate::http::TransportError> {
                self.calls.lock().unwrap().push(body);
                let v = self.bodies.lock().unwrap().remove(0);
                Ok(HttpResponse {
                    status: 200,
                    body: v.to_string(),
                })
            }
            fn get(
                &self,
                _url: &str,
            ) -> Result<HttpResponse, crate::translate::http::TransportError> {
                unreachable!()
            }
        }
        fn segs(items: &[(f64, f64, &str)], lang: Option<&str>) -> serde_json::Value {
            serde_json::json!({
                "detected_language": lang,
                "segments": items.iter().map(|(s, e, t)| serde_json::json!({
                    "start": s, "end": e, "text": t,
                })).collect::<Vec<_>>(),
            })
        }
        let t = Scripted {
            bodies: Mutex::new(vec![
                segs(&[(0.0, 1.5, "first chunk")], Some("en")),
                segs(&[(0.5, 1.9, "second chunk")], Some("en")),
            ]),
            calls: Mutex::new(Vec::new()),
        };
        let pcm1 = silence(1);
        let pcm2 = silence(1);
        let chunks = vec![pcm1.as_slice(), pcm2.as_slice()];
        let mut reports = Vec::new();
        let (cues, lang) = transcribe_pcm(
            &t,
            &AsrEndpoint::LocalWhisper {
                base_url: "http://x".into(),
            },
            &chunks,
            "en",
            |d, tt| {
                reports.push((d, tt));
            },
        )
        .unwrap();
        assert_eq!(lang, "en");
        assert_eq!(cues.len(), 2);
        // второй чанк сдвинут на CHUNK_SECS (300 с)
        assert_eq!(cues[0].start_ms, 0);
        assert_eq!(
            cues[1].start_ms,
            500 + super::super::decode::CHUNK_SECS as i64 * 1000
        );
        assert_eq!(reports, vec![(1, 2), (2, 2)]);
        // prompt второго запроса — текст первого
        let second = t.calls.lock().unwrap()[1].clone();
        let text = String::from_utf8_lossy(&second);
        assert!(text.contains("name=\"prompt\"\r\n\r\nfirst chunk"));
    }

    #[test]
    fn jobs_generations_cancel_older() {
        let jobs = AsrJobs::default();
        let g1 = jobs.bump("t");
        assert!(jobs.is_current("t", g1));
        let g2 = jobs.bump("t");
        assert!(!jobs.is_current("t", g1), "первое поколение отменено");
        assert!(jobs.is_current("t", g2));
        // другая вкладка независима
        assert!(!jobs.is_current("t2", 1));
        assert!(jobs.is_current("t2", 0));
    }
}
