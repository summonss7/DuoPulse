//! Конвейер перевода дорожек (задача 4.2, docs/03 §7): батчинг cue пачками
//! ≤ 2 КБ текста (и ≤ лимитов провайдера), контекст пачки — последняя строка
//! предыдущей (связность терминов, DeepL `context`), кэш SQLite
//! [`TranslationsCache`] — повторный просмотр без сети (DoD 4.2), прогресс —
//! событие контракта `subtitles:translate_progress`.
//!
//! Источник запроса — content-слой (он владеет cue дорожек): WebMessage
//! `{"duopulse":"translate-track", reqId, videoKey, trackId, sourceLang,
//! targetLang, cues[]}`. Ответ приходит document-событием
//! `duopulse-translate-track` eval'ом активной вкладки на главном потоке
//! (паттерн duopulse-file-track, задача 3.6) — из фоновой нити COM WebView2
//! не зовём. Перевод — минуты на длинном видео: обработчик сразу отдаёт
//! поток COM-хендлера, работа в spawn_blocking, прогресс летит событиями.
//!
//! Наружу уходят только тексты субтитров (docs/02 §9); тайминги не переводим
//! и не меняем — переведённая дорожка наследует сетку cue оригинала.

use std::sync::Arc;

use tauri::Manager;

use super::config::{build_provider, load_config, ApiKeys, ProviderId};
use super::{
    translate_with_retries, HttpTransport, ProviderLimits, RetryPolicy, TranslateError,
    TranslateRequest, TranslationProvider, UreqTransport,
};
use crate::bridge::{self, BridgeEvent};
use crate::subtitles::cache::{now_ms, TranslationsCache};
use crate::subtitles::Cue;

/// Потолок пачки батчера, байт: docs/03 §7 «пачками ≤ 2 КБ текста» — меньше
/// лимитов провайдеров, сверху ещё режется их `ProviderLimits`.
pub const BATCH_MAX_BYTES: usize = 2048;

/// Лимит суммарного текста дорожки в запросе content-слоя (защита WebMessage).
const REQUEST_MAX_TEXT_BYTES: usize = 512 * 1024;

/// Запрос перевода дорожки (content → Core, WebMessage «translate-track»).
#[derive(Debug, Clone)]
pub struct TrackTranslateRequest {
    pub video_key: String,
    pub track_id: String,
    /// Язык оригинала ("" — автоопределение провайдером).
    pub source_lang: String,
    pub target_lang: String,
    pub cues: Vec<Cue>,
}

/// Прогресс конвейера для события subtitles:translate_progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgressReport {
    pub done: usize,
    pub total: usize,
    pub from_cache: bool,
}

/// Итог перевода дорожки.
#[derive(Debug, Clone)]
pub struct TrackTranslateOutcome {
    /// Переведённая дорожка (сетка таймингов исходной).
    pub cues: Vec<Cue>,
    /// Дорожка целиком из кэша — сети не было.
    pub from_cache: bool,
    /// Сколько пачек ушло в провайдера (0 — кэш-хит).
    pub batches: usize,
}

/// Разрезать тексты cue на пачки: (start, end) диапазоны индексов. Накопление
/// до min(BATCH_MAX_BYTES, limits.max_bytes) байт и limits.max_texts строк;
/// строка длиннее потолка — своя пачка (провайдер откажет TooLarge — честно,
/// субтитры таких строк не содержат). Пустые строки в пачки не попадают —
/// их и не переводят (фильтрует вызывающий).
pub fn split_batches(texts: &[String], limits: &ProviderLimits) -> Vec<(usize, usize)> {
    let byte_cap = limits.max_bytes.min(BATCH_MAX_BYTES);
    let mut batches = Vec::new();
    let mut start = 0;
    let mut bytes = 0usize;
    for (i, text) in texts.iter().enumerate() {
        let len = text.len();
        let over_bytes = bytes > 0 && bytes + len > byte_cap;
        let over_texts = i - start >= limits.max_texts;
        if over_bytes || over_texts {
            batches.push((start, i));
            start = i;
            bytes = 0;
        }
        bytes += len;
    }
    if start < texts.len() {
        batches.push((start, texts.len()));
    }
    batches
}

