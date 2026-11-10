//! Ожидающий кандидат бара «Сохранить пароль?» (этап 2 duopulse-108).
//!
//! Content-слой шлёт кандидата по сабмиту формы логина (WebMessage
//! «password-candidate», main.rs); Core решает, показывать ли бар:
//! пустые поля, denylist never_save и не изменившийся пароль — бар не
//! заслужен. Кандидат с паролем живёт ТОЛЬКО здесь (память процесса),
//! событие passwords:save_prompt и команда passwords.candidate отдают
//! вид без пароля — UI-бару он не нужен. Кнопки бара решают судьбу
//! одной командой passwords.resolve_candidate: save (upsert хранилища
//! этапа 1), never (origin → denylist), dismiss.
//!
//! Жизненный цикл — один кандидат на приложение (бар один): новый сабмит
//! заменяет прежнего; смена активной вкладки гасит кандидата (on_tabs_changed,
//! как бабл Chrome), панель закрывает UI по tabs.updated.

use std::sync::Mutex;

use schemars::JsonSchema;
use serde::Serialize;

use super::PasswordStore;

/// Кандидат с паролем (только память Core, наружу не отдаётся).
#[derive(Debug, Clone)]
pub struct PasswordCandidate {
    pub tab_id: String,
    pub origin: String,
    /// Полный адрес страницы входа (уходит в add → url записи).
    pub url: String,
    pub title: String,
    pub username: String,
    pub password: String,
    /// Логин уже сохранён на сайте — бар спрашивает «Обновить пароль?».
    pub updated: bool,
}

/// Вид кандидата для UI (без пароля) — событие и passwords.candidate.
#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasswordsCandidateView {
    pub tab_id: String,
    pub origin: String,
    pub username: String,
    /// true — логин уже сохранён, бар предлагает обновить пароль.
    pub updated: bool,
}

impl From<&PasswordCandidate> for PasswordsCandidateView {
    fn from(c: &PasswordCandidate) -> Self {
        PasswordsCandidateView {
            tab_id: c.tab_id.clone(),
            origin: c.origin.clone(),
            username: c.username.clone(),
            updated: c.updated,
        }
    }
}

/// Ожидающий кандидат (управляемое состояние, один на процесс).
pub struct PasswordPrompts {
    current: Mutex<Option<PasswordCandidate>>,
}

impl Default for PasswordPrompts {
    fn default() -> Self {
        Self {
            current: Mutex::new(None),
        }
    }
}

impl PasswordPrompts {
    /// Принять кандидата от content-слоя. None — бар не показываем:
    /// пустой логин/пароль, сайт в denylist либо пароль совпадает с
    /// сохранённым. Some — кандидат запомнен, UI получает вид для бара.
    /// Инкогнито и неактивная вкладка — на совести вызывающего (main.rs).
    pub fn offer(
        &self,
        store: &PasswordStore,
        tab_id: &str,
        tab_url: &str,
        title: &str,
        username: &str,
        password: &str,
    ) -> Result<Option<PasswordsCandidateView>, String> {
        let username = username.trim();
        if username.is_empty() || password.is_empty() {
            return Ok(None);
        }
        let origin = super::origin_of(tab_url)?;
        if store.is_denied(&origin) {
            return Ok(None);
        }
        let saved = store.credential(&origin, username)?;
        if saved.as_deref() == Some(password) {
            return Ok(None); // тот же пароль — спрашивать не о чем
        }
        let candidate = PasswordCandidate {
            tab_id: tab_id.to_string(),
            origin,
            url: tab_url.to_string(),
            title: title.to_string(),
            username: username.to_string(),
            password: password.to_string(),
            updated: saved.is_some(),
        };
        let view = Some(PasswordsCandidateView::from(&candidate));
        *self.current.lock().unwrap() = Some(candidate);
        Ok(view)
    }

    /// Текущий кандидат без пароля (панель pwsave при загрузке; null — бара нет).
    pub fn view(&self) -> Option<PasswordsCandidateView> {
        self.current.lock().unwrap().as_ref().map(PasswordsCandidateView::from)
    }

    /// Вынуть кандидата (решение или сброс).
    fn take(&self) -> Option<PasswordCandidate> {
        self.current.lock().unwrap().take()
    }

