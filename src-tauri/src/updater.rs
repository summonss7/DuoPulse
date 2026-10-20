//! Автообновление (задача 5.2, docs/05 §3; DoD — обновление канарейки):
//! tauri-plugin-updater — подписанные (minisign) NSIS-пакеты. Канал из
//! настроек (stable/canary, src/settings) выбирает сегмент пути фида;
//! DUOPULSE_UPDATE_BASE перекрывает сервер фида (стенд e2e и тестовые
//! машины канарейки). Фид — JSON формата плагина:
//! `{version, notes, pub_date, platforms: {"windows-x86_64": {signature,
//! url}}}`; плейсхолдеры {{target}}/{{arch}}/{{current_version}} подставляет
//! сам плагин (check подставляет их и в %-кодированном виде).
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

use crate::settings::UpdateChannel;

/// Сервер фида обновлений по умолчанию (совпадает с plugins.updater.endpoints
/// tauri.conf.json — канал там зашит stable; сюда канал подставляет Rust).
/// Хостинг — GitHub Pages репозитория duopulse-updates (решение автора
/// 20.10.2026, вопрос duopulse_035_hosting_20261019).
pub const DEFAULT_FEED_BASE: &str = "https://summonss7.github.io/duopulse-updates";

/// Таймаут запросов к фиду/файлу обновления.
const FEED_TIMEOUT_SECS: u64 = 20;

/// База фида: DUOPULSE_UPDATE_BASE перекрывает адрес (нестандартный сервер
/// стендов и тестовых машин канарейки), пустое значение игнорируется.
/// Локальные фиды стендов — http://127.0.0.1:…, поэтому в plugins.updater
/// включён dangerousInsecureTransportProtocol: сам пакет в любом случае
/// проверяется minisign-подписью, а прод-эндпоинты зашиты https.
fn feed_base() -> String {
    std::env::var("DUOPULSE_UPDATE_BASE")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_FEED_BASE.to_string())
}

/// URL фида канала: <база>/<канал>/{{target}}/{{arch}}/{{current_version}} —
/// плагин подставит цель/архитектуру/текущую версию при запросе.
pub fn endpoints_for_base(base: &str, channel: UpdateChannel) -> Result<Vec<String>, String> {
    let base = base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("пустой адрес сервера обновлений".into());
    }
    if !base.starts_with("https://") && !base.starts_with("http://") {
        return Err(format!("адрес сервера обновлений без схемы: {base}"));
    }
    Ok(vec![format!(
        "{base}/{}/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}",
        channel.path()
    )])
}

