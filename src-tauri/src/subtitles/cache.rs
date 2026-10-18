//! SQLite-кэш переведённых дорожек (задача 4.2, docs/03 §7): таблица
//! `translated_tracks` в duopulse.db профиля — `(videoKey, trackId,
//! targetLang, provider) → cues`. Повторный просмотр того же видео с тем же
//! провайдером отдаёт дорожку из кэша без сети (DoD 4.2: 0 сетевых вызовов
//! перевода). Очистка — LRU по `last_used_at` (docs/03 §7): чтение освежает
//! запись, сверх лимита строк старейшие удаляются.
//!
//! Потокобезопасность — Mutex над одним Connection (паттерн HistoryStore/
//! PerfStore); обращения короткие, тяжёлый перевод идёт мимо кэша (сеть),
//! сюда попадают только точечные get/put.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use super::Cue;

/// Максимум дорожек в кэше (LRU сверх него; типичный трек ~30 КБ — потолок
/// ~4 МБ, docs/03 §7 «LRU-очистка»).
pub const MAX_ROWS: usize = 120;

/// Текущее время, unix-ms (для тестов время передаётся явно — детерминизм).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("системное время позже эпохи Unix")
        .as_millis() as i64
}

/// Хранилище переводов: duopulse.db, таблица translated_tracks.
pub struct TranslationsCache {
    conn: Mutex<Connection>,
}

impl TranslationsCache {
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

