//! Duo-движок мобильной ветки (этап 2 карточки duopulse-082, зонтичная
//! aila-370): HTTP-доступ к субтитрам YouTube и переводу Google для страницы
//! приложения — WebView мобильной ветки открывает видео в КРОСС-ДОМЕННОМ
//! iframe /embed/ID, fetch timedtext из него CORS'ом запрещён, поэтому сеть
//! ходит нативно через ureq (webpki-roots, без JNI — ср. граблю NovaGrid с
//! rustls-platform-verifier).
//!
//! Пути добычи (живые пробы 08.11.2026, журнал duopulse-082):
//! - список дорожек — innertube /youtubei/v1/player с клиентом ANDROID
//!   20.10.38: единственная опробованная конфигурация, чьи
//!   captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl
//!   открывают timedtext БЕЗ PO-токена (web-клиент отдаёт baseUrl, но тело
//!   приходит пустым; tvembed/mweb — бот-блок с этой машины; ключ API —
//!   публичный констант страниц YouTube). Ответ уходит фронтенду как есть:
//!   все знания о YouTube (parse списка, id-схема yt:<lang>) живут в
//!   content-адаптере TS, здесь их не дублируем.
//! - cue-тела — GET baseUrl (+&tlang= от фронтенда): статус и разобранные
//!   cue возвращает parse_auto (единый источник разбора с десктопом);
//! - перевод — Google gtx (translate_a/single, client=gtx, без ключа):
//!   мобильной ветке недоступны ни tlang (429 без PO-токена сессии плеера —
//!   десктоп ездит верхом на живом URL с pot), ни провайдеры десктопа
//!   (DeepL/Google v2/Libre — ключи в DPAPI, этап 2 их не тащит). Оффлайн/
//!   рейт-лимит — честная ошибка строкой, фронтенд деградирует сообщением.
//!
//! Сетевая часть (ureq, команды) — cfg(mobile): либа десктопа остаётся
//! тонкой (MinGW cdylib-экспорт rustls не тянет, рецепт NovaGrid); чистые
//! функции (allowlist, gtx-parse, кэш-ключи) компилируются и тестируются
//! везде. Хосты fetch — только YouTube/Google (allowlist): команда не
//! открытый прокси.

use std::time::Duration;

use serde::Serialize;

// --- константы -----------------------------------------------------------------

/// Публичный web-ключ innertube (константа каждой страницы YouTube; извлечение
/// из watch-страницы давало тот же ключ, проба duopulse-082).
pub const INNERTUBE_KEY: &str = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
/// Клиент innertube, чьи captionTracks открываемы без PO-токена (см. шапку).
pub const INNERTUBE_CLIENT: &str = "ANDROID";
pub const INNERTUBE_CLIENT_VERSION: &str = "20.10.38";
/// UA браузера: пробы прошли и с python-requests, и с Chrome — берём Chrome
/// как «настоящий» клиент приложения.
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                             (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
/// TTL кэша player-ответов: baseUrl подписаны с запасом (порядка часов),
/// час кэша безопасен и экономит запросы при переключениях набора.
pub const PLAYER_TTL: Duration = Duration::from_secs(3600);
/// Ёмкость кэша player-ответов (видео за сеанс немного; вытеснение самой
/// старой записи).
pub const PLAYER_CACHE_MAX: usize = 8;
/// Потолок тела ответа timedtext (как ручные файлы десктопа, 4 МБ).
pub const BODY_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Ёмкость кэша переводов gtx (пачки за сеанс; сверх — чистим целиком).
pub const GTX_CACHE_MAX: usize = 4096;
/// Максимум строк пачки gtx (страховка от URL-переполнения; фронтенд режет
/// по ~1,5 КБ текста — это ≈ десятки строк).
pub const GTX_BATCH_MAX_LINES: usize = 60;

// --- состояние и типы (везде) ---------------------------------------------------

/// Cue для фронтенда (зеркало content Cue, camelCase).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuoCue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Результат duo_fetch_cues: статус апстрима + разобранные cue (на не-200 cue
/// пусты — фронтенд решает, ретраить (429/5xx) или деградировать).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuoCuesResult {
    pub status: u16,
    pub cues: Vec<DuoCue>,
    pub warnings: Vec<String>,
}

