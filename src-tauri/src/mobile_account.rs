//! DuoPulse — аккаунт Aila и пароли на мобильной ветке (этап 6 карточки
//! duopulse-112, цепочка duopulse-106): тонкие команды-обёртки над общим
//! ядром с десктопом (этапы 4–5) — AilaAccount (aila.rs: вход PBKDF2, синк
//! appdata-блобов паролей и закладок) и PasswordStore (passwords/mod.rs:
//! AES-256-GCM SQLite). Протокол и форматы те же, поэтому телефон сходится
//! с десктопом без конверсий; секреты (ключ синка, токен, passwords.key) —
//! под AndroidKeyStore (secrets.rs → MobileKeystoreHelper), аналогично DPAPI.
//!
//! Пароли на телефоне — просмотр/копирование (лист из меню «⋮»); сохранение
//! из форм мобильной ветки нет — iframe-плеер не касается форм входа,
//! автозаполнение — отдельной карточкой при надобности (см. карточку 112).
//! Копирование — системный буфер через JNI (MobileClipboardHelper):
//! navigator.clipboard из WebView на части прошивок молчит без жеста.
//!
//! Модуль компилируется только мобильными таргетами (lib.rs): на десктопе
//! команды регистрирует bridge.rs.

use std::sync::Arc;

use crate::aila::AilaAccount;
use crate::history::HistoryStore;
use crate::passwords::{PasswordListParams, PasswordListResult, PasswordStore};

/// Снимок аккаунта для меню (camelCase — фронту).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AilaStatusMobile {
    pub logged_in: bool,
    pub username: String,
    pub display_name: String,
    pub server: String,
    pub revision: u64,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
}

/// Итог ручного синка (кнопка «Синхронизировать»): статистика обоих
/// хранилищ из sync_round — та же форма, что десктопному UI.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatsMobile {
    pub passwords: (u64, u64, u64, bool, u64),
    pub bookmarks: (u64, u64, bool),
}

/// aila.status: вход/сервер/последний синк/ошибка — блок «Аккаунт Aila»
/// в меню «⋮» и подсказки листа паролей.
#[tauri::command]
pub fn aila_status(account: tauri::State<'_, Arc<AilaAccount>>) -> AilaStatusMobile {
    let (logged_in, username, display_name, server, revision, last_sync_at, last_error) =
        account.status();
    AilaStatusMobile {
        logged_in,
        username,
        display_name,
        server,
        revision,
        last_sync_at,
        last_error,
    }
}

/// aila.login: PBKDF2-вход (серверу — только auth_hash), ключи — под
/// AndroidKeyStore; после входа будим воркер — локальные закладки и первый
/// синк паролей уходят в облако (как на десктопе, этап 4).
#[tauri::command]
pub fn aila_login(
    account: tauri::State<'_, Arc<AilaAccount>>,
    username: String,
    password: String,
) -> Result<(), String> {
    account.login(&username, &password)?;
    account.schedule_sync();
    Ok(())
}

/// aila.logout: сессия на сервере гасится лучшим усилием, ключи стираются;
/// локальные закладки/пароли остаются (работа без аккаунта не страдает).
#[tauri::command]
pub fn aila_logout(account: tauri::State<'_, Arc<AilaAccount>>) {
    account.logout();
}

/// aila.sync_now: круг синка обоих хранилищ синхронно (кнопка в меню) —
/// статистика уходит в UI, по успеху фронт обновляет закладки/статус.
#[tauri::command]
pub fn aila_sync_now(
    account: tauri::State<'_, Arc<AilaAccount>>,
    passwords: tauri::State<'_, Arc<PasswordStore>>,
    history: tauri::State<'_, Arc<HistoryStore>>,
) -> Result<SyncStatsMobile, String> {
    let (passwords, bookmarks) = account.sync_now(passwords.inner(), history.inner())?;
    Ok(SyncStatsMobile { passwords, bookmarks })
}

/// passwords.list (мобильное подмножество): записи без паролей.
#[tauri::command]
pub fn mobile_passwords_list(
    passwords: tauri::State<'_, Arc<PasswordStore>>,
    params: PasswordListParams,
) -> Result<PasswordListResult, String> {
    passwords.list(params.query.as_deref().unwrap_or(""), params.limit.unwrap_or(200))
}

/// passwords.reveal: пароль записи — только по явному запросу (кнопка
/// «показать»/«копировать» листа); логами не светится (eprintln его не
/// касается, в CDP-стенде значение не печатается).
#[tauri::command]
pub fn mobile_passwords_reveal(
    passwords: tauri::State<'_, Arc<PasswordStore>>,
    id: i64,
) -> Result<String, String> {
    passwords.reveal(id)
}

/// Скопировать текст в системный буфер (ClipboardManager через JNI) —
/// «копировать пароль» на листе паролей; годится и для другого текста.
#[tauri::command]
pub fn mobile_clipboard_copy(text: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::mobile_jni::with_jni(|env, context| {
            let helper = crate::mobile_jni::app_class(
                env,
                context,
                "dev.duopulse.mobile.MobileClipboardHelper",
            )?;
            let jtext = crate::mobile_jni::jstr(env, &text)?;
            let r = env
                .call_static_method(
                    &helper,
                    "copy",
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;",
                    &[context.into(), (&jtext).into()],
                )
                .map_err(|e| format!("clipboard: {e}"))?
                .l()
                .map_err(|e| format!("clipboard: {e}"))?;
            let js = jni::objects::JString::from(r);
            let out = env
                .get_string(&js)
                .map(|s| s.to_string_lossy().into_owned())
                .map_err(|e| format!("clipboard: {e}"))?;
            match out.as_str() {
                "copied" => Ok(()),
                other => Err(format!("буфер обмена: {}", other.strip_prefix("error: ").unwrap_or(&other))),
            }
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = text;
        Err("буфер обмена доступен только на Android".into())
    }
}
