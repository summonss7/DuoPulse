//! SQLite-кэш ASR-дорожек (карточка duopulse-060): таблица `asr_tracks` в
//! duopulse.db профиля — `(videoKey, engine, lang) → cues`. Повторный просмотр
//! того же видео тем же движком отдаёт дорожку из кэша без скачивания аудио и
//! транскрипции. Очистка — LRU по `last_used_at` (по образцу translated_tracks,
//! задача 4.2): чтение освежает запись, сверх лимита старейшие удаляются.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::subtitles::Cue;

/// Строка кэша для экспорта/импорта профиля (задача 5.1).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AsrTrackRow {
    pub video_key: String,
    /// Идентификатор движка: "local:base" / "openai:whisper-1" — смена модели
    /// облака/размера локальной модели = другая дорожка.
    pub engine: String,
    pub lang: String,
    pub cues: String,
    pub cue_count: i64,
    pub last_used_at: i64,
}

/// Максимум ASR-дорожек в кэше (LRU сверх него; типичный трек ~30 КБ —
/// потолок ~4 МБ).
pub const MAX_ROWS: usize = 120;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("системное время позже эпохи Unix")
        .as_millis() as i64
}

/// Хранилище ASR-дорожек: duopulse.db, таблица asr_tracks.
pub struct AsrCache {
    conn: Mutex<Connection>,
}

