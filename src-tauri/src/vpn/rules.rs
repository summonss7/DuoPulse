//! Split-tunnel: правила домен → маршрут (задача 6.3, docs/02 §6.2,
//! карточка duopulse-039).
//!
//! Режимы VPN (docs/02 §6.2):
//!   - `Off`    — весь трафик напрямую (туннель не поднимается);
//!   - `Global` — весь трафик браузера через туннель (поведение задачи 6.2);
//!   - `Split`  — целевой режим по умолчанию: правило по домену «через
//!     туннель» / «напрямую». Домен без правила идёт напрямую — в туннель
//!     попадают только явно добавленные заблокированные сайты, YouTube и
//!     видеоплатформы не теряют скорость (F-12, docs/01 §5.6).
//!
//! Персист (docs/02 §8): `vpn/split-rules.json` в профиле — режим и список
//! правил переживают перезапуск; стартовый список пуст, пользователь добавляет
//! сайты сам (настройки VPN; действие на странице ошибки — задача 6.5).
//! Секретов в файле нет — только домены и маршруты.
//!
//! Матчинг: правило `example.com` ловит `example.com` и `sub.example.com`
//! (суффикс по границе меток, регистр не важен); `ample.com` НЕ ловит
//! `example.com`. IP-литералы доменными правилами не ловятся (у них нет
//! домена — они идут маршрутом по умолчанию).

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Режим VPN (docs/02 §6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitMode {
    /// Весь трафик напрямую.
    Off,
    /// Весь трафик через туннель.
    Global,
    /// Правила домен → маршрут; без правила — напрямую.
    Split,
}

impl SplitMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Global => "global",
            Self::Split => "split",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Ok(Self::Off),
            "global" => Ok(Self::Global),
            "split" => Ok(Self::Split),
            _ => Err(format!("режим «{s}» не известен (off | global | split)")),
        }
    }
}

/// Действие правила: через туннель или напрямую.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleAction {
    Tunnel,
    Direct,
}

impl RuleAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tunnel => "tunnel",
            Self::Direct => "direct",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "tunnel" => Ok(Self::Tunnel),
            "direct" => Ok(Self::Direct),
            _ => Err(format!("маршрут «{s}» не известен (tunnel | direct)")),
        }
    }
}

/// Одно правило (домен → маршрут).
#[derive(Debug, Clone, PartialEq)]
pub struct SplitRule {
    pub domain: String,
    pub action: RuleAction,
    /// Unix-ms добавления (сортировка списка в UI).
    pub added_at: i64,
}

/// Содержимое vpn/split-rules.json.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleSet {
    pub mode: SplitMode,
    pub rules: Vec<SplitRule>,
}

impl Default for RuleSet {
    fn default() -> Self {
        // Новый профиль: режим off, правил нет (docs/02 §6.2 — стартовый
        // список пуст; split включается осознанно).
        Self {
            mode: SplitMode::Off,
            rules: Vec::new(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RuleSetFile {
    #[serde(default)]
    split_rules: u32,
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default)]
    rules: Vec<SplitRuleSerde>,
}

fn default_mode() -> String {
    "off".into()
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SplitRuleSerde {
    domain: String,
    route: String,
    added_at: i64,
}

fn rules_path(dir: &Path) -> PathBuf {
    dir.join("vpn").join("split-rules.json")
}

/// Проверка домена правила: hostname-формы (метки 1–63, буквы/цифры/дефис,
/// дефис не в начале/конце метки, IDNA-юмникод допустим — сравнение потом
/// побайтовое). Порт/протокол/путь не входят.
pub fn validate_domain(domain: &str) -> Result<String, String> {
    let d = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() {
        return Err("домен не задан".into());
    }
    if d.len() > 253 {
        return Err("домен длиннее 253 символов".into());
    }
    if d.parse::<std::net::IpAddr>().is_ok() {
        return Err("правила задаются для доменов, не IP-адресов".into());
    }
    for label in d.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(format!("метка «{label}» пустая или длиннее 63 символов"));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(format!(
                "метка «{label}» не может начинаться/кончаться дефисом"
            ));
        }
        if !label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || !c.is_ascii())
        {
            return Err(format!("недопустимый символ в метке «{label}»"));
        }
    }
    Ok(d)
}

