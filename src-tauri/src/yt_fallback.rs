//! Фолбэк-добыча дорожек YouTube ядром десктопа (карточка duopulse-228, из
//! диагностики duopulse-226): YouTube изредка отдаёт деградированной
//! анонимной сессии watch-ответ БЕЗ секции captions (перезагрузка страницы
//! не помогает — куки сессии живы, рестарт браузера ротирует сессию и
//! лечит). Content-адаптер читает список дорожей только из player-ответа
//! страницы — в такой сессии DuoPulse бессилен до рестарта.
//!
//! Лечение: content-слой, увидев живой videoDetails без captions, просит
//! ядро переспросить player у innertube клиентом ANDROID (сетевой путь
//! мобильного duo_yt_player: свежая анонимная сессия без куки страницы;
//! baseUrl его captionTracks открывают timedtext БЕЗ PO-токена — так грузит
//! yt-dlp). Тела дорожек страница качает сама (same-origin), переводы tlang
//! подписью не покрыты — вторая строка дуо поднимается бесплатным gtx
//! (пачки, как duo_translate_texts мобильной ветки).
//!
//! Контракт WebMessage (паттерн asr-begin → document-событие):
//! - «yt-fallback» {reqId, videoId} → событие duopulse-yt-fallback
//!   {reqId, ok, tracks[], translations[], error?} — дорожки сырыми JSON-объектами
//!   captionTracks (все знания о YouTube — в content-адаптере TS, ядро их
//!   не интерпретирует);
//! - «gtx-translate» {reqId, texts[], from, to} → событие duopulse-gtx-translate
//!   {reqId, ok, lines[], error?}.
//! Оба идут через spawn_blocking (COM-поток WebMessage не блокируем),
//! ответ — eval'ом вкладки на главном потоке (reply_to_tab как у ASR).

use crate::duo_mobile::{
    parse_gtx_joined, split_joined, valid_video_id, GTX_BATCH_MAX_LINES, GTX_HOSTS,
    INNERTUBE_CLIENT, INNERTUBE_CLIENT_VERSION, INNERTUBE_KEY, USER_AGENT,
};
use tauri::Manager;

/// Секции фолбэк-ответа, нужные адаптеру (duopulse-228): captions целиком
/// (captionTracks/translationLanguages/audioTracks рендерера) + videoDetails
/// и верхнеуровневые audioTracks — язык оригинала (originalLangsOf: ANDROID
/// отдаёт audioTracks[].original, чего страницевой web-клиент не даёт).
/// Сырые JSON — разбор имён/id-схемы/оригиналов живёт в content-адаптере.
#[derive(Debug, Clone, PartialEq)]
pub struct FallbackSections {
    pub video_details: serde_json::Value,
    pub audio_tracks: serde_json::Value,
    pub captions: serde_json::Value,
}

/// Извлечь секции из player-ответа innertube. None — captions нет или
/// дорожек 0 (видео без субтитров; переводы без дорожек бесполезны —
/// tlang к baseUrl требует базу).
pub fn extract_fallback_sections(player: &serde_json::Value) -> Option<FallbackSections> {
    let renderer = player.pointer("/captions/playerCaptionsTracklistRenderer")?;
    let empty = renderer
        .get("captionTracks")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if empty {
        return None;
    }
    Some(FallbackSections {
        video_details: player.get("videoDetails").cloned().unwrap_or(serde_json::Value::Null),
        audio_tracks: player.get("audioTracks").cloned().unwrap_or(serde_json::Value::Null),
        captions: player.get("captions").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// Тело POST /youtubei/v1/player (клиент ANDROID — baseUrl без PO-токена,
/// см. шапку duo_mobile.rs). Чистая — тест на форму.
pub fn innertube_request_body(video_id: &str) -> serde_json::Value {
    serde_json::json!({
        "context": { "client": {
            "clientName": INNERTUBE_CLIENT,
            "clientVersion": INNERTUBE_CLIENT_VERSION,
            "hl": "ru",
        }},
        "videoId": video_id,
        "contentCheckOk": true,
        "racyCheckOk": true,
    })
}

/// Ответ innertube готов к разбору дорожек? Бот-блок/приватность —
/// playabilityStatus.status ≠ OK — честная ошибка (фронтенд покажет текст).
pub fn playability_error(player: &serde_json::Value) -> Option<String> {
    let status = player
        .pointer("/playabilityStatus/status")?
        .as_str()?
        .to_string();
    if status == "OK" {
        return None;
    }
    Some(format!(
        "YouTube: {}",
        player
            .pointer("/playabilityStatus/reason")
            .and_then(|r| r.as_str())
            .unwrap_or("видео недоступно")
    ))
}

// --- сеть (ureq, тем же путём что WebView2 — SOCKS5-роутер, если поднят) -------

fn agent(socks_port: Option<u16>) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20));
    if let Some(port) = socks_port {
        if let Ok(proxy) = ureq::Proxy::new(format!("socks5://127.0.0.1:{port}")) {
            builder = builder.proxy(proxy);
        }
    }
    builder.build()
}