/// Перевести дорожку: кэш → пачки → провайдер (с ретраями) → кэш.
/// `on_progress` зовётся после каждой пачки (и на кэш-хите). Ошибка пачки
/// останавливает конвейер, частичный перевод в кэш не пишется — следующая
/// попытка начнётся с нуля (деградация — задача 4.3).
pub fn translate_track<P: FnMut(ProgressReport)>(
    provider: &dyn TranslationProvider,
    transport: &dyn HttpTransport,
    cache: &TranslationsCache,
    req: &TrackTranslateRequest,
    policy: &RetryPolicy,
    on_progress: &mut P,
) -> Result<TrackTranslateOutcome, TranslateError> {
    let provider_id = provider.id();
    if let Some(mut cached) = cache.get(
        &req.video_key,
        &req.track_id,
        &req.target_lang,
        provider_id.as_str(),
        now_ms(),
    ) {
        // Сетка таймингов могла обновиться (asr-дорожки) — выравниваем по
        // исходнику там, где совпадает число cue, иначе отдаём как есть.
        if cached.len() == req.cues.len() {
            for (out, src) in cached.iter_mut().zip(&req.cues) {
                out.start_ms = src.start_ms;
                out.end_ms = src.end_ms;
            }
        }
        on_progress(ProgressReport {
            done: cached.len(),
            total: cached.len(),
            from_cache: true,
        });
        return Ok(TrackTranslateOutcome {
            cues: cached,
            from_cache: true,
            batches: 0,
        });
    }

    // Переводим только непустые тексты; пустые останутся как есть.
    let indexed: Vec<(usize, &str)> = req
        .cues
        .iter()
        .enumerate()
        .map(|(i, c)| (i, c.text.as_str()))
        .filter(|(_, t)| !t.trim().is_empty())
        .collect();
    let texts: Vec<String> = indexed.iter().map(|(_, t)| (*t).to_string()).collect();
    let total = texts.len();
    if total == 0 {
        return Err(TranslateError::BadResponse(
            "дорожка без непустых cue — переводить нечего".into(),
        ));
    }
    let batches = split_batches(&texts, &provider.limits());
    let batch_count = batches.len();
    let mut translated: Vec<Option<String>> = vec![None; req.cues.len()];
    let mut context: Option<String> = None;
    let mut done = 0usize;
    for &(b_start, b_end) in &batches {
        let pack: Vec<String> = texts[b_start..b_end].to_vec();
        let request = TranslateRequest {
            texts: pack,
            source_lang: req.source_lang.clone(),
            target_lang: req.target_lang.clone(),
            context_before: context.clone(),
        };
        let out = translate_with_retries(provider, transport, &request, policy)?;
        // Контекст следующей пачки — последняя строка предыдущей (docs/03 §7).
        context = request.texts.last().cloned();
        for (offset, line) in out.into_iter().enumerate() {
            translated[indexed[b_start + offset].0] = Some(line);
        }
        done += b_end - b_start;
        on_progress(ProgressReport {
            done,
            total,
            from_cache: false,
        });
    }
    let cues: Vec<Cue> = req
        .cues
        .iter()
        .zip(translated)
        .map(|(src, text)| Cue {
            start_ms: src.start_ms,
            end_ms: src.end_ms,
            text: text.unwrap_or_else(|| src.text.clone()),
        })
        .collect();
    cache.put(
        &req.video_key,
        &req.track_id,
        &req.target_lang,
        provider_id.as_str(),
        &cues,
        now_ms(),
    );
    Ok(TrackTranslateOutcome {
        cues,
        from_cache: false,
        batches: batch_count,
    })
}

/// Событие subtitles:translate_progress (docs/05 §2) — панель показывает
/// «Перевод… 12/40» и итог (кэш/сеть/ошибка).
#[derive(Debug, Clone)]
pub struct SubtitlesTranslateProgressEvent;

/// Payload события: табл-контекст + фаза конвейера.
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesTranslateProgress {
    pub tab_id: String,
    pub video_key: String,
    pub track_id: String,
    pub target_lang: String,
    /// Провайдер (deepl/google/libretranslate) — чей ключ/квота в работе.
    pub provider: String,
    /// Переведено cue / всего.
    pub done: u32,
    pub total: u32,
    /// Дорожка отдана из кэша — сети не было.
    pub from_cache: bool,
    /// translating | done | error.
    pub phase: String,
    /// Текст ошибки (phase=error).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BridgeEvent for SubtitlesTranslateProgressEvent {
    const NAME: &'static str = "subtitles:translate_progress";
    type Payload = SubtitlesTranslateProgress;
}

/// Человекочитаемое имя дорожки для панели: «DeepL → ru».
fn provider_label(id: ProviderId) -> &'static str {
    match id {
        ProviderId::Deepl => "DeepL",
        ProviderId::Google => "Google",
        ProviderId::Libretranslate => "LibreTranslate",
    }
}

