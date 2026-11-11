//! История и закладки (задача 1.4, docs/05 §1 src/history/, хранение —
//! docs/02 §8): SQLite-файл `duopulse.db` в профиле пользователя
//! (`%APPDATA%\DuoPulse\profile\`).
//!
//! Схема: таблицы `visits` (визиты) и `bookmarks` (закладки, url — ключ),
//! `bookmark_groups` + `bookmark_group_items` (группы избранного, карточка
//! duopulse-058: закладка состоит в нескольких группах или без группы;
//! миграция плоского списка — все закладки в «Избранное», is_default) +
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

// Контрактные типы домена history.* — в contract.rs (duopulse-104: мобильная
// либа компилирует history без десктопного bridge.rs; bridge реэкспортирует).
pub mod contract;
// HistoryBookmark — реэкспорт для settings/profile.rs (путь сохранён).
pub use contract::HistoryBookmark;
use contract::{
    BookmarkGroupInfo, BookmarkGroupRef, BookmarkGroupRow, HistoryEntry, HistoryHit, HistorySource,
};

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
        // каскады членства закладок в группах (удаление группы/закладки)
        conn.pragma_update(None, "foreign_keys", "ON")?;
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
             CREATE TABLE IF NOT EXISTS bookmark_groups(
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL UNIQUE,
                 position INTEGER NOT NULL DEFAULT 0,
                 sort_by TEXT NOT NULL DEFAULT 'manual',
                 is_default INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS bookmark_group_items(
                 group_id INTEGER NOT NULL REFERENCES bookmark_groups(id) ON DELETE CASCADE,
                 bookmark_id INTEGER NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
                 position INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY(group_id, bookmark_id)
             );
             CREATE INDEX IF NOT EXISTS idx_bgi_group_pos
                 ON bookmark_group_items(group_id, position);
             CREATE TABLE IF NOT EXISTS sync_tombstones(
                 kind TEXT NOT NULL,
                 key TEXT NOT NULL,
                 deleted_at INTEGER NOT NULL,
                 PRIMARY KEY(kind, key)
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
                 title, url, source UNINDEXED, ref UNINDEXED
             );",
        )?;
        // duopulse-111 (этап 5): updated_at закладки — арбитр свежести
        // заголовка при слиянии облачного документа; у существующих строк
        // стартует с added_at («никогда не переименовывалась»).
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(bookmarks)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<_, _>>()?;
        if !cols.iter().any(|c| c == "updated_at") {
            conn.execute(
                "ALTER TABLE bookmarks ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            conn.execute("UPDATE bookmarks SET updated_at = added_at", [])?;
        }
        // Миграция плоского списка (карточка duopulse-058): групп ещё не было —
        // создаётся «Избранное» (is_default, туда же падают Ctrl+D и звёздочка
        // без выбора) и все существующие закладки становятся её членами в
        // порядке добавления. Повторно не срабатывает: группы есть у всех
        // последующих открытий (в т.ч. после ручного разгруппирования).
        let has_groups: i64 =
            conn.query_row("SELECT COUNT(*) FROM bookmark_groups", [], |r| r.get(0))?;
        if has_groups == 0 {
            conn.execute(
                "INSERT INTO bookmark_groups(name, position, sort_by, is_default, created_at)
                 VALUES ('Избранное', 0, 'manual', 1, ?1)",
                rusqlite::params![now_ms()],
            )?;
            let gid = conn.last_insert_rowid();
            conn.execute(
                "INSERT OR IGNORE INTO bookmark_group_items(group_id, bookmark_id, position)
                 SELECT ?1, id, ROW_NUMBER() OVER (ORDER BY added_at, id) - 1 FROM bookmarks",
                rusqlite::params![gid],
            )?;
        }
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
    /// на фокус); у закладочных подсказок поле group — имена групп «Имя · Имя»
    /// (карточка duopulse-058).
    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<HistoryHit>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let limit = limit.clamp(1, 20) as i64;
        let q = query.trim();
        if q.is_empty() {
            // закладки по свежести добавления, без FTS
            let mut stmt = conn
                .prepare(
                    "SELECT b.url, b.title,
                            (SELECT GROUP_CONCAT(g.name, ' · ')
                             FROM bookmark_group_items i
                             JOIN bookmark_groups g ON g.id = i.group_id
                             WHERE i.bookmark_id = b.id)
                     FROM bookmarks b ORDER BY b.added_at DESC LIMIT ?1",
                )
                .map_err(err_sql)?;
            let hits = stmt
                .query_map([limit], |r| {
                    Ok(HistoryHit {
                        source: HistorySource::Bookmark,
                        url: r.get(0)?,
                        title: r.get(1)?,
                        group: r.get(2)?,
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
                "SELECT source, url, title, ref FROM search
                 WHERE search MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(err_sql)?;
        // ref (id исходной строки) нужен только для метки группы закладки —
        // в контракт он не идёт, снимается до сборки ответа
        let rows = stmt
            .query_map(rusqlite::params![expr, limit], |r| {
                Ok((
                    HistoryHit {
                        source: HistorySource::from_db(&r.get::<_, String>(0)?),
                        url: r.get(1)?,
                        title: r.get(2)?,
                        group: None,
                    },
                    r.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let mut ids: Vec<i64> = rows
            .iter()
            .filter(|(h, _)| h.source == HistorySource::Bookmark)
            .filter_map(|(_, id)| *id)
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let labels = group_labels(&conn, &ids).map_err(err_sql)?;
        Ok(rows
            .into_iter()
            .map(|(mut hit, id)| {
                if hit.source == HistorySource::Bookmark {
                    if let (Some(id), None) = (id, &hit.group) {
                        hit.group = labels.get(&id).cloned();
                    }
                }
                hit
            })
            .collect())
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

    /// Добавить закладку в группу (карточка duopulse-058): group=None —
    /// группа по умолчанию («Избранное»), Some(id) — конкретная (её нет —
    /// ошибка). Существующая закладка получает членство (upsert).
    pub fn bookmark_add_to(
        &self,
        url: &str,
        title: &str,
        group: Option<i64>,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let member = match group {
            Some(id) => {
                let exists: bool = tx
                    .query_row("SELECT 1 FROM bookmark_groups WHERE id = ?1", [id], |_| {
                        Ok(true)
                    })
                    .or_else(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => Ok(false),
                        other => Err(other),
                    })
                    .map_err(err_sql)?;
                if !exists {
                    return Err(format!("группа {id} не найдена"));
                }
                Some(id)
            }
            None => Some(
                tx.query_row(
                    "SELECT id FROM bookmark_groups WHERE is_default = 1",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| format!("группа по умолчанию не найдена: {e}"))?,
            ),
        };
        Self::bookmark_add_tx(&tx, url, title, member, now_ms())?;
        tx.commit().map_err(err_sql)
    }

    /// Ядро добавления (в транзакции вызвавшего): upsert закладки + индекс;
    /// member — добавить членство группы (INSERT OR IGNORE идемпотентен;
    /// None — членств не трогать — путь импорта профиля). Ответ — id строки
    /// и вставлена ли она только что (для счётчика импорта).
    fn bookmark_add_tx(
        tx: &rusqlite::Transaction<'_>,
        url: &str,
        title: &str,
        member: Option<i64>,
        added_at: i64,
    ) -> Result<(i64, bool), String> {
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
        let (id, inserted) = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE bookmarks SET
                         title = CASE WHEN ?1 = '' THEN title ELSE ?1 END,
                         updated_at = CASE WHEN ?1 != '' AND ?1 != title THEN ?3
                                           ELSE updated_at END
                     WHERE id = ?2",
                    rusqlite::params![title, id, added_at],
                )
                .map_err(err_sql)?;
                tx.execute(
                    "UPDATE search SET title = (SELECT title FROM bookmarks WHERE id = ?2)
                     WHERE source = 'bookmark' AND ref = ?2",
                    rusqlite::params![title, id],
                )
                .map_err(err_sql)?;
                (id, false)
            }
            None => {
                tx.execute(
                    "INSERT INTO bookmarks(url, title, added_at, updated_at)
                     VALUES (?1, ?2, ?3, ?3)",
                    rusqlite::params![url, title, added_at],
                )
                .map_err(err_sql)?;
                let id = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO search(title, url, source, ref) VALUES (?1, ?2, 'bookmark', ?3)",
                    rusqlite::params![title, url, id],
                )
                .map_err(err_sql)?;
                (id, true)
            }
        };
        if let Some(gid) = member {
            tx.execute(
                "INSERT OR IGNORE INTO bookmark_group_items(group_id, bookmark_id, position)
                 VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_group_items
                      WHERE group_id = ?1))",
                rusqlite::params![gid, id],
            )
            .map_err(err_sql)?;
        }
        Ok((id, inserted))
    }

    /// Есть ли закладка с этим URL (звёздочка навбара, карточка duopulse-057).
    pub fn is_bookmarked(&self, url: &str) -> bool {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        conn.query_row("SELECT 1 FROM bookmarks WHERE url = ?1", [url], |_| Ok(()))
            .is_ok()
    }

    /// Ctrl+D / звёздочка: закладка вкл/выкл. Ответ — стала ли страница
    /// закладкой (добавили — true, убрали — false). Добавление — в группу
    /// по умолчанию (карточка duopulse-058).
    pub fn toggle_bookmark(&self, url: &str, title: &str) -> Result<bool, String> {
        if self.is_bookmarked(url) {
            self.bookmark_remove(url)?;
            Ok(false)
        } else {
            self.bookmark_add_to(url, title, None)?;
            Ok(true)
        }
    }

    /// Удалить закладку (нет — тихо ок, операция идемпотентна). Пишет
    /// надгробие синка (этап 5 duopulse-111): удаление уезжает в облако и
    /// не даёт закладке воскреснуть на других машинах, пока её не добавят
    /// заново (свежее added_at побеждает надгробие).
    pub fn bookmark_remove(&self, url: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        Self::bookmark_remove_tx(&tx, url)?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_tombstones(kind, key, deleted_at)
             VALUES ('bookmark', ?1, ?2)",
            rusqlite::params![url, now_ms()],
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(())
    }

    /// Ядро удаления закладки (в транзакции вызвавшего): строка, строка
    /// индекса; членства групп снимает каскад. Надгробие пишет вызвавший.
    fn bookmark_remove_tx(tx: &rusqlite::Transaction<'_>, url: &str) -> Result<(), String> {
        tx.execute(
            "DELETE FROM search WHERE source = 'bookmark' AND ref IN \
             (SELECT id FROM bookmarks WHERE url = ?1)",
            [url],
        )
        .map_err(err_sql)?;
        tx.execute("DELETE FROM bookmarks WHERE url = ?1", [url])
            .map_err(err_sql)?;
        Ok(())
    }

    /// Переименовать закладку (правка на странице управления). Метка
    /// updated_at (этап 5 duopulse-111) — свежее переименование выигрывает
    /// слияние синка.
    pub fn bookmark_update(&self, url: &str, title: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let changed = tx
            .execute(
                "UPDATE bookmarks SET title = ?1, updated_at = ?3 WHERE url = ?2",
                rusqlite::params![title, url, now_ms()],
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

    /// Закладки для страницы управления, query — FTS-фильтр, group — охват
    /// и порядок (карточка duopulse-058): All — все свежими первыми;
    /// Group(id) — члены группы в её порядке сортировки (manual → позиции
    /// drag&drop, title → по имени, added → свежими первыми); Ungrouped —
    /// вне групп. Каждая строка несёт свои группы (groups: id + имя).
    pub fn bookmark_list(
        &self,
        query: &str,
        group: GroupFilter,
        offset: u32,
        limit: u32,
    ) -> Result<(Vec<HistoryBookmark>, u32), String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let limit = limit.clamp(1, 500) as i64;
        let offset = offset.min(i32::MAX as u32) as i64;
        let mut conds: Vec<String> = Vec::new();
        if let Some(expr) = match_expr(query.trim()) {
            conds.push(format!(
                "b.id IN (SELECT ref FROM search WHERE search MATCH '{}' \
                 AND source = 'bookmark')",
                expr.replace('\'', "''")
            ));
        }
        let mut params: Vec<i64> = Vec::new();
        let (join, order) = match group {
            GroupFilter::All => (String::new(), "b.added_at DESC, b.url".to_string()),
            GroupFilter::Group(gid) => {
                let sort_by: String = conn
                    .query_row(
                        "SELECT sort_by FROM bookmark_groups WHERE id = ?1",
                        [gid],
                        |r| r.get(0),
                    )
                    .map_err(|_| format!("группа {gid} не найдена"))?;
                let order = match sort_by.as_str() {
                    "title" => "b.title COLLATE NOCASE, b.url".to_string(),
                    "added" => "b.added_at DESC, b.url".to_string(),
                    _ => "i.position, b.url".to_string(),
                };
                params.push(gid);
                (
                    " JOIN bookmark_group_items i ON i.bookmark_id = b.id AND i.group_id = ?1"
                        .to_string(),
                    order,
                )
            }
            GroupFilter::Ungrouped => {
                conds.push("i.group_id IS NULL".into());
                (
                    " LEFT JOIN bookmark_group_items i ON i.bookmark_id = b.id".to_string(),
                    "b.added_at DESC, b.url".to_string(),
                )
            }
        };
        let where_clause = if conds.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", conds.join(" AND "))
        };
        // нумерация: ?1 — группа (если есть), ?2/?3 — LIMIT/OFFSET (только
        // entries-запрос); COUNT использует те же ?1 и WHERE
        let mut entry_params = params.clone();
        entry_params.push(limit);
        entry_params.push(offset);
        let sql_entries = format!(
            "SELECT b.id, b.url, b.title, b.added_at FROM bookmarks b{join}{where_clause}
             ORDER BY {order} LIMIT ?{} OFFSET ?{}",
            params.len() + 1,
            params.len() + 2
        );
        let mut stmt = conn.prepare(&sql_entries).map_err(err_sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(&entry_params), |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    HistoryBookmark {
                        url: r.get(1)?,
                        title: r.get(2)?,
                        added_at: r.get(3)?,
                        groups: Vec::new(),
                    },
                ))
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let sql_total = format!("SELECT COUNT(*) FROM bookmarks b{join}{where_clause}");
        let total = conn
            .query_row(&sql_total, rusqlite::params_from_iter(&params), |r| {
                r.get::<_, i64>(0)
            })
            .map_err(err_sql)? as u32;
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let refs = group_refs_of(&conn, &ids).map_err(err_sql)?;
        let bookmarks = rows
            .into_iter()
            .map(|(id, mut b)| {
                b.groups = refs.get(&id).cloned().unwrap_or_default();
                b
            })
            .collect();
        Ok((bookmarks, total))
    }

    // --- карточка duopulse-058: группы избранного -----------------------------

    /// Группы для UI (по позициям) с числом закладок.
    pub fn group_list(&self) -> Result<Vec<BookmarkGroupInfo>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let mut stmt = conn
            .prepare(
                "SELECT g.id, g.name, g.position, g.sort_by, g.is_default,
                        (SELECT COUNT(*) FROM bookmark_group_items i WHERE i.group_id = g.id)
                 FROM bookmark_groups g ORDER BY g.position, g.id",
            )
            .map_err(err_sql)?;
        let groups = stmt
            .query_map([], |r| {
                Ok(BookmarkGroupInfo {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    position: r.get::<_, i64>(2)? as u32,
                    sort_by: r.get(3)?,
                    is_default: r.get::<_, i64>(4)? != 0,
                    count: r.get::<_, i64>(5)? as u32,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        Ok(groups)
    }

    /// Создать группу (имя уникально, пустое/дубликат — ошибка); новая —
    /// последняя, сортировка «вручную».
    pub fn group_add(&self, name: &str) -> Result<BookmarkGroupInfo, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("имя группы пустое".into());
        }
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let dup: bool = tx
            .query_row(
                "SELECT 1 FROM bookmark_groups WHERE name = ?1",
                [name],
                |_| Ok(()),
            )
            .is_ok();
        if dup {
            return Err(format!("группа «{name}» уже есть"));
        }
        let position: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_groups",
                [],
                |r| r.get(0),
            )
            .map_err(err_sql)?;
        tx.execute(
            "INSERT INTO bookmark_groups(name, position, sort_by, is_default, created_at)
             VALUES (?1, ?2, 'manual', 0, ?3)",
            rusqlite::params![name, position, now_ms()],
        )
        .map_err(err_sql)?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(err_sql)?;
        Ok(BookmarkGroupInfo {
            id,
            name: name.to_string(),
            position: position as u32,
            sort_by: "manual".into(),
            is_default: false,
            count: 0,
        })
    }

    /// Переименовать группу (имя уникально; несуществующая — ошибка).
    pub fn group_rename(&self, id: i64, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("имя группы пустое".into());
        }
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let dup: Option<i64> = tx
            .query_row(
                "SELECT id FROM bookmark_groups WHERE name = ?1 AND id != ?2",
                rusqlite::params![name, id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(err_sql)?;
        if dup.is_some() {
            return Err(format!("группа «{name}» уже есть"));
        }
        let changed = tx
            .execute(
                "UPDATE bookmark_groups SET name = ?1 WHERE id = ?2",
                rusqlite::params![name, id],
            )
            .map_err(err_sql)?;
        if changed == 0 {
            return Err(format!("группа {id} не найдена"));
        }
        tx.commit().map_err(err_sql)
    }

    /// Удалить группу: закладки остаются (членства снимаются каскадом),
    /// группа по умолчанию не удаляется (Ctrl+D и звёздочка без выбора
    /// добавляют в неё).
    pub fn group_remove(&self, id: i64) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let is_default: Option<bool> = tx
            .query_row(
                "SELECT is_default != 0 FROM bookmark_groups WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
            .map_err(err_sql)?;
        match is_default {
            None => return Err(format!("группа {id} не найдена")),
            Some(true) => return Err("группу по умолчанию удалить нельзя — переименуйте её".into()),
            Some(false) => {}
        }
        // надгробие синка по ИМЕНИ (этап 5 duopulse-111): идентификаторы групп
        // на машинах различаются, ключ слияния — имя
        let name: String = tx
            .query_row(
                "SELECT name FROM bookmark_groups WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .map_err(err_sql)?;
        tx.execute("DELETE FROM bookmark_groups WHERE id = ?1", [id])
            .map_err(err_sql)?;
        tx.execute(
            "INSERT OR REPLACE INTO sync_tombstones(kind, key, deleted_at)
             VALUES ('group', ?1, ?2)",
            rusqlite::params![name, now_ms()],
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)
    }

    /// Режим сортировки группы: manual (позиции drag&drop) | title | added.
    pub fn group_set_sort(&self, id: i64, sort_by: &str) -> Result<(), String> {
        let sort_by = normalize_sort_by(sort_by);
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let changed = conn
            .execute(
                "UPDATE bookmark_groups SET sort_by = ?1 WHERE id = ?2",
                rusqlite::params![sort_by, id],
            )
            .map_err(err_sql)?;
        if changed == 0 {
            return Err(format!("группа {id} не найдена"));
        }
        Ok(())
    }

    /// Членство закладки в группе вкл/выкл (закладка может быть в нескольких
    /// группах или ни в одной). Снятие всех членств оставляет закладку
    /// «без группы» (видна в фильтре Ungrouped и в «Все»).
    pub fn group_toggle_bookmark(&self, url: &str, group_id: i64, on: bool) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let group_exists: bool = tx
            .query_row(
                "SELECT 1 FROM bookmark_groups WHERE id = ?1",
                [group_id],
                |_| Ok(true),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(other),
            })
            .map_err(err_sql)?;
        if !group_exists {
            return Err(format!("группа {group_id} не найдена"));
        }
        let bid: i64 = tx
            .query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| {
                r.get(0)
            })
            .map_err(|_| format!("закладка {url} не найдена"))?;
        if on {
            tx.execute(
                "INSERT OR IGNORE INTO bookmark_group_items(group_id, bookmark_id, position)
                 VALUES (?1, ?2,
                     (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_group_items
                      WHERE group_id = ?1))",
                rusqlite::params![group_id, bid],
            )
            .map_err(err_sql)?;
        } else {
            tx.execute(
                "DELETE FROM bookmark_group_items WHERE group_id = ?1 AND bookmark_id = ?2",
                rusqlite::params![group_id, bid],
            )
            .map_err(err_sql)?;
        }
        tx.commit().map_err(err_sql)
    }

    /// Переставить закладку внутри группы (drag&drop, позиция 0 = верх):
    /// порядок группы переписывается целиком — позиции всегда плотные.
    pub fn bookmark_move(&self, url: &str, group_id: i64, position: u32) -> Result<(), String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let group_exists: bool = tx
            .query_row(
                "SELECT 1 FROM bookmark_groups WHERE id = ?1",
                [group_id],
                |_| Ok(true),
            )
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(other),
            })
            .map_err(err_sql)?;
        if !group_exists {
            return Err(format!("группа {group_id} не найдена"));
        }
        let bid: i64 = tx
            .query_row("SELECT id FROM bookmarks WHERE url = ?1", [url], |r| {
                r.get(0)
            })
            .map_err(|_| format!("закладка {url} не найдена"))?;
        let mut ids: Vec<i64> = {
            let mut stmt = tx
                .prepare(
                    "SELECT bookmark_id FROM bookmark_group_items
                     WHERE group_id = ?1 ORDER BY position, bookmark_id",
                )
                .map_err(err_sql)?;
            let rows = stmt
                .query_map([group_id], |r| r.get::<_, i64>(0))
                .map_err(err_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err_sql)?;
            rows
        };
        let from = ids
            .iter()
            .position(|id| *id == bid)
            .ok_or_else(|| format!("закладка {url} не в группе {group_id}"))?;
        ids.remove(from);
        let to = (position as usize).min(ids.len());
        ids.insert(to, bid);
        for (idx, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE bookmark_group_items SET position = ?1
                 WHERE group_id = ?2 AND bookmark_id = ?3",
                rusqlite::params![idx as i64, group_id, id],
            )
            .map_err(err_sql)?;
        }
        tx.commit().map_err(err_sql)
    }

    // --- этап 5 duopulse-111: синк закладок через аккаунт Aila ---------------

    /// Документ облачного блоба закладок: всё живое + надгробия удалений.
    /// Шифруется целиком ключом синка (aila.rs), машина-приёмник сливает его
    /// merge_sync_doc. Группы адресуются по ИМЕНИ (id локальны), закладки —
    /// по url.
    pub fn export_sync_doc(&self) -> Result<BookmarkSyncDoc, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let mut stmt = conn
            .prepare("SELECT id, url, title, added_at, updated_at FROM bookmarks ORDER BY url")
            .map_err(err_sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    SyncBookmark {
                        url: r.get(1)?,
                        title: r.get(2)?,
                        added_at: r.get(3)?,
                        updated_at: r.get(4)?,
                        groups: Vec::new(),
                    },
                ))
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let refs = group_refs_of(&conn, &ids).map_err(err_sql)?;
        let bookmarks = rows
            .into_iter()
            .map(|(id, mut b)| {
                b.groups = refs
                    .get(&id)
                    .map(|v| v.iter().map(|r| r.name.clone()).collect())
                    .unwrap_or_default();
                b
            })
            .collect();
        let mut stmt = conn
            .prepare("SELECT name, sort_by, created_at FROM bookmark_groups ORDER BY position, id")
            .map_err(err_sql)?;
        let groups = stmt
            .query_map([], |r| {
                Ok(SyncGroup {
                    name: r.get(0)?,
                    sort_by: r.get(1)?,
                    created_at: r.get(2)?,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let mut stmt = conn
            .prepare("SELECT kind, key, deleted_at FROM sync_tombstones ORDER BY kind, key")
            .map_err(err_sql)?;
        let tombstones = stmt
            .query_map([], |r| {
                Ok(SyncTombstone {
                    kind: r.get(0)?,
                    key: r.get(1)?,
                    deleted_at: r.get(2)?,
                })
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        Ok(BookmarkSyncDoc {
            v: 1,
            bookmarks,
            groups,
            tombstones,
        })
    }

    /// Влить облачный документ (этап 5 duopulse-111). Правила:
    /// надгробия — объединение (свежее deleted_at); локальные закладки/группы,
    /// чьё надгробие свежее их создания, — удаляются (удаление синкается);
    /// облако отдаёт живые закладки (объединение по url: новых нет — вставка,
    /// заголовок берёт свежий updated_at) и группы (объединение по имени);
    /// надгробие, пережитое более поздним созданием, снимается — повторное
    /// добавление побеждает удаление. Позиции/порядок групп не синкаются
    /// (локальный выбор), снятие членства — объединение (не удаление).
    pub fn merge_sync_doc(&self, remote: &BookmarkSyncDoc) -> Result<BookmarkMergeStats, String> {
        let mut stats = BookmarkMergeStats::default();
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        // 1) надгробия: объединение, свежая дата выигрывает
        for t in &remote.tombstones {
            tx.execute(
                "INSERT INTO sync_tombstones(kind, key, deleted_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(kind, key)
                 DO UPDATE SET deleted_at = MAX(deleted_at, ?3)",
                rusqlite::params![t.kind, t.key, t.deleted_at],
            )
            .map_err(err_sql)?;
        }
        let tomb = tombstones_of(&tx)?;
        // 2) локальные удаления по надгробиям (свежее удаления, чем создание)
        {
            let mut stmt = tx
                .prepare("SELECT id, name, created_at FROM bookmark_groups")
                .map_err(err_sql)?;
            let groups: Vec<(i64, String, i64)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(err_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err_sql)?;
            drop(stmt);
            for (id, name, created) in groups {
                let dead = tomb
                    .get(&(TOMBSTONE_GROUP.to_string(), name.clone()))
                    .is_some_and(|&d| d > created);
                if dead {
                    tx.execute("DELETE FROM bookmark_groups WHERE id = ?1", [id])
                        .map_err(err_sql)?; // членства — каскадом, закладки живы
                    stats.removed += 1;
                }
            }
        }
        {
            let mut stmt = tx
                .prepare("SELECT id, url, added_at FROM bookmarks")
                .map_err(err_sql)?;
            let marks: Vec<(i64, String, i64)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .map_err(err_sql)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(err_sql)?;
            drop(stmt);
            for (id, url, added) in marks {
                let dead = tomb
                    .get(&(TOMBSTONE_BOOKMARK.to_string(), url.clone()))
                    .is_some_and(|&d| d > added);
                if dead {
                    tx.execute(
                        "DELETE FROM search WHERE source = 'bookmark' AND ref = ?1",
                        [id],
                    )
                    .map_err(err_sql)?;
                    tx.execute("DELETE FROM bookmarks WHERE id = ?1", [id])
                        .map_err(err_sql)?;
                    stats.removed += 1;
                }
            }
        }
        // 3) группы облака: по имени; надгробие свежее создания — не воскресаем
        for g in &remote.groups {
            let name = g.name.trim();
            if name.is_empty() {
                continue;
            }
            if tomb
                .get(&(TOMBSTONE_GROUP.to_string(), name.to_string()))
                .is_some_and(|&d| d >= g.created_at)
            {
                continue;
            }
            let exists: bool = tx
                .query_row(
                    "SELECT 1 FROM bookmark_groups WHERE name = ?1",
                    [name],
                    |_| Ok(true),
                )
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(false),
                    other => Err(other),
                })
                .map_err(err_sql)?;
            if exists {
                continue; // настройки существующей (порядок/сортировка) — локальные
            }
            let position: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_groups",
                    [],
                    |r| r.get(0),
                )
                .map_err(err_sql)?;
            tx.execute(
                "INSERT INTO bookmark_groups(name, position, sort_by, is_default, created_at)
                 VALUES (?1, ?2, ?3, 0, ?4)",
                rusqlite::params![name, position, normalize_sort_by(&g.sort_by), g.created_at],
            )
            .map_err(err_sql)?;
            stats.applied += 1;
        }
        // 4) закладки облака: по url; надгробие свежее добавления — скип.
        //    Карта имя→id групп — после шага 3 (свежие группы видны).
        let gid_of_name: std::collections::HashMap<String, i64> = {
            let mut stmt = tx
                .prepare("SELECT name, id FROM bookmark_groups")
                .map_err(err_sql)?;
            let map = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(err_sql)?
                .collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()
                .map_err(err_sql)?;
            map
        };
        for b in &remote.bookmarks {
            let url = b.url.trim();
            if url.is_empty() {
                continue;
            }
            if tomb
                .get(&(TOMBSTONE_BOOKMARK.to_string(), url.to_string()))
                .is_some_and(|&d| d >= b.added_at)
            {
                continue;
            }
            let local: Option<(i64, String, i64, i64)> = tx
                .query_row(
                    "SELECT id, title, added_at, updated_at FROM bookmarks WHERE url = ?1",
                    [url],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(err_sql)?;
            let id = match local {
                Some((id, title, _added, updated)) => {
                    // заголовок: свежий updated_at выигрывает (переименование)
                    if b.updated_at > updated && !b.title.is_empty() && b.title != title {
                        tx.execute(
                            "UPDATE bookmarks SET title = ?1, updated_at = ?2 WHERE id = ?3",
                            rusqlite::params![b.title, b.updated_at, id],
                        )
                        .map_err(err_sql)?;
                        tx.execute(
                            "UPDATE search SET title = ?1 WHERE source = 'bookmark' AND ref = ?2",
                            rusqlite::params![b.title, id],
                        )
                        .map_err(err_sql)?;
                        stats.applied += 1;
                    }
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO bookmarks(url, title, added_at, updated_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![url, b.title, b.added_at, b.updated_at],
                    )
                    .map_err(err_sql)?;
                    let id = tx.last_insert_rowid();
                    tx.execute(
                        "INSERT INTO search(title, url, source, ref) VALUES (?1, ?2, 'bookmark', ?3)",
                        rusqlite::params![b.title, url, id],
                    )
                    .map_err(err_sql)?;
                    stats.applied += 1;
                    id
                }
            };
            // членства — объединение по именам (докторит рассинхрон групп)
            for gname in &b.groups {
                let Some(&gid) = gid_of_name.get(gname.trim()) else {
                    continue;
                };
                tx.execute(
                    "INSERT OR IGNORE INTO bookmark_group_items(group_id, bookmark_id, position)
                     VALUES (?1, ?2,
                         (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_group_items
                          WHERE group_id = ?1))",
                    rusqlite::params![gid, id],
                )
                .map_err(err_sql)?;
            }
        }
        // 5) надгробия, пережитые более поздним созданием, — сняты: повторное
        //    добавление побеждает удаление, надгробие уходит из документа
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = 'bookmark' AND deleted_at <= \
             (SELECT added_at FROM bookmarks WHERE bookmarks.url = sync_tombstones.key)",
            [],
        )
        .map_err(err_sql)?;
        tx.execute(
            "DELETE FROM sync_tombstones WHERE kind = 'group' AND deleted_at <= \
             (SELECT created_at FROM bookmark_groups WHERE bookmark_groups.name = sync_tombstones.key)",
            [],
        )
        .map_err(err_sql)?;
        tx.commit().map_err(err_sql)?;
        Ok(stats)
    }

    // --- задача 5.1: экспорт/импорт профиля -----------------------------------

    /// Дамп всех закладок (экспорт профиля; url — ключ, даты сохраняются).
    /// Строки несут членства групп (groups: id машины-источника + имя).
    pub fn dump_bookmarks(&self) -> Result<Vec<HistoryBookmark>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let mut stmt = conn
            .prepare("SELECT id, url, title, added_at FROM bookmarks ORDER BY added_at, url")
            .map_err(err_sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    HistoryBookmark {
                        url: r.get(1)?,
                        title: r.get(2)?,
                        added_at: r.get(3)?,
                        groups: Vec::new(),
                    },
                ))
            })
            .map_err(err_sql)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err_sql)?;
        let ids: Vec<i64> = rows.iter().map(|(id, _)| *id).collect();
        let refs = group_refs_of(&conn, &ids).map_err(err_sql)?;
        Ok(rows
            .into_iter()
            .map(|(id, mut b)| {
                b.groups = refs.get(&id).cloned().unwrap_or_default();
                b
            })
            .collect())
    }

    /// Дамп групп (экспорт профиля): позиция, сортировка, флаг «по
    /// умолчанию»; id — локальный (импорт мапит по имени).
    pub fn dump_groups(&self) -> Result<Vec<BookmarkGroupRow>, String> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let mut stmt = conn
            .prepare(
                "SELECT id, name, position, sort_by, is_default
                 FROM bookmark_groups ORDER BY position, id",
            )
            .map_err(err_sql)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(BookmarkGroupRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    position: r.get::<_, i64>(2)? as u32,
                    sort_by: r.get(3)?,
                    is_default: r.get::<_, i64>(4)? != 0,
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

    /// Импорт групп (переезд профиля): соответствие по имени — на машине-
    /// приёмнике свои id (в т.ч. группа по умолчанию уже есть); новые группы
    /// дописываются в конец, существующим обновляется режим сортировки.
    /// Ответ — карта id файла → локальный id (для членств закладок).
    /// Группа с is_default переносит флаг «по умолчанию» на локальную группу
    /// с этим именем (если имени нет — создаётся новая и становится default).
    pub fn import_groups(
        &self,
        rows: &[BookmarkGroupRow],
    ) -> Result<std::collections::BTreeMap<i64, i64>, String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let mut map = std::collections::BTreeMap::new();
        let mut next_pos: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_groups",
                [],
                |r| r.get(0),
            )
            .map_err(err_sql)?;
        for row in rows {
            let name = row.name.trim();
            if name.is_empty() {
                continue;
            }
            let local: Option<i64> = tx
                .query_row(
                    "SELECT id FROM bookmark_groups WHERE name = ?1",
                    [name],
                    |r| r.get(0),
                )
                .map(Some)
                .or_else(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => Ok(None),
                    other => Err(other),
                })
                .map_err(err_sql)?;
            let id = match local {
                Some(id) => {
                    tx.execute(
                        "UPDATE bookmark_groups SET sort_by = ?1 WHERE id = ?2",
                        rusqlite::params![normalize_sort_by(&row.sort_by), id],
                    )
                    .map_err(err_sql)?;
                    id
                }
                None => {
                    tx.execute(
                        "INSERT INTO bookmark_groups(name, position, sort_by, is_default,
                                                     created_at)
                         VALUES (?1, ?2, ?3, 0, ?4)",
                        rusqlite::params![
                            name,
                            next_pos,
                            normalize_sort_by(&row.sort_by),
                            now_ms()
                        ],
                    )
                    .map_err(err_sql)?;
                    next_pos += 1;
                    tx.last_insert_rowid()
                }
            };
            map.insert(row.id, id);
        }
        // флаг «по умолчанию» — с файла на локальную группу (ровно один)
        if let Some(src_default) = rows.iter().find(|r| r.is_default) {
            if let Some(&local) = map.get(&src_default.id) {
                tx.execute(
                    "UPDATE bookmark_groups SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
                    [local],
                )
                .map_err(err_sql)?;
            }
        }
        tx.commit().map_err(err_sql)?;
        Ok(map)
    }

    /// Импорт закладок (переезд профиля): существующий url получает заголовок
    /// из файла (непустой), дата добавления сохраняется у новых. Членства
    /// групп применяются по карте import_groups (фолбэк — имя); закладка без
    /// групп в файле становится членом группы по умолчанию (как при миграции
    /// плоского списка). Возвращает число вставленных.
    pub fn import_bookmarks(
        &self,
        rows: &[HistoryBookmark],
        group_map: &std::collections::BTreeMap<i64, i64>,
    ) -> Result<u32, String> {
        let mut conn = self.conn.lock().expect("history: лок не отравлен");
        let tx = conn.transaction().map_err(err_sql)?;
        let mut inserted = 0u32;
        for b in rows {
            if b.url.trim().is_empty() {
                continue;
            }
            // upsert (даты — из файла), членства — ниже по карте/имени
            let (id, was_new) = Self::bookmark_add_tx(&tx, &b.url, &b.title, None, b.added_at)?;
            if was_new {
                inserted += 1;
            }
            // членства: карта id файла → локальный; фолбэк — совпадение имени
            let mut gids: Vec<i64> = Vec::new();
            for r in &b.groups {
                if let Some(local) = group_map.get(&r.id) {
                    gids.push(*local);
                } else {
                    let by_name: Option<i64> = tx
                        .query_row(
                            "SELECT id FROM bookmark_groups WHERE name = ?1",
                            [r.name.trim()],
                            |row| row.get(0),
                        )
                        .map(Some)
                        .or_else(|e| match e {
                            rusqlite::Error::QueryReturnedNoRows => Ok(None),
                            other => Err(other),
                        })
                        .map_err(err_sql)?;
                    if let Some(local) = by_name {
                        gids.push(local);
                    }
                }
            }
            if gids.is_empty() && was_new {
                // файл без групп (старый формат) — в группу по умолчанию
                gids.push(
                    tx.query_row(
                        "SELECT id FROM bookmark_groups WHERE is_default = 1",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(err_sql)?,
                );
            }
            for gid in gids {
                tx.execute(
                    "INSERT OR IGNORE INTO bookmark_group_items(group_id, bookmark_id, position)
                     VALUES (?1, ?2,
                         (SELECT COALESCE(MAX(position) + 1, 0) FROM bookmark_group_items
                          WHERE group_id = ?1))",
                    rusqlite::params![gid, id],
                )
                .map_err(err_sql)?;
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

/// Фильтр/порядок списка закладок по группам (карточка duopulse-058):
/// All — все, свежие первыми; Group(id) — члены группы в её порядке
/// сортировки; Ungrouped — вне групп, свежие первыми.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupFilter {
    All,
    Group(i64),
    Ungrouped,
}

// --- этап 5 duopulse-111: документ облачного синка закладок ------------------

/// Вид надгробия: закладка (ключ — url) или группа (ключ — имя).
pub const TOMBSTONE_BOOKMARK: &str = "bookmark";
pub const TOMBSTONE_GROUP: &str = "group";

/// Закладка облачного документа синка (этап 5 duopulse-111): группы — имена
/// (id групп на машинах различаются), updated_at — арбитр свежести заголовка
/// при слиянии (переименование).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBookmark {
    pub url: String,
    pub title: String,
    pub added_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub groups: Vec<String>,
}

/// Группа облачного документа: имя — ключ слияния, created_at — арбитр
/// против надгробия удаления.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncGroup {
    pub name: String,
    pub sort_by: String,
    pub created_at: i64,
}

/// Надгробие удаления: kind — TOMBSTONE_BOOKMARK | TOMBSTONE_GROUP,
/// key — url | имя группы, deleted_at — когда удалили.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTombstone {
    pub kind: String,
    pub key: String,
    pub deleted_at: i64,
}

