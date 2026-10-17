//! Сервис состояния субтитров (задача 3.7, docs/03 §8): кэш по вкладкам
//! последних сообщений content-слоя — детект видео («video»), список дорожек
//! адаптера («tracks», полный: базовые + переводы tlang), применённый набор с
//! флагом показа/сдвигом/стилем («set-state»). Источник ответа
//! subtitles.list_tracks (панель читает снапшот активной вкладки) и данных
//! событий subtitles:tracks_ready / subtitles:set_applied для кнопки «duo» и
//! панели настроек набора. Сообщения приходит WebMessage'ми (main.rs);
//! навигация вкладки сбрасывает её состояние (до первого сообщения нового
//! документа), закрытие — удаляет запись.
//!
//! Content-слой остаётся исполнителем (часы, показ, загрузка дорожек):
//! сервис только зеркало его состояния для UI, команда субтитров — eval в
//! активную вкладку (паттерн subtitles.set_offset, задача 3.5).

use std::collections::HashMap;
use std::sync::Mutex;

use schemars::JsonSchema;
use serde::Serialize;

/// Базовая дорожка из player-ответа платформы (зеркало BaseTrackInfo
/// content-адаптера, docs/03 §3.1).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct BaseTrackInfo {
    pub id: String,
    pub lang: String,
    /// manual | asr (ручная или распознанная).
    pub kind: String,
    /// Отображаемое имя (локализовано платформой).
    pub name: String,
    /// Дорожка языка оригинала (audioTracks.original).
    pub original: bool,
    /// Платформа разрешает машинный перевод (tlang) этой дорожки.
    pub translatable: bool,
}

/// Язык машинного перевода (tlang), доступный для базовых дорожек.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslationLangInfo {
    pub lang: String,
    pub name: String,
}

/// Дорожка применённого набора (зеркало set-state content-слоя): панель
/// показывает состав/порядок, кнопка «duo» — количество (выкл/1/дуо/три).
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppliedTrackInfo {
    pub id: String,
    pub lang: String,
    /// youtube | file | translate | test (docs/03 §6).
    pub source: String,
    /// Отображаемое имя (имя платформы/слаг файла).
    pub name: String,
    /// original | translation.
    pub role: String,
}

/// Стиль плашки (docs/03 §6 SubtitleStyle): панель редактирует, оверлей
/// применяет; здесь — последнее сообщённое значение.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SubtitlesStyleInfo {
    /// Масштаб кегля, %: 75–300 (docs/03 §5).
    pub font_scale_pct: u32,
    /// bottom | top.
    pub position: String,
    /// Отступ от края видео, % высоты.
    pub margin_pct: u32,
    /// Непрозрачность подложки, 0–1 (гайд 06 §6).
    pub plate_opacity: f64,
}

impl Default for SubtitlesStyleInfo {
    fn default() -> Self {
        Self {
            font_scale_pct: 100,
            position: "bottom".to_string(),
            margin_pct: 6,
            plate_opacity: 0.78,
        }
    }
}

/// Состояние субтитров одной вкладки (default — видео не найдено, показ
/// включён: флаг управляет показом последнего набора, docs/03 §8 п.2).
#[derive(Debug, Clone, Serialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct TabSubtitles {
    /// Ключ текущего видео (None — видео не детектировано/ушло).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_key: Option<String>,
    /// Адаптер платформы дал список дорожек (кнопка «duo» видна).
    pub can_tracks: bool,
    /// Показ включён (Alt+D/панель; при false набор помнят обе стороны).
    pub enabled: bool,
    /// Применённый набор (до 3 дорожек, порядок = порядок строк).
    pub tracks: Vec<AppliedTrackInfo>,
    /// Полный список базовых дорожек адаптера (пуст — не YouTube/не получен).
    pub base: Vec<BaseTrackInfo>,
    /// Доступные переводы (tlang).
    pub translations: Vec<TranslationLangInfo>,
    /// Сдвиг показа, мс (±10 с, docs/03 §4).
    pub offset_ms: i64,
    /// Стиль плашки.
    pub style: SubtitlesStyleInfo,
}

impl TabSubtitles {
    /// Начальное состояние вкладки: включено, пусто (до сообщений документа).
    pub(crate) fn fresh() -> Self {
        Self {
            enabled: true,
            ..Self::default()
        }
    }
}

/// Кэш состояния по вкладкам (ключ — id webview-вкладки).
#[derive(Default)]
pub struct SubtitlesService {
    tabs: Mutex<HashMap<String, TabSubtitles>>,
}

