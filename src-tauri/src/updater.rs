//! Автообновление (задача 5.2, docs/05 §3; DoD — обновление канарейки):
//! tauri-plugin-updater — подписанные (minisign) NSIS-пакеты. Канал из
//! настроек (stable/canary, src/settings) выбирает сегмент пути фида;
//! источник (GitHub/Aila, duopulse-049) — базовый адрес и форму пути, при
//! недоступности выбранного проверка уходит ко второму (зеркало). Фид —
//! JSON формата плагина: `{version, notes, pub_date, platforms:
//! {"windows-x86_64": {signature, url}}}`; плейсхолдеры
//! {{target}}/{{arch}}/{{current_version}} подставляет сам плагин (check
//! подставляет их и в %-кодированном виде).
//!
//! Установку драйвит Core (контракт updater.check → updater.install):
//! install() на Windows запускает пакет с /P /UPDATE /R (passive-прогресс,
//! UPDATE-режим установщика, автоперезапуск) и завершает процесс — команда
//! updater.install при успехе не возвращается, UI показывает «перезапуск…».
//! Автопроверка на старте (updater.autoCheck, через 20 с — после метрик
//! старта) — тихая: обновление лишь запоминается, решение за пользователем.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::{UpdateChannel, UpdateSource, UpdaterConfig};

/// Сервер фида обновлений по умолчанию (совпадает с plugins.updater.endpoints
/// tauri.conf.json — канал там зашит stable; сюда канал подставляет Rust).
/// Хостинг — GitHub Pages репозитория duopulse-updates (решение автора
/// 20.10.2026, вопрос duopulse_035_hosting_20261019).
pub const DEFAULT_FEED_BASE: &str = "https://summonss7.github.io/duopulse-updates";

/// Зеркало фида на семейном сервере Aila (duopulse-049): updates/duopulse/
/// отдаётся статикой (aila-163) рядом с manifest.json v2; tauri-фиды —
/// latest.json (stable) / latest-canary.json (canary) с абсолютным адресом
/// пакета в том же канале.
pub const AILA_FEED_BASE: &str = "https://aila.skillcoin.pp.ua/updates/duopulse";

/// Таймаут запросов к фиду/файлу обновления.
const FEED_TIMEOUT_SECS: u64 = 20;

/// База фида выбранного источника (DUOPULSE_UPDATE_BASE подменяет её — см.
/// endpoints_for). Локальные фиды стендов — http://127.0.0.1:…, поэтому в
/// plugins.updater включён dangerousInsecureTransportProtocol: сам пакет в
/// любом случае проверяется minisign-подписью, а прод-эндпоинты зашиты https.
fn base_of(source: UpdateSource) -> &'static str {
    match source {
        UpdateSource::Github => DEFAULT_FEED_BASE,
        UpdateSource::Aila => AILA_FEED_BASE,
    }
}

/// URL фида для базы, источника и канала. GitHub: <база>/<канал>/{{target}}/
/// {{arch}}/{{current_version}} — файл фида на версию клиента (конвейер фида
/// поддерживает их в репозитории duopulse-updates). Aila: <база>/latest.json
/// (stable) или latest-canary.json — один файл на канал, плейсхолдеры не нужны.
pub fn endpoint_for_base(
    base: &str,
    source: UpdateSource,
    channel: UpdateChannel,
) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("пустой адрес сервера обновлений".into());
    }
    if !base.starts_with("https://") && !base.starts_with("http://") {
        return Err(format!("адрес сервера обновлений без схемы: {base}"));
    }
    Ok(match source {
        UpdateSource::Github => format!(
            "{base}/{}/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",
            channel.path()
        ),
        UpdateSource::Aila => match channel {
            UpdateChannel::Stable => format!("{base}/latest.json"),
            UpdateChannel::Canary => format!("{base}/latest-canary.json"),
        },
    })
}