/// Player-ответ innertube (ANDROID) по videoId → дорожки. Без кэша: фолбэк
/// редок (деградированные сессии), по одному запросу на видео.
pub fn fetch_fallback_tracks(
    video_id: &str,
    socks_port: Option<u16>,
) -> Result<FallbackSections, String> {
    let url = format!("https://www.youtube.com/youtubei/v1/player?key={INNERTUBE_KEY}");
    let body = innertube_request_body(video_id);
    let resp = agent(socks_port)
        .post(&url)
        .set("Content-Type", "application/json")
        .set("User-Agent", USER_AGENT)
        .set("Accept-Language", "en-US,en")
        .send_string(&body.to_string())
        .map_err(|e| format!("innertube сеть: {e}"))?;
    if resp.status() != 200 {
        return Err(format!("innertube HTTP {}", resp.status()));
    }
    let player: serde_json::Value = resp
        .into_string()
        .map_err(|e| format!("innertube тело: {e}"))?
        .trim()
        .parse()
        .map_err(|e| format!("innertube JSON: {e}"))?;
    if let Some(err) = playability_error(&player) {
        return Err(err);
    }
    extract_fallback_sections(&player)
        .ok_or_else(|| "у видео нет субтитров".to_string())
}

/// Один GET gtx (текст в query, кодирование как в duo_mobile) → тело 200.
/// Хосты по порядку (независимые рейт-лимиты рёбер), по одной попытке:
/// десктоп-сеть стабильна, длинные паузы мобильного профиля не нужны.
fn gtx_fetch(agent: &ureq::Agent, from: &str, to: &str, joined: &str) -> Result<String, String> {
    let mut query = format!("client=gtx&dj=1&sl={from}&tl={to}&dt=t&q=");
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
        match agent
            .get(&url)
            .set("User-Agent", USER_AGENT)
            .set("Accept-Language", "en-US,en")
            .call()
        {
            Ok(resp) => {
                let status = resp.status();
                let body = resp
                    .into_string()
                    .map_err(|e| format!("чтение тела: {e}"))?;
                if status == 200 {
                    return Ok(body);
                }
                last_err = format!("gtx HTTP {status} ({host})");
            }
            Err(ureq::Error::Status(code, resp)) => {
                let body = resp.into_string().unwrap_or_default();
                last_err = format!(
                    "gtx HTTP {code} ({host}): {}",
                    body.chars().take(120).collect::<String>()
                );
            }
            Err(e) => return Err(format!("gtx сеть: {e}")),
        }
    }
    Err(last_err)
}

/// Перевести пачку строк gtx (соединённых \n): пакетный запрос, несовпадение
/// длин (Google смёржил строки) — построчный фолбэк. Сессии перевода
/// редки (фолбэк-дорожки), кэша нет. Лимит пачки — как duo_translate_texts.
pub fn gtx_translate_batch(
    texts: &[String],
    from: &str,
    to: &str,
    socks_port: Option<u16>,
) -> Result<Vec<String>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    if texts.len() > GTX_BATCH_MAX_LINES {
        return Err(format!("пачка больше {GTX_BATCH_MAX_LINES} строк"));
    }
    let a = agent(socks_port);
    let joined = texts.join("\n");
    let batch = gtx_fetch(&a, from, to, &joined)
        .and_then(|body| parse_gtx_joined(&body).ok_or_else(|| "gtx ответ не разобран".into()))
        .and_then(|j| split_joined(&j, texts.len()).ok_or_else(|| "несовпадение строк".into()));
    match batch {
        Ok(lines) => Ok(lines),
        Err(_) => {
            // Построчный фолбэк: короткие строки Google сливает в одну.
            let mut out = Vec::with_capacity(texts.len());
            for t in texts {
                let body = gtx_fetch(&a, from, to, t)?;
                let one = parse_gtx_joined(&body)
                    .ok_or_else(|| "gtx ответ не разобран".to_string())?;
                out.push(one.trim().to_string());
            }
            Ok(out)
        }
    }
}

// --- WebMessage-обработчики (десктоп-бин; вызываются из main.rs) ---------------