/// Доставить ответ content-слою вкладки: document-событие
/// duopulse-translate-track eval'ом на главном потоке (паттерн задачи 3.6 —
/// из фоновой нити COM не зовём). Вкладка могла закрыться/уйти навигацией —
/// ошибка доставки не критична.
fn reply_to_tab(app: &tauri::AppHandle, tab_id: &str, detail: &serde_json::Value) {
    let Some(wv) = app.get_webview(tab_id) else {
        return;
    };
    // Склейка без format!: тройные скобки в eval уже давали тихий SyntaxError (3.6).
    let Ok(detail_json) = serde_json::to_string(detail) else {
        return;
    };
    let mut js =
        String::from("document.dispatchEvent(new CustomEvent('duopulse-translate-track',{detail:");
    js.push_str(&detail_json);
    js.push_str("}))");
    let app = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        let _ = wv.eval(&js);
    }) {
        eprintln!("[translate] доставка ответа вкладке {tab_id}: {e}");
    }
}

/// Контекст одного запроса для эмитов прогресса (не клонируем по кругу).
struct ProgressCtx {
    app: tauri::AppHandle,
    tab_id: String,
    video_key: String,
    track_id: String,
    target_lang: String,
    provider: String,
}

impl ProgressCtx {
    fn emit(&self, done: u32, total: u32, from_cache: bool, phase: &str, error: Option<String>) {
        let _ = bridge::emit::<SubtitlesTranslateProgressEvent>(
            &self.app,
            &SubtitlesTranslateProgress {
                tab_id: self.tab_id.clone(),
                video_key: self.video_key.clone(),
                track_id: self.track_id.clone(),
                target_lang: self.target_lang.clone(),
                provider: self.provider.clone(),
                done,
                total,
                from_cache,
                phase: phase.to_string(),
                error,
            },
        );
    }

    fn fail(&self, error: String, req_id: u64) {
        eprintln!("[translate] ошибка: {error}");
        self.emit(0, 0, false, "error", Some(error.clone()));
        let detail = serde_json::json!({ "reqId": req_id, "ok": false, "error": error });
        reply_to_tab(&self.app, &self.tab_id, &detail);
    }
}