/// Попытки проверки: выбранный источник первым, второй — фолбэк на случай
/// его недоступности (duopulse-049: канал обновлений не должен зависеть от
/// одного хостинга). DUOPULSE_UPDATE_BASE перекрывает базу выбранного
/// источника (форма адреса — по-прежнему выбранного источника), вторая
/// попытка остаётся зеркалом — подменённый стенд может быть мёртв, фолбэк
/// это и проверяет; пустое значение env игнорируется.
fn attempts_for(cfg: &UpdaterConfig) -> Result<Vec<(url::Url, UpdateSource)>, String> {
    let parse =
        |raw: String| url::Url::parse(&raw).map_err(|e| format!("адрес фида не разбирается: {e}"));
    let env_base = std::env::var("DUOPULSE_UPDATE_BASE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let order = match cfg.source {
        UpdateSource::Github => [UpdateSource::Github, UpdateSource::Aila],
        UpdateSource::Aila => [UpdateSource::Aila, UpdateSource::Github],
    };
    order
        .map(|source| {
            // env-база — только выбранному источнику (первой попытке);
            // зеркалу — штатная, иначе фолбэк уходил бы на тот же подменённый стенд
            let base = if source == cfg.source {
                env_base.as_deref().unwrap_or(base_of(source))
            } else {
                base_of(source)
            };
            Ok((
                parse(endpoint_for_base(base, source, cfg.channel)?)?,
                source,
            ))
        })
        .into_iter()
        .collect()
}

// ---------------------------------------------------------------------------
// Контрактные типы (схемы — в bridge/contract.json)
// ---------------------------------------------------------------------------

/// Доступное обновление (найдено проверкой, ждёт решения пользователя).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Версия пакета на фиде (semver, новее текущей).
    pub version: String,
    /// Заметки о релизе (notes/body манифеста).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Дата публикации пакета, unix-секунды (0 — фид не указал).
    pub date_unix: i64,
}

/// Итог проверки фида: что нашли (или почему не смогли посмотреть).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckResult {
    /// Есть пакет новее текущей версии.
    pub available: bool,
    /// Версия найденного пакета (available=true).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Заметки о релизу (available=true, фид указал).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Дата публикации пакета, unix-секунды (available=true).
    pub date_unix: i64,
    /// Источник, ответивший проверкой (github/aila, duopulse-049): выбранной
    /// базой или зеркалом-фолбэком; None — ответа не было (error).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<UpdateSource>,
    /// Время проверки, unix-мс.
    pub checked_at_unix: i64,
    /// Отказ проверки (сеть/фид/подпись манифеста): available=false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// updater.status: состояние автообновления для страницы «Настройки».
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatusResult {
    /// Версия работающего приложения (package_info).
    pub current_version: String,
    /// Канал, источник и автопроверка — раздел "updater" настроек.
    pub channel: UpdateChannel,
    pub source: UpdateSource,
    pub auto_check: bool,
    /// Последняя проверка (ручная или автопроверка старта).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_check: Option<UpdaterCheckResult>,
    /// Обновление, найденное последней удачной проверкой (ждёт решения).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<UpdateInfo>,
}

/// Marker-тип события updater:check_done (duopulse-067): итог каждой проверки
/// фида — автопроверки старта и ручных; бейдж найденного обновления на кнопке
/// «⋮» зажигается/гаснет по нему (available=false — «последняя версия» или
/// отказ сети — гасит: pending в книге проверок очищается тем же переходом).
#[derive(Debug, Clone)]
pub struct UpdaterCheckDoneEvent;

impl crate::bridge::BridgeEvent for UpdaterCheckDoneEvent {
    const NAME: &'static str = "updater:check_done";
    type Payload = UpdaterCheckResult;
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// OffsetDateTime плагина — crate time не именуем без прямой зависимости,
/// метод зовём по значению (тип выводится).
fn info_of(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        notes: update.body.clone(),
        date_unix: update
            .date
            .as_ref()
            .map(|d| d.unix_timestamp())
            .unwrap_or(0),
    }
}

// ---------------------------------------------------------------------------
// Состояние: чистая книга проверок (юнит-тесты) + подписанный пакет
// ---------------------------------------------------------------------------

/// Чистое состояние без пакета — переходы проверок (тестируется юнитами).
#[derive(Debug, Default, PartialEq)]
struct CheckBook {
    last_check: Option<UpdaterCheckResult>,
    pending: Option<UpdateInfo>,
}