fn endpoints_for(channel: UpdateChannel) -> Result<Vec<url::Url>, String> {
    endpoints_for_base(&feed_base(), channel)?
        .into_iter()
        .map(|raw| url::Url::parse(&raw).map_err(|e| format!("адрес фида не разбирается: {e}")))
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
    /// Канал и автопроверка — раздел "updater" настроек.
    pub channel: UpdateChannel,
    pub auto_check: bool,
    /// Последняя проверка (ручная или автопроверка старта).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_check: Option<UpdaterCheckResult>,
    /// Обновление, найденное последней удачной проверкой (ждёт решения).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending: Option<UpdateInfo>,
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
    /// Удачная проверка: нашли обновление (pending) или актуальны.
    fn found(&mut self, info: Option<UpdateInfo>) -> UpdaterCheckResult {
        let res = match &info {
            Some(info) => UpdaterCheckResult {
                available: true,
                version: Some(info.version.clone()),
                notes: info.notes.clone(),
                date_unix: info.date_unix,
                checked_at_unix: now_ms(),
                error: None,
            },
            None => UpdaterCheckResult {
                available: false,
                version: None,
                notes: None,
                date_unix: 0,
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
    fn found(&self, update: Option<Arc<Update>>) -> UpdaterCheckResult {
        let info = update.as_ref().map(|u| info_of(u));
        let res = self.book.lock().expect("book").found(info);
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
        channel: UpdateChannel,
        auto_check: bool,
    ) -> UpdaterStatusResult {
        let book = self.book.lock().expect("book");
        UpdaterStatusResult {
            current_version,
            channel,
            auto_check,
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

/// Проверить фид канала: настройка updater.status + пакет (если нашли)
/// запоминаются в сервисе, итог возвращается командой updater.check.
pub async fn run_check(
    app: &AppHandle,
    service: &UpdaterService,
    channel: UpdateChannel,
) -> UpdaterCheckResult {
    let result = try_check(app, channel).await;
    match result {
        Ok(update) => service.found(update.map(Arc::new)),
        Err(e) => service.failed(e),
    }
}

async fn try_check(app: &AppHandle, channel: UpdateChannel) -> Result<Option<Update>, String> {
    let endpoints = endpoints_for(channel)?;
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|e| format!("фид обновлений не настроен: {e}"))?
        .timeout(std::time::Duration::from_secs(FEED_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("фид обновлений не настроен: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("фид обновлений (канал {}): {e}", channel.path()))?;
    Ok(update)
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
    let res = run_check(app, service, cfg.channel).await;
    if res.available {
        eprintln!(
            "[updater] автопроверка: доступна версия {} (канал {})",
            res.version.as_deref().unwrap_or("?"),
            cfg.channel.path()
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

    #[test]
    fn endpoints_follow_base_and_channel() {
        let urls = endpoints_for_base("https://updates.example.com", UpdateChannel::Stable)
            .expect("база валидна");
        assert_eq!(
            urls,
            vec!["https://updates.example.com/stable/{{target}}/{{arch}}/{{current_version}}"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
        let urls = endpoints_for_base("http://127.0.0.1:8898/", UpdateChannel::Canary)
            .expect("локальный стенд");
        assert_eq!(
            urls[0],
            "http://127.0.0.1:8898/canary/{{target}}/{{arch}}/{{current_version}}"
        );
        // мусорная база — отказ до запроса
        assert!(endpoints_for_base("", UpdateChannel::Stable).is_err());
        assert!(endpoints_for_base("updates.example.com", UpdateChannel::Stable).is_err());
        assert!(endpoints_for_base("ftp://updates.example.com", UpdateChannel::Stable).is_err());
    }

    #[test]
    fn book_found_keeps_pending_and_last() {
        let mut book = CheckBook::default();
        let res = book.found(Some(UpdateInfo {
            version: "0.2.0".into(),
            notes: Some("тест".into()),
            date_unix: 123,
        }));
        assert!(res.available && res.version.as_deref() == Some("0.2.0"));
        assert!(res.error.is_none());
        assert_eq!(book.pending.as_ref().unwrap().version, "0.2.0");
        assert!(book.last_check.as_ref().unwrap().available);

        // актуальная версия — pending очищается
        let res = book.found(None);
        assert!(!res.available && res.version.is_none());
        assert!(book.pending.is_none());
    }

    #[test]
    fn book_failed_clears_stale_pending() {
        let mut book = CheckBook::default();
        book.found(Some(UpdateInfo {
            version: "0.2.0".into(),
            notes: None,
            date_unix: 0,
        }));
        let res = book.failed("нет сети".into());
        assert!(!res.available && res.error.as_deref() == Some("нет сети"));
        assert!(book.pending.is_none(), "устаревшая находка без пакета");
        assert!(book.last_check.as_ref().unwrap().error.is_some());
    }

    #[test]
    fn service_take_package_is_one_shot() {
        let service = UpdaterService::new();
        assert!(service.take_package().is_err(), "до проверки пакета нет");
        // книга без пакета тоже не устанавливается
        service.found(None);
        assert!(service.take_package().is_err());
        let st = service.status("0.1.0".into(), UpdateChannel::Canary, false);
        assert!(!st.last_check.expect("проверка записана").available);
        assert!(st.pending.is_none());
        service.failed("офлайн".into());
        let st = service.status("0.1.0".into(), UpdateChannel::Canary, false);
        assert_eq!(st.last_check.unwrap().error.as_deref(), Some("офлайн"));
        assert!(service.take_package().is_err());
    }
}