impl SubtitlesService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Детект/смена видео (сообщение «video»): список дорожек прошлого видео
    /// не актуален — чистим (свежий придёт «tracks»). Применённый набор/флаг
    /// показа НЕ трогаем: content-слой шлёт «set-state» ДО «video» (набор
    /// восстановлен из памяти по videoKey либо уже пуст) — оно уже актуально.
    pub fn on_video(&self, tab: &str, video_key: &str, can_tracks: bool) -> TabSubtitles {
        let mut tabs = self.tabs.lock().expect("subtitles: лок не отравлен");
        let st = tabs
            .entry(tab.to_string())
            .or_insert_with(TabSubtitles::fresh);
        st.video_key = Some(video_key.to_string());
        st.can_tracks = can_tracks;
        st.base.clear();
        st.translations.clear();
        st.clone()
    }

    /// Список дорожек адаптера (сообщение «tracks»): храним целиком — панель
    /// выбирает из него языки/переводы.
    pub fn on_tracks(
        &self,
        tab: &str,
        video_key: &str,
        base: Vec<BaseTrackInfo>,
        translations: Vec<TranslationLangInfo>,
    ) -> TabSubtitles {
        let mut tabs = self.tabs.lock().expect("subtitles: лок не отравлен");
        let st = tabs
            .entry(tab.to_string())
            .or_insert_with(TabSubtitles::fresh);
        st.video_key = Some(video_key.to_string());
        st.can_tracks = !base.is_empty();
        st.base = base;
        st.translations = translations;
        st.clone()
    }

    /// Состояние набора (сообщение «set-state»): состав/показ/сдвиг/стиль.
    /// Список дорожек и can_tracks сообщение не несёт (их знают «video»/
    /// «tracks») — сохраняем; смена videoKey означает смену видео — прошлый
    /// список не актуален (e2e 3.7 ловил: панель теряла пресеты после дропа).
    pub fn on_set_state(&self, tab: &str, state: TabSubtitles) -> TabSubtitles {
        let mut tabs = self.tabs.lock().expect("subtitles: лок не отравлен");
        let st = tabs
            .entry(tab.to_string())
            .or_insert_with(TabSubtitles::fresh);
        if st.video_key != state.video_key {
            st.base.clear();
            st.translations.clear();
            st.can_tracks = false;
        }
        st.video_key = state.video_key.clone();
        st.enabled = state.enabled;
        st.tracks = state.tracks;
        st.offset_ms = state.offset_ms;
        st.style = state.style;
        st.clone()
    }

    /// Новая навигация вкладки (on_page_load Started): прошлый документ
    /// ушёл — состояние чистое до первого сообщения нового.
    pub fn reset_tab(&self, tab: &str) {
        self.tabs
            .lock()
            .expect("subtitles: лок не отравлен")
            .insert(tab.to_string(), TabSubtitles::fresh());
    }

    /// Вкладка закрыта — запись больше не нужна.
    pub fn remove_tab(&self, tab: &str) {
        self.tabs
            .lock()
            .expect("subtitles: лок не отравлен")
            .remove(tab);
    }

    /// Снапшот состояния вкладки (нет записи — начальное: без видео).
    pub fn snapshot(&self, tab: &str) -> TabSubtitles {
        self.tabs
            .lock()
            .expect("subtitles: лок не отравлен")
            .get(tab)
            .cloned()
            .unwrap_or_else(TabSubtitles::fresh)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn applied(id: &str) -> AppliedTrackInfo {
        AppliedTrackInfo {
            id: id.to_string(),
            lang: "en".to_string(),
            source: "youtube".to_string(),
            name: id.to_string(),
            role: "original".to_string(),
        }
    }

    #[test]
    fn snapshot_unknown_tab_is_fresh_enabled() {
        let svc = SubtitlesService::new();
        let st = svc.snapshot("tab-1");
        assert!(st.video_key.is_none());
        assert!(!st.can_tracks);
        assert!(st.tracks.is_empty());
        assert!(st.enabled); // флаг показа включён — «выключено» = явное сообщение
    }

    #[test]
    fn on_video_clears_past_list_keeps_reported_set() {
        let svc = SubtitlesService::new();
        let mut reported = TabSubtitles::fresh();
        reported.tracks = vec![applied("yt:en")]; // восстановлен из памяти по videoKey
        reported.video_key = Some("yt:aaa".into());
        reported.enabled = false; // показ выключен — набор помнят
        svc.on_set_state("t", reported);
        let st = svc.on_video("t", "yt:aaa", true);
        assert_eq!(st.video_key.as_deref(), Some("yt:aaa"));
        // список прошлого видео не актуален — чист; набор/флаг — как сообщено
        assert!(st.base.is_empty() && st.translations.is_empty());
        assert_eq!(st.tracks.len(), 1);
        assert!(!st.enabled);
    }

    #[test]
    fn set_state_merges_keeping_adapter_list() {
        let svc = SubtitlesService::new();
        svc.on_tracks(
            "t",
            "yt:aaa",
            vec![BaseTrackInfo {
                id: "yt:en".into(),
                lang: "en".into(),
                kind: "manual".into(),
                name: "English".into(),
                original: true,
                translatable: true,
            }],
            vec![TranslationLangInfo {
                lang: "ru".into(),
                name: "Русский".into(),
            }],
        );
        // set-state того же видео (дроп файла): список адаптера и can_tracks
        // сохраняются — панель строит пресеты из живого списка (e2e 3.7).
        let mut reported = TabSubtitles::fresh();
        reported.video_key = Some("yt:aaa".into());
        reported.enabled = false; // Alt+D выключил — набор помним
        reported.tracks = vec![applied("yt:en"), applied("yt:en+ru")];
        reported.offset_ms = 500;
        let echoed = svc.on_set_state("t", reported);
        assert!(!echoed.enabled);
        assert_eq!(echoed.tracks.len(), 2);
        assert_eq!(echoed.offset_ms, 500);
        assert_eq!(svc.snapshot("t").tracks.len(), 2);
        assert_eq!(echoed.base.len(), 1, "список адаптера пережил set-state");
        assert!(echoed.can_tracks);

        // set-state другого видео: прошлый список не актуален — чист.
        let mut next = TabSubtitles::fresh();
        next.video_key = Some("yt:bbb".into());
        let echoed2 = svc.on_set_state("t", next);
        assert!(echoed2.base.is_empty() && echoed2.translations.is_empty());
        assert!(!echoed2.can_tracks);
    }

    #[test]
    fn reset_and_remove_tab() {
        let svc = SubtitlesService::new();
        let mut st = TabSubtitles::fresh();
        st.tracks = vec![applied("yt:en")];
        st.video_key = Some("yt:aaa".into());
        svc.on_set_state("t", st);
        svc.reset_tab("t");
        assert!(svc.snapshot("t").tracks.is_empty());
        assert!(svc.snapshot("t").enabled);
        svc.remove_tab("t");
        assert!(svc.snapshot("t").video_key.is_none());
    }
}