impl CheckBook {
    /// Удачная проверка: нашли обновление (pending) или актуальны; source —
    /// кто ответил (выбранный источник или зеркало-фолбэк, duopulse-049).
    fn found(
        &mut self,
        info: Option<UpdateInfo>,
        source: Option<UpdateSource>,
    ) -> UpdaterCheckResult {
        let res = match &info {
            Some(info) => UpdaterCheckResult {
                available: true,
                version: Some(info.version.clone()),
                notes: info.notes.clone(),
                date_unix: info.date_unix,
                source,
                checked_at_unix: now_ms(),
                error: None,
            },
            None => UpdaterCheckResult {
                available: false,
                version: None,
                notes: None,
                date_unix: 0,
                source,
                checked_at_unix: now_ms(),
                error: None,
            },
        };
        self.pending = info;
        self.last_check = Some(res.clone());
        res
    }

    /// Отказ проверки: pending очищается (старая находка без пакета не валидна).
    fn failed(&mut self, error: String) -> UpdaterCheckResult {
        let res = UpdaterCheckResult {
            available: false,
            version: None,
            notes: None,
            date_unix: 0,
            source: None,
            checked_at_unix: now_ms(),
            error: Some(error),
        };
        self.pending = None;
        self.last_check = Some(res.clone());
        res
    }
}

/// Сервис автообновления (manage в main): книга проверок + подписанный пакет
/// последней удачной проверки (install берёт его, повторный check заменяет).
pub struct UpdaterService {
    book: Mutex<CheckBook>,
    package: Mutex<Option<Arc<Update>>>,
}

impl Default for UpdaterService {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterService {
    pub fn new() -> Self {
        Self {
            book: Mutex::new(CheckBook::default()),
            package: Mutex::new(None),
        }
    }

    /// Записать удачную проверку; пакет — для последующего install.
    fn found(&self, update: Option<Arc<Update>>, source: UpdateSource) -> UpdaterCheckResult {
        let info = update.as_ref().map(|u| info_of(u));
        let res = self.book.lock().expect("book").found(info, Some(source));
        *self.package.lock().expect("package") = update;
        res
    }

    fn failed(&self, error: String) -> UpdaterCheckResult {
        self.book.lock().expect("book").failed(error)
    }

    /// Снапшот для updater.status.
    pub(crate) fn status(
        &self,
        current_version: String,
        cfg: &UpdaterConfig,
    ) -> UpdaterStatusResult {
        let book = self.book.lock().expect("book");
        UpdaterStatusResult {
            current_version,
            channel: cfg.channel,
            source: cfg.source,
            auto_check: cfg.auto_check,
            last_check: book.last_check.clone(),
            pending: book.pending.clone(),
        }
    }

    /// Забрать пакет для установки (одноразово: повторный install требует
    /// новой проверки — пакет мог устареть).
    pub(crate) fn take_package(&self) -> Result<Arc<Update>, String> {
        self.package
            .lock()
            .expect("package")
            .take()
            .ok_or_else(|| "нет проверенного обновления — сначала проверка".to_string())
    }
}

/// Проверить фид: настройка updater + пакет (если нашли) запоминаются в
/// сервисе, итог возвращается командой updater.check. Попытки — по порядку
/// источников (выбранный → зеркало, duopulse-049): ответивший фиксируется
/// в поле source результата; «нет обновлений» от первого источника — уже
/// ответ, ко второму не идём.
pub async fn run_check(
    app: &AppHandle,
    service: &UpdaterService,
    cfg: &UpdaterConfig,
) -> UpdaterCheckResult {
    let res = match try_check(app, cfg).await {
        Ok((update, source)) => service.found(update.map(Arc::new), source),
        Err(e) => service.failed(e),
    };
    // Итог — событием в UI (duopulse-067): любая проверка (автопроверка
    // старта и ручная из настроек) обновляет бейдж «⋮» о pending-обновлении.
    let _ = crate::bridge::emit::<UpdaterCheckDoneEvent>(app, &res);
    res
}

async fn try_check(
    app: &AppHandle,
    cfg: &UpdaterConfig,
) -> Result<(Option<Update>, UpdateSource), String> {
    let attempts = attempts_for(cfg)?;
    // Попытки строго по одной: плагин умеет список endpoints, но тогда не
    // видно, кто ответил (source результата) — а это и есть репортаж фолбэка.
    let mut errors = Vec::new();
    for (endpoint, source) in attempts {
        let updater = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| format!("фид обновлений не настроен: {e}"))?
            .timeout(std::time::Duration::from_secs(FEED_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("фид обновлений не настроен: {e}"))?;
        match updater.check().await {
            Ok(update) => return Ok((update, source)),
            Err(e) => errors.push(format!("{}: {e}", source_title(source))),
        }
    }
    Err(errors.join("; "))
}

/// Человекочитаемое имя источника (журналы и ошибки проверок).
pub fn source_title(source: UpdateSource) -> &'static str {
    match source {
        UpdateSource::Github => "GitHub",
        UpdateSource::Aila => "Aila",
    }
}

