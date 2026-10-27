//! История и закладки (задача 1.4, docs/05 §1 src/history/, хранение —
//! docs/02 §8): SQLite-файл `duopulse.db` в профиле пользователя
//! (`%APPDATA%\DuoPulse\profile\`).
//!
//! Схема: таблицы `visits` (визиты) и `bookmarks` (закладки, url — ключ) +
//! FTS5-индекс `search` для полнотекстового поиска (омnibox-подсказки и поиск
//! на странице управления). FTS-строка хранит (title, url, source, ref= id
//! строки исходной таблицы); вставка/правка/удаление держат индекс в sync
//! с таблицами в одной транзакции.
//!
//! Поиск — каждый токен запроса префиксный (для «you» находится «youtube»),
//! токенизатор unicode61 (латиница и кириллица), ранжирование bm25; пустой
//! запрос `search` отдаёт закладки (подсказки на фокус omnibox).
//!
//! Запись визитов: Core сам вызывает `visit` из on_page_load вкладок
//! (src/tabs/, только http/https); дубли подавляются — повторный заход на
//! тот же URL в пределах DEDUP_MS обновляет время/заголовок, а не плодит
//! строки (заголовок страницы приходит позже on_title → `note_title`).

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// HistoryBookmark — тип контракта bridge; реэкспорт для settings/profile.rs.
pub use crate::bridge::HistoryBookmark;
use crate::bridge::{HistoryEntry, HistoryHit, HistorySource};

/// Строка визита для экспорта/импорта профиля (задача 5.1, settings/profile.rs):
/// поля таблицы visits без внутреннего id.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VisitRow {
    pub url: String,
    pub title: String,
    pub visited_at: i64,
}

/// Повторный визит того же URL в этом окне — не новый визит: обновляются
/// время и заголовок последнего (защита от F5/миграций заголовка).
const DEDUP_MS: i64 = 60_000;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("системное время позже эпохи Unix")
        .as_millis() as i64
}

/// Локальный/петлевой хост: прогревать DNS/соединения к нему бессмысленно
/// (фильтр top_hosts, задача 2.4). Проверка по префиксам — фильтр подсказок,
/// не безопасность.
fn host_is_local(host: &str) -> bool {
    if host.is_empty()
        || host == "localhost"
        || host == "::1"
        || host == "[::1]"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return true;
    }
    // IPv4-литерал: петля и приватные диапазоны RFC1918/link-local.
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    {
        let o: Vec<u32> = parts.iter().map(|p| p.parse().unwrap_or(0)).collect();
        return o[0] == 127
            || o[0] == 10
            || (o[0] == 192 && o[1] == 168)
            || (o[0] == 169 && o[1] == 254)
            || (o[0] == 172 && (16..=31).contains(&o[1]));
    }
    false
}

/// Хранилище истории и закладок: SQLite в профиле (потокобезопасно через
/// Mutex; все обращения — короткие, включая транзакции).
pub struct HistoryStore {
    conn: Mutex<Connection>,
}

