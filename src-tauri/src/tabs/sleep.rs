//! Спящий режим вкладок (задача 2.3, docs/04 §1.3 «не работать, когда не
//! просят»): долгонеактивная вкладка приостанавливается энергоэффективным
//! режимом WebView2 — `ICoreWebView2_3::TrySuspend` замораживает рендер-
//! процессы вкладки (JS, таймеры, воркеры, сеть страницы стоят, память не
//! тратится на выполнение) при сохранении состояния страницы. Пробуждение —
//! `Resume` при активации вкладки (WebView2 и сам будит показанный webview,
//! явный Resume гарантирует поведение независимо от порядка show/резюма).
//!
//! TrySuspend требует, чтобы webview был невидим — неактивные вкладки уже
//! скрыты (`apply_visibility`), поэтому сон идёт по расписанию скан-нити, а
//! не «когда получится». Завершение асинхронно: флаг `sleeping` ставится в
//! момент вызова и откатывается, если TrySuspend не удался (колбэк).
//!
//! Исключения (карточка duopulse-019): вкладка с играющим звуком/видео не
//! усыпляется — состояние сообщает content/media-watch.js (WebMessage →
//! `TabManager::on_media`); активная вкладка не спит никогда.
//!
//! Таймаут: неактивность N минут, по умолчанию 5 (docs/04 §1.3);
//! `DUOPULSE_SLEEP_AFTER_SECS` переопределяет (e2e-стенды, замер P-04 «до»:
//! 0 — спящий режим выключен). Фоновая нить (start_sleeper, main.rs setup)
//! сканирует список раз в clamp(N/4; 1..30) секунд.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::bridge::TabsListResult;
use crate::tabs::{now_ms, TabManager};

/// Таймаут усыпления по умолчанию: 5 минут простоя (docs/04 §1.3).
const DEFAULT_AFTER_SECS: u64 = 300;

/// Чистая часть `timing` (для тестов): None — режим выключен, иначе
/// (таймаут, период сканирования): чаще раза в секунду скан не нужен,
/// реже 30 с — пробуждение задерживалось бы заметными пачками.
pub(crate) fn timing_from(after_s: u64) -> Option<(Duration, Duration)> {
    if after_s == 0 {
        return None;
    }
    let scan_s = (after_s / 4).clamp(1, 30);
    Some((Duration::from_secs(after_s), Duration::from_secs(scan_s)))
}