/// Скачать и установить ожидающий пакет. Windows: плагин запускает NSIS-пакет
/// (/P /UPDATE /R — passive-прогресс, автоперезапуск) и завершает процесс —
/// при успехе этот вызов не возвращается.
pub async fn install_pending(service: &UpdaterService) -> Result<(), String> {
    let update = service.take_package()?;
    eprintln!(
        "[updater] установка {} — пассивный пакет с автоперезапуском",
        update.version
    );
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("пакет обновления: {e}"))
}

/// Тихая автопроверка на старте (updater.autoCheck): обновление лишь
/// запоминается (страница «Настройки» покажет), установка — всегда руками.
pub async fn auto_check_if_enabled(app: &AppHandle, service: &UpdaterService) {
    let cfg = crate::settings::load_updater(&crate::proxy::profile_dir());
    if !cfg.auto_check {
        return;
    }
    let res = run_check(app, service, &cfg).await;
    if res.available {
        eprintln!(
            "[updater] автопроверка: доступна версия {} (канал {}, источник {})",
            res.version.as_deref().unwrap_or("?"),
            cfg.channel.path(),
            res.source.map(source_title).unwrap_or("?"),
        );
    } else if let Some(e) = &res.error {
        eprintln!("[updater] автопроверка: {e}");
    }
}