// --- чистые проверки (везде, тесты на десктопе) ---------------------------------

/// videoId YouTube ([\w-]{6,20}) — защита от инъекций в путь/запрос.
pub fn valid_video_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 20
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Разрешённые хосты duo_fetch_cues/duo_yt_player: YouTube и его CDN контента
/// (timedtext отдаёт www.youtube.com; подписанные googlevideo — на будущее),
/// хосты gtx (см. GTX_HOSTS).
pub fn fetch_host_allowed(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    h == "youtube.com"
        || h == "www.youtube.com"
        || h.ends_with(".googlevideo.com")
        || GTX_HOSTS.contains(&h.as_str())
}

/// Хосты gtx в порядке проб (зонд duopulse-082: у Гугла несколько рёбер этого
/// эндпоинта, рейт-лимит у них независимый — clients5 (виджет-хост) живёт
/// охотнее персонального translate.googleapis).
pub const GTX_HOSTS: [&str; 2] = ["clients5.google.com", "translate.googleapis.com"];

#[test]
fn fetch_host_allowlist() {
    assert!(fetch_host_allowed("www.youtube.com"));
    assert!(fetch_host_allowed("youtube.com"));
    assert!(fetch_host_allowed("rr3---sn-x.googlevideo.com"));
    assert!(fetch_host_allowed("translate.googleapis.com"));
    assert!(fetch_host_allowed("clients5.google.com"));
    assert!(!fetch_host_allowed("evil-youtube.com"));
    assert!(!fetch_host_allowed("youtube.com.evil.io"));
    assert!(!fetch_host_allowed("example.com"));
}

#[test]
fn video_id_guard() {
    assert!(valid_video_id("iG9CE55wbtY"));
    assert!(valid_video_id("9bZkp7q19f0"));
    assert!(!valid_video_id(""));
    assert!(!valid_video_id("../watch"));
    assert!(!valid_video_id("с кириллицей"));
    assert!(!valid_video_id("waytoolongidentifierover20"));
}

/// Проверка URL cue-запроса: https + домен из allowlist (url::Url — общая
/// зависимость; сам запрос строит команда через agent().get).
pub fn check_fetch_url(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("некорректный URL: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("только https, получено {}", parsed.scheme()));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !fetch_host_allowed(host) {
        return Err(format!("хост недоступен в мобильной ветке: {host}"));
    }
    Ok(parsed)
}

#[test]
fn fetch_url_guard() {
    assert!(check_fetch_url("https://www.youtube.com/api/timedtext?v=abc&lang=en").is_ok());
    let https_err = check_fetch_url("http://www.youtube.com/api/timedtext").unwrap_err();
    assert!(https_err.contains("https"), "{https_err}");
    let host_err = check_fetch_url("https://example.com/x").unwrap_err();
    assert!(host_err.contains("example.com"), "{host_err}");
    assert!(check_fetch_url("не url").is_err());
}

// --- gtx-перевод: чистые части (везде, тесты на десктопе) -----------------------

/// Тело gtx dj=1 → соединённый перевод (None — структура не сошлась).
pub fn parse_gtx_joined(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let sentences = v.get("sentences")?.as_array()?;
    let mut out = String::new();
    for s in sentences {
        let trans = s.get("trans")?.as_str()?;
        out.push_str(trans);
    }
    Some(out)
}

/// Соединённый перевод → построчно; длины не совпали (Google смёржил/разбил
/// строки) — None, вызывающий уходит в построчный запрос.
pub fn split_joined(joined: &str, expected: usize) -> Option<Vec<String>> {
    if expected == 0 {
        return Some(Vec::new());
    }
    let lines: Vec<String> = joined.split('\n').map(str::to_string).collect();
    if lines.len() == expected {
        Some(lines)
    } else {
        None
    }
}