impl RuleSet {
    /// Домен уже нормализован (validate_domain); хост — как пришёл от Chromium.
    /// Возвращает действие первого подходящего правила (список короткий,
    /// линейный поиск; приоритет = порядок добавления).
    pub fn match_host(&self, host: &str) -> Option<RuleAction> {
        let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
        if h.parse::<std::net::IpAddr>().is_ok() {
            return None; // IP-литерал — доменных правил нет
        }
        self.rules.iter().find_map(|r| {
            let d = r.domain.trim_end_matches('.');
            (h == d || h.ends_with(&format!(".{d}"))).then_some(r.action)
        })
    }
}

/// Разделяемый стор правил: роутер матчит по той же ручке, что меняет IPC —
/// правка действует на новые соединения сразу, без перезапуска. Мутации
/// персистятся в vpn/split-rules.json.
#[derive(Clone)]
pub struct RuleStore {
    inner: Arc<RwLock<RuleSet>>,
    path: PathBuf,
}

impl RuleStore {
    /// Загрузить из профиля (нет файла/битый — дефолт off/пусто).
    pub fn load(dir: &Path) -> RuleStore {
        let set = std::fs::read_to_string(rules_path(dir))
            .ok()
            .and_then(|raw| serde_json::from_str::<RuleSetFile>(&raw).ok())
            .map(|f| RuleSet {
                mode: SplitMode::parse(&f.mode).unwrap_or(SplitMode::Off),
                rules: f
                    .rules
                    .into_iter()
                    .filter_map(|r| {
                        Some(SplitRule {
                            domain: validate_domain(&r.domain).ok()?,
                            action: RuleAction::parse(&r.route).ok()?,
                            added_at: r.added_at,
                        })
                    })
                    .collect(),
            })
            .unwrap_or_default();
        RuleStore {
            inner: Arc::new(RwLock::new(set)),
            path: rules_path(dir),
        }
    }