fn reply_to_tab(app: &tauri::AppHandle, tab_id: &str, event: &str, detail: &serde_json::Value) {
    let Some(wv) = app.get_webview(tab_id) else {
        return;
    };
    let Ok(detail_json) = serde_json::to_string(detail) else {
        return;
    };
    let mut js = String::from("document.dispatchEvent(new CustomEvent('");
    js.push_str(event);
    js.push_str("',{detail:");
    js.push_str(&detail_json);
    js.push_str("}))");
    let app2 = app.clone();
    if let Err(e) = app2.run_on_main_thread(move || {
        let _ = wv.eval(&js);
    }) {
        eprintln!("[yt-fallback] доставка ответа вкладке {tab_id}: {e}");
    }
}

/// Порт SOCKS5-роутера приложения (None — роутера нет); тот же сетевой
/// путь, что у самофетча ASR/адблока.
fn router_port(app: &tauri::AppHandle) -> Option<u16> {
    app.try_state::<Option<crate::vpn::router::Router>>()
        .and_then(|r| r.inner().as_ref().map(crate::vpn::router::Router::port))
}

/// WebMessage «yt-fallback» {reqId, videoId}: player-ответ innertube →
/// дорожки. Сеть — в spawn_blocking, ответ — document-событие вкладки.
pub fn handle_yt_fallback(app: &tauri::AppHandle, tab_id: &str, msg: &serde_json::Value) {
    let (Some(req_id), Some(video_id)) = (msg["reqId"].as_u64(), msg["videoId"].as_str()) else {
        return;
    };
    if !valid_video_id(video_id) {
        reply_to_tab(
            app,
            tab_id,
            "duopulse-yt-fallback",
            &serde_json::json!({ "reqId": req_id, "ok": false, "error": "некорректный videoId" }),
        );
        return;
    }
    let video_id = video_id.to_string();
    let socks = router_port(app);
    let app = app.clone();
    let tab = tab_id.to_string();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let detail = match fetch_fallback_tracks(&video_id, socks) {
            Ok(sections) => {
                eprintln!(
                    "[yt-fallback] {video_id}: дорожки добыты за {} мс",
                    started.elapsed().as_millis()
                );
                serde_json::json!({
                    "reqId": req_id, "ok": true,
                    "player": {
                        "videoDetails": sections.video_details,
                        "audioTracks": sections.audio_tracks,
                        "captions": sections.captions,
                    },
                })
            }
            Err(e) => {
                eprintln!("[yt-fallback] {video_id}: отказ — {e}");
                serde_json::json!({ "reqId": req_id, "ok": false, "error": e })
            }
        };
        reply_to_tab(&app, &tab, "duopulse-yt-fallback", &detail);
    });
}