/// Ключ кэша пачки gtx (from/to/тексты через \u{1}).
pub fn gtx_cache_key(from: &str, to: &str, texts: &[String]) -> String {
    format!("{from}\u{1}{to}\u{1}{}", texts.join("\u{1}"))
}

#[test]
fn gtx_parse_maps_lines() {
    let body = r#"{"sentences":[{"trans":"Доброе утро.\n","orig":"Good morning.\n"},
                   {"trans":"Опять будильник.","orig":"Alarm again."}],"src":"en"}"#;
    let joined = parse_gtx_joined(body).expect("тело разбирается");
    assert_eq!(
        split_joined(&joined, 2).expect("длины сошлись"),
        ["Доброе утро.", "Опять будильник."]
    );
    assert!(split_joined(&joined, 3).is_none(), "чужая длина — фолбэк");
    assert!(parse_gtx_joined("<html>Sorry</html>").is_none());
    assert!(split_joined(&"", 0).map(|v| v.is_empty()).unwrap_or(false));
    assert_eq!(
        gtx_cache_key("en", "ru", &["a".into(), "b".into()]),
        "en\u{1}ru\u{1}a\u{1}b"
    );
}

// --- мобильная сетевая часть (cfg(mobile)) -------------------------------------

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) mod net {
    use super::*;
    use std::collections::HashMap;
    use std::io::Read;
    use std::sync::Mutex;
    use std::time::Instant;

    use tauri::State;

    use crate::subtitles::parse_auto;

    /// Обёртка DuoState для managed state: внутренние кэши под локами (команды
    /// приходят из разных вызовов фронтенда).
    #[derive(Default)]
    pub struct DuoManaged {
        pub player_cache: Mutex<HashMap<String, (Instant, serde_json::Value)>>,
        pub gtx_cache: Mutex<HashMap<String, Vec<String>>>,
    }

    fn agent() -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
    }

    /// Вызов GET c расшифровкой статусов: ureq отдаёт не-2xx как
    /// Err(Status) — тело ответа сохраняем (причина рейт-лимита видна в
    /// ошибке, «Sorry page» YouTube/gtx не глотается).
    fn get_status(agent: &ureq::Agent, url: &str) -> Result<(u16, String), String> {
        match agent
            .get(url)
            .set("User-Agent", USER_AGENT)
            .set("Accept-Language", "en-US,en")
            .call()
        {
            Ok(resp) => {
                let status = resp.status();
                resp.into_string()
                    .map(|body| (status, body))
                    .map_err(|e| format!("чтение тела: {e}"))
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                Err(format!(
                    "HTTP {code}: {}",
                    body.chars().take(160).collect::<String>()
                ))
            }
            Err(e) => Err(format!("сеть: {e}")),
        }
    }

    /// Один GET gtx для пачки текстов (соединённых \n) → соединённый перевод.
    /// Хосты пробуем по порядку (GTX_HOSTS — рейт-лимиты рёбер независимые),
    /// на отказе каждого — пауза и повтор (до 2 попыток на хост, 6 с).
    fn gtx_get(agent: &ureq::Agent, from: &str, to: &str, joined: &str) -> Result<String, String> {
        let mut query = format!("client=gtx&dj=1&sl={from}&tl={to}&dt=t&q=");
        // q кодируем вручную: ureq-кодировщик не экранирует \n (0x0A) — сервер
        // принимает сырой символ в query, но экранированный вид надёжнее.
        for b in joined.bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    query.push(b as char)
                }
                b' ' => query.push_str("%20"),
                b'\n' => query.push_str("%0A"),
                _ => query.push_str(&format!("%{b:02X}")),
            }
        }
        let mut last_err = String::from("gtx недоступен");
        for host in GTX_HOSTS {
            let url = format!("https://{host}/translate_a/single?{query}");
            for attempt in 0..2 {
                if attempt > 0 {
                    std::thread::sleep(Duration::from_secs(6));
                }
                match get_status(agent, &url) {
                    Ok((200, body)) => {
                        return parse_gtx_joined(&body)
                            .ok_or_else(|| "gtx ответ не разобран".to_string());
                    }
                    Ok((status, _)) => {
                        last_err = format!("gtx HTTP {status} ({host})");
                    }
                    Err(e) => {
                        last_err = e;
                    }
                }
            }
        }
        Err(last_err)
    }

    /// Перевод пачки: кэш → пакетный GET → построчный фолбэк при несовпадении
    /// длин (Google смёржил короткие строки).
    fn translate_batch(
        agent: &ureq::Agent,
        state: &DuoManaged,
        texts: &[String],
        from: &str,
        to: &str,
    ) -> Result<Vec<String>, String> {
        let cache_key = gtx_cache_key(from, to, texts);
        if let Some(hit) = state
            .gtx_cache
            .lock()
            .expect("duo: лок не отравлен")
            .get(&cache_key)
        {
            return Ok(hit.clone());
        }
        let joined = texts.join("\n");
        let out = match gtx_get(agent, from, to, &joined).and_then(|j| {
            split_joined(&j, texts.len()).ok_or_else(|| "несовпадение строк".to_string())
        }) {
            Ok(lines) => lines,
            Err(_) => {
                // Фолбэк: построчно (пачка смёржилась или профильный сбой).
                let mut lines = Vec::with_capacity(texts.len());
                for t in texts {
                    let one = gtx_get(agent, from, to, t)?;
                    lines.push(one.trim().to_string());
                }
                lines
            }
        };
        let mut cache = state.gtx_cache.lock().expect("duo: лок не отравлен");
        if cache.len() >= GTX_CACHE_MAX {
            cache.clear(); // сеансовые объёмы малы; простое сбрасывание достаточно
        }
        cache.insert(cache_key, out.clone());
        Ok(out)
    }

    /// Player-ответ YouTube (innertube, ANDROID-клиент) по videoId — сырым
    /// JSON: разбор списка дорожек делает фронтенд (content-адаптер). Кэш 1 ч.
    #[tauri::command]
    pub fn duo_yt_player(
        video_id: String,
        state: State<'_, DuoManaged>,
    ) -> Result<serde_json::Value, String> {
        if !valid_video_id(&video_id) {
            return Err("некорректный videoId".into());
        }
        {
            let cache = state.player_cache.lock().expect("duo: лок не отравлен");
            if let Some((at, v)) = cache.get(&video_id) {
                if at.elapsed() < PLAYER_TTL {
                    return Ok(v.clone());
                }
            }
        }
        let body = serde_json::json!({
            "context": { "client": { "clientName": INNERTUBE_CLIENT, "clientVersion": INNERTUBE_CLIENT_VERSION } },
            "videoId": video_id,
            "contentCheckOk": true,
            "racyCheckOk": true,
        });
        let url = format!("https://www.youtube.com/youtubei/v1/player?key={INNERTUBE_KEY}");
        let resp = agent()
            .post(&url)
            .set("Content-Type", "application/json")
            .set("User-Agent", USER_AGENT)
            .set("Accept-Language", "en-US,en")
            .send_string(&body.to_string())
            .map_err(|e| format!("innertube сеть: {e}"))?;
        if resp.status() != 200 {
            return Err(format!("innertube HTTP {}", resp.status()));
        }
        let value: serde_json::Value = resp
            .into_string()
            .map_err(|e| format!("innertube тело: {e}"))?
            .trim()
            .parse()
            .map_err(|e| format!("innertube JSON: {e}"))?;
        // Бот-блок/приватность — сразу честная ошибка (фронтенд покажет текст).
        if let Some(status) = value
            .pointer("/playabilityStatus/status")
            .and_then(|s| s.as_str())
        {
            if status != "OK" {
                let reason = value
                    .pointer("/playabilityStatus/reason")
                    .and_then(|r| r.as_str())
                    .unwrap_or("видео недоступно");
                return Err(format!("YouTube: {reason}"));
            }
        }
        let mut cache = state.player_cache.lock().expect("duo: лок не отравлен");
        if cache.len() >= PLAYER_CACHE_MAX {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(video_id, (Instant::now(), value.clone()));
        Ok(value)
    }

    /// Cue-тело по URL дорожки (baseUrl/tlang с фронтенда): https + allowlist,
    /// статус и parse_auto (единый парсер с десктопом). Не-200 — cue пусты,
    /// статус наружу (429 у tlang — фронтенд деградирует сообщением).
    #[tauri::command]
    pub fn duo_fetch_cues(url: String) -> Result<DuoCuesResult, String> {
        check_fetch_url(&url)?;
        let fetch = || -> Result<Result<(u16, String), u16>, String> {
            match agent()
                .get(&url)
                .set("User-Agent", USER_AGENT)
                .set("Accept-Language", "en-US,en")
                .call()
            {
                Ok(resp) => {
                    let status = resp.status();
                    resp.into_string()
                        .map(|body| Ok((status, body)))
                        .map_err(|e| format!("timedtext чтение: {e}"))
                }
                // ureq не-2xx — Err(Status): статус наружу для ретрая фронтенда
                Err(ureq::Error::Status(code, resp)) => {
                    let _ = resp.into_reader();
                    Ok(Err(code))
                }
                Err(e) => Err(format!("timedtext сеть: {e}")),
            }
        };
        let (status, text) = match fetch() {
            Ok(Ok(pair)) => pair,
            Ok(Err(code)) => {
                return Ok(DuoCuesResult {
                    status: code,
                    cues: Vec::new(),
                    warnings: Vec::new(),
                })
            }
            Err(e) => return Err(e),
        };
        if status != 200 {
            return Ok(DuoCuesResult {
                status,
                cues: Vec::new(),
                warnings: Vec::new(),
            });
        }
        if text.len() > BODY_MAX_BYTES {
            return Err("тело дорожки больше 4 МБ".into());
        }
        let parsed = parse_auto(&text);
        let cues = parsed
            .cues
            .into_iter()
            .map(|c| DuoCue {
                start_ms: c.start_ms,
                end_ms: c.end_ms,
                text: c.text,
            })
            .collect();
        let warnings = parsed
            .warnings
            .into_iter()
            .map(|w| format!("строка {}: {}", w.line, w.message))
            .collect();
        Ok(DuoCuesResult {
            status,
            cues,
            warnings,
        })
    }

    /// Перевод пачек cue-текстов Google gtx (без ключа; мобильная ветка — см.
    /// шапку). Пачку режет фронтенд (~1,5 КБ), кэш сеансовый в памяти.
    #[tauri::command]
    pub fn duo_translate_texts(
        texts: Vec<String>,
        from: String,
        to: String,
        state: State<'_, DuoManaged>,
    ) -> Result<Vec<String>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() > GTX_BATCH_MAX_LINES {
            return Err(format!("пачка больше {GTX_BATCH_MAX_LINES} строк"));
        }
        let agent = agent();
        let mut out: Vec<String> = Vec::with_capacity(texts.len());
        let mut rest = texts.as_slice();
        while !rest.is_empty() {
            let take = rest.len().min(24);
            let (chunk, tail) = rest.split_at(take);
            out.extend(translate_batch(&agent, &state, chunk, &from, &to)?);
            rest = tail;
        }
        Ok(out)
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub use net::DuoManaged;

// Хендлер команд собирает lib.rs (generate_handler! резолвит скрытые
// элементы команд по ПУТИ — net открыт как pub(crate), рядом же регистрируется
// и mobile_updater этапа 3).

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn player_cache_evicts_oldest() {
        let mut cache: HashMap<String, (std::time::Instant, serde_json::Value)> = HashMap::new();
        for (i, key) in ["aaa", "bbb", "ccc"].iter().enumerate() {
            std::thread::sleep(Duration::from_millis(5));
            cache.insert(
                key.to_string(),
                (std::time::Instant::now(), serde_json::json!({"n": i})),
            );
        }
        // зеркало логики команды: при переполнении уходит самая старая запись
        let oldest = cache
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(k, _)| k.clone())
            .unwrap();
        assert_eq!(oldest, "aaa");
        cache.remove(&oldest);
        assert_eq!(cache.len(), 2);
    }
}