/// Облачный документ закладок (шифруется целиком ключом синка, aila.rs).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkSyncDoc {
    pub v: u8,
    #[serde(default)]
    pub bookmarks: Vec<SyncBookmark>,
    #[serde(default)]
    pub groups: Vec<SyncGroup>,
    #[serde(default)]
    pub tombstones: Vec<SyncTombstone>,
}

/// Итог слияния облачных закладок в локальное хранилище.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct BookmarkMergeStats {
    /// добавлено/обновлено из облака.
    pub applied: u64,
    /// удалено локально по надгробиям.
    pub removed: u64,
}

/// Все надгробия: (kind, key) → deleted_at (общее для дампа и слияния).
fn tombstones_of(
    conn: &Connection,
) -> Result<std::collections::HashMap<(String, String), i64>, String> {
    let mut stmt = conn
        .prepare("SELECT kind, key, deleted_at FROM sync_tombstones")
        .map_err(err_sql)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(err_sql)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(err_sql)?;
    Ok(rows.into_iter().collect())
}

/// Членства групп закладок: id закладки → (id группы, имя) по позициям групп
/// (общее для списка закладок и дампа профиля). Чанками — лимит переменных
/// SQLite на старых движках.
fn group_refs_of(
    conn: &Connection,
    ids: &[i64],
) -> rusqlite::Result<std::collections::HashMap<i64, Vec<BookmarkGroupRef>>> {
    let mut map: std::collections::HashMap<i64, Vec<BookmarkGroupRef>> =
        std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT i.bookmark_id, g.id, g.name
             FROM bookmark_group_items i JOIN bookmark_groups g ON g.id = i.group_id
             WHERE i.bookmark_id IN ({placeholders})
             ORDER BY i.bookmark_id, g.position, g.id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                BookmarkGroupRef {
                    id: r.get(1)?,
                    name: r.get(2)?,
                },
            ))
        })?;
        for row in rows {
            let (bid, rf) = row?;
            map.entry(bid).or_default().push(rf);
        }
    }
    Ok(map)
}