impl HistoryStore {
    /// Открыть/создать `duopulse.db` в каталоге профиля (docs/02 §8).
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
    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::connect(Connection::open_in_memory()?)
    }

    fn connect(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "busy_timeout", 5000)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS visits(
                 id INTEGER PRIMARY KEY,
                 url TEXT NOT NULL,
                 title TEXT NOT NULL DEFAULT '',
                 visited_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_visits_url_time ON visits(url, visited_at DESC);
             CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(visited_at);
             CREATE TABLE IF NOT EXISTS bookmarks(
                 id INTEGER PRIMARY KEY,
                 url TEXT NOT NULL UNIQUE,
                 title TEXT NOT NULL DEFAULT '',
                 added_at INTEGER NOT NULL
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
                 title, url, source UNINDEXED, ref UNINDEXED
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Записать посещение (дедуп — см. DEDUP_MS).
    pub fn visit(&self, url: &str, title: &str) -> Result<(), String> {
        self.visit_at(url, title, now_ms())
    }

    /// Запись визита с заданным временем (внутреннее; тесты управляют
    /// временем для проверки дедупа и диапазонов удаления).
    fn visit_at(&self, url: &str, title: &str, now: i64) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let dup: Option<(i64, String)> = tx
            .query_row(
                "SELECT id, title FROM visits WHERE url = ?1 AND visited_at >= ?2 \
                 ORDER BY visited_at DESC LIMIT 1",
                rusqlite::params![url, now - DEDUP_MS],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(err_sql)?;
        match dup {
            // SQLite-документированное поведение bare-колонок: title/id берутся
            // из строки последнего визита — достаточно для дедупа по времени.
            Some((id, old_title)) => {
                tx.execute(
                    "UPDATE visits SET visited_at = ?1, title = ?2 WHERE id = ?3",
                    rusqlite::params![now, title, id],
                )
                .map_err(err_sql)?;
                if old_title != title {
                    tx.execute(
                        "UPDATE search SET title = ?1 WHERE source = 'history' AND ref = ?2",
                        rusqlite::params![title, id],
                    )
                    .map_err(err_sql)?;
                }
            }
            None => {
                tx.execute(
                    "INSERT INTO visits(url, title, visited_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![url, title, now],
                )
                .map_err(err_sql)?;
                let id = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO search(title, url, source, ref) VALUES (?1, ?2, 'history', ?3)",
                    rusqlite::params![title, url, id],
                )
                .map_err(err_sql)?;
            }
        }
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Заголовок страницы пришёл после записи визита (on_title) — обновить
    /// последний визит этого URL и индекс.
    pub fn note_title(&self, url: &str, title: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let changed = tx
            .execute(
                "UPDATE visits SET title = ?1
                 WHERE title != ?1 AND id = (
                     SELECT id FROM visits WHERE url = ?2 ORDER BY visited_at DESC LIMIT 1
                 )",
                rusqlite::params![title, url],
            )
            .map_err(err_sql)?;
        if changed > 0 {
            tx.execute(
                "UPDATE search SET title = ?1
                 WHERE source = 'history' AND ref IN (SELECT id FROM visits WHERE url = ?2)",
                rusqlite::params![title, url],
            )
            .map_err(err_sql)?;
        }
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Полнотекстовый поиск подсказок omnibox: каждый токен запроса —
    /// префиксный, ранжирование bm25. Пустой запрос — закладки (подсказки
    /// на фокус).
    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<HistoryHit>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let limit = limit.clamp(1, 20) as i64;
        let q = query.trim();
        if q.is_empty() {
            // закладки по свежести добавления, без FTS
            let mut stmt = conn
                .prepare("SELECT url, title FROM bookmarks ORDER BY added_at DESC LIMIT ?1")
                .map_err(err_sql)?;
            let hits = stmt
                .query_map([limit], |r| {
                    Ok(HistoryHit {
                        source: HistorySource::Bookmark,
                        url: r.get(0)?,
                        title: r.get(1)?,
                    })
                })
                .map_err(err_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err_sql)?;
            return Ok(hits);
        }
        let Some(expr) = match_expr(q) else {
            return Ok(Vec::new());
        };
        let mut stmt = conn
            .prepare(
                "SELECT source, url, title FROM search
                 WHERE search MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(err_sql)?;
        let hits = stmt
            .query_map(rusqlite::params![expr, limit], |r| {
                Ok(HistoryHit {
                    source: HistorySource::from_db(&r.get::<_, String>(0)?),
                    url: r.get(1)?,
                    title: r.get(2)?,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        Ok(hits)
    }

    /// Топ-хосты истории (задача 2.4, docs/04 §1.4 — прогрев DNS/preconnect):
    /// адреса визитов за последние `window_days` дней, сгруппированные по
    /// хосту (http/https, «www.» снят); хосты с `min_visits` визитами и
    /// более, частые первыми, `limit` штук. Группировка в Rust — SQL не
    /// умеет хост из URL. Локальные адреса не греем (бесполезно), не-http(s)
    /// схемы (duopulse://, ftp) не считаются.
    pub fn top_hosts(&self, limit: usize, window_days: i64, min_visits: u32) -> Vec<String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let since = now_ms() - window_days * 24 * 60 * 60 * 1000;
        let Ok(mut stmt) = conn
            .prepare(
                "SELECT url FROM visits WHERE visited_at >= ?1 \
                 ORDER BY visited_at DESC LIMIT 5000",
            )
            .map_err(err_sql)
        else {
            return vec![];
        };
        let Ok(rows) = stmt
            .query_map(rusqlite::params![since], |r| r.get::<_, String>(0))
            .map_err(err_sql)
        else {
            return vec![];
        };
        let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for url in rows.flatten() {
            let Ok(parsed) = tauri::Url::parse(&url) else {
                continue;
            };
            if !matches!(parsed.scheme(), "http" | "https") {
                continue;
            }
            let Some(host) = parsed.host_str() else {
                continue;
            };
            let host = host.trim_start_matches("www.").to_lowercase();
            if host_is_local(&host) {
                continue;
            }
            *counts.entry(host).or_insert(0) += 1;
        }
        let mut top: Vec<(String, u32)> = counts
            .into_iter()
            .filter(|(_, c)| *c >= min_visits)
            .collect();
        top.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        top.truncate(limit);
        top.into_iter().map(|(host, _)| host).collect()
    }

    /// История для страницы управления: агрегат по URL (последний визит,
    /// заголовок последнего визита, число визитов), свежие первыми.
    /// Непустой query — FTS-фильтр по заголовку/адресу. total — число
    /// подходящих URL (для пагинации).
    pub fn list(
        &self,
        query: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<HistoryEntry>, u32), String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let limit = limit.clamp(1, 500) as i64;
        let offset = offset.min(i32::MAX as u32) as i64;
        let filter = match match_expr(query.trim()) {
            Some(expr) => format!(
                " WHERE v.id IN (SELECT ref FROM search WHERE search MATCH '{}' \
                 AND source = 'history')",
                expr.replace('\'', "''")
            ),
            None => String::new(),
        };
        let sql_entries = format!(
            "SELECT v.url, v.title, MAX(v.visited_at), COUNT(*)
             FROM visits v{filter}
             GROUP BY v.url
             ORDER BY MAX(v.visited_at) DESC, v.url
             LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql_entries).map_err(err_sql)?;
        let entries = stmt
            .query_map(rusqlite::params![limit, offset], |r| {
                Ok(HistoryEntry {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    last_visited_at: r.get(2)?,
                    visit_count: r.get::<_, i64>(3)? as u32,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let sql_total = format!("SELECT COUNT(DISTINCT v.url) FROM visits v{filter}");
        let total = conn
            .query_row(&sql_total, [], |r| r.get::<_, i64>(0))
            .map_err(err_sql)? as u32;
        Ok((entries, total))
    }

    /// Удалить записи истории по URL (все визиты адреса + строки индекса).
    pub fn delete_urls(&self, urls: &[String]) -> Result<(), String> {
        if urls.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let placeholders = std::iter::repeat_n("?", urls.len())
            .collect::<Vec<_>>()
            .join(",");
        tx.execute(
            &format!(
                "DELETE FROM search WHERE source = 'history' AND ref IN \
                 (SELECT id FROM visits WHERE url IN ({placeholders}))"
            ),
            rusqlite::params_from_iter(urls),
        )
        .map_err(err_sql)?;
        tx.execute(
            &format!("DELETE FROM visits WHERE url IN ({placeholders})"),
            rusqlite::params_from_iter(urls),
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Удалить визиты за диапазон времени [from_ms..=to_ms] (unix-ms),
    /// включая строки индекса. from=0, to=«будущее» — вся история.
    pub fn delete_range(&self, from_ms: i64, to_ms: i64) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        tx.execute(
            "DELETE FROM search WHERE source = 'history' AND ref IN \
             (SELECT id FROM visits WHERE visited_at >= ?1 AND visited_at <= ?2)",
            rusqlite::params![from_ms, to_ms],
        )
        .map_err(err_sql)?;
        tx.execute(
            "DELETE FROM visits WHERE visited_at >= ?1 AND visited_at <= ?2",
            rusqlite::params![from_ms, to_ms],
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Добавить закладку (url — ключ): повторное добавление обновляет
    /// заголовок, не трогая дату. Пустой заголовок сохраняет прежний.
    pub fn bookmark_add(&self, url: &str, title: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let existing: Option<i64> = tx
            .query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| {
                r.get(0)
            })
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(err_sql)?;
        match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE bookmarks SET title = CASE WHEN ?1 = '' THEN title ELSE ?1 END
                     WHERE id = ?2",
                    rusqlite::params![title, id],
                )
                .map_err(err_sql)?;
                tx.execute(
                    "UPDATE search SET title = (SELECT title FROM bookmarks WHERE id = ?2)
                     WHERE source = 'bookmark' AND ref = ?2",
                    rusqlite::params![title, id],
                )
                .map_err(err_sql)?;
            }
            None => {
                tx.execute(
                    "INSERT INTO bookmarks(url, title, added_at) VALUES (?1, ?2, ?3)",
                    rusqlite::params![url, title, now_ms()],
                )
                .map_err(err_sql)?;
                let id = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO search(title, url, source, ref) VALUES (?1, ?2, 'bookmark', ?3)",
                    rusqlite::params![title, url, id],
                )
                .map_err(err_sql)?;
            }
        }
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Есть ли закладка с этим URL (звёздочка навбара, карточка duopulse-057).
    pub fn is_bookmarked(&self, url: &str) -> bool {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        conn.query_row("SELECT 1 FROM bookmarks WHERE url = ?1", [url], |_| Ok(()))
            .is_ok()
    }

    /// Ctrl+D / звёздочка: закладка вкл/выкл. Ответ — стала ли страница
    /// закладкой (добавили — true, убрали — false).
    pub fn toggle_bookmark(&self, url: &str, title: &str) -> Result<bool, String> {
        if self.is_bookmarked(url) {
            self.bookmark_remove(url)?;
            Ok(false)
        } else {
            self.bookmark_add(url, title)?;
            Ok(true)
        }
    }

    /// Удалить закладку (нет — тихо ок, операция идемпотентна).
    pub fn bookmark_remove(&self, url: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        tx.execute(
            "DELETE FROM search WHERE source = 'bookmark' AND ref IN \
             (SELECT id FROM bookmarks WHERE url = ?1)",
            [url],
        )
        .map_err(err_sql)?;
        tx.execute("DELETE FROM bookmarks WHERE url = ?1", [url])
            .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Переименовать закладку (правка на странице управления).
    pub fn bookmark_update(&self, url: &str, title: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let changed = tx
            .execute(
                "UPDATE bookmarks SET title = ?1 WHERE url = ?2",
                rusqlite::params![title, url],
            )
            .map_err(err_sql)?;
        if changed == 0 {
            return Err(format!("закладка {url} не найдена"));
        }
        tx.execute(
            "UPDATE search SET title = ?1 WHERE source = 'bookmark' AND ref IN \
             (SELECT id FROM bookmarks WHERE url = ?2)",
            rusqlite::params![title, url],
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Закладки для страницы управления (свежие первыми), query — FTS-фильтр.
    pub fn bookmark_list(
        &self,
        query: &str,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<HistoryBookmark>, u32), String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let limit = limit.clamp(1, 500) as i64;
        let offset = offset.min(i32::MAX as u32) as i64;
        let filter = match match_expr(query.trim()) {
            Some(expr) => format!(
                " WHERE b.id IN (SELECT ref FROM search WHERE search MATCH '{}' \
                 AND source = 'bookmark')",
                expr.replace('\'', "''")
            ),
            None => String::new(),
        };
        let sql_entries = format!(
            "SELECT b.url, b.title, b.added_at FROM bookmarks b{filter}
             ORDER BY b.added_at DESC, b.url LIMIT ?1 OFFSET ?2"
        );
        let mut stmt = conn.prepare(&sql_entries).map_err(err_sql)?;
        let bookmarks = stmt
            .query_map(rusqlite::params![limit, offset], |r| {
                Ok(HistoryBookmark {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    added_at: r.get(2)?,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let sql_total = format!("SELECT COUNT(*) FROM bookmarks b{filter}");
        let total = conn
            .query_row(&sql_total, [], |r| r.get::<_, i64>(0))
            .map_err(err_sql)? as u32;
        Ok((bookmarks, total))
    }

    // --- задача 5.1: экспорт/импорт профиля -----------------------------------

    /// Дамп всех закладок (экспорт профиля; url — ключ, даты сохраняются).
    pub fn dump_bookmarks(&self) -> Result<Vec<HistoryBookmark>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let mut stmt = conn
            .prepare("SELECT url, title, added_at FROM bookmarks ORDER BY added_at, url")
            .map_err(err_sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(HistoryBookmark {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    added_at: r.get(2)?,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        Ok(rows)
    }

    /// Дамп всех визитов (экспорт профиля).
    pub fn dump_visits(&self) -> Result<Vec<VisitRow>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let mut stmt = conn
            .prepare("SELECT url, title, visited_at FROM visits ORDER BY id")
            .map_err(err_sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(VisitRow {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    visited_at: r.get(2)?,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        Ok(rows)
    }

    /// Импорт закладок (переезд профиля): существующий url получает заголовок
    /// из файла (непустой), дата добавления сохраняется у новых. Возвращает
    /// число вставленных.
    pub fn import_bookmarks(&self, rows: &[HistoryBookmark]) -> Result<u32, String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let mut inserted = 0u32;
        for b in rows {
            if b.url.trim().is_empty() {
                continue;
            }
            let existing: Option<i64> = tx
                .query_row("SELECT id FROM bookmarks WHERE url = ?1", [&b.url], |r| {
                    r.get(0)
                })
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(err_sql)?;
            match existing {
                Some(id) => {
                    if !b.title.is_empty() {
                        tx.execute(
                            "UPDATE bookmarks SET title = ?1 WHERE id = ?2",
                            rusqlite::params![b.title, id],
                        )
                        .map_err(err_sql)?;
                        tx.execute(
                            "UPDATE search SET title = ?1 WHERE source = 'bookmark' AND ref = ?2",
                            rusqlite::params![b.title, id],
                        )
                        .map_err(err_sql)?;
                    }
                }
                None => {
                    tx.execute(
                        "INSERT INTO bookmarks(url, title, added_at) VALUES (?1, ?2, ?3)",
                        rusqlite::params![b.url, b.title, b.added_at],
                    )
                    .map_err(err_sql)?;
                    let id = tx.last_insert_rowid();
                    tx.execute(
                        "INSERT INTO search(title, url, source, ref) VALUES (?1, ?2, 'bookmark', ?3)",
                        rusqlite::params![b.title, b.url, id],
                    )
                    .map_err(err_sql)?;
                    inserted += 1;
                }
            }
        }
        tx.commit().map_err(err_sql)?;
        Ok(inserted)
    }

    /// Импорт визитов (переезд профиля): вставка с исходным временем (дедуп
    /// источника уже отработал), точные дубликаты (url + время) пропускаются —
    /// повторный импорт того же файла не раздувает историю. Возвращает число
    /// вставленных.
    pub fn import_visits(&self, rows: &[VisitRow]) -> Result<u32, String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let mut inserted = 0u32;
        for v in rows {
            if v.url.trim().is_empty() {
                continue;
            }
            let dup: bool = tx
                .query_row(
                    "SELECT 1 FROM visits WHERE url = ?1 AND visited_at = ?2",
                    rusqlite::params![v.url, v.visited_at],
                    |_| Ok(()),
                )
                .is_ok();
            if dup {
                continue;
            }
            tx.execute(
                "INSERT INTO visits(url, title, visited_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![v.url, v.title, v.visited_at],
            )
            .map_err(err_sql)?;
            let id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO search(title, url, source, ref) VALUES (?1, ?2, 'history', ?3)",
                rusqlite::params![v.title, v.url, id],
            )
            .map_err(err_sql)?;
            inserted += 1;
        }
        tx.commit().map_err(err_sql)?;
        Ok(inserted)
    }
}

fn err_sql(e: rusqlite::Error) -> String {
    format!("SQLite: {e}")
}

/// MATCH-выражение FTS5 из пользовательского ввода: токены из букв/цифр,
/// каждый — экранированная префиксная фраза («"токен"*»). None — токенов нет.
fn match_expr(query: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split_whitespace()
        .filter(|tok| tok.chars().any(char::is_alphanumeric))
        .map(|tok| format!("\"{}\"*", tok.replace('"', "\"\"")))
        .collect();
    (!tokens.is_empty()).then(|| tokens.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Сид как в e2e (e2e/omnibox/run.mjs): закладки + история.
    fn seeded() -> HistoryStore {
        let store = HistoryStore::open_in_memory().unwrap();
        store
            .visit(
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "Rick Astley — Never Gonna Give You Up",
            )
            .unwrap();
        store
            .visit(
                "https://www.youtube.com/results?search_query=rust+lang",
                "rust lang — YouTube",
            )
            .unwrap();
        store
            .visit("https://music.youtube.com/", "YouTube Music")
            .unwrap();
        store
            .visit(
                "https://www.youtube.com/feed/subscriptions",
                "Подписки — YouTube",
            )
            .unwrap();
        store
            .visit("https://ru.wikipedia.org/wiki/Rust", "Rust — Википедия")
            .unwrap();
        store
            .visit(
                "https://ru.wikipedia.org/wiki/Субтитры",
                "Субтитры — Википедия",
            )
            .unwrap();
        store
            .visit(
                "https://en.wikipedia.org/wiki/Subtitle",
                "Subtitle — Wikipedia",
            )
            .unwrap();
        store
            .visit(
                "https://github.com/tauri-apps/tauri",
                "tauri-apps/tauri — Tauri Framework",
            )
            .unwrap();
        store
            .visit(
                "https://github.com/rust-lang/rust",
                "rust-lang/rust — Empowering everyone",
            )
            .unwrap();
        store
            .visit(
                "https://doc.rust-lang.org/book/",
                "The Rust Programming Language",
            )
            .unwrap();
        store.visit("https://habr.com/ru/all/", "Хабр").unwrap();
        store
            .visit("https://news.ycombinator.com/", "Hacker News")
            .unwrap();
        store
            .visit("https://translate.google.com/", "Google Переводчик")
            .unwrap();
        store
            .bookmark_add("https://www.youtube.com/", "YouTube")
            .unwrap();
        store
            .bookmark_add(
                "https://ru.wikipedia.org/",
                "Википедия — свободная энциклопедия",
            )
            .unwrap();
        store
            .bookmark_add("https://github.com/", "GitHub: Let's build from here")
            .unwrap();
        store
            .bookmark_add("https://developer.mozilla.org/ru/", "MDN Web Docs")
            .unwrap();
        store
    }

    fn urls(hits: &[HistoryHit]) -> Vec<&str> {
        hits.iter().map(|h| h.url.as_str()).collect()
    }

    #[test]
    fn prefix_match_by_url_and_title() {
        let store = seeded();
        // префикс «you» находится и в URL, и в заголовке
        let hits = store.search("you", 8).unwrap();
        assert!(hits.iter().any(|h| h.url.contains("youtube.com")));
        // поиск по слову заголовка, которого нет в URL
        let hits = store.search("Переводчик", 8).unwrap();
        assert!(urls(&hits).contains(&"https://translate.google.com/"));
        // кириллица: префикс «субтит» по заголовку
        let hits = store.search("субтит", 8).unwrap();
        assert!(hits.iter().any(|h| h.url.contains("Субтитры")));
    }

    #[test]
    fn search_is_case_insensitive() {
        let store = seeded();
        assert_eq!(
            urls(&store.search("rust", 8).unwrap()),
            urls(&store.search("RUST", 8).unwrap())
        );
        assert!(!store.search("RUST", 8).unwrap().is_empty());
    }

    #[test]
    fn multiword_query_intersects_tokens() {
        let store = seeded();
        // оба слова есть только у википедийной записи про субтитры
        let hits = store.search("википедия субтитры", 8).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].url.contains("Субтитры"));
    }

    #[test]
    fn garbage_queries_do_not_panic() {
        let store = seeded();
        assert!(store.search("\"\"\" ", 8).unwrap().is_empty());
        assert!(store.search("- -- ???", 8).unwrap().is_empty());
        assert!(store.search("zzzznonexistent", 8).unwrap().is_empty());
    }

    #[test]
    fn empty_query_returns_bookmarks_only() {
        let store = seeded();
        let hits = store.search("", 8).unwrap();
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h.source == HistorySource::Bookmark));
    }

    #[test]
    fn limit_is_respected() {
        let store = seeded();
        assert!(store.search("youtube", 2).unwrap().len() <= 2);
    }

    // --- задача 1.4: запись/дедуп/заголовки ---------------------------------

    #[test]
    fn visit_dedupes_rapid_revisits_and_keeps_old_title() {
        let store = HistoryStore::open_in_memory().unwrap();
        store.visit_at("https://a.example/", "", 1_000).unwrap();
        // в пределах DEDUP_MS — не новый визит: обновляются время и заголовок
        store
            .visit_at("https://a.example/", "Заголовок A", 2_000)
            .unwrap();
        let (entries, total) = store.list("", 0, 100).unwrap();
        assert_eq!(total, 1);
        assert_eq!(entries[0].visit_count, 1, "дедуп не плодит визиты");
        assert_eq!(entries[0].title, "Заголовок A");
        assert_eq!(entries[0].last_visited_at, 2_000);
        // за пределами окна (от последнего визита 2_000) — отдельный визит
        store
            .visit_at("https://a.example/", "Заголовок A", 2_000 + DEDUP_MS + 1)
            .unwrap();
        let (entries, total) = store.list("", 0, 100).unwrap();
        assert_eq!(total, 1);
        assert_eq!(entries[0].visit_count, 2, "визит вне окна дедупа — новый");
        // FTS-индекс видит заголовок
        assert!(store
            .search("заголовок", 8)
            .unwrap()
            .iter()
            .any(|h| h.url.contains("a.example")));
    }

    #[test]
    fn note_title_updates_latest_visit_only() {
        let store = HistoryStore::open_in_memory().unwrap();
        store.visit("https://a.example/", "").unwrap();
        store.visit("https://b.example/", "").unwrap();
        store.note_title("https://a.example/", "Титул A").unwrap();
        let (entries, _) = store.list("", 0, 100).unwrap();
        let a = entries
            .iter()
            .find(|e| e.url == "https://a.example/")
            .unwrap();
        assert_eq!(a.title, "Титул A");
        let hits = store.search("титул", 8).unwrap();
        assert_eq!(hits.len(), 1, "индекс обновился у одного адреса");
    }

    // --- задача 1.4: список/удаление ----------------------------------------

    #[test]
    fn list_aggregates_by_url_paginates_and_fts_filters() {
        let store = HistoryStore::open_in_memory().unwrap();
        store
            .visit_at("https://a.example/1", "статья один", 1_000)
            .unwrap();
        store
            .visit_at("https://b.example/2", "статья два", 2_000)
            .unwrap();
        store
            .visit_at("https://a.example/1", "статья один", 300_000)
            .unwrap(); // 2-й визит
        store
            .bookmark_add("https://c.example/", "статья три (закладка)")
            .unwrap();
        let (entries, total) = store.list("", 0, 100).unwrap();
        assert_eq!(total, 2, "закладки в историю не попадают");
        let a = entries
            .iter()
            .find(|e| e.url == "https://a.example/1")
            .unwrap();
        assert_eq!(a.visit_count, 2);
        let b = entries
            .iter()
            .find(|e| e.url == "https://b.example/2")
            .unwrap();
        assert!(a.last_visited_at >= b.last_visited_at, "свежие первыми");
        // пагинация
        let (page, page_total) = store.list("", 1, 1).unwrap();
        assert_eq!(page_total, 2);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].url, "https://b.example/2");
        // FTS-фильтр: «статья» — по заголовкам (закладка отфильтрована по source),
        // «b.example» — по токенам URL
        assert_eq!(store.list("статья", 0, 100).unwrap().1, 2);
        assert_eq!(store.list("b.example", 0, 100).unwrap().1, 1);
    }

    #[test]
    fn delete_urls_removes_visits_and_index() {
        let store = seeded();
        store
            .delete_urls(&["https://news.ycombinator.com/".into()])
            .unwrap();
        assert!(store.search("hacker", 8).unwrap().is_empty());
        let (_, total) = store.list("", 0, 100).unwrap();
        assert_eq!(total, 12, "остальные записи на месте");
    }

    #[test]
    fn delete_range_respects_bounds() {
        let store = HistoryStore::open_in_memory().unwrap();
        store.visit_at("https://old.example/", "", 1_000).unwrap();
        store.visit_at("https://new.example/", "", 200_000).unwrap();
        // удаляем всё до t=150_000 — уходит только старый визит
        store.delete_range(0, 150_000).unwrap();
        let (entries, total) = store.list("", 0, 100).unwrap();
        assert_eq!(total, 1);
        assert_eq!(entries[0].url, "https://new.example/");
        assert!(store.search("old", 8).unwrap().is_empty());
    }

    #[test]
    fn delete_range_all_clears_history_but_not_bookmarks() {
        let store = seeded();
        store.delete_range(0, now_ms() + 100_000).unwrap();
        assert!(store.list("", 0, 100).unwrap().1 == 0);
        assert!(!store.search("", 8).unwrap().is_empty(), "закладки живы");
    }

    // --- задача 1.4: закладки -------------------------------------------------

    #[test]
    fn bookmark_upsert_remove_update_and_list() {
        let store = HistoryStore::open_in_memory().unwrap();
        store.bookmark_add("https://a.example/", "A").unwrap();
        // повторное добавление: обновляет заголовок, дата не сбрасывается в 0
        store.bookmark_add("https://a.example/", "A v2").unwrap();
        store.bookmark_add("https://b.example/", "B").unwrap();
        let (marks, total) = store.bookmark_list("", 0, 100).unwrap();
        assert_eq!(total, 2);
        assert_eq!(
            marks
                .iter()
                .find(|m| m.url == "https://a.example/")
                .unwrap()
                .title,
            "A v2"
        );
        assert!(marks.iter().all(|m| m.added_at > 0));
        // правка заголовка
        store
            .bookmark_update("https://b.example/", "B новое имя")
            .unwrap();
        assert!(store
            .search("новое имя", 8)
            .unwrap()
            .iter()
            .any(|h| h.source == HistorySource::Bookmark));
        // пустой заголовок при добавлении не затирает существующий
        store.bookmark_add("https://b.example/", "").unwrap();
        assert_eq!(
            store
                .bookmark_list("", 0, 100)
                .unwrap()
                .0
                .iter()
                .find(|m| m.url == "https://b.example/")
                .unwrap()
                .title,
            "B новое имя"
        );
        // удаление идемпотентно
        store.bookmark_remove("https://a.example/").unwrap();
        store.bookmark_remove("https://a.example/").unwrap();
        assert_eq!(store.bookmark_list("", 0, 100).unwrap().1, 1);
        assert!(
            store.search("a v2", 8).unwrap().is_empty(),
            "индекс закладки тоже удалён"
        );
        // правка несуществующей — ошибка
        assert!(store.bookmark_update("https://nope.example/", "x").is_err());
        // FTS-фильтр списка
        assert_eq!(store.bookmark_list("новое", 0, 100).unwrap().1, 1);
    }

    #[test]
    fn bookmark_survives_history_deletion_of_same_url() {
        let store = HistoryStore::open_in_memory().unwrap();
        store.visit("https://a.example/", "A").unwrap();
        store.bookmark_add("https://a.example/", "A").unwrap();
        store.delete_urls(&["https://a.example/".into()]).unwrap();
        assert_eq!(
            store.bookmark_list("", 0, 100).unwrap().1,
            1,
            "закладка не часть истории"
        );
        assert!(store
            .search("", 8)
            .unwrap()
            .iter()
            .any(|h| h.url == "https://a.example/"));
    }

    /// Ctrl+D / звёздочка (карточка duopulse-057): toggle добавляет и убирает,
    /// is_bookmarked следит за состоянием, повторный toggle идемпотентен.
    #[test]
    fn bookmark_toggle_adds_and_removes() {
        let store = HistoryStore::open_in_memory().unwrap();
        let url = "https://yt.example/watch?v=1";
        assert!(!store.is_bookmarked(url));
        assert!(
            store.toggle_bookmark(url, "Видео").unwrap(),
            "первый — добавить"
        );
        assert!(store.is_bookmarked(url));
        // тот же URL — снятие; пустой заголовок при добавлении не мешает
        assert!(!store.toggle_bookmark(url, "").unwrap(), "второй — убрать");
        assert!(!store.is_bookmarked(url));
        // цикл повторяется: снова добавить
        assert!(
            store.toggle_bookmark(url, "").unwrap(),
            "третий — снова добавить"
        );
        assert!(store.is_bookmarked(url));
    }

    // --- задача 1.4: файл в профиле и замер omnibox ---------------------------

    /// Топ-хосты для прогрева (задача 2.4): агрегация по хосту со снятием
    /// «www.», фильтры окна/частоты/схемы/локальности, порядок по частоте.
    #[test]
    fn top_hosts_aggregates_filters_and_orders() {
        let s = HistoryStore::open_in_memory().unwrap();
        let now = now_ms();
        // 3 визита youtube (www снят) + отдельный хост m.youtube.com (1 — мимо)
        for i in 0..3 {
            s.visit_at(
                &format!("https://www.youtube.com/watch?v={i}"),
                "yt",
                now - i,
            )
            .unwrap();
        }
        s.visit_at("https://m.youtube.com/x", "yt", now).unwrap();
        // 2 визита example.com
        for i in 0..2 {
            s.visit_at(&format!("https://example.com/p{i}"), "e", now - i)
                .unwrap();
        }
        // разовый визит — ниже MIN_VISITS; локальный/ftp/за-окном — не считаются
        s.visit_at("https://once.test/", "o", now).unwrap();
        s.visit_at("http://127.0.0.1:8898/a", "l", now).unwrap();
        s.visit_at("http://10.0.0.5/x", "l", now).unwrap();
        s.visit_at("ftp://x.test/f", "f", now).unwrap();
        s.visit_at("https://old.test/", "o", now - 40 * 24 * 60 * 60 * 1000)
            .unwrap();

        let top = s.top_hosts(10, 30, 2);
        assert_eq!(
            top,
            vec!["youtube.com".to_string(), "example.com".to_string()]
        );
        assert_eq!(s.top_hosts(1, 30, 2).len(), 1, "лимит");
        assert!(
            s.top_hosts(10, 30, 4).is_empty(),
            "порог числа визитов режет всё"
        );
    }

    #[test]
    fn store_persists_across_reopen() {
        let dir =
            std::env::temp_dir().join(format!("duopulse-history-test-{}", std::process::id()));
        let path = dir.join("duopulse.db");
        let _ = std::fs::remove_file(&path);
        {
            let store = HistoryStore::open(&dir).unwrap();
            store.visit("https://a.example/", "A").unwrap();
            store.bookmark_add("https://b.example/", "B").unwrap();
        }
        let store = HistoryStore::open(&dir).unwrap();
        assert_eq!(store.list("", 0, 100).unwrap().1, 1);
        assert_eq!(store.bookmark_list("", 0, 100).unwrap().1, 1);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(dir.join("duopulse.db-wal"));
        let _ = std::fs::remove_file(dir.join("duopulse.db-shm"));
        let _ = std::fs::remove_dir(&dir);
    }

    // --- задача 5.1: дамп/импорт профиля --------------------------------------

    #[test]
    fn dump_import_roundtrip_moves_everything() {
        let src = seeded();
        let visits = src.dump_visits().unwrap();
        let marks = src.dump_bookmarks().unwrap();
        assert_eq!(visits.len(), 13);
        assert_eq!(marks.len(), 4);

        // «чистая машина»: другой store (in-memory), импорт, сверка
        let dst = HistoryStore::open_in_memory().unwrap();
        assert_eq!(dst.import_bookmarks(&marks).unwrap(), 4);
        assert_eq!(dst.import_visits(&visits).unwrap(), 13);
        assert_eq!(dst.dump_visits().unwrap().len(), 13);
        assert_eq!(dst.dump_bookmarks().unwrap().len(), 4);
        // агрегат и поиск работают на импортированном
        let (entries, total) = dst.list("", 0, 100).unwrap();
        assert_eq!(total, 13);
        assert!(entries.iter().all(|e| e.visit_count >= 1));
        assert!(dst
            .search("переводчик", 8)
            .unwrap()
            .iter()
            .any(|h| h.url.contains("translate.google")));
        assert!(dst
            .search("википедия", 8)
            .unwrap()
            .iter()
            .any(|h| h.source == HistorySource::Bookmark));

        // повторный импорт того же файла — идемпотентен (точные дубликаты скип)
        assert_eq!(dst.import_visits(&visits).unwrap(), 0);
        assert_eq!(dst.import_bookmarks(&marks).unwrap(), 0);
        assert_eq!(dst.dump_visits().unwrap().len(), 13);

        // существующая закладка обновляет заголовок, дата не сбрасывается
        let mut changed = marks[0].clone();
        changed.title = "Новое имя".into();
        assert_eq!(
            dst.import_bookmarks(std::slice::from_ref(&changed))
                .unwrap(),
            0
        );
        let (all, _) = dst.bookmark_list("", 0, 100).unwrap();
        assert_eq!(
            all.iter().find(|m| m.url == changed.url).unwrap().title,
            "Новое имя"
        );
        // пустые url игнорируются
        assert_eq!(
            dst.import_visits(&[VisitRow {
                url: "  ".into(),
                title: String::new(),
                visited_at: 1
            }])
            .unwrap(),
            0
        );
    }

    /// DoD задач 1.3/1.4: поиск omnibox по 10k записей истории — < 50 мс.
    /// Замер на файловой БД (как в проде) на пяти разных запросах подряд
    /// (консервативнее одного), прогрев включён.
    #[test]
    fn search_10k_under_50ms() {
        let dir = std::env::temp_dir().join(format!("duopulse-perf-{}", std::process::id()));
        let path = dir.join("duopulse.db");
        let _ = std::fs::remove_file(&path);
        let store = HistoryStore::open(&dir).unwrap();
        let topics = [
            "видео",
            "статья",
            "форум",
            "документация",
            "музыка",
            "субтитры",
        ];
        for i in 0..10_000u32 {
            let topic = topics[(i as usize) % topics.len()];
            store
                .visit(
                    &format!("https://site{}.example/thread/{i}", i % 97),
                    &format!("{topic} №{i} — обсуждение и комментарии"),
                )
                .unwrap();
        }

        for q in ["видео", "wiki", "документация"] {
            store.search(q, 8).unwrap(); // прогрев: FTS-структуры и кэш страниц
        }
        let start = std::time::Instant::now();
        for q in [
            "видео",
            "wiki",
            "документация",
            "статья 123",
            "zzzznonexistent",
        ] {
            store.search(q, 8).unwrap();
        }
        let elapsed = start.elapsed();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(dir.join("duopulse.db-wal"));
        let _ = std::fs::remove_file(dir.join("duopulse.db-shm"));
        let _ = std::fs::remove_dir(&dir);
        assert!(
            elapsed.as_millis() < 50,
            "5 поисков по 10k записей уложились в {elapsed:?} (бюджет 50 мс)"
        );
    }
}
