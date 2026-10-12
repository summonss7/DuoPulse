//! История и закладки для подсказок omnibox (задача 1.3, docs/05 §1
//! src/history/, словарь контракта `history.search`).
//!
//! ВРЕМЕННАЯ реализация задачи 1.3: in-memory SQLite с FTS5-индексом и
//! фиксированным сид-набором популярных адресов (запись визитов, файл в
//! профиле, страница управления — задача 1.4; полная интеграция там же).
//! Контракт команды и схема FTS спроектированы так, чтобы 1.4 заменила
//! хранение, не меняя словарь: колонки (title, url, source) сохранятся.
//!
//! Поиск — полнотекстовый (FTS5, токенизатор unicode61: латиница и кириллица),
//! каждый токен запроса — префиксный (для «you» находится «youtube»),
//! ранжирование bm25; пустой запрос отдаёт закладки (подсказки на фокус
//! omnibox).

use std::sync::Mutex;

use rusqlite::Connection;

use crate::bridge::{HistoryHit, HistorySource};

/// Подсказки omnibox: FTS-индекс истории и закладок.
pub struct HistoryStore {
    conn: Mutex<Connection>,
}

impl HistoryStore {
    /// In-memory хранилище с сид-набором (временные данные задачи 1.3).
    pub fn seeded() -> Self {
        let store = Self::empty();
        let seed: &[(&str, &str)] = &[
            // закладки — первыми: пустой запрос отдаёт их как есть
            ("bookmark", "https://www.youtube.com/|YouTube"),
            (
                "bookmark",
                "https://ru.wikipedia.org/|Википедия — свободная энциклопедия",
            ),
            (
                "bookmark",
                "https://github.com/|GitHub: Let's build from here",
            ),
            ("bookmark", "https://developer.mozilla.org/ru/|MDN Web Docs"),
            (
                "history",
                "https://www.youtube.com/watch?v=dQw4w9WgXcQ|Rick Astley — Never Gonna Give You Up",
            ),
            (
                "history",
                "https://www.youtube.com/results?search_query=rust+lang|rust lang — YouTube",
            ),
            ("history", "https://music.youtube.com/|YouTube Music"),
            (
                "history",
                "https://www.youtube.com/feed/subscriptions|Подписки — YouTube",
            ),
            (
                "history",
                "https://ru.wikipedia.org/wiki/Rust|Rust — Википедия",
            ),
            (
                "history",
                "https://ru.wikipedia.org/wiki/Субтитры|Субтитры — Википедия",
            ),
            (
                "history",
                "https://en.wikipedia.org/wiki/Subtitle|Subtitle — Wikipedia",
            ),
            (
                "history",
                "https://github.com/tauri-apps/tauri|tauri-apps/tauri — Tauri Framework",
            ),
            (
                "history",
                "https://github.com/rust-lang/rust|rust-lang/rust — Empowering everyone",
            ),
            (
                "history",
                "https://doc.rust-lang.org/book/|The Rust Programming Language",
            ),
            (
                "history",
                "https://docs.rs/|docs.rs — документация крейтов Rust",
            ),
            (
                "history",
                "https://developer.mozilla.org/ru/docs/Web/API/WebSocket|WebSocket — MDN Web Docs",
            ),
            (
                "history",
                "https://stackoverflow.com/questions|Stack Overflow — Where Developers Learn",
            ),
            ("history", "https://habr.com/ru/all/|Хабр"),
            ("history", "https://www.reddit.com/r/rust/|r/rust — Reddit"),
            ("history", "https://news.ycombinator.com/|Hacker News"),
            ("history", "https://translate.google.com/|Google Переводчик"),
            ("history", "https://mail.google.com/|Gmail"),
            (
                "history",
                "https://rustyy.ru/|Rust по-русски — сообщество разработчиков",
            ),
            (
                "history",
                "https://www.ivi.ru/watch/subtitles|Фильмы с субтитрами — ivi",
            ),
        ];
        for (source, entry) in seed {
            let (url, title) = entry.split_once('|').expect("сид: url|title");
            store.insert(
                if *source == "bookmark" {
                    HistorySource::Bookmark
                } else {
                    HistorySource::History
                },
                url,
                title,
            );
        }
        store
    }

    /// Пустое in-memory хранилище (тесты производительности).
    pub fn empty() -> Self {
        let conn = Connection::open_in_memory().expect("in-memory SQLite");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE entries USING fts5(title, url, source UNINDEXED);",
        )
        .expect("создать FTS5-таблицу");
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// Добавить запись (история или закладка). Транзакция — на вызывающем.
    pub fn insert(&self, source: HistorySource, url: &str, title: &str) {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        conn.execute(
            "INSERT INTO entries(title, url, source) VALUES (?1, ?2, ?3)",
            (title, url, source.as_str()),
        )
        .expect("вставка в FTS5");
    }