/// Таймаут/период из окружения (DUOPULSE_SLEEP_AFTER_SECS; 0 — выкл).
pub(crate) fn timing() -> Option<(Duration, Duration)> {
    let after_s = std::env::var("DUOPULSE_SLEEP_AFTER_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_AFTER_SECS);
    timing_from(after_s)
}

/// Нить авто-усыпления: раз в скан-период переводит простаивающие вкладки
/// в сон. Стартует из setup main.rs (нужен AppHandle); режим выключен
/// (DUOPULSE_SLEEP_AFTER_SECS=0) — нить не создаётся.
pub(crate) fn start_sleeper(app: AppHandle) {
    let Some((after, scan)) = timing() else {
        return;
    };
    std::thread::spawn(move || loop {
        std::thread::sleep(scan);
        let manager = app.state::<TabManager>();
        for id in manager.sleep_candidates(after) {
            manager.suspend(&app, &id);
        }
    });
}

impl TabManager {
    /// Идентификаторы вкладок, готовых ко сну: не активные, не ленивые, не
    /// спящие, без играющего медиа, простаивающие дольше таймаута
    /// (последняя активность — активация/открытие/стоп медиа).
    pub(crate) fn sleep_candidates(&self, after: Duration) -> Vec<String> {
        let now = now_ms();
        let st = self.state.lock().expect("tabs: лок не отравлен");
        st.tabs
            .iter()
            .enumerate()
            .filter(|(i, t)| {
                st.active != Some(*i)
                    && !t.lazy
                    && !t.sleeping
                    && !t.media_playing
                    && now.saturating_sub(t.last_active_ms) >= after.as_millis() as i64
            })
            .map(|(_, t)| t.id.clone())
            .collect()
    }

    /// tabs.sleep: усыпить вкладку вручную (контекстное меню таб-бара).
    /// Активная вкладка не усыпляется (TrySuspend требует скрытый webview),
    /// играющая звук/видео — исключение спящего режима (карточка 2.3).
    /// Факт сна подтверждает tabs:updated/tabs.list по завершении TrySuspend.
    pub fn sleep_by_id(&self, app: &AppHandle, id: &str) -> Result<TabsListResult, String> {
        {
            let st = self.state.lock().expect("tabs: лок не отравлен");
            let index = st
                .tabs
                .iter()
                .position(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            if st.active == Some(index) {
                return Err("активную вкладку нельзя усыпить".into());
            }
            if st.tabs[index].media_playing {
                return Err("вкладка играет звук/видео — исключение спящего режима".into());
            }
        }
        self.suspend(app, id);
        Ok(self.snapshot())
    }

    /// tabs.wake: разбудить вкладку (тесты/диагностика; активация будит сама).
    /// Не спящая вкладка — no-op. Счётчик простоя сбрасывается: после ручного
    /// пробуждения авто-усыпление вернётся не раньше нового таймаута.
    pub fn wake_by_id(&self, app: &AppHandle, id: &str) -> Result<TabsListResult, String> {
        {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let entry = st
                .tabs
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| format!("вкладка {id} не найдена"))?;
            if !entry.sleeping {
                return Ok(self.snapshot());
            }
            entry.sleeping = false;
            entry.last_active_ms = now_ms();
        }
        self.resume_webview(app, id);
        Ok(self.finish(app))
    }

    /// Перевести вкладку в сон (общая часть авто-нити и tabs.sleep): пометить
    /// и вызвать TrySuspend в webview (with_webview доставляет замыкание на
    /// главный поток). Вызов неблокирующий; неудача откатывает флаг.
    pub(crate) fn suspend(&self, app: &AppHandle, id: &str) {
        if !self.set_sleeping(app, id, true) {
            return; // уже спит (или вкладки нет) — повтора не нужно
        }
        let Some(wv) = app.get_webview(id) else {
            self.set_sleeping(app, id, false);
            return;
        };
        let app_for_wv = app.clone();
        let id_for_wv = id.to_string();
        if let Err(e) =
            wv.with_webview(move |pw| unsafe { suspend_corewebview(pw, &app_for_wv, &id_for_wv) })
        {
            eprintln!("tabs: suspend {id}: {e}");
            self.set_sleeping(app, id, false);
        }
    }

    /// Разбудить webview вкладки (Resume; идемпотентен для бодрой вкладки).
    pub(crate) fn resume_webview(&self, app: &AppHandle, id: &str) {
        if let Some(wv) = app.get_webview(id) {
            if let Err(e) = wv.with_webview(|pw| unsafe { resume_corewebview(pw) }) {
                eprintln!("tabs: wake {id}: {e}");
            }
        }
    }

    /// Состояние медиа от content/media-watch.js: playing=true — вкладка не
    /// усыпляется (исключение карточки 2.3). Стоп медиа (true→false)
    /// перезапускает отсчёт таймаута простоя; старт медиа у спящей вкладки
    /// (гонка «suspend в полёте» — медиа замерзает) — защитное пробуждение.
    pub(crate) fn on_media(&self, app: &AppHandle, id: &str, playing: bool) {
        let wake = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            let Some(entry) = st.tabs.iter_mut().find(|t| t.id == id) else {
                return;
            };
            if entry.media_playing == playing {
                return;
            }
            entry.media_playing = playing;
            if !playing {
                entry.last_active_ms = now_ms();
            }
            playing && entry.sleeping
        };
        if wake {
            if let Err(e) = self.wake_by_id(app, id) {
                eprintln!("tabs: защитное пробуждение {id}: {e}");
            }
        }
    }

    /// Переключить флаг сна; true — было изменение (снапшот/событие в ответ).
    pub(crate) fn set_sleeping(&self, app: &AppHandle, id: &str, on: bool) -> bool {
        let changed = {
            let mut st = self.state.lock().expect("tabs: лок не отравлен");
            match st.tabs.iter_mut().find(|t| t.id == id) {
                Some(entry) if entry.sleeping != on => {
                    entry.sleeping = on;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.finish(app);
        }
        changed
    }
}

/// TrySuspend для webview вкладки: колбэк завершения откатывает флаг, если
/// WebView2 не приостановил (вкладка видна/занята — повтор на следующем скане).
unsafe fn suspend_corewebview(pw: tauri::webview::PlatformWebview, app: &AppHandle, id: &str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use windows_core::Interface;

    let controller = pw.controller();
    let Ok(core) = controller.CoreWebView2() else {
        return;
    };
    let Ok(core3) = core.cast::<ICoreWebView2_3>() else {
        eprintln!("tabs: ICoreWebView2_3 недоступен — спящий режим не работает");
        return;
    };
    let app = app.clone();
    let id = id.to_string();
    let app_for_log = app.clone();
    let id_for_log = id.clone();
    let handler =
        webview2_com::TrySuspendCompletedHandler::create(Box::new(move |error, successful| {
            if error.is_err() || !successful {
                eprintln!("tabs: TrySuspend {id_for_log} не удался (error={error:?})");
                app.state::<TabManager>()
                    .set_sleeping(&app, &id_for_log, false);
            }
            Ok(())
        }));
    if let Err(e) = core3.TrySuspend(&handler) {
        eprintln!("tabs: TrySuspend {id}: {e}");
        app_for_log
            .state::<TabManager>()
            .set_sleeping(&app_for_log, &id, false);
    }
}

/// Явный Resume webview вкладки (пробуждение при активации/tabs.wake).
unsafe fn resume_corewebview(pw: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use windows_core::Interface;

    let controller = pw.controller();
    let Ok(core) = controller.CoreWebView2() else {
        return;
    };
    let Ok(core3) = core.cast::<ICoreWebView2_3>() else {
        return;
    };
    if let Err(e) = core3.Resume() {
        eprintln!("tabs: Resume: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Расписание усыпления: 0 — выключено; период скана — четверть таймаута,
    /// зажатая в 1..30 с (короткие таймауты e2e сканируются каждую секунду,
    /// длинные — не реже раза в 30 с).
    #[test]
    fn sleep_timing() {
        assert_eq!(timing_from(0), None);
        assert_eq!(
            timing_from(2),
            Some((Duration::from_secs(2), Duration::from_secs(1)))
        );
        assert_eq!(
            timing_from(300),
            Some((Duration::from_secs(300), Duration::from_secs(30)))
        );
        assert_eq!(
            timing_from(240),
            Some((Duration::from_secs(240), Duration::from_secs(30)))
        );
    }
}