// ---------------------------------------------------------------------------
// Тесты
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(source: UpdateSource, channel: UpdateChannel) -> UpdaterConfig {
        UpdaterConfig {
            channel,
            source,
            auto_check: false,
        }
    }

    #[test]
    fn endpoints_follow_base_source_and_channel() {
        // GitHub: файл фида на версию клиента, канал — сегмент пути
        let url = endpoint_for_base(
            "https://updates.example.com",
            UpdateSource::Github,
            UpdateChannel::Stable,
        )
        .expect("база валидна");
        assert_eq!(
            url,
            "https://updates.example.com/stable/{{target}}/{{arch}}/{{current_version}}"
        );
        let url = endpoint_for_base(
            "http://127.0.0.1:8898/",
            UpdateSource::Github,
            UpdateChannel::Canary,
        )
        .expect("локальный стенд");
        assert_eq!(
            url,
            "http://127.0.0.1:8898/canary/{{target}}/{{arch}}/{{current_version}}"
        );
        // Aila: один файл на канал, плейсхолдеров нет (duopulse-049)
        assert_eq!(
            endpoint_for_base(AILA_FEED_BASE, UpdateSource::Aila, UpdateChannel::Stable).unwrap(),
            "https://aila.skillcoin.pp.ua/updates/duopulse/latest.json"
        );
        assert_eq!(
            endpoint_for_base(
                "http://127.0.0.1:8898",
                UpdateSource::Aila,
                UpdateChannel::Canary
            )
            .unwrap(),
            "http://127.0.0.1:8898/latest-canary.json"
        );
        // мусорная база — отказ до запроса
        assert!(endpoint_for_base("", UpdateSource::Github, UpdateChannel::Stable).is_err());
        assert!(endpoint_for_base(
            "updates.example.com",
            UpdateSource::Github,
            UpdateChannel::Stable
        )
        .is_err());
        assert!(endpoint_for_base(
            "ftp://updates.example.com",
            UpdateSource::Aila,
            UpdateChannel::Stable
        )
        .is_err());
    }

    #[test]
    fn attempts_follow_source_with_fallback() {
        // выбранный источник первым, второй — зеркало (duopulse-049); url::Url
        // кодирует скобки плейсхолдеров (плагин заменяет и %-кодированную форму)
        let gh_stable = "https://summonss7.github.io/duopulse-updates/stable/%7B%7Btarget%7D%7D/%7B%7Barch%7D%7D/%7B%7Bcurrent_version%7D%7D";
        let urls = attempts_for(&cfg(UpdateSource::Github, UpdateChannel::Stable)).expect("ок");
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].0.as_str(), gh_stable);
        assert_eq!(urls[0].1, UpdateSource::Github);
        assert_eq!(
            urls[1].0.as_str(),
            "https://aila.skillcoin.pp.ua/updates/duopulse/latest.json"
        );
        assert_eq!(urls[1].1, UpdateSource::Aila);

        let urls = attempts_for(&cfg(UpdateSource::Aila, UpdateChannel::Canary)).expect("ок");
        assert_eq!(urls[0].1, UpdateSource::Aila);
        assert_eq!(
            urls[0].0.as_str(),
            "https://aila.skillcoin.pp.ua/updates/duopulse/latest-canary.json"
        );
        assert_eq!(urls[1].1, UpdateSource::Github);
    }

    #[test]
    fn book_found_keeps_pending_last_and_source() {
        let mut book = CheckBook::default();
        let res = book.found(
            Some(UpdateInfo {
                version: "0.2.0".into(),
                notes: Some("тест".into()),
                date_unix: 123,
            }),
            Some(UpdateSource::Aila),
        );
        assert!(res.available && res.version.as_deref() == Some("0.2.0"));
        assert!(res.error.is_none());
        assert_eq!(res.source, Some(UpdateSource::Aila), "кто ответил — видно");
        assert_eq!(book.pending.as_ref().unwrap().version, "0.2.0");
        assert!(book.last_check.as_ref().unwrap().available);

        // актуальная версия — pending очищается, источник ответа остаётся
        let res = book.found(None, Some(UpdateSource::Github));
        assert!(!res.available && res.version.is_none());
        assert_eq!(res.source, Some(UpdateSource::Github));
        assert!(book.pending.is_none());
    }

    #[test]
    fn book_failed_clears_stale_pending() {
        let mut book = CheckBook::default();
        book.found(
            Some(UpdateInfo {
                version: "0.2.0".into(),
                notes: None,
                date_unix: 0,
            }),
            Some(UpdateSource::Github),
        );
        let res = book.failed("нет сети".into());
        assert!(!res.available && res.error.as_deref() == Some("нет сети"));
        assert!(res.source.is_none(), "ответа не было");
        assert!(book.pending.is_none(), "устаревшая находка без пакета");
        assert!(book.last_check.as_ref().unwrap().error.is_some());
    }

    #[test]
    fn service_take_package_is_one_shot() {
        let service = UpdaterService::new();
        assert!(service.take_package().is_err(), "до проверки пакета нет");
        // книга без пакета тоже не устанавливается
        service.found(None, UpdateSource::Aila);
        assert!(service.take_package().is_err());
        let st = service.status(
            "0.1.0".into(),
            &cfg(UpdateSource::Aila, UpdateChannel::Canary),
        );
        assert_eq!(st.source, UpdateSource::Aila);
        assert!(!st.last_check.expect("проверка записана").available);
        assert!(st.pending.is_none());
        service.failed("офлайн".into());
        let st = service.status(
            "0.1.0".into(),
            &cfg(UpdateSource::Aila, UpdateChannel::Canary),
        );
        assert_eq!(st.last_check.unwrap().error.as_deref(), Some("офлайн"));
        assert!(service.take_package().is_err());
    }
}