    /// Снапшот для IPC/UI.
    pub fn snapshot(&self) -> RuleSet {
        self.inner.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Клон-ручка того же стора (передача в политику роутера: тот же Arc —
    /// правки IPC видны соединениям сразу).
    pub fn handle(&self) -> RuleStore {
        self.clone()
    }

    pub fn mode(&self) -> SplitMode {
        self.snapshot().mode
    }

    /// Горячий путь роутера: действие для хоста (None — маршрутом по
    /// умолчанию, в split это напрямую).
    pub fn match_action(&self, host: &str) -> Option<RuleAction> {
        self.inner
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .match_host(host)
    }

    /// Сменить режим (персист; поднятие/гашение туннеля — вызывающий).
    pub fn set_mode(&self, mode: SplitMode) -> Result<(), String> {
        {
            let mut set = self.inner.write().unwrap_or_else(|p| p.into_inner());
            set.mode = mode;
        }
        self.persist()
    }

    /// Добавить/обновить правило (upsert по домену — повторно добавленный
    /// сайт меняет маршрут, а не плодит строки). Персист.
    pub fn add_rule(&self, domain: &str, action: RuleAction) -> Result<SplitRule, String> {
        let domain = validate_domain(domain)?;
        let rule = SplitRule {
            domain: domain.clone(),
            action,
            added_at: now_ms(),
        };
        {
            let mut set = self.inner.write().unwrap_or_else(|p| p.into_inner());
            match set.rules.iter_mut().find(|r| r.domain == domain) {
                Some(slot) => {
                    rule.clone_into(slot);
                }
                None => set.rules.push(rule.clone()),
            }
        }
        self.persist()?;
        Ok(rule)
    }

    /// Удалить правило по домену. Возвращает, было ли оно.
    pub fn remove_rule(&self, domain: &str) -> Result<bool, String> {
        let domain = validate_domain(domain)?;
        let removed = {
            let mut set = self.inner.write().unwrap_or_else(|p| p.into_inner());
            let before = set.rules.len();
            set.rules.retain(|r| r.domain != domain);
            set.rules.len() < before
        };
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    fn persist(&self) -> Result<(), String> {
        let set = self.snapshot();
        let file = RuleSetFile {
            split_rules: 1,
            mode: set.mode.as_str().into(),
            rules: set
                .rules
                .into_iter()
                .map(|r| SplitRuleSerde {
                    domain: r.domain,
                    route: r.action.as_str().into(),
                    added_at: r.added_at,
                })
                .collect(),
        };
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("создать {}: {e}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json)
            .map_err(|e| format!("записать {}: {e}", self.path.display()))
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// Тесты: матчинг суффиксов, валидация, персист/roundtrip, upsert (docs/02 §6.2,
// docs/10 — «unit-тесты split-правил»).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("duopulse-rules-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mode_parse_roundtrip() {
        for m in [SplitMode::Off, SplitMode::Global, SplitMode::Split] {
            assert_eq!(SplitMode::parse(m.as_str()).unwrap(), m);
        }
        assert!(SplitMode::parse("vpn").is_err());
        assert_eq!(
            SplitMode::parse("  SPLIT ").unwrap(),
            SplitMode::Split,
            "регистр и пробелы не важны"
        );
    }

    #[test]
    fn action_parse() {
        assert_eq!(RuleAction::parse("tunnel").unwrap(), RuleAction::Tunnel);
        assert_eq!(RuleAction::parse("Direct").unwrap(), RuleAction::Direct);
        assert!(RuleAction::parse("proxy").is_err());
    }

    #[test]
    fn match_is_suffix_on_label_boundary() {
        let set = RuleSet {
            mode: SplitMode::Split,
            rules: vec![
                SplitRule {
                    domain: "blocked.example".into(),
                    action: RuleAction::Tunnel,
                    added_at: 1,
                },
                SplitRule {
                    domain: "video.net".into(),
                    action: RuleAction::Direct,
                    added_at: 2,
                },
            ],
        };
        // Точное имя и поддомены — ловятся.
        assert_eq!(set.match_host("blocked.example"), Some(RuleAction::Tunnel));
        assert_eq!(
            set.match_host("SUB.Blocked.Example."),
            Some(RuleAction::Tunnel),
            "регистр и хвостовая точка не важны"
        );
        assert_eq!(set.match_host("video.net"), Some(RuleAction::Direct));
        assert_eq!(set.match_host("cdn.video.net"), Some(RuleAction::Direct));
        // Суффикс не по границе меток — НЕ ловится (docs/02 §10: unit-тесты
        // split-правил защищают от наивного ends_with).
        assert_eq!(set.match_host("unblocked.example"), None);
        assert_eq!(set.match_host("notblocked.example"), None);
        assert_eq!(set.match_host("xblocked.example"), None);
        // Чужие домены и IP-литералы — маршрутом по умолчанию.
        assert_eq!(set.match_host("youtube.com"), None);
        assert_eq!(set.match_host("203.0.113.7"), None);
        assert_eq!(set.match_host("blocked.example.evil.com"), None);
    }

    #[test]
    fn first_matching_rule_wins() {
        let set = RuleSet {
            mode: SplitMode::Split,
            rules: vec![
                SplitRule {
                    domain: "a.test".into(),
                    action: RuleAction::Direct,
                    added_at: 1,
                },
                SplitRule {
                    domain: "a.test".into(),
                    action: RuleAction::Tunnel,
                    added_at: 2,
                },
            ],
        };
        // Дублей через add_rule не бывает (upsert), но при чтении файла
        // поведение определено: первое правило.
        assert_eq!(set.match_host("a.test"), Some(RuleAction::Direct));
    }

    #[test]
    fn domain_validation() {
        assert_eq!(
            validate_domain("  Example.COM. ").unwrap(),
            "example.com",
            "нормализация: трим + нижний регистр + снятие точки"
        );
        assert_eq!(
            validate_domain("xn--e1afmkfd.test").unwrap(),
            "xn--e1afmkfd.test"
        );
        assert_eq!(
            validate_domain("кино.рф").unwrap(),
            "кино.рф",
            "юмникод допустим"
        );
        assert!(validate_domain("").is_err());
        assert!(validate_domain("a..b").is_err());
        assert!(validate_domain("-a.test").is_err());
        assert!(validate_domain("a-.test").is_err());
        assert!(validate_domain("a b.test").is_err());
        assert!(validate_domain("a\\b.test").is_err());
        assert!(validate_domain("1.2.3.4").is_err(), "IP — не домен правила");
        assert!(validate_domain(&format!("{}.test", "a".repeat(64))).is_err());
    }

    #[test]
    fn store_persists_rules_and_mode_across_reload() {
        let dir = temp_dir("persist");
        let store = RuleStore::load(&dir);
        assert_eq!(store.mode(), SplitMode::Off, "нет файла — режим off");
        assert!(store.snapshot().rules.is_empty());

        store.set_mode(SplitMode::Split).unwrap();
        store
            .add_rule("blocked.example", RuleAction::Tunnel)
            .unwrap();
        store.add_rule("video.net", RuleAction::Direct).unwrap();

        // «Перезапуск»: новый стор из того же каталога.
        let reloaded = RuleStore::load(&dir);
        assert_eq!(reloaded.mode(), SplitMode::Split);
        let rules = reloaded.snapshot().rules;
        assert_eq!(rules.len(), 2);
        assert!(rules
            .iter()
            .any(|r| r.domain == "blocked.example" && r.action == RuleAction::Tunnel));
        assert!(rules
            .iter()
            .any(|r| r.domain == "video.net" && r.action == RuleAction::Direct));
        // Файл лежит в vpn/ и без секретов — только домены/маршруты.
        let raw = std::fs::read_to_string(rules_path(&dir)).unwrap();
        assert!(
            raw.contains("blocked.example") && raw.contains("\"split\""),
            "{raw}"
        );

        // Upsert: повторное добавление меняет маршрут, не плодя строки.
        reloaded
            .add_rule("blocked.example", RuleAction::Direct)
            .unwrap();
        assert_eq!(reloaded.snapshot().rules.len(), 2);
        assert_eq!(
            reloaded.match_action("blocked.example"),
            Some(RuleAction::Direct)
        );

        // Удаление.
        assert!(reloaded.remove_rule("blocked.example").unwrap());
        assert!(
            !reloaded.remove_rule("blocked.example").unwrap(),
            "повтор — no-op"
        );
        assert_eq!(reloaded.snapshot().rules.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_live_handle_shares_state() {
        // Роутер и IPC держат клоны одного стора: правка видна сразу.
        let dir = temp_dir("live");
        let a = RuleStore::load(&dir);
        let b = a.clone();
        a.add_rule("x.test", RuleAction::Tunnel).unwrap();
        assert_eq!(b.match_action("x.test"), Some(RuleAction::Tunnel));
        b.remove_rule("x.test").unwrap();
        assert_eq!(a.match_action("x.test"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(dir.join("vpn")).unwrap();
        std::fs::write(rules_path(&dir), "{ не json").unwrap();
        let store = RuleStore::load(&dir);
        assert_eq!(store.mode(), SplitMode::Off);
        assert!(store.snapshot().rules.is_empty());
        // …и первая же мутация чинит файл.
        store.add_rule("ok.test", RuleAction::Tunnel).unwrap();
        assert_eq!(RuleStore::load(&dir).snapshot().rules.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_entries_skipped_on_load() {
        let dir = temp_dir("skip");
        std::fs::create_dir_all(dir.join("vpn")).unwrap();
        std::fs::write(
            rules_path(&dir),
            r#"{ "split_rules": 1, "mode": "split", "rules": [
                { "domain": "good.test", "route": "tunnel", "added_at": 1 },
                { "domain": "bad route", "route": "tunnel", "added_at": 2 },
                { "domain": "odd.test", "route": " sideways ", "added_at": 3 }
            ] }"#,
        )
        .unwrap();
        let store = RuleStore::load(&dir);
        let rules = store.snapshot().rules;
        assert_eq!(rules.len(), 1, "битые строки пропущены: {rules:?}");
        assert_eq!(rules[0].domain, "good.test");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