    /// In-memory хранилище (тесты).
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::connect(Connection::open_in_memory()?)
    }

    fn connect(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS translated_tracks(
                 video_key TEXT NOT NULL,
                 track_id TEXT NOT NULL,
                 target_lang TEXT NOT NULL,
                 provider TEXT NOT NULL,
                 cues TEXT NOT NULL,
                 cue_count INTEGER NOT NULL,
                 last_used_at INTEGER NOT NULL,
                 UNIQUE(video_key, track_id, target_lang, provider)
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Переведённая дорожка из кэша (None — промах); попадание освежает
    /// last_used_at (LRU). Повреждённый JSON строки — трактуется как промах.
    pub fn get(
        &self,
        video_key: &str,
        track_id: &str,
        target_lang: &str,
        provider: &str,
        now_ms: i64,
    ) -> Option<Vec<Cue>> {
        let conn = self.conn.lock().expect("translations: лок не отравлен");
        let cues: Option<String> = conn
            .query_row(
                "SELECT cues FROM translated_tracks
                 WHERE video_key=?1 AND track_id=?2 AND target_lang=?3 AND provider=?4",
                rusqlite::params![video_key, track_id, target_lang, provider],
                |row| row.get(0),
            )
            .ok();
        let cues = cues?;
        let _ = conn.execute(
            "UPDATE translated_tracks SET last_used_at=?5
             WHERE video_key=?1 AND track_id=?2 AND target_lang=?3 AND provider=?4",
            rusqlite::params![video_key, track_id, target_lang, provider, now_ms],
        );
        serde_json::from_str(&cues).ok()
    }

    /// Записать переведённую дорожку (замена при том же ключе) и подрезать
    /// LRU до MAX_ROWS. Ошибка записи не роняет перевод — кэш оптимизация.
    pub fn put(
        &self,
        video_key: &str,
        track_id: &str,
        target_lang: &str,
        provider: &str,
        cues: &[Cue],
        now_ms: i64,
    ) {
        let Ok(json) = serde_json::to_string(cues) else {
            return;
        };
        let conn = self.conn.lock().expect("translations: лок не отравлен");
        let _ = conn.execute(
            "INSERT INTO translated_tracks(video_key, track_id, target_lang, provider, cues, cue_count, last_used_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(video_key, track_id, target_lang, provider)
             DO UPDATE SET cues=excluded.cues, cue_count=excluded.cue_count,
                           last_used_at=excluded.last_used_at",
            rusqlite::params![
                video_key,
                track_id,
                target_lang,
                provider,
                json,
                cues.len() as i64,
                now_ms
            ],
        );
        self.trim(&conn, MAX_ROWS);
    }

    /// LRU-подрезка: удалить старейшие по last_used_at сверх лимита строк.
    fn trim(&self, conn: &Connection, max_rows: usize) {
        let _ = conn.execute(
            "DELETE FROM translated_tracks WHERE rowid IN (
                 SELECT rowid FROM translated_tracks
                 ORDER BY last_used_at DESC, rowid DESC LIMIT -1 OFFSET ?1
             )",
            rusqlite::params![max_rows as i64],
        );
    }

    /// Число записей (диагностика/тесты).
    pub fn len(&self) -> usize {
        self.conn
            .lock()
            .expect("translations: лок не отравлен")
            .query_row("SELECT COUNT(*) FROM translated_tracks", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cue(text: &str) -> Cue {
        Cue {
            start_ms: 1_000,
            end_ms: 2_000,
            text: text.into(),
        }
    }

    fn cache() -> TranslationsCache {
        TranslationsCache::open_in_memory().expect("память под кэш")
    }

    #[test]
    fn put_get_roundtrip_and_miss_on_other_key() {
        let c = cache();
        assert!(c.get("yt:v1", "yt:en", "ru", "deepl", 100).is_none());
        c.put(
            "yt:v1",
            "yt:en",
            "ru",
            "deepl",
            &[cue("привет"), cue("мир")],
            200,
        );
        let hit = c
            .get("yt:v1", "yt:en", "ru", "deepl", 300)
            .expect("кэш-хит");
        assert_eq!(hit.len(), 2);
        assert_eq!(hit[1].text, "мир");

        // любой другой элемент ключа — отдельная запись (промах)
        assert!(
            c.get("yt:v2", "yt:en", "ru", "deepl", 300).is_none(),
            "другое видео"
        );
        assert!(
            c.get("yt:v1", "yt:en", "es", "deepl", 300).is_none(),
            "другой язык"
        );
        assert!(
            c.get("yt:v1", "yt:en", "ru", "google", 300).is_none(),
            "другой провайдер"
        );
        assert_eq!(c.len(), 1);
    }

    #[test]
    fn put_replaces_same_key() {
        let c = cache();
        c.put("yt:v1", "yt:en", "ru", "deepl", &[cue("старый")], 100);
        c.put(
            "yt:v1",
            "yt:en",
            "ru",
            "deepl",
            &[cue("новый"), cue("набор")],
            200,
        );
        assert_eq!(c.len(), 1, "тот же ключ — одна запись");
        let hit = c
            .get("yt:v1", "yt:en", "ru", "deepl", 300)
            .expect("кэш-хит");
        assert_eq!(hit.len(), 2);
        assert_eq!(hit[0].text, "новый");
    }

    #[test]
    fn lru_trim_drops_stalest_and_get_refreshes() {
        let c = cache();
        // заполняем до лимита: треки t0..t119, last_used растёт с номером
        for i in 0..MAX_ROWS {
            c.put(
                "v",
                &format!("t{i}"),
                "ru",
                "deepl",
                &[cue("x")],
                1_000 + i as i64,
            );
        }
        assert_eq!(c.len(), MAX_ROWS);
        // t0 устарела, но её чтение освежило: теперь самая старая — t1
        assert!(c.get("v", "t0", "ru", "deepl", 100_000).is_some());
        c.put("v", "extra", "ru", "deepl", &[cue("e")], 100_100); // сверх лимита → LRU режет t1
        assert!(
            c.get("v", "t1", "ru", "deepl", 100_200).is_none(),
            "t1 вытеснена"
        );
        assert!(
            c.get("v", "t0", "ru", "deepl", 100_200).is_some(),
            "t0 жива (была прочитана)"
        );
        assert!(c.get("v", "t2", "ru", "deepl", 100_200).is_some());
        assert!(c.get("v", "extra", "ru", "deepl", 100_200).is_some());
        assert_eq!(c.len(), MAX_ROWS);
    }

    #[test]
    fn corrupted_row_is_miss_not_panic() {
        let c = cache();
        c.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO translated_tracks VALUES('v','t','ru','deepl','не json',1,1)",
                [],
            )
            .unwrap();
        assert!(c.get("v", "t", "ru", "deepl", 10).is_none());
    }

    #[test]
    fn open_creates_table_in_file_db() {
        let dir = std::env::temp_dir().join(format!("duopulse-trcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = TranslationsCache::open(&dir).expect("открыть файловую базу");
        assert!(c.is_empty());
        c.put("v", "t", "ru", "deepl", &[cue("x")], now_ms());
        drop(c);
        // переоткрытие — данные на месте (персистентность между просмотрами)
        let c2 = TranslationsCache::open(&dir).expect("переоткрыть");
        assert!(c2.get("v", "t", "ru", "deepl", now_ms()).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