/// Имена групп одним текстом «Имя · Имя» (подсказки omnibox): id закладки →
/// конкатенация (порядок групп — их позиции).
fn group_labels(
    conn: &Connection,
    ids: &[i64],
) -> rusqlite::Result<std::collections::HashMap<i64, String>> {
    let mut map: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
    for chunk in ids.chunks(500) {
        if chunk.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT i.bookmark_id, GROUP_CONCAT(g.name, ' · ')
             FROM bookmark_group_items i JOIN bookmark_groups g ON g.id = i.group_id
             WHERE i.bookmark_id IN ({placeholders})
             GROUP BY i.bookmark_id"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(chunk), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        for row in rows {
            let (bid, label) = row?;
            if let Some(label) = label {
                map.insert(bid, label);
            }
        }
    }
    Ok(map)
}

/// Канонический режим сортировки группы (неизвестный — «вручную»).
fn normalize_sort_by(s: &str) -> &'static str {
    match s.trim() {
        "title" => "title",
        "added" => "added",
        _ => "manual",
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
            .bookmark_add_to("https://www.youtube.com/", "YouTube", None)
            .unwrap();
        store
            .bookmark_add_to(
                "https://ru.wikipedia.org/",
                "Википедия — свободная энциклопедия",
                None,
            )
            .unwrap();
        store
            .bookmark_add_to("https://github.com/", "GitHub: Let's build from here", None)
            .unwrap();
        store
            .bookmark_add_to("https://developer.mozilla.org/ru/", "MDN Web Docs", None)
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
            .bookmark_add_to("https://c.example/", "статья три (закладка)", None)
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
        store
            .bookmark_add_to("https://a.example/", "A", None)
            .unwrap();
        // повторное добавление: обновляет заголовок, дата не сбрасывается в 0
        store
            .bookmark_add_to("https://a.example/", "A v2", None)
            .unwrap();
        store
            .bookmark_add_to("https://b.example/", "B", None)
            .unwrap();
        let (marks, total) = store.bookmark_list("", GroupFilter::All, 0, 100).unwrap();
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
        store
            .bookmark_add_to("https://b.example/", "", None)
            .unwrap();
        assert_eq!(
            store
                .bookmark_list("", GroupFilter::All, 0, 100)
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
        assert_eq!(
            store.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1,
            1
        );
        assert!(
            store.search("a v2", 8).unwrap().is_empty(),
            "индекс закладки тоже удалён"
        );
        // правка несуществующей — ошибка
        assert!(store.bookmark_update("https://nope.example/", "x").is_err());
        // FTS-фильтр списка
        assert_eq!(
            store
                .bookmark_list("новое", GroupFilter::All, 0, 100)
                .unwrap()
                .1,
            1
        );
    }

    #[test]
    fn bookmark_survives_history_deletion_of_same_url() {
        let store = HistoryStore::open_in_memory().unwrap();
        store.visit("https://a.example/", "A").unwrap();
        store
            .bookmark_add_to("https://a.example/", "A", None)
            .unwrap();
        store.delete_urls(&["https://a.example/".into()]).unwrap();
        assert_eq!(
            store.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1,
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

    // --- карточка duopulse-058: группы избранного -----------------------------

    /// Миграция duopulse.db с плоским списком закладок (до карточки 058):
    /// все закладки — в «Избранное» (is_default) в порядке добавления,
    /// ничего не теряется. Повторное открытие не пересобирает членства.
    #[test]
    fn migration_moves_flat_bookmarks_to_default_group() {
        let dir = std::env::temp_dir().join(format!("duopulse-migrate-{}", std::process::id()));
        let path = dir.join("duopulse.db");
        let _ = std::fs::remove_file(&path);
        std::fs::create_dir_all(&dir).unwrap();
        {
            // старая схема: без bookmark_groups/bookmark_group_items
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE bookmarks(
                     id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE,
                     title TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL);
                 CREATE VIRTUAL TABLE search USING fts5(
                     title, url, source UNINDEXED, ref UNINDEXED);
                 INSERT INTO bookmarks(url, title, added_at) VALUES
                     ('https://a.example/', 'A', 100),
                     ('https://b.example/', 'B', 300),
                     ('https://c.example/', 'C', 200);",
            )
            .unwrap();
        }
        let store = HistoryStore::open(&dir).unwrap();
        let groups = store.group_list().unwrap();
        assert_eq!(groups.len(), 1);
        let fav = &groups[0];
        assert_eq!(fav.name, "Избранное");
        assert!(fav.is_default);
        assert_eq!(fav.count, 3, "все закладки мигрировали");
        // порядок внутри группы — по added_at (A, C, B)
        let (marks, total) = store
            .bookmark_list("", GroupFilter::Group(fav.id), 0, 100)
            .unwrap();
        assert_eq!(total, 3);
        assert_eq!(
            marks.iter().map(|m| m.url.as_str()).collect::<Vec<_>>(),
            vec![
                "https://a.example/",
                "https://c.example/",
                "https://b.example/"
            ]
        );
        // «Все» по-прежнему всё
        assert_eq!(
            store.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1,
            3
        );

        // снятие членства переживает переоткрытие (миграция не повторяется)
        store
            .group_toggle_bookmark("https://a.example/", fav.id, false)
            .unwrap();
        drop(store);
        let store = HistoryStore::open(&dir).unwrap();
        assert_eq!(
            store
                .bookmark_list("", GroupFilter::Ungrouped, 0, 100)
                .unwrap()
                .1,
            1,
            "a.example осталась без группы"
        );
        assert_eq!(
            store
                .bookmark_list("", GroupFilter::Group(fav.id), 0, 100)
                .unwrap()
                .1,
            2
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(dir.join("duopulse.db-wal"));
        let _ = std::fs::remove_file(dir.join("duopulse.db-shm"));
        let _ = std::fs::remove_dir(&dir);
    }

    /// Свежая база: группа по умолчанию есть и без закладок; Ctrl+D
    /// (toggle_bookmark) кладёт новые закладки в неё.
    #[test]
    fn fresh_db_has_default_group_and_toggle_uses_it() {
        let store = HistoryStore::open_in_memory().unwrap();
        let groups = store.group_list().unwrap();
        assert_eq!(groups.len(), 1);
        assert!(groups[0].is_default);
        assert!(store.toggle_bookmark("https://x.example/", "X").unwrap());
        let (marks, _) = store
            .bookmark_list("", GroupFilter::Group(groups[0].id), 0, 100)
            .unwrap();
        assert_eq!(marks.len(), 1);
        assert_eq!(marks[0].groups.len(), 1);
        assert_eq!(marks[0].groups[0].name, "Избранное");
    }

    /// CRUD групп + членства: создание/переименование/удаление, дубликаты
    /// имён, защита группы по умолчанию, множественные членства, «без группы».
    #[test]
    fn group_crud_and_membership() {
        let store = HistoryStore::open_in_memory().unwrap();
        let fav = store.group_list().unwrap().remove(0);
        let work = store.group_add("Работа").unwrap();
        let study = store.group_add("Учёба").unwrap();
        // позиции растут, счётчики нулевые
        let groups = store.group_list().unwrap();
        assert_eq!(
            groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            vec!["Избранное", "Работа", "Учёба"]
        );
        assert!(groups.iter().all(|g| g.count == 0));

        // пустое имя и дубликат — ошибки
        assert!(store.group_add("   ").is_err());
        assert!(store.group_add("Работа").is_err());
        // переименование в занятое имя — ошибка, в своё — ок
        assert!(store.group_rename(work.id, "Учёба").is_err());
        store.group_rename(work.id, "Работа и проект").unwrap();
        assert!(store.group_rename(999, "нет такой").is_err());
        // группу по умолчанию удалить нельзя, прочие — можно
        assert!(store.group_remove(fav.id).is_err());
        store.group_remove(study.id).unwrap();
        assert_eq!(store.group_list().unwrap().len(), 2);

        // закладки и членства
        store
            .bookmark_add_to("https://a.example/", "A", None)
            .unwrap();
        store
            .bookmark_add_to("https://b.example/", "B", Some(work.id))
            .unwrap();
        // b — в двух группах, a — только в «Избранное»
        store
            .group_toggle_bookmark("https://b.example/", fav.id, true)
            .unwrap();
        let groups = store.group_list().unwrap();
        let w = groups.iter().find(|g| g.name == "Работа и проект").unwrap();
        let f = groups.iter().find(|g| g.is_default).unwrap();
        assert_eq!((f.count, w.count), (2, 1));
        // строки несут свои группы
        let (marks, _) = store.bookmark_list("", GroupFilter::All, 0, 100).unwrap();
        let b = marks.iter().find(|m| m.url.contains("b.example")).unwrap();
        assert_eq!(b.groups.len(), 2);
        // неизвестная группа/закладка — ошибки
        assert!(
            store
                .group_toggle_bookmark("https://b.example/", study.id, true)
                .is_err(),
            "группа удалена"
        );
        assert!(store
            .group_toggle_bookmark("https://nope.example/", work.id, true)
            .is_err());
        assert!(store
            .bookmark_add_to("https://c.example/", "C", Some(999))
            .is_err());

        // снятие обоих членств — закладка «без группы», но жива
        store
            .group_toggle_bookmark("https://b.example/", fav.id, false)
            .unwrap();
        store
            .group_toggle_bookmark("https://b.example/", work.id, false)
            .unwrap();
        assert_eq!(
            store
                .bookmark_list("", GroupFilter::Ungrouped, 0, 100)
                .unwrap()
                .1,
            1
        );
        assert_eq!(
            store.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1,
            2,
            "«Все» показывает и безгруппные"
        );
        // FTS-фильтр работает вместе с фильтром группы
        assert_eq!(
            store
                .bookmark_list("b.example", GroupFilter::Ungrouped, 0, 100)
                .unwrap()
                .1,
            1
        );
        // удаление группы снимает членства (каскад), закладки живы
        store
            .group_toggle_bookmark("https://a.example/", work.id, true)
            .unwrap();
        store.group_remove(work.id).unwrap();
        assert_eq!(
            store.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1,
            2
        );
        // удаление закладки тоже снимает членства без остатка
        store.bookmark_remove("https://a.example/").unwrap();
        let groups = store.group_list().unwrap();
        assert_eq!(groups[0].count, 0, "членства a.example ушли вместе с ней");
    }

    /// Сортировка группы: manual — позиции (bookmark_move/drag&drop),
    /// title — по имени без учёта регистра, added — свежие первыми.
    #[test]
    fn group_sort_modes_and_manual_move() {
        let store = HistoryStore::open_in_memory().unwrap();
        let fav = store.group_list().unwrap().remove(0);
        let read = store.group_add("Чтение").unwrap();
        for (url, title) in [
            ("https://w.example/", "Википедия"),
            ("https://g.example/", "GitHub"),
            ("https://m.example/", "mdn"),
        ] {
            store.bookmark_add_to(url, title, Some(read.id)).unwrap();
        }
        let urls = |g: GroupFilter| {
            store
                .bookmark_list("", g, 0, 100)
                .unwrap()
                .0
                .iter()
                .map(|m| m.url.as_str().to_string())
                .collect::<Vec<_>>()
        };
        // manual: порядок вставки
        assert_eq!(
            urls(GroupFilter::Group(read.id)),
            vec![
                "https://w.example/",
                "https://g.example/",
                "https://m.example/"
            ]
        );
        // перемещение вверх: m → позиция 0; кламп за пределы — в конец
        store
            .bookmark_move("https://m.example/", read.id, 0)
            .unwrap();
        store
            .bookmark_move("https://w.example/", read.id, 99)
            .unwrap();
        assert_eq!(
            urls(GroupFilter::Group(read.id)),
            vec![
                "https://m.example/",
                "https://g.example/",
                "https://w.example/"
            ],
            "[w,g,m] → m наверх → w в конец → [m,g,w]"
        );
        assert!(
            store
                .bookmark_move("https://w.example/", fav.id, 0)
                .is_err(),
            "w не в «Избранное» — перемещать нельзя"
        );

        // title: без учёта регистра
        store.group_set_sort(read.id, "title").unwrap();
        store.group_set_sort(999, "title").unwrap_err();
        assert_eq!(
            urls(GroupFilter::Group(read.id)),
            vec![
                "https://g.example/",
                "https://m.example/",
                "https://w.example/"
            ],
            "GitHub < mdn < Википедия (латиница раньше кириллицы)"
        );
        // added: свежие первыми — задаём явные added_at (в цикле добавления
        // миллисекунды совпадают, тогда порядок решает url-тайбрейк)
        {
            let conn = store.conn.lock().expect("history: лок не отравлен");
            conn.execute(
                "UPDATE bookmarks SET added_at = 3000 WHERE url = 'https://m.example/'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE bookmarks SET added_at = 2000 WHERE url = 'https://g.example/'",
                [],
            )
            .unwrap();
            conn.execute(
                "UPDATE bookmarks SET added_at = 1000 WHERE url = 'https://w.example/'",
                [],
            )
            .unwrap();
        }
        store.group_set_sort(read.id, "added").unwrap();
        assert_eq!(
            urls(GroupFilter::Group(read.id)),
            vec![
                "https://m.example/",
                "https://g.example/",
                "https://w.example/"
            ]
        );
        // неизвестный режим — «вручную» (не ошибка)
        store.group_set_sort(read.id, "мусор").unwrap();
        assert_eq!(
            urls(GroupFilter::Group(read.id)),
            vec![
                "https://m.example/",
                "https://g.example/",
                "https://w.example/"
            ]
        );
    }

    /// Подсказки omnibox несут имена групп закладки (пустой запрос и FTS);
    /// вне групп — None.
    #[test]
    fn search_hits_carry_group_labels() {
        let store = HistoryStore::open_in_memory().unwrap();
        let fav = store.group_list().unwrap().remove(0);
        let work = store.group_add("Работа").unwrap();
        store
            .bookmark_add_to("https://rust.example/", "Rust", Some(fav.id))
            .unwrap();
        store
            .group_toggle_bookmark("https://rust.example/", work.id, true)
            .unwrap();
        store
            .bookmark_add_to("https://plain.example/", "Plain", None)
            .unwrap();
        // пустой запрос — закладки с метками
        let hits = store.search("", 8).unwrap();
        let rust = hits
            .iter()
            .find(|h| h.url.contains("rust.example"))
            .unwrap();
        let label = rust.group.as_deref().unwrap();
        assert!(
            label.contains("Избранное") && label.contains("Работа"),
            "«{label}»"
        );
        // FTS-поиск — метка у bookmark-подсказок, у history — None
        let hits = store.search("rust", 8).unwrap();
        let rust = hits
            .iter()
            .find(|h| h.url.contains("rust.example"))
            .unwrap();
        assert!(rust.group.as_deref().unwrap().contains("Избранное"));
        assert!(hits
            .iter()
            .all(|h| h.group.is_none() || h.source == HistorySource::Bookmark));
        // одиночная группа — просто имя, без разделителя
        let hits = store.search("plain", 8).unwrap();
        let plain = hits
            .iter()
            .find(|h| h.url.contains("plain.example"))
            .unwrap();
        assert_eq!(plain.group.as_deref(), Some("Избранное"));
    }

    /// Импорт групп (профиль): соответствие по имени, новые — в конец,
    /// is_default с файла переносится на локальную группу.
    #[test]
    fn import_groups_maps_by_name_and_moves_default() {
        let store = HistoryStore::open_in_memory().unwrap();
        let map = store
            .import_groups(&[
                BookmarkGroupRow {
                    id: 10,
                    name: "Избранное".into(),
                    position: 0,
                    sort_by: "manual".into(),
                    is_default: true,
                },
                BookmarkGroupRow {
                    id: 11,
                    name: "Работа".into(),
                    position: 1,
                    sort_by: "title".into(),
                    is_default: false,
                },
            ])
            .unwrap();
        let fav_local = store.group_list().unwrap().remove(0).id;
        assert_eq!(map.get(&10), Some(&fav_local), "«Избранное» смапилась");
        let work_local = *map.get(&11).unwrap();
        assert_ne!(work_local, fav_local);
        let groups = store.group_list().unwrap();
        let w = groups.iter().find(|g| g.id == work_local).unwrap();
        assert_eq!((w.name.as_str(), w.sort_by.as_str()), ("Работа", "title"));
        assert!(groups.iter().filter(|g| g.is_default).count() == 1);
        // пустые имена пропускаются
        let map2 = store
            .import_groups(&[BookmarkGroupRow {
                id: 12,
                name: "  ".into(),
                position: 9,
                sort_by: "manual".into(),
                is_default: false,
            }])
            .unwrap();
        assert!(map2.is_empty());
        assert_eq!(store.group_list().unwrap().len(), 2);
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
            store
                .bookmark_add_to("https://b.example/", "B", None)
                .unwrap();
        }
        let store = HistoryStore::open(&dir).unwrap();
        assert_eq!(store.list("", 0, 100).unwrap().1, 1);
        assert_eq!(
            store.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1,
            1
        );
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
        let groups = src.dump_groups().unwrap();
        assert_eq!(visits.len(), 13);
        assert_eq!(marks.len(), 4);
        assert_eq!(groups.len(), 1, "у сида одна группа — «Избранное»");
        assert!(marks.iter().all(|m| m.groups.len() == 1));

        // «чистая машина»: другой store (in-memory), импорт, сверка
        let dst = HistoryStore::open_in_memory().unwrap();
        let empty_map = std::collections::BTreeMap::new();
        assert_eq!(dst.import_bookmarks(&marks, &empty_map).unwrap(), 4);
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
        assert_eq!(dst.import_bookmarks(&marks, &empty_map).unwrap(), 0);
        assert_eq!(dst.dump_visits().unwrap().len(), 13);

        // существующая закладка обновляет заголовок, дата не сбрасывается
        let mut changed = marks[0].clone();
        changed.title = "Новое имя".into();
        assert_eq!(
            dst.import_bookmarks(std::slice::from_ref(&changed), &empty_map)
                .unwrap(),
            0
        );
        let (all, _) = dst.bookmark_list("", GroupFilter::All, 0, 100).unwrap();
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

    // --- этап 5 duopulse-111: синк закладок -----------------------------------

    /// Две «машины»: закладки и группы, добавленные на A, после слияния
    /// документа A есть на B (членства — по именам групп); повторное слияние
    /// того же документа ничего не меняет.
    #[test]
    fn sync_doc_moves_bookmarks_and_groups_between_machines() {
        let a = HistoryStore::open_in_memory().unwrap();
        let b = HistoryStore::open_in_memory().unwrap();
        let work = a.group_add("Музыка").unwrap();
        a.bookmark_add_to("https://yt.example/", "YouTube", None)
            .unwrap();
        a.bookmark_add_to("https://m.example/track", "Трек", Some(work.id))
            .unwrap();
        let doc = a.export_sync_doc().unwrap();
        assert_eq!(doc.bookmarks.len(), 2);
        assert_eq!(doc.groups.len(), 2); // «Избранное» + «Музыка»
        assert!(doc
            .bookmarks
            .iter()
            .find(|x| x.url == "https://m.example/track")
            .unwrap()
            .groups
            .contains(&"Музыка".to_string()));

        // машина B сливает: обе закладки и группа приехали, членство по имени
        let st = b.merge_sync_doc(&doc).unwrap();
        assert_eq!((st.applied, st.removed), (3, 0)); // 2 закладки + группа
        let (marks, total) = b.bookmark_list("", GroupFilter::All, 0, 100).unwrap();
        assert_eq!(total, 2);
        let track = marks.iter().find(|m| m.url.contains("m.example")).unwrap();
        assert_eq!(track.title, "Трек");
        assert!(track.groups.iter().any(|g| g.name == "Музыка"));
        assert_eq!(
            b.group_list()
                .unwrap()
                .iter()
                .map(|g| g.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Избранное", "Музыка"],
            "группа приехала, своя «Избранное» осталась"
        );

        // повторное слияние того же документа — идемпотентно
        let st = b.merge_sync_doc(&doc).unwrap();
        assert_eq!((st.applied, st.removed), (0, 0));
        // обратное слияние документа B в A тоже ничего не меняет
        let st = a.merge_sync_doc(&b.export_sync_doc().unwrap()).unwrap();
        assert_eq!((st.applied, st.removed), (0, 0));
        assert_eq!(a.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1, 2);
    }

    /// Удаление синкается надгробием: remove на A → B удаляет; документ B
    /// несёт надгробие дальше — на A закладка не воскресает.
    #[test]
    fn tombstone_syncs_deletion_and_prevents_resurrection() {
        let a = HistoryStore::open_in_memory().unwrap();
        let b = HistoryStore::open_in_memory().unwrap();
        a.bookmark_add_to("https://gone.example/", "Удалюсь", None)
            .unwrap();
        b.merge_sync_doc(&a.export_sync_doc().unwrap()).unwrap();
        assert!(b.is_bookmarked("https://gone.example/"));

        // удаление строго позже добавления (сравнения — по миллисекундам)
        std::thread::sleep(std::time::Duration::from_millis(2));
        a.bookmark_remove("https://gone.example/").unwrap();
        let doc = a.export_sync_doc().unwrap();
        assert!(
            doc.tombstones
                .iter()
                .any(|t| t.kind == TOMBSTONE_BOOKMARK && t.key == "https://gone.example/"),
            "удаление оставило надгробие в документе"
        );
        let st = b.merge_sync_doc(&doc).unwrap();
        assert_eq!(st.removed, 1);
        assert!(!b.is_bookmarked("https://gone.example/"));
        assert!(
            b.search("удалюсь", 8).unwrap().is_empty(),
            "строка индекса удалена тоже"
        );

        // документ B уносит надгробие дальше: на A закладка не воскресает
        let st = a.merge_sync_doc(&b.export_sync_doc().unwrap()).unwrap();
        assert_eq!((st.applied, st.removed), (0, 0));
        assert!(!a.is_bookmarked("https://gone.example/"));
    }

    /// Повторное добавление после удаления побеждает надгробие (свежее
    /// added_at): на другой машине закладка живёт, надгробия сходят на нет
    /// с обеих сторон.
    #[test]
    fn readd_after_delete_beats_tombstone() {
        let a = HistoryStore::open_in_memory().unwrap();
        let b = HistoryStore::open_in_memory().unwrap();
        // машина A: добавила (t=100) → удалила (t=1000) → добавила снова
        // (t=9000, свежее надгробия). Время управляем руками ДО синка.
        a.bookmark_add_to("https://back.example/", "Вернусь", None)
            .unwrap();
        {
            let conn = a.conn.lock().expect("history: лок не отравлен");
            conn.execute("UPDATE bookmarks SET added_at = 100, updated_at = 100", [])
                .unwrap();
        }
        a.bookmark_remove("https://back.example/").unwrap();
        {
            let conn = a.conn.lock().expect("history: лок не отравлен");
            conn.execute("UPDATE sync_tombstones SET deleted_at = 1000", [])
                .unwrap();
        }
        a.bookmark_add_to("https://back.example/", "Вернулся", None)
            .unwrap();
        {
            let conn = a.conn.lock().expect("history: лок не отравлен");
            conn.execute(
                "UPDATE bookmarks SET added_at = 9000, updated_at = 9000 \
                 WHERE url = 'https://back.example/'",
                [],
            )
            .unwrap();
        }
        let doc = a.export_sync_doc().unwrap();
        // надгробие ещё в документе (экспорт не чистит), но добавление свежее —
        // машина B обязана принять закладку, а не похоронить
        let st = b.merge_sync_doc(&doc).unwrap();
        assert!(b.is_bookmarked("https://back.example/"));
        assert_eq!(st.removed, 0);
        assert!(
            b.export_sync_doc().unwrap().tombstones.is_empty(),
            "у B надгробие снято (пережито более поздним добавлением)"
        );
        // ответ B чистит надгробие и у A
        let st = a.merge_sync_doc(&b.export_sync_doc().unwrap()).unwrap();
        assert_eq!((st.applied, st.removed), (0, 0));
        assert!(a.export_sync_doc().unwrap().tombstones.is_empty());
    }

    /// Переименование синкается по updated_at: свежее имя выигрывает,
    /// старый облачный заголовок более свежее локальное не затирает.
    #[test]
    fn rename_syncs_by_updated_at() {
        let a = HistoryStore::open_in_memory().unwrap();
        let b = HistoryStore::open_in_memory().unwrap();
        a.bookmark_add_to("https://r.example/", "Старое имя", None)
            .unwrap();
        b.merge_sync_doc(&a.export_sync_doc().unwrap()).unwrap();

        // A переименовала — B берёт новое имя (переименование строго свежее:
        // updated_at сравнивается по миллисекундам)
        std::thread::sleep(std::time::Duration::from_millis(2));
        a.bookmark_update("https://r.example/", "Новое имя")
            .unwrap();
        let st = b.merge_sync_doc(&a.export_sync_doc().unwrap()).unwrap();
        assert_eq!(st.applied, 1);
        assert_eq!(
            b.bookmark_list("", GroupFilter::All, 0, 100)
                .unwrap()
                .0
                .iter()
                .find(|m| m.url == "https://r.example/")
                .unwrap()
                .title,
            "Новое имя"
        );

        // устаревший документ (старый updated_at) более свежий локальный
        // заголовок не перезаписывает
        let stale_doc = BookmarkSyncDoc {
            v: 1,
            bookmarks: vec![SyncBookmark {
                url: "https://r.example/".into(),
                title: "Древнее имя".into(),
                added_at: 1,
                updated_at: 1,
                groups: vec![],
            }],
            groups: vec![],
            tombstones: vec![],
        };
        b.merge_sync_doc(&stale_doc).unwrap();
        assert_eq!(
            b.bookmark_list("", GroupFilter::All, 0, 100)
                .unwrap()
                .0
                .iter()
                .find(|m| m.url == "https://r.example/")
                .unwrap()
                .title,
            "Новое имя"
        );
    }

    /// Удаление группы синкается надгробием по имени: группа уходит на другой
    /// машине, её закладки живы (членства сняты каскадом).
    #[test]
    fn group_deletion_tombstone_keeps_bookmarks() {
        let a = HistoryStore::open_in_memory().unwrap();
        let b = HistoryStore::open_in_memory().unwrap();
        let work = a.group_add("Работа").unwrap();
        a.bookmark_add_to("https://task.example/", "Задача", Some(work.id))
            .unwrap();
        b.merge_sync_doc(&a.export_sync_doc().unwrap()).unwrap();
        assert_eq!(b.group_list().unwrap().len(), 2);

        a.group_remove(work.id).unwrap();
        let doc = a.export_sync_doc().unwrap();
        assert!(doc
            .tombstones
            .iter()
            .any(|t| t.kind == TOMBSTONE_GROUP && t.key == "Работа"));
        let st = b.merge_sync_doc(&doc).unwrap();
        assert_eq!(st.removed, 1);
        assert_eq!(
            b.group_list()
                .unwrap()
                .iter()
                .map(|g| g.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Избранное"],
            "группа удалена надгробием"
        );
        assert!(b.is_bookmarked("https://task.example/"), "закладка жива");
        assert_eq!(
            b.bookmark_list("", GroupFilter::Ungrouped, 0, 100)
                .unwrap()
                .1,
            1,
            "членство снято — закладка «без группы»"
        );
    }

    /// Без синка локальная работа не меняется: удаление/повторное добавление
    /// на месте, надгробия не мешают спискам и поиску; слияние своего же
    /// документа снимает пережитые надгробия (самолечение).
    #[test]
    fn local_crud_unaffected_and_selfheal_prunes_stale_tombstone() {
        let s = HistoryStore::open_in_memory().unwrap();
        s.bookmark_add_to("https://plain.example/", "Обычная", None)
            .unwrap();
        s.bookmark_remove("https://plain.example/").unwrap();
        s.bookmark_add_to("https://plain.example/", "Снова", None)
            .unwrap();
        assert!(s.is_bookmarked("https://plain.example/"));
        assert_eq!(s.bookmark_list("", GroupFilter::All, 0, 100).unwrap().1, 1);
        assert!(!s.search("снова", 8).unwrap().is_empty());
        // надгробие пережито повторным добавлением — слияние своего документа
        // его снимает
        let doc = s.export_sync_doc().unwrap();
        assert!(
            !doc.tombstones.is_empty(),
            "до самолечения надгробие на месте"
        );
        s.merge_sync_doc(&doc).unwrap();
        assert!(s.export_sync_doc().unwrap().tombstones.is_empty());
    }
}
