//! Декодирование аудио для ASR (карточка duopulse-060): байты аудиодорожки
//! (m4a/AAC, webm/Opus, mp3, wav, flac, ogg) → PCM 16 кГц моно — вход
//! whisper. Декодер — symphonia (чистый Rust, без ffmpeg в поставке);
//! сведение каналов — среднее, ресемпл — линейная интерполяция (для ASР
//! достаточно, узкополосный вход 16 кГц). Дальше — WAV-байты для multipart
//! и чанки ≤ 5 минут (лимит файла облаков 25–100 МБ, 16 кГц моно WAV
//! 5 мин = 9,6 МБ; чанки дают прогресс и отмену между запросами).

use std::io::Cursor;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Целевая частота whisper, Гц.
pub const TARGET_RATE: u32 = 16_000;

/// Длительность одного чанка транскрипции, секунд (прогресс/отмена между
/// чанками; ≤ лимитов файла провайдеров).
pub const CHUNK_SECS: u32 = 300;

/// Декодировать байты в PCM 16 кГц моно (i16). Первая аудиодорожка контейнера;
/// повреждённые пакеты пропускаются (ASR устойчив к ним), конец потока —
/// нормальное завершение.
pub fn decode_to_pcm16k_mono(input: &[u8]) -> Result<Vec<i16>, String> {
    // owned-копия: MediaSourceStream требует 'static-источник
    let src = MediaSourceStream::new(Box::new(Cursor::new(input.to_vec())), Default::default());
    let hint = Hint::new();
    // m4a/webm без расширения: пусть probe сам определит по содержимому
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            src,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("определить формат аудио: {e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "аудиодорожка не найдена".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("декодер {track_id}: {e}"))?;

    let mut mono: Vec<f32> = Vec::new();
    let mut src_rate: Option<u32> = None;
    let mut channels: Option<usize> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue, // битый пакет — мимо
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count();
        src_rate.get_or_insert(spec.rate);
        channels.get_or_insert(ch);
        let frames = decoded.capacity() as u64;
        let mut sbuf = SampleBuffer::<f32>::new(frames, spec);
        sbuf.copy_interleaved_ref(decoded);
        let samples = sbuf.samples();
        // сведение в моно: среднее каналов
        if ch == 1 {
            mono.extend(samples.iter().copied());
        } else {
            for frame in samples.chunks_exact(ch) {
                mono.push(frame.iter().sum::<f32>() / ch as f32);
            }
        }
    }
    let rate = src_rate.ok_or_else(|| "пустой аудиопоток".to_string())?;
    if mono.is_empty() {
        return Err("аудио без кадров".into());
    }
    Ok(resample_to16k_mono(&mono, rate))
}

/// Линейный ресемпл в 16 кГц с клампом уровня.
pub fn resample_to16k_mono(samples: &[f32], src_rate: u32) -> Vec<i16> {
    if src_rate == TARGET_RATE {
        return samples
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
            .collect();
    }
    let step = src_rate as f64 / TARGET_RATE as f64;
    let out_len = (samples.len() as f64 / step).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 * step;
        let i0 = pos.floor() as usize;
        let i1 = (i0 + 1).min(samples.len() - 1);
        let frac = (pos - i0 as f64) as f32;
        let v = samples[i0] * (1.0 - frac) + samples[i1] * frac;
        out.push((v.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16);
    }
    out
}

/// PCM моно 16 кГц → байты WAV (16 бит, RIFF): тело для multipart-запроса
/// локального whisper-server и OpenAI-совместимых API.
pub fn pcm_to_wav(samples: &[i16]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // моно
    out.extend_from_slice(&TARGET_RATE.to_le_bytes());
    out.extend_from_slice(&(TARGET_RATE * 2).to_le_bytes()); // байт/сек
    out.extend_from_slice(&2u16.to_le_bytes()); // блок
    out.extend_from_slice(&16u16.to_le_bytes()); // биты
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Разрезать PCM на чанки по CHUNK_SECS секунд (кадр = один i16 моно).
pub fn chunk_pcm(samples: &[i16]) -> Vec<&[i16]> {
    let chunk_frames = CHUNK_SECS as usize * TARGET_RATE as usize;
    if samples.len() <= chunk_frames {
        return vec![samples];
    }
    samples.chunks(chunk_frames).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сгенерировать WAV-байты заданной частоты/длительности (тон или тишина).
    fn wav_bytes(rate: u32, secs: f64, amp: f32, freq: f64) -> Vec<u8> {
        let n = (rate as f64 * secs) as usize;
        let mut samples: Vec<i16> = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / rate as f32;
            let v = amp * (2.0 * std::f32::consts::PI * (freq as f32) * t).sin();
            samples.push((v * i16::MAX as f32) as i16);
        }
        let mut out = pcm_to_wav(&samples);
        // pcm_to_wav пишет заголовок для 16 кГц — для другой частоты перепишем
        out[24..28].copy_from_slice(&rate.to_le_bytes());
        out[28..32].copy_from_slice(&(rate * 2).to_le_bytes());
        out
    }

    #[test]
    fn decode_wav_44100_resamples_to_16k() {
        let wav = wav_bytes(44_100, 1.0, 0.5, 440.0);
        let pcm = decode_to_pcm16k_mono(&wav).expect("декод");
        // 1 с → ~16000 кадров (± 1 на округлении интерполяции)
        let n = pcm.len();
        assert!((15_990..=16_010).contains(&n), "длина {n}");
        // тон 440 Гц на 16 кГц живой: есть и положительная, и отрицательная
        // полуволны приличной амплитуды
        assert!(
            pcm.iter().copied().max().unwrap() > 8_000,
            "максимальная амплитуда мала"
        );
        assert!(pcm.iter().copied().min().unwrap() < -8_000);
    }

    #[test]
    fn decode_wav_16k_passthrough_length() {
        let wav = wav_bytes(16_000, 0.5, 0.2, 220.0);
        let pcm = decode_to_pcm16k_mono(&wav).expect("декод");
        assert!((7_990..=8_010).contains(&pcm.len()), "длина {}", pcm.len());
    }

    #[test]
    fn garbage_input_is_error_not_panic() {
        assert!(decode_to_pcm16k_mono(b"not audio at all").is_err());
        assert!(decode_to_pcm16k_mono(b"").is_err());
    }

    #[test]
    fn wav_header_roundtrip() {
        let wav = pcm_to_wav(&[0, 1000, -1000, i16::MAX, i16::MIN]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 10);
        let pcm = decode_to_pcm16k_mono(&wav).expect("свой WAV читается");
        assert_eq!(pcm.len(), 5);
        assert_eq!(pcm[1], 1000);
    }

    #[test]
    fn chunk_splits_by_five_minutes() {
        let tiny = vec![1i16; 100];
        assert_eq!(chunk_pcm(&tiny).len(), 1);
        let chunk_frames = CHUNK_SECS as usize * TARGET_RATE as usize;
        let long = vec![0i16; chunk_frames * 2 + 17];
        let chunks = chunk_pcm(&long);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].len(), chunk_frames);
        assert_eq!(chunks[2].len(), 17);
    }

    #[test]
    fn resample_preserves_silence_and_clamps() {
        let out = resample_to16k_mono(&[0.0; 100], 48_000);
        assert!(out.iter().all(|&s| s == 0));
        let loud = resample_to16k_mono(&[2.0, -2.0, 2.0], 16_000);
        assert_eq!(loud, vec![i16::MAX, -32767, i16::MAX], "кламп уровня");
    }
}
