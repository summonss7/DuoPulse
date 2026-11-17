//! Чистое ядро ASR-конвейера (карточка duopulse-167): части, общие для
//! десктопа (pipeline.rs) и мобильной либы (mobile_asr.rs), без платформенных
//! зависимостей — отмена поколениями [`AsrJobs`], форма события прогресса
//! [`SubtitlesAsrProgress`] и транскрипция PCM-чанков [`transcribe_pcm`]
//! (транспорт подменяется в тестах). Десктопный конвейер (WebMessage
//! asr-begin, SOCKS-роутер, document-событие вкладке) — pipeline.rs;
//! мобильный (команды + фетч аудио через iframe-transport) — mobile_asr.rs.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::subtitles::Cue;

use super::decode::pcm_to_wav;
use super::engine::{transcribe, AsrEndpoint, AsrError, AsrTransport};

/// Потолок скачиваемого аудио, байт (аудио 48 кбит/с ≈ 21 МБ/час — с запасом
/// на качество; больше — честный отказ, см. docs/03 §3.3-ASR). Общий для
/// десктопного самофетча и мобильного приёма чанков от iframe-фетчера.
pub const AUDIO_MAX_BYTES: usize = 250 * 1024 * 1024;

/// Максимальная длина prompt-контекста между чанками (хвост предыдущего
/// текста — связность терминов на стыке чанков).
pub const PROMPT_TAIL_CHARS: usize = 200;

/// Событие subtitles:asr_progress — панель показывает «Распознавание…»
/// по фазам: model (скачивание модели, done/total — байты), audio (скачивание
/// аудио, байты), decode (без счётчиков), transcribe (done/total — чанки),
/// done, error. Мобильная ветка шлёт ту же форму (videoId вместо tabId).
#[derive(Debug, Clone, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesAsrProgress {
    /// Десктоп — id вкладки, мобильная ветка — videoId (вкладок Core не знает).
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

// --- отмена поколениями --------------------------------------------------------

/// Поколения задач по ключу (десктоп — вкладка, мобильная ветка — videoId):
/// bumps отменяют работающий конвейер.
#[derive(Default)]
pub struct AsrJobs {
    gens: Mutex<HashMap<String, u64>>,
}

impl AsrJobs {
    /// Новое поколение ключа (старая работа, если была, видит рассинхрон).
    pub fn bump(&self, key: &str) -> u64 {
        let mut gens = self.gens.lock().expect("asr-jobs: лок не отравлен");
        let next = gens.get(key).copied().unwrap_or(0) + 1;
        gens.insert(key.to_string(), next);
        next
    }

    /// Всё ещё актуально ли поколение (границы фаз).
    pub fn is_current(&self, key: &str, gen: u64) -> bool {
        self.gens
            .lock()
            .expect("asr-jobs: лок не отравлен")
            .get(key)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jobs_generations_cancel_older() {
        let jobs = AsrJobs::default();
        let g1 = jobs.bump("t");
        assert!(jobs.is_current("t", g1));
        let g2 = jobs.bump("t");
        assert!(!jobs.is_current("t", g1), "первое поколение отменено");
        assert!(jobs.is_current("t", g2));
        // другой ключ независим
        assert!(!jobs.is_current("t2", 1));
        assert!(jobs.is_current("t2", 0));
    }

    /// Тихий PCM (5 секунд нуля).
    fn silence(secs: u32) -> Vec<i16> {
        vec![0i16; secs as usize * super::super::decode::TARGET_RATE as usize]
    }

    #[test]
    fn transcribe_pcm_offsets_chunks_and_carries_prompt() {
        use super::super::engine::AsrTransport;
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
            ) -> Result<super::super::engine::HttpResponse, super::super::engine::TransportError>
            {
                self.calls.lock().unwrap().push(body);
                let v = self.bodies.lock().unwrap().remove(0);
                Ok(super::super::engine::HttpResponse {
                    status: 200,
                    body: v.to_string(),
                })
            }
            fn get(
                &self,
                _url: &str,
            ) -> Result<super::super::engine::HttpResponse, super::super::engine::TransportError>
            {
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
}
