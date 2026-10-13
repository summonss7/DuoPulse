//! Сессия вкладок (задача 1.6, docs/04 §1.3 «отложенная активация»):
//! список вкладок (URL, заголовок, активная) сохраняется в профиль при
//! каждом изменении и при выходе из приложения; на старте по сессии
//! восстанавливается весь таб-бар, но webview создаётся только для активной
//! вкладки — остальные материализуются при первом переключении (лениво).
//!
//! Хранение (docs/02 §8): `%APPDATA%\DuoPulse\profile\session.json`;
//! запись атомарна (tmp-файл + rename поверх) — прерывание не оставляет
//! битой сессии. При DUOPULSE_START_URL (e2e-стенды) сессия не читается
//! и не пишется — детерминированный старт (см. tabs::init /
//! TabManager::persist_session).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Потолок вкладок в сессии: файл не растёт неограниченно при злоупотреблении.
const MAX_TABS: usize = 200;

/// Одна вкладка сессии: канонический URL и последний известный заголовок
/// (титул таб-бара до материализации webview).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionTab {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Снимок сессии: вкладки в порядке таб-бара + индекс активной.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Session {
    pub tabs: Vec<SessionTab>,
    pub active: Option<usize>,
    /// Время сохранения, unix-ms (диагностика; на восстановление не влияет).
    pub saved_at: i64,
}

pub(crate) fn session_path(dir: &Path) -> PathBuf {
    dir.join("session.json")
}

/// Атомарная запись: во временный файл, затем rename поверх прежней сессии
/// (std::fs::rename на Windows заменяет существующий файл).
pub(crate) fn save(dir: &Path, session: &Session) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(session).map_err(std::io::Error::other)?;
    let tmp = dir.join("session.json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, session_path(dir))
}

/// Чтение сессии; None — файла нет, он повреждён или валидных вкладок не
/// осталось. URL, не разбираемые tauri::Url, отбрасываются; active зажимается
/// в границы списка (None/выход за край → первая вкладка).
pub(crate) fn load(dir: &Path) -> Option<Session> {
    let raw = std::fs::read_to_string(session_path(dir)).ok()?;
    let session: Session = serde_json::from_str(&raw).ok()?;
    let tabs: Vec<SessionTab> = session
        .tabs
        .into_iter()
        .filter(|t| tauri::Url::parse(&t.url).is_ok())
        .take(MAX_TABS)
        .collect();
    if tabs.is_empty() {
        return None;
    }
    let active = match session.active {
        Some(i) if i < tabs.len() => Some(i),
        _ => Some(0),
    };
    Some(Session {
        tabs,
        active,
        saved_at: session.saved_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("duopulse-session-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample() -> Session {
        Session {
            tabs: vec![
                SessionTab {
                    url: "https://www.youtube.com/".into(),
                    title: Some("YouTube".into()),
                },
                SessionTab {
                    url: "duopulse://history".into(),
                    title: None,
                },
            ],
            active: Some(0),
            saved_at: 1_760_300_000_000,
        }
    }

    #[test]
    fn roundtrip() {
        let dir = tmp_dir("roundtrip");
        save(&dir, &sample()).unwrap();
        assert_eq!(load(&dir), Some(sample()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_or_corrupt_or_empty_is_none() {
        let dir = tmp_dir("none");
        assert_eq!(load(&dir), None); // файла нет
        std::fs::write(session_path(&dir), "{ мусор").unwrap();
        assert_eq!(load(&dir), None); // не JSON
        std::fs::write(session_path(&dir), r#"{"tabs":[],"active":3,"savedAt":1}"#).unwrap();
        assert_eq!(load(&dir), None); // пустой список — сессии нет
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn invalid_urls_filtered_and_active_clamped() {
        let dir = tmp_dir("clamp");
        let session = Session {
            tabs: vec![
                SessionTab {
                    url: "https://example.com/".into(),
                    title: Some("Пример".into()),
                },
                SessionTab {
                    url: "не url".into(),
                    title: None,
                },
                SessionTab {
                    url: "http://127.0.0.1:8898/p7".into(),
                    title: Some("Страница 7".into()),
                },
            ],
            active: Some(9),
            saved_at: 0,
        };
        save(&dir, &session).unwrap();
        let loaded = load(&dir).expect("валидые вкладки остаются");
        assert_eq!(
            loaded
                .tabs
                .iter()
                .map(|t| t.url.as_str())
                .collect::<Vec<_>>(),
            vec!["https://example.com/", "http://127.0.0.1:8898/p7"]
        );
        assert_eq!(loaded.active, Some(0)); // active за краем → первая
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tabs_capped() {
        let dir = tmp_dir("cap");
        let session = Session {
            tabs: (0..300)
                .map(|i| SessionTab {
                    url: format!("https://example.com/{i}"),
                    title: None,
                })
                .collect(),
            active: Some(299),
            saved_at: 0,
        };
        save(&dir, &session).unwrap();
        let loaded = load(&dir).expect("сессия читается");
        assert_eq!(loaded.tabs.len(), MAX_TABS);
        // active=299 указывал за край обрезанного списка — зажимается к первой
        assert_eq!(loaded.active, Some(0));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
