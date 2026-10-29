//! Генерация субтитров распознаванием речи — ASR (карточка duopulse-060,
//! решение автора 29.10.2026: гибрид). Для видео без дорожек платформы
//! дорожка `asr:<lang>` создаётся транскрипцией аудио:
//!
//! - **локальный движок** — whisper-server.exe (whisper.cpp, MIT) с HTTP-API
//!   `/inference`; Core управляет процессом ([`server`]), модель ggml
//!   скачивается по требованию в профиль. Работает офлайн, аудио не покидает
//!   машину;
//! - **облачный провайдер** — OpenAI-совместимый `/v1/audio/transcriptions`
//!   (OpenAI / Groq / свой сервер), ключ — DPAPI по образцу перевода
//!   ([`config`]);
//! - единый конвейер ([`pipeline`]): самофетч аудио тем же сетевым путём, что
//!   и WebView2 (SOCKS5-роутер, прецедент adblock/replace.rs) → декод в PCM
//!   16 кГц моно ([`decode`], symphonia) → чанки ≤ 5 мин → провайдер →
//!   cue-таблица → SQLite-кэш [`cache`] (повторный просмотр без сети) →
//!   событие прогресса `subtitles:asr_progress` и ответ content-слою.
//!
//! Источник запроса — content-слой (он знает URL аудио из контекста
//! страницы): WebMessage `{"duopulse":"asr-begin", reqId, videoKey, url,
//! lang}`; ответ — document-событие `duopulse-asr-track` eval'ом вкладки
//! (паттерн translate-track, задача 4.2). Кнопка панели — команда
//! `subtitles.asr_start` → eval `duopulse-asr-request` в активную вкладку.

pub mod cache;
pub mod config;
pub mod decode;
pub mod engine;
pub mod pipeline;
pub mod server;