/// WebMessage «gtx-translate» {reqId, texts, from, to}: перевод пачки cue
/// бесплатным gtx (вторая строка дуо на фолбэк-дорожках, где tlang невозможен).
pub fn handle_gtx_translate(app: &tauri::AppHandle, tab_id: &str, msg: &serde_json::Value) {
    let (Some(req_id), Some(texts), Some(from), Some(to)) = (
        msg["reqId"].as_u64(),
        msg["texts"].as_array(),
        msg["from"].as_str(),
        msg["to"].as_str(),
    ) else {
        return;
    };
    let texts: Vec<String> = texts
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .take(GTX_BATCH_MAX_LINES + 1)
        .collect();
    if texts.is_empty() {
        reply_to_tab(
            app,
            tab_id,
            "duopulse-gtx-translate",
            &serde_json::json!({ "reqId": req_id, "ok": false, "error": "пустая пачка" }),
        );
        return;
    }
    let from = from.trim().to_lowercase();
    let to = to.trim().to_lowercase();
    let socks = router_port(app);
    let app = app.clone();
    let tab = tab_id.to_string();
    std::thread::spawn(move || {
        let detail = match gtx_translate_batch(&texts, &from, &to, socks) {
            Ok(lines) => serde_json::json!({ "reqId": req_id, "ok": true, "lines": lines }),
            Err(e) => serde_json::json!({ "reqId": req_id, "ok": false, "error": e }),
        };
        reply_to_tab(&app, &tab, "duopulse-gtx-translate", &detail);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_player(with_captions: bool) -> serde_json::Value {
        let mut v = serde_json::json!({
            "playabilityStatus": { "status": "OK" },
            "videoDetails": { "videoId": "p83syVvdrc4", "title": "T" },
        });
        if with_captions {
            v["captions"] = serde_json::json!({
                "playerCaptionsTracklistRenderer": {
                    "captionTracks": [
                        {
                            "baseUrl": "https://www.youtube.com/api/timedtext?v=p83syVvdrc4&lang=ru&fmt=srv3&signature=S",
                            "name": { "simpleText": "Russian (auto-generated)" },
                            "vssId": ".ruASR",
                            "languageCode": "ru",
                            "kind": "asr",
                            "isTranslatable": true
                        },
                        {
                            "baseUrl": "https://www.youtube.com/api/timedtext?v=p83syVvdrc4&lang=en&fmt=srv3&signature=S2",
                            "name": { "runs": [{ "text": "English" }] },
                            "vssId": ".en",
                            "languageCode": "en",
                            "isTranslatable": true
                        }
                    ],
                    "translationLanguages": [
                        { "languageCode": "ru", "languageName": { "simpleText": "Russian" } },
                        { "languageCode": "uk", "languageName": { "simpleText": "Ukrainian" } }
                    ]
                }
            });
        }
        v
    }

    #[test]
    fn extracts_caption_tracks_and_translations() {
        let got = extract_fallback_sections(&sample_player(true)).expect("дорожки есть");
        let tracks = got
            .captions
            .pointer("/playerCaptionsTracklistRenderer/captionTracks")
            .and_then(|v| v.as_array())
            .expect("captionTracks на месте");
        assert_eq!(tracks.len(), 2);
        assert_eq!(
            tracks[0].pointer("/languageCode").and_then(|v| v.as_str()),
            Some("ru")
        );
        // сырой объект без интерпретации: имя остаётся структурой YouTube
        assert!(tracks[0].get("name").unwrap().get("simpleText").is_some());
        // секции языка оригинала едут с ответом (originalLangsOf адаптера)
        assert_eq!(
            got.video_details.pointer("/videoId").and_then(|v| v.as_str()),
            Some("p83syVvdrc4")
        );
        assert!(got.audio_tracks.is_null()); // в образце верхних audioTracks нет
    }

    #[test]
    fn no_captions_section_is_none() {
        // Деградированная сессия (duopulse-226): videoDetails жив, captions нет.
        assert!(extract_fallback_sections(&sample_player(false)).is_none());
        // пустой captionTracks — тоже None (переводы без дорожек бесполезны)
        let mut v = sample_player(true);
        v.pointer_mut("/captions/playerCaptionsTracklistRenderer/captionTracks")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .clear();
        assert!(extract_fallback_sections(&v).is_none());
        // не-объект — None, не паника
        assert!(extract_fallback_sections(&serde_json::json!(42)).is_none());
        assert!(extract_fallback_sections(&serde_json::json!({})).is_none());
    }

    #[test]
    fn playability_blocks_are_honest_errors() {
        assert!(playability_error(&sample_player(true)).is_none());
        let blocked = serde_json::json!({
            "playabilityStatus": { "status": "LOGIN_REQUIRED", "reason": "Sign in to confirm you're not a bot" }
        });
        let err = playability_error(&blocked).expect("бот-блок виден");
        assert!(err.contains("Sign in"), "{err}");
        // статуса нет (не player-ответ) — не ошибка, разбор дорожек скажет своё
        assert!(playability_error(&serde_json::json!({ "videoDetails": {} })).is_none());
    }

    #[test]
    fn innertube_body_is_android_player_request() {
        let body = innertube_request_body("iG9CE55wbtY");
        assert_eq!(
            body.pointer("/context/client/clientName").and_then(|v| v.as_str()),
            Some("ANDROID")
        );
        assert_eq!(
            body.pointer("/videoId").and_then(|v| v.as_str()),
            Some("iG9CE55wbtY")
        );
        assert_eq!(body.pointer("/contentCheckOk").and_then(|v| v.as_bool()), Some(true));
    }

    /// Живая проверка критерия: дорожки видео с ASR-субтитрами добываются
    /// фолбэком, baseUrl открывает timedtext БЕЗ PO-токена (cues > 0).
    /// Запуск вручную: cargo test --bin duopulse yt_fallback -- --ignored.
    #[test]
    #[ignore = "живая сеть YouTube"]
    fn innertube_fallback_live() {
        let sections = fetch_fallback_tracks("p83syVvdrc4", None).expect("фолбэк жив");
        let tracks = sections
            .captions
            .pointer("/playerCaptionsTracklistRenderer/captionTracks")
            .and_then(|v| v.as_array())
            .expect("captionTracks в ответе");
        assert!(!tracks.is_empty(), "у видео есть ASR-дорожка ru");
        let base = tracks[0]
            .get("baseUrl")
            .and_then(|v| v.as_str())
            .expect("baseUrl в дорожке");
        // fmt=srv3 → json3 (пословный показ автодорожек), подпись не покрывает fmt
        let json3 = crate::duo_mobile::cue_url_json3(base);
        let resp = agent(None)
            .get(&json3)
            .set("User-Agent", USER_AGENT)
            .call()
            .expect("timedtext без PO-токена");
        assert_eq!(resp.status(), 200);
        let body = resp.into_string().expect("тело");
        let parsed = crate::subtitles::parse_auto(&body);
        assert!(!parsed.cues.is_empty(), "cues > 0: {}", body.chars().take(120).collect::<String>());
    }
}