    /// Полнотекстовый поиск подсказок: каждый токен запроса — префиксный,
    /// ранжирование bm25. Пустой запрос — закладки (подсказки на фокус).
    pub fn search(&self, query: &str, limit: u32) -> Vec<HistoryHit> {
        let conn = self.conn.lock().expect("history: лок не отравлен");
        let limit = limit.clamp(1, 20) as i64;
        let q = query.trim();
        if q.is_empty() {
            return select(
                &conn,
                "SELECT source, url, title FROM entries \
                 WHERE source = 'bookmark' LIMIT ?1",
                limit,
                None,
            );
        }
        let Some(expr) = match_expr(q) else {
            return Vec::new();
        };
        select(
            &conn,
            "SELECT source, url, title FROM entries \
             WHERE entries MATCH ?1 ORDER BY rank LIMIT ?2",
            limit,
            Some(&expr),
        )
    }
}

/// Выполнить SELECT и собрать строки в подсказки.
fn select(conn: &Connection, sql: &str, limit: i64, expr: Option<&str>) -> Vec<HistoryHit> {
    let mut stmt = conn.prepare(sql).expect("подготовить поиск");
    let rows = match expr {
        Some(e) => stmt.query_map([e, &limit.to_string()], hit_of),
        None => stmt.query_map([limit.to_string()], hit_of),
    }
    .expect("выполнить поиск");
    rows.filter_map(|r| {
        r.ok()
            .map(|(source, url, title)| HistoryHit { source, url, title })
    })
    .collect()
}

fn hit_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<(HistorySource, String, String)> {
    Ok((
        // source хранится строкой (UNINDEXED-колонка FTS5 — только текст)
        HistorySource::from_db(row.get::<_, String>(0)?.as_str()),
        row.get(1)?,
        row.get(2)?,
    ))
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

    fn urls(hits: &[HistoryHit]) -> Vec<&str> {
        hits.iter().map(|h| h.url.as_str()).collect()
    }

    #[test]
    fn prefix_match_by_url_and_title() {
        let store = HistoryStore::seeded();
        // префикс «you» находится и в URL, и в заголовке
        let hits = store.search("you", 8);
        assert!(hits.iter().any(|h| h.url.contains("youtube.com")));
        // поиск по слову заголовка, которого нет в URL
        let hits = store.search("Переводчик", 8);
        assert!(urls(&hits).contains(&"https://translate.google.com/"));
        // кириллица: префикс «субтит» по заголовку
        let hits = store.search("субтит", 8);
        assert!(hits.iter().any(|h| h.url.contains("Субтитры")));
    }

    #[test]
    fn search_is_case_insensitive() {
        let store = HistoryStore::seeded();
        assert_eq!(
            urls(&store.search("wikipedia", 8)),
            urls(&store.search("WIKIpedia", 8))
        );
        assert!(!store.search("WIKIpedia", 8).is_empty());
    }

    #[test]
    fn multiword_query_intersects_tokens() {
        let store = HistoryStore::seeded();
        // оба слова есть только у википедийных записей про субтитры
        let hits = store.search("википедия субтитры", 8);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].url.contains("Субтитры"));
    }

    #[test]
    fn garbage_queries_do_not_panic() {
        let store = HistoryStore::seeded();
        assert!(store.search("\"\"\" ", 8).is_empty());
        assert!(store.search("- -- ???", 8).is_empty());
        assert!(store.search("zzzznonexistent", 8).is_empty());
    }

    #[test]
    fn empty_query_returns_bookmarks_only() {
        let store = HistoryStore::seeded();
        let hits = store.search("", 8);
        assert!(!hits.is_empty());
        assert!(hits.iter().all(|h| h.source == HistorySource::Bookmark));
    }

    #[test]
    fn limit_is_respected() {
        let store = HistoryStore::seeded();
        assert!(store.search("youtube", 2).len() <= 2);
    }

    /// DoD задачи 1.3: поиск по 10k записей истории — < 50 мс. Замер на пяти
    /// разных запросах подряд (консервативнее одного), прогрев включён.
    #[test]
    fn search_10k_under_50ms() {
        let store = HistoryStore::empty();
        let topics = [
            "видео",
            "статья",
            "форум",
            "документация",
            "музыка",
            "субтитры",
        ];
        let conn = store.conn.lock().unwrap();
        conn.execute_batch("BEGIN").unwrap();
        drop(conn);
        for i in 0..10_000u32 {
            let topic = topics[(i as usize) % topics.len()];
            store.insert(
                HistorySource::History,
                &format!("https://site{}.example/thread/{i}", i % 97),
                &format!("{topic} №{i} — обсуждение и комментарии"),
            );
        }
        let conn = store.conn.lock().unwrap();
        conn.execute_batch("COMMIT").unwrap();
        drop(conn);

        for q in ["видео", "wiki", "документация"] {
            store.search(q, 8); // прогрев: первый FTS-запрос строит структуры
        }
        let start = std::time::Instant::now();
        for q in [
            "видео",
            "wiki",
            "документация",
            "статья 123",
            "zzzznonexistent",
        ] {
            store.search(q, 8);
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_millis() < 50,
            "5 поисков по 10k записей уложились в {elapsed:?} (бюджет 50 мс)"
        );
    }
}