impl AsrCache {
    /// Открыть/создать таблицу в duopulse.db профиля (docs/02 §8).
    pub fn open(dir: &Path) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(dir).map_err(|e| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(format!(
                "создать каталог профиля {}: {e}",
                dir.display()
            ))))
        })?;
        Self::connect(Connection::open(dir.join("duopulse.db"))?)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::connect(Connection::open_in_memory()?)
    }

    fn connect(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS asr_tracks(
                 video_key TEXT NOT NULL,
                 engine TEXT NOT NULL,
                 lang TEXT NOT NULL,
                 cues TEXT NOT NULL,
                 cue_count INTEGER NOT NULL,
                 last_used_at INTEGER NOT NULL,
                 UNIQUE(video_key, engine, lang)
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Дорожка из кэша (None — промах): cues и язык записи (для реплая — при
    /// автоопределении повторный просмотр узнаёт язык той же дорожки).
    /// Попадание освежает last_used_at (LRU). Пустой `lang` (автоопределение
    /// при транскрипции) — последняя запись этой пары (videoKey, engine):
    /// повторный просмотр получает ту же дорожку, что и первый.
    /// Повреждённый JSON строки — трактуется как промах.
    pub fn get(
        &self,
        video_key: &str,
        engine: &str,
        lang: &str,
        now_ms: i64,
    ) -> Option<(Vec<Cue>, String)> {
        let conn = self.conn.lock().expect("asr: лок не отравлен");
        let row: Option<(String, String)> = if lang.is_empty() {
            conn.query_row(
                "SELECT cues, lang FROM asr_tracks
                 WHERE video_key=?1 AND engine=?2
                 ORDER BY last_used_at DESC, rowid DESC LIMIT 1",
                rusqlite::params![video_key, engine],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
        } else {
            conn.query_row(
                "SELECT cues, lang FROM asr_tracks
                 WHERE video_key=?1 AND engine=?2 AND lang=?3",
                rusqlite::params![video_key, engine, lang],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok()
        };
        let (cues, stored_lang) = row?;
        let _ = conn.execute(
            "UPDATE asr_tracks SET last_used_at=?4
             WHERE video_key=?1 AND engine=?2 AND lang=?3",
            rusqlite::params![video_key, engine, stored_lang, now_ms],
        );
        Some((serde_json::from_str(&cues).ok()?, stored_lang))
    }

    /// Записать дорожку (замена при том же ключе) и подрезать LRU. Ошибка
    /// записи не роняет конвейер — кэш оптимизация.
    pub fn put(&self, video_key: &str, engine: &str, lang: &str, cues: &[Cue], now_ms: i64) {
        let Ok(json) = serde_json::to_string(cues) else {
            return;
        };
        let conn = self.conn.lock().expect("asr: лок не отравлен");
        let _ = conn.execute(
            "INSERT INTO asr_tracks(video_key, engine, lang, cues, cue_count, last_used_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(video_key, engine, lang)
             DO UPDATE SET cues=excluded.cues, cue_count=excluded.cue_count,
                           last_used_at=excluded.last_used_at",
            rusqlite::params![video_key, engine, lang, json, cues.len() as i64, now_ms],
        );
        self.trim(&conn, MAX_ROWS);
    }

    fn trim(&self, conn: &Connection, max_rows: usize) {
        let _ = conn.execute(
            "DELETE FROM asr_tracks WHERE rowid IN (
                 SELECT rowid FROM asr_tracks
                 ORDER BY last_used_at DESC, rowid DESC LIMIT -1 OFFSET ?1
             )",
            rusqlite::params![max_rows as i64],
        );
    }

    /// Число записей (диагностика/тесты).
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.conn
            .lock()
            .expect("asr: лок не отравлен")
            .query_row("SELECT COUNT(*) FROM asr_tracks", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    // --- экспорт/импорт профиля (задача 5.1) -----------------------------------

    pub fn dump(&self) -> Result<Vec<AsrTrackRow>, String> {
        let conn = self.conn.lock().expect("asr: лок не отравлен");
        let mut stmt = conn
            .prepare(
                "SELECT video_key, engine, lang, cues, cue_count, last_used_at
                 FROM asr_tracks ORDER BY last_used_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(AsrTrackRow {
                    video_key: r.get(0)?,
                    engine: r.get(1)?,
                    lang: r.get(2)?,
                    cues: r.get(3)?,
                    cue_count: r.get(4)?,
                    last_used_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// Импорт строк (переезд профиля): upsert по ключу, битый cues-JSON —
    /// пропуск. Возвращает число записанных.
    pub fn import_rows(&self, rows: &[AsrTrackRow]) -> Result<u32, String> {
        let conn = self.conn.lock().expect("asr: лок не отравлен");
        let mut written = 0u32;
        for row in rows {
            if row.video_key.is_empty() || row.engine.is_empty() {
                continue;
            }
            if serde_json::from_str::<Vec<Cue>>(&row.cues).is_err() {
                continue;
            }
            conn.execute(
                "INSERT INTO asr_tracks(video_key, engine, lang, cues, cue_count, last_used_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(video_key, engine, lang)
                 DO UPDATE SET cues=excluded.cues, cue_count=excluded.cue_count,
                               last_used_at=excluded.last_used_at",
                rusqlite::params![
                    row.video_key,
                    row.engine,
                    row.lang,
                    row.cues,
                    row.cue_count,
                    row.last_used_at
                ],
            )
            .map_err(|e| e.to_string())?;
            written += 1;
        }
        self.trim(&conn, MAX_ROWS);
        Ok(written)
    }

    /// Очистить кэш целиком (приватность). Возвращает число удалённых строк.
    pub fn clear(&self) -> usize {
        self.conn
            .lock()
            .expect("asr: лок не отравлен")
            .execute("DELETE FROM asr_tracks", [])
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(text: &str, start: i64) -> Cue {
        Cue {
            start_ms: start,
            end_ms: start + 1_800,
            text: text.into(),
        }
    }

    fn cache() -> AsrCache {
        AsrCache::open_in_memory().expect("память под кэш")
    }

    #[test]
    fn put_get_roundtrip_and_miss_on_other_key() {
        let c = cache();
        assert!(c.get("yt:v1", "local:base", "en", 100).is_none());
        c.put(
            "yt:v1",
            "local:base",
            "en",
            &[cue("hello", 0), cue("world", 2_000)],
            200,
        );
        let (hit, lang) = c.get("yt:v1", "local:base", "en", 300).expect("кэш-хит");
        assert_eq!(lang, "en");
        assert_eq!(hit.len(), 2);
        assert_eq!(hit[1].text, "world");
        assert!(
            c.get("yt:v2", "local:base", "en", 300).is_none(),
            "другое видео"
        );
        assert!(
            c.get("yt:v1", "local:small", "en", 300).is_none(),
            "другая модель"
        );
        assert!(
            c.get("yt:v1", "local:base", "ru", 300).is_none(),
            "другой язык"
        );
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn auto_lang_lookup_returns_last_track_with_its_lang() {
        // транскрипция с lang="" (авто) пишет под определённый движком язык;
        // повтор с lang="" находит ту же дорожку и её язык — реплай content-слоя
        // даёт тот же id asr:<lang>, дорожка не дублируется
        let c = cache();
        c.put("yt:v1", "local:whisper", "en", &[cue("hi", 0)], 100);
        let (hit, lang) = c
            .get("yt:v1", "local:whisper", "", 200)
            .expect("any-lang хит");
        assert_eq!(lang, "en");
        assert_eq!(hit.len(), 1);
        // авто-lookup не видит чужие движки/видео
        assert!(c.get("yt:v2", "local:whisper", "", 200).is_none());
        // точный lookup по коду тоже работает
        assert!(c.get("yt:v1", "local:whisper", "en", 300).is_some());
    }

    #[test]
    fn lru_trim_and_get_refreshes() {
        let c = cache();
        for i in 0..MAX_ROWS {
            c.put(
                "v",
                "local:base",
                &format!("l{i}"),
                &[cue("x", 0)],
                1_000 + i as i64,
            );
        }
        assert_eq!(c.len(), MAX_ROWS);
        assert!(
            c.get("v", "local:base", "l0", 100_000).is_some(),
            "освежаем l0"
        );
        c.put("v", "local:base", "extra", &[cue("e", 0)], 100_100);
        assert!(
            c.get("v", "local:base", "l1", 100_200).is_none(),
            "l1 вытеснена"
        );
        assert!(c.get("v", "local:base", "l0", 100_200).is_some(), "l0 жива");
        assert_eq!(c.len(), MAX_ROWS);
    }

    #[test]
    fn corrupted_row_is_miss_and_dump_import_clear() {
        let c = cache();
        c.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO asr_tracks VALUES('v','local:base','en','не json',1,1)",
                [],
            )
            .unwrap();
        assert!(c.get("v", "local:base", "en", 10).is_none());
        c.clear();
        assert!(c.is_empty());

        let src = cache();
        src.put("yt:v1", "openai:whisper-1", "ru", &[cue("привет", 0)], 100);
        let rows = src.dump().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(c.import_rows(&rows).unwrap(), 1);
        assert!(c.get("yt:v1", "openai:whisper-1", "ru", 200).is_some());
        // битый JSON — строка пропущена, импорт не падает
        let mut broken = rows[0].clone();
        broken.cues = "не json".into();
        broken.lang = "de".into();
        assert_eq!(c.import_rows(std::slice::from_ref(&broken)).unwrap(), 0);
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn open_creates_table_in_file_db() {
        let dir = std::env::temp_dir().join(format!("duopulse-asrcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = AsrCache::open(&dir).expect("открыть файловую базу");
        c.put("v", "local:base", "en", &[cue("x", 0)], now_ms());
        drop(c);
        let c2 = AsrCache::open(&dir).expect("переоткрыть");
        assert!(c2.get("v", "local:base", "en", now_ms()).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