/// WebMessage «translate-track» (main.rs): снисходительный разбор, валидация,
/// фоновый прогон конвейера. Вызывается на потоке COM-хендлера — ничего
/// блокирующего: тяжёлая работа уходит в spawn_blocking.
pub fn handle_translate_request(app: &tauri::AppHandle, tab_id: &str, msg: &serde_json::Value) {
    let Some(req_id) = msg["reqId"].as_u64() else {
        return;
    };
    let str_of = |key: &str| msg[key].as_str().unwrap_or_default().to_string();
    let video_key = str_of("videoKey");
    let track_id = str_of("trackId");
    let source_lang = str_of("sourceLang").to_ascii_lowercase();
    let target_lang = str_of("targetLang").trim().to_ascii_lowercase();
    let mut cues: Vec<Cue> = Vec::new();
    if let Some(arr) = msg["cues"].as_array() {
        for c in arr {
            cues.push(Cue {
                start_ms: c["startMs"].as_i64().unwrap_or(0),
                end_ms: c["endMs"].as_i64().unwrap_or(0),
                text: c["text"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    let text_bytes: usize = cues.iter().map(|c| c.text.len()).sum();
    let fail_now = |reason: String| {
        eprintln!("[translate] отказ: {reason}");
        let detail = serde_json::json!({ "reqId": req_id, "ok": false, "error": reason });
        reply_to_tab(app, tab_id, &detail);
    };
    if track_id.is_empty() || target_lang.is_empty() || cues.is_empty() {
        fail_now("запрос неполный: нужен trackId, targetLang и cue дорожки".into());
        return;
    }
    if text_bytes > REQUEST_MAX_TEXT_BYTES {
        fail_now(format!(
            "дорожка {} КБ — сверх лимита 512 КБ",
            text_bytes / 1024
        ));
        return;
    }
    eprintln!(
        "[translate] запрос: video={video_key} track={track_id} → {target_lang} ({} cue, {} КБ, tab {tab_id})",
        cues.len(),
        text_bytes / 1024
    );

    let request = TrackTranslateRequest {
        video_key,
        track_id,
        source_lang,
        target_lang,
        cues,
    };
    let app = app.clone();
    let tab_owned = tab_id.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::proxy::profile_dir();
        let cfg = load_config(&dir);
        let ctx = ProgressCtx {
            app: app.clone(),
            tab_id: tab_owned,
            video_key: request.video_key.clone(),
            track_id: request.track_id.clone(),
            target_lang: request.target_lang.clone(),
            provider: cfg.provider.as_str().to_string(),
        };
        if !cfg.enabled {
            ctx.fail(
                "облачный перевод выключен — включите в панели «Перевод»".into(),
                req_id,
            );
            return;
        }
        let provider = match build_provider(&cfg, &ApiKeys::load(&dir)) {
            Ok(p) => p,
            Err(e) => {
                ctx.fail(e.message(), req_id);
                return;
            }
        };
        let cache = app.state::<Arc<TranslationsCache>>();
        let transport = UreqTransport::new();
        let policy = RetryPolicy::default();
        let ctx_for_progress = ProgressCtx {
            app: ctx.app.clone(),
            tab_id: ctx.tab_id.clone(),
            video_key: ctx.video_key.clone(),
            track_id: ctx.track_id.clone(),
            target_lang: ctx.target_lang.clone(),
            provider: ctx.provider.clone(),
        };
        let mut on_progress = |r: ProgressReport| {
            ctx_for_progress.emit(
                r.done as u32,
                r.total.max(r.done) as u32,
                r.from_cache,
                "translating",
                None,
            );
        };
        match translate_track(
            provider.as_ref(),
            &transport,
            &cache,
            &request,
            &policy,
            &mut on_progress,
        ) {
            Err(e) => ctx.fail(e.message(), req_id),
            Ok(outcome) => {
                let name = format!(
                    "{} → {}",
                    provider_label(provider.id()),
                    request.target_lang
                );
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
                ctx.emit(
                    outcome.cues.len() as u32,
                    outcome.cues.len() as u32,
                    outcome.from_cache,
                    "done",
                    None,
                );
                let cues_json: Vec<serde_json::Value> = outcome
                    .cues
                    .iter()
                    .map(|c| {
                        serde_json::json!({ "startMs": c.start_ms, "endMs": c.end_ms, "text": c.text })
                    })
                    .collect();
                let detail = serde_json::json!({
                    "reqId": req_id,
                    "ok": true,
                    "cues": cues_json,
                    "name": name,
                    "fromCache": outcome.from_cache,
                });
                reply_to_tab(&ctx.app, &ctx.tab_id, &detail);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subtitles::cache::TranslationsCache;
    use crate::translate::config::DeeplPlan;
    use crate::translate::deepl::DeeplProvider;
    use crate::translate::http::MockTransport;
    use crate::translate::libre::LibreProvider;

    fn cue(text: &str, start: i64) -> Cue {
        Cue {
            start_ms: start,
            end_ms: start + 1_500,
            text: text.into(),
        }
    }

    fn req(cues: Vec<Cue>) -> TrackTranslateRequest {
        TrackTranslateRequest {
            video_key: "yt:v1".into(),
            track_id: "yt:en".into(),
            source_lang: "en".into(),
            target_lang: "ru".into(),
            cues,
        }
    }

    /// Ответ Libre (без ключа) на mock-транспорте: q с префиксом цели.
    fn libre_reply(items: &[&str]) -> String {
        let out: Vec<String> = items.iter().map(|s| format!("⟪ru⟫{s}")).collect();
        format!(
            r#"{{"translatedText":{}}}"#,
            serde_json::to_string(&out).unwrap()
        )
    }

    /// Ответ DeepL: переводы с префиксом цели.
    fn deepl_reply(items: &[&str]) -> String {
        let out: Vec<String> = items.iter().map(|s| format!("⟪ru⟫{s}")).collect();
        let inner: Vec<String> = out
            .iter()
            .map(|t| format!(r#"{{"text":{}}}"#, serde_json::to_string(t).unwrap()))
            .collect();
        format!(r#"{{"translations":[{}]}}"#, inner.join(","))
    }

    fn zero_policy() -> RetryPolicy {
        RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 0,
        }
    }

    #[test]
    fn split_batches_by_bytes_cap_and_texts() {
        let limits = ProviderLimits {
            max_texts: 50,
            max_bytes: 100_000,
        };
        // ≤ 2 КБ: 3 строки по 800 байт → 2 пачки (1600 + 800)
        let texts: Vec<String> = (0..3).map(|i| "x".repeat(800 - i % 3)).collect();
        let batches = split_batches(&texts, &limits);
        assert_eq!(
            batches,
            vec![(0, 2), (2, 3)],
            "потолок 2048: две строки влезают, третья — нет"
        );

        // лимит строк провайдера режет раньше байтов
        let small = ProviderLimits {
            max_texts: 2,
            max_bytes: 100_000,
        };
        let short: Vec<String> = (0..5).map(|i| format!("строка {i}")).collect();
        let batches = split_batches(&short, &small);
        assert_eq!(batches, vec![(0, 2), (2, 4), (4, 5)]);

        // лимит байт провайдера меньше 2 КБ: 5+3=8 > 7 → «12345» отдельно,
        // «678»+«90» вместе (5 ≤ 7)
        let tiny = ProviderLimits {
            max_texts: 50,
            max_bytes: 7,
        };
        let two = vec!["12345".to_string(), "678".to_string(), "90".to_string()];
        assert_eq!(split_batches(&two, &tiny), vec![(0, 1), (1, 3)]);

        // одиночная строка длиннее потолка — своя пачка (TooLarge отдаст провайдер)
        let one = vec!["y".repeat(3_000)];
        assert_eq!(split_batches(&one, &limits), vec![(0, 1)]);

        // пустой вход — без пачек
        assert!(split_batches(&[], &limits).is_empty());
    }

    #[test]
    fn pipeline_batches_result_mapping_and_progress() {
        let provider = LibreProvider::new("http://libre.test", None);
        let cache = TranslationsCache::open_in_memory().unwrap();
        // 3 строки: 2×1022 байта (2044 ≤ 2048) + «hello» → пачки (0,2) и (2,3)
        let cues = vec![
            cue(&"a".repeat(1022), 0),
            cue(&"b".repeat(1022), 2_000),
            cue("hello", 4_000),
        ];
        let t = MockTransport::new();
        t.push_ok(
            200,
            &libre_reply(&["a".repeat(1022).as_str(), "b".repeat(1022).as_str()]),
        );
        t.push_ok(200, &libre_reply(&["hello"]));
        let mut reports = Vec::new();
        let out = translate_track(
            &provider,
            &t,
            &cache,
            &req(cues.clone()),
            &zero_policy(),
            &mut |r| reports.push(r),
        )
        .unwrap();
        assert!(!out.from_cache);
        assert_eq!(out.batches, 2);
        // переводы легли по своим cue, тайминги исходные
        assert_eq!(out.cues[0].text, format!("⟪ru⟫{}", "a".repeat(1022)));
        assert_eq!(out.cues[2].text, "⟪ru⟫hello");
        assert_eq!(out.cues[2].start_ms, 4_000);
        // прогресс после каждой пачки
        assert_eq!(
            reports,
            vec![
                ProgressReport {
                    done: 2,
                    total: 3,
                    from_cache: false
                },
                ProgressReport {
                    done: 3,
                    total: 3,
                    from_cache: false
                },
            ]
        );
        assert_eq!(t.recorded().len(), 2);
    }

    /// Контекст пачки — последняя строка предыдущей (DeepL `context`,
    /// docs/03 §7: связность терминов между пачками).
    #[test]
    fn second_batch_carries_context_of_previous() {
        let provider = DeeplProvider::new(DeeplPlan::Free, "k".into());
        let cache = TranslationsCache::open_in_memory().unwrap();
        let a = "a".repeat(1022);
        let b = "b".repeat(1022);
        let cues = vec![cue(&a, 0), cue(&b, 2_000), cue("hello", 4_000)];
        let t = MockTransport::new();
        t.push_ok(200, &deepl_reply(&[&a, &b]));
        t.push_ok(200, &deepl_reply(&["hello"]));
        translate_track(
            &provider,
            &t,
            &cache,
            &req(cues),
            &zero_policy(),
            &mut |_| {},
        )
        .unwrap();
        let calls = t.recorded();
        assert_eq!(calls.len(), 2);
        assert!(
            calls[0].body.get("context").is_none(),
            "первая пачка без контекста"
        );
        assert_eq!(
            calls[1].body["context"], b,
            "контекст — последняя строка первой пачки"
        );
    }

    /// DoD 4.2: повторный просмотр — 0 сетевых вызовов перевода. Второй
    /// прогон идёт на транспорте с пустой очередью ответов: обращение к сети
    /// паникует mock — тест зелёный только если конвейер не ходил в сеть.
    #[test]
    fn second_run_served_from_cache_zero_network() {
        let provider = LibreProvider::new("http://libre.test", None);
        let cache = TranslationsCache::open_in_memory().unwrap();
        let cues = vec![cue("hello", 0), cue("world", 2_000)];
        let first = MockTransport::new();
        first.push_ok(200, &libre_reply(&["hello", "world"]));
        let out1 = translate_track(
            &provider,
            &first,
            &cache,
            &req(cues.clone()),
            &zero_policy(),
            &mut |_| {},
        )
        .unwrap();
        assert!(!out1.from_cache);
        assert_eq!(first.recorded().len(), 1);

        // «повторный просмотр»: свежий транспорт без заготовок — сеть запрещена
        let second = MockTransport::new();
        let mut reports = Vec::new();
        let out2 = translate_track(
            &provider,
            &second,
            &cache,
            &req(cues),
            &zero_policy(),
            &mut |r| reports.push(r),
        )
        .unwrap();
        assert!(out2.from_cache, "дорожка отдана из кэша");
        assert_eq!(out2.cues, out1.cues);
        assert_eq!(second.recorded().len(), 0, "0 сетевых вызовов перевода");
        assert_eq!(
            reports,
            vec![ProgressReport {
                done: 2,
                total: 2,
                from_cache: true
            }]
        );
    }

    #[test]
    fn batch_error_aborts_and_writes_nothing_to_cache() {
        let provider = LibreProvider::new("http://libre.test", None);
        let cache = TranslationsCache::open_in_memory().unwrap();
        let cues = vec![
            cue(&"a".repeat(1022), 0),
            cue(&"b".repeat(1022), 2_000),
            cue("hello", 4_000),
        ];
        let t = MockTransport::new();
        t.push_ok(
            200,
            &libre_reply(&["a".repeat(1022).as_str(), "b".repeat(1022).as_str()]),
        );
        // вторая пачка — сеть отваливается все 3 попытки
        t.push_err("сбой");
        t.push_err("сбой");
        t.push_err("сбой");
        let err = translate_track(
            &provider,
            &t,
            &cache,
            &req(cues),
            &zero_policy(),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, TranslateError::Network(_)), "{err:?}");
        // частичный перевод в кэш не попал — повтор начнётся с нуля
        assert!(cache.is_empty());
    }

    #[test]
    fn empty_texts_kept_as_is_and_all_empty_is_error() {
        let provider = LibreProvider::new("http://libre.test", None);
        let cache = TranslationsCache::open_in_memory().unwrap();
        // пустой cue в середине — не переводим, текст остаётся
        let cues = vec![cue("hello", 0), cue("   ", 2_000), cue("world", 4_000)];
        let t = MockTransport::new();
        t.push_ok(200, &libre_reply(&["hello", "world"]));
        let out = translate_track(
            &provider,
            &t,
            &cache,
            &req(cues),
            &zero_policy(),
            &mut |_| {},
        )
        .unwrap();
        assert_eq!(out.cues[1].text, "   ");
        assert_eq!(out.cues[0].text, "⟪ru⟫hello");

        // все пустые — переводить нечего (другой trackId: тот же ключ уже в кэше)
        let mut all_empty = req(vec![cue(" ", 0)]);
        all_empty.track_id = "yt:en2".into();
        let err = translate_track(
            &provider,
            &t,
            &cache,
            &all_empty,
            &zero_policy(),
            &mut |_| {},
        )
        .unwrap_err();
        assert!(matches!(err, TranslateError::BadResponse(_)));
    }

    #[test]
    fn cache_hit_retimes_to_fresh_grid() {
        // asr-дорожка обновилась — сетка сдвинулась, перевод из кэша получает
        // новые тайминги при совпадающей длине
        let provider = LibreProvider::new("http://libre.test", None);
        let cache = TranslationsCache::open_in_memory().unwrap();
        let t = MockTransport::new();
        t.push_ok(200, &libre_reply(&["hi"]));
        translate_track(
            &provider,
            &t,
            &cache,
            &req(vec![cue("hi", 1_000)]),
            &zero_policy(),
            &mut |_| {},
        )
        .unwrap();
        let fresh = req(vec![cue("hi", 9_999)]);
        let out =
            translate_track(&provider, &t, &cache, &fresh, &zero_policy(), &mut |_| {}).unwrap();
        assert!(out.from_cache);
        assert_eq!(out.cues[0].start_ms, 9_999);
        assert_eq!(out.cues[0].text, "⟪ru⟫hi");
    }
}
