//! Данные автозаполнения паролей web-оверлея мобильной ветки (карточка
//! duopulse-166, паритет 3/8 аудита duopulse-156): чистое ядро — логины
//! сайта (без паролей) и пароль выбранного логина, оба по origin из URL
//! вкладки, инкогнито выключает оба (в приватном режиме — только ручной
//! ввод). Десктоп ходит в PasswordStore напрямую из обработчика
//! WebMessage (main.rs: passwords-lookup/passwords-fill); мобильная ветка
//! зовёт эти функции из JNI-моста mobile_pass.rs (Kotlin DuopulseFill →
//! иконка-ключ → нативный лист выбора). Компилируется на хосте вместе с
//! общим PasswordStore — тесты здесь же, контракт у JNI тот же.

use super::PasswordStore;

/// Логины сайта для автозаполнения (мобильный аналог passwords-lookup
/// десктопа): usernames без паролей — пароль отдаётся только credential
/// ниже, по факту выбора в листе. Инкогнито и битый URL — пусто: иконки-ключа
/// нет, выбирать нечего; ошибка хранилища тоже пусто (страница не страдает).
/// Записи «только пароль» (пустой логин, duopulse-194) в лист не попадают:
/// нативный лист выбора без имени не отличим, мобильное заполнение пустого
/// логина — вопрос паритета на будущее.
pub fn accounts_for_url(store: &PasswordStore, incognito: bool, url: &str) -> Vec<String> {
    if incognito {
        return Vec::new();
    }
    match super::origin_of(url) {
        Ok(origin) => store
            .accounts_for(&origin)
            .unwrap_or_default()
            .into_iter()
            .filter(|u| !u.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Пароль выбранного логина (reveal по факту выбора): инкогнито, пустой
/// логин, битый URL и чужой логин сайта — None. Единственный путь пароля
/// наружу — evaluateJavascript точечного заполнения полей (мгновение
/// в памяти, в JS-переменных не хранится).
pub fn credential_for_url(
    store: &PasswordStore,
    incognito: bool,
    url: &str,
    username: &str,
) -> Option<String> {
    if incognito || username.is_empty() {
        return None;
    }
    let origin = super::origin_of(url).ok()?;
    store.credential(&origin, username).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> PasswordStore {
        let mut k = [0u8; 32];
        k[..8].copy_from_slice(&1u64.to_le_bytes());
        PasswordStore::open_in_memory(k).unwrap()
    }

    #[test]
    fn accounts_by_origin_without_passwords() {
        let s = store();
        s.add("https://example.com/login", None, "artem", "p1").unwrap();
        s.add("https://example.com/", None, "alya", "p2").unwrap();
        s.add("https://other.org/", None, "artem", "p3").unwrap();
        // путь/порт отбрасываются origin_of — тот же сайт, тот же список
        let mut acc = accounts_for_url(&s, false, "https://example.com/signin?x=1");
        acc.sort();
        assert_eq!(acc, vec!["alya", "artem"]);
        assert!(accounts_for_url(&s, false, "https://none.io/").is_empty());
    }

    #[test]
    fn password_only_entries_hidden_from_mobile_sheet() {
        let s = store();
        s.add("http://192.168.31.1/", None, "", "router").unwrap();
        s.add("http://192.168.31.1/", None, "admin", "a").unwrap();
        // запись «только пароль» (пустой логин) в нативный лист не попадает
        // (duopulse-194): мобильное заполнение пустого логина — паритет на
        // будущее; десктоп работает с ней напрямую через PasswordStore
        assert_eq!(
            accounts_for_url(&s, false, "http://192.168.31.1/"),
            vec!["admin"]
        );
    }

    #[test]
    fn incognito_silences_both_queries() {
        let s = store();
        s.add("https://example.com/", None, "artem", "p1").unwrap();
        // инкогнито: ни логинов (иконки нет), ни пароля по имени — ручной ввод
        assert!(accounts_for_url(&s, true, "https://example.com/").is_empty());
        assert!(credential_for_url(&s, true, "https://example.com/", "artem").is_none());
    }

    #[test]
    fn credential_only_for_saved_login_of_that_origin() {
        let s = store();
        s.add("https://example.com/", None, "artem", "p1").unwrap();
        assert_eq!(
            credential_for_url(&s, false, "https://example.com/x", "artem").as_deref(),
            Some("p1")
        );
        // чужой логин и чужой сайт — None (страница своего сайта не получит)
        assert!(credential_for_url(&s, false, "https://example.com/", "ghost").is_none());
        assert!(credential_for_url(&s, false, "https://other.org/", "artem").is_none());
        assert!(credential_for_url(&s, false, "https://example.com/", "").is_none());
    }

    #[test]
    fn junk_url_is_empty_not_error() {
        let s = store();
        s.add("https://example.com/", None, "u", "p").unwrap();
        // Kotlin мог поймать URL между навигациями — мусор тихо пуст
        assert!(accounts_for_url(&s, false, "about:blank").is_empty());
        assert!(accounts_for_url(&s, false, "не адрес").is_empty());
        assert!(credential_for_url(&s, false, "about:blank", "u").is_none());
    }
}