    /// Решение бара: save — upsert в хранилище этапа 1, never — сайт в
    /// denylist, dismiss — просто забыть. false — решать было нечего
    /// (кандидата нет: гонка события и панели — тихо).
    pub fn resolve(&self, store: &PasswordStore, action: &str) -> Result<bool, String> {
        let Some(c) = self.take() else {
            return Ok(false);
        };
        match action {
            "save" => {
                store.add(&c.url, Some(&c.title), &c.username, &c.password)?;
            }
            "never" => {
                store.deny(&c.origin)?;
            }
            "dismiss" => {}
            other => return Err(format!("неизвестное действие бара паролей: {other}")),
        }
        Ok(true)
    }

    /// Список вкладок изменился (tabs/mod.rs finish): кандидат чужой
    /// активной вкладки гасится — бар не переживает переключение вкладки
    /// (как бабл Chrome), пароль не задерживается в памяти без дела.
    pub fn on_tabs_changed(&self, active_id: Option<&str>) {
        let stale = match self.current.lock().unwrap().as_ref() {
            Some(c) => Some(c.tab_id.clone()) != active_id.map(str::to_string),
            None => false,
        };
        if stale {
            self.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> PasswordStore {
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&1u64.to_le_bytes());
        PasswordStore::open_in_memory(k).unwrap()
    }

    fn prompts() -> PasswordPrompts {
        PasswordPrompts::default()
    }

    #[test]
    fn offer_new_update_and_unchanged() {
        let s = store();
        let p = prompts();
        // новый логин — бар «Сохранить»
        let v = p
            .offer(&s, "tab-1", "https://example.com/login", "Example", "artem", "p1")
            .unwrap()
            .expect("новый логин заслуживает бар");
        assert_eq!((v.origin.as_str(), v.username.as_str(), v.updated), ("https://example.com", "artem", false));
        // сменил пароль — бар «Обновить» (после save записи; тот же пароль — тишина)
        p.resolve(&s, "save").unwrap();
        let v2 = p
            .offer(&s, "tab-1", "https://example.com/login", "Example", "artem", "p2")
            .unwrap()
            .expect("смена пароля заслуживает бар");
        assert!(v2.updated);
        p.resolve(&s, "save").unwrap();
        assert_eq!(s.credential("https://example.com", "artem").unwrap().as_deref(), Some("p2"));
        // повторный сабмит с тем же паролем — бара нет
        assert!(
            p.offer(&s, "tab-1", "https://example.com/login", "Example", "artem", "p2")
                .unwrap()
                .is_none()
        );
        // пустые поля — бара нет
        assert!(p.offer(&s, "t", "https://example.com/", "", "", "x").unwrap().is_none());
        assert!(p.offer(&s, "t", "https://example.com/", "u", "", "").unwrap().is_none());
        // не-адрес вкладки — честная ошибка (журнал main.rs)
        assert!(p.offer(&s, "t", "не адрес", "", "u", "p").is_err());
    }

    #[test]
    fn resolve_actions() {
        let s = store();
        let p = prompts();
        // пустой стенд: решать нечего — false, не ошибка
        assert!(!p.resolve(&s, "dismiss").unwrap());
        // never — сайт в denylist, следующих кандидатов с него нет
        p.offer(&s, "tab-1", "https://example.com/", "", "artem", "p1").unwrap().unwrap();
        assert!(p.resolve(&s, "never").unwrap());
        assert!(s.is_denied("https://example.com"));
        assert!(
            p.offer(&s, "tab-1", "https://example.com/", "", "artem", "p2")
                .unwrap()
                .is_none()
        );
        // неизвестное действие — ошибка, кандидат уже вынут (бар закрылся)
        p.offer(&s, "tab-1", "https://other.org/", "", "u", "p").unwrap().unwrap();
        assert!(p.resolve(&s, "nonsense").is_err());
        assert!(p.view().is_none());
    }

    #[test]
    fn tabs_change_drops_stale_candidate() {
        let s = store();
        let p = prompts();
        p.offer(&s, "tab-1", "https://example.com/", "", "artem", "p1").unwrap().unwrap();
        p.on_tabs_changed(Some("tab-1")); // та же активная — живёт
        assert!(p.view().is_some());
        p.on_tabs_changed(Some("tab-2")); // ушли с вкладки — гасим
        assert!(p.view().is_none());
        // решать после сброса нечего
        assert!(!p.resolve(&s, "save").unwrap());
        // новых сабмитов на месте активной вкладки не теряем
        p.offer(&s, "tab-2", "https://example.com/", "", "artem", "p1").unwrap().unwrap();
        p.on_tabs_changed(Some("tab-2"));
        assert!(p.view().is_some());
    }
}
