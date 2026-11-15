//! HTTP-авторизация сайта (карточка duopulse-148): ответ 401 с
//! WWW-Authenticate (роутер, внутренний портал) WebView2 без обработчика
//! роняет навигацию — WebErrorStatus 17 VALID_AUTHENTICATION_CREDENTIALS_
//! REQUIRED, страница ошибки говорит «сервер требует авторизацию», и зайти
//! на роутер нельзя. Обработчик BasicAuthenticationRequested берёт деферрал
//! (сетевой запрос ждёт), Core эмитит «auth:challenge», UI открывает панель
//! auth (форма логин/пароль, src/chrome/auth-dialog.ts); решение приходит
//! командой auth.respond — креды уходят в ответ WebView2 (страница грузится),
//! null — отмена (навигация падает на страницу ошибки кода 17).
//!
//! Один ожидающий запрос на браузер (как один диалог в Chrome): новый
//! челлендж гасит прежний пустым ответом. Повторный челлендж того же адреса
//! после отвеченного — креды не приняли: панель показывает «неверный логин
//! или пароль» и прежний логин. COM-вызовы деферрала — только на главном
//! потоке (run_on_main_thread): интерфейсы WebView2 не агильные, вызов с
//! потокового пула даёт RPC_E_WRONG_THREAD.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Ожидающий запрос авторизации для панели (auth.pending; null — нет).
#[derive(Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthChallengeView {
    /// Адрес, запросивший авторизацию (страница роутера и т.п.).
    pub uri: String,
    /// Хост для заголовка диалога (из uri; пустой — покажем uri).
    pub host: String,
    /// realm из заголовка WWW-Authenticate (может быть пустым).
    pub realm: String,
    /// Номер попытки: >1 — прежние креды отвергнуты сервером.
    pub attempts: u32,
    /// Логин прошлой попытки (подставить в поле формы).
    pub last_username: String,
}

/// auth.respond: решение диалога. Some — креды уходят в WebView2,
/// None — отмена (пустой ответ, навигация падает на страницу ошибки).
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuthRespondParams {
    pub username: Option<String>,
    pub password: Option<String>,
}

/// Последний челлендж: адрес, счётчик попыток и логин прошлой подачи —
/// платформонезависим, чтобы auth.pending/respond компилировались и в
/// мобильной либе (там обработчика нет, команды — тихие no-op).
#[derive(Default)]
struct LastChallenge {
    uri: String,
    /// Вкладка последнего челленджа: NavigationCompleted владельца решает
    /// судьбу диалога (успех — закрыть, неудача — закрыть с ошибкой).
    tab: String,
    attempts: u32,
    answered: bool,
    last_username: String,
}

fn last_lock() -> std::sync::MutexGuard<'static, LastChallenge> {
    // Mutex::new(ConstNew) доступен с Rust 1.63 в const-контексте
    static LAST: std::sync::Mutex<LastChallenge> = std::sync::Mutex::new(LastChallenge::empty());
    LAST.lock().unwrap_or_else(|p| p.into_inner())
}

impl LastChallenge {
    const fn empty() -> Self {
        Self {
            uri: String::new(),
            tab: String::new(),
            attempts: 0,
            answered: false,
            last_username: String::new(),
        }
    }
}

/// Креды в ответ челленджа (UserName/Password у Response аргументов).
#[cfg(windows)]
unsafe fn set_credentials(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2BasicAuthenticationRequestedEventArgs,
    user: &str,
    pass: &str,
) -> windows_core::Result<()> {
    let resp = args.Response()?;
    let hu = windows_core::HSTRING::from(user);
    let hp = windows_core::HSTRING::from(pass);
    resp.SetUserName(windows_core::PCWSTR::from_raw(hu.as_ptr()))?;
    resp.SetPassword(windows_core::PCWSTR::from_raw(hp.as_ptr()))?;
    Ok(())
}

/// Подавить страницу ошибки для статуса 17 («сервер требует авторизацию»)?
/// Челлендж активен (диалог открыт) или только что отвечен — повторная нога
/// с кредами грузится независимо от «упавшей» первой (401): ошибка вводит в
/// заблуждение — страница вот-вот появится или ждёт ввода в диалоге.
pub fn suppress_error_page() -> bool {
    #[cfg(windows)]
    {
        let pending = pending_lock().is_some();
        let last = last_lock();
        pending || (!last.uri.is_empty() && last.answered)
    }
    #[cfg(not(windows))]
    {
        let last = last_lock();
        !last.uri.is_empty() && last.answered
    }
}

/// realm из заголовка Challenge (`Basic realm="Router"`, у Digest за realm
/// идут другие параметры): в кавычках — до закрывающей, без — до запятой/пробела.
fn realm_of(challenge: &str) -> String {
    let lower = challenge.to_ascii_lowercase();
    let Some(at) = lower.find("realm") else {
        return String::new();
    };
    let rest = challenge[at + "realm".len()..].trim_start();
    let Some(rest) = rest.strip_prefix('=') else {
        return String::new(); // «realm» без «=» — не параметр
    };
    let rest = rest.trim_start();
    let value = if let Some(stripped) = rest.strip_prefix('"') {
        match stripped.find('"') {
            Some(end) => &stripped[..end],
            None => stripped,
        }
    } else {
        rest.split([',', ' ', '\t']).next().unwrap_or("")
    };
    value.chars().take(80).collect()
}

/// auth.pending: ожидающий запрос HTTP-авторизации (панель при загрузке).
#[tauri::command]
pub fn auth_pending() -> Result<Option<AuthChallengeView>, String> {
    #[cfg(windows)]
    {
        let pending = pending_lock();
        let last = last_lock();
        Ok(pending.as_ref().map(|p| AuthChallengeView {
            uri: p.uri.clone(),
            host: p.host.clone(),
            realm: p.realm.clone(),
            attempts: p.attempts,
            last_username: last.last_username.clone(),
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = last_lock();
        Ok(None)
    }
}

/// auth.respond: решение диалога — креды в WebView2 или отмена (null).
/// Ожидающего запроса нет (гонка события и панели) — тихо.
#[tauri::command]
pub fn auth_respond(app: tauri::AppHandle, params: AuthRespondParams) -> Result<(), String> {
    {
        let mut last = last_lock();
        match &params.username {
            Some(u) if !last.uri.is_empty() => {
                last.answered = true;
                last.last_username = u.clone();
            }
            _ => last.answered = false,
        }
    }
    #[cfg(windows)]
    {
        let pending = pending_lock().take();
        if let Some(p) = pending {
            let is_cancel = params.username.is_none();
            let tab_id = p.tab_id.clone();
            // COM-ответ — на главном потоке (неагильные интерфейсы WebView2)
            let res = app.run_on_main_thread(move || unsafe {
                if let (Some(u), Some(pw)) = (&params.username, &params.password) {
                    if let Err(e) = set_credentials(p.args(), u, pw) {
                        eprintln!("[auth] креды не установлены: {e}");
                    }
                }
                // без кредов — пустой ответ: сервер повторит 401, навигация
                // падает (страница ошибки «сервер требует авторизацию»)
                if let Err(e) = p.deferral().Complete() {
                    eprintln!("[auth] деферрал не завершён: {e}");
                }
            });
            if let Err(e) = res {
                eprintln!("[auth] run_on_main_thread не встал в очередь: {e}");
            }
            // отмена: WebView2 покажет пустую страницу-факт «вход отменён» —
            // вместо неё наша страница ошибки с «Повторить» (как в Chrome)
            if is_cancel {
                use tauri::Manager;
                println!("[auth] отмена — страница ошибки для {tab_id}");
                app.state::<crate::tabs::TabManager>()
                    .on_nav_failed(&app, &tab_id, crate::tabs::WEB_ERROR_AUTH_REQUIRED);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

/// Гасит ожидающий запрос пустым ответом (панель умерла без решения: Esc,
/// клик по хрому, ресайз окна, новая вкладка поверх) — иначе сетевой запрос
/// висит на деферрале до таймаута сервера.
pub fn cancel_pending(app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        last_lock().answered = false;
        let pending = pending_lock().take();
        if let Some(p) = pending {
            let app = app.clone();
            let _ = app.run_on_main_thread(move || unsafe {
                let _ = p.deferral().Complete();
            });
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

/// Навигация вкладки-владельца завершилась — исход авторизации ясен, диалог
/// закрываем. ПОДВОХ WebView2 (duopulse-148, подтверждено трассировкой): нога
/// запроса с 401 завершается NavigationCompleted(ошибка 17) ещё ДО ответа на
/// челлендж — пока деферрал ждёт (pending есть), любое завершение навигации
/// владельца это шум первой ноги, игнорируем. Финал = pending забран respond
/// (креды отправлены): нога-ретрай дошла (успех или отказ сервера) — диалог
/// закрываем. Вызов — из NavigationCompleted каждой вкладки.
pub fn on_nav_completed(app: &tauri::AppHandle, tab_id: &str) {
    let (mine, waiting) = {
        let last = last_lock();
        (
            !last.uri.is_empty() && last.tab == tab_id && last.answered,
            pending_lock().is_some(),
        )
    };
    if !mine || waiting {
        return;
    }
    crate::chrome_panel::close_if_kind(app, "auth");
    // финал обработки: «отвечен» больше не давит страницу ошибки — будущие
    // 401-челленджи других страниц снова честно падают (или открывают диалог)
    last_lock().answered = false;
}

// --- Windows: обработчик BasicAuthenticationRequested ------------------------

/// COM-интерфейс WebView2 в Send-обёртке: сам тип не Send (NonNull), но
/// методы зовём ТОЛЬКО на главном потоке (событие приходит на нём, ответ —
/// run_on_main_thread) — обёртка фиксирует договорённость. Без неё Rust-2021
/// точечно захватывает поля замыканием, и struct-level impl Send не помогает.
#[cfg(windows)]
struct ComSend<T>(T);
#[cfg(windows)]
unsafe impl<T> Send for ComSend<T> {}

#[cfg(windows)]
struct PendingAuth {
    args: ComSend<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2BasicAuthenticationRequestedEventArgs>,
    deferral: ComSend<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral>,
    tab_id: String,
    uri: String,
    host: String,
    realm: String,
    attempts: u32,
}

#[cfg(windows)]
impl PendingAuth {
    /// Доступ к COM-полям — методами: Rust-2021 точечно захватывает поле
    /// замыканием (`p.args.0` в теле рвал бы Send), вызов метода захватывает
    /// весь `p` целиком (все поля Send).
    fn args(
        &self,
    ) -> &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2BasicAuthenticationRequestedEventArgs {
        &self.args.0
    }
    fn deferral(
        &self,
    ) -> &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral {
        &self.deferral.0
    }
}

#[cfg(windows)]
fn pending_lock() -> std::sync::MutexGuard<'static, Option<PendingAuth>> {
    static PENDING: std::sync::Mutex<Option<PendingAuth>> = std::sync::Mutex::new(None);
    PENDING.lock().unwrap_or_else(|p| p.into_inner())
}

/// Подписка на челлендж Basic-авторизации для webview вкладки (вызов —
/// из install_content_handlers, главный поток). Деферрал держит запрос,
/// пока UI не решит; UI открывает панель по событию «auth:challenge».
#[cfg(windows)]
pub(crate) unsafe fn install_basic_auth_handler(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    app: &tauri::AppHandle,
    tab_id: &str,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_10;
    use webview2_com::{BasicAuthenticationRequestedEventHandler, CoTaskMemPWSTR};
    use windows_core::{Interface, PWSTR};

    let tab_id = tab_id.to_string();

    // событие — на инкремент-интерфейсе ICoreWebView2_10 (SDK 1.0.1054+);
    // старый рантайм без него — тихо остаёмся на прежнем поведении (страница
    // ошибки «сервер требует авторизацию»)
    let Ok(core10) = core.cast::<ICoreWebView2_10>() else {
        eprintln!("auth: ICoreWebView2_10 недоступен, диалог авторизации выключен");
        return;
    };
    let app = app.clone();
    let res = core10.add_BasicAuthenticationRequested(
        &BasicAuthenticationRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let mut uri_pw = PWSTR::null();
            args.Uri(&mut uri_pw)?;
            let uri = CoTaskMemPWSTR::from(uri_pw).to_string();
            let mut ch_pw = PWSTR::null();
            args.Challenge(&mut ch_pw)?;
            let challenge = CoTaskMemPWSTR::from(ch_pw).to_string();

            // прежний запрос (если висел) гасим пустым ответом: один диалог
            let stale = pending_lock().take();
            if let Some(old) = stale {
                // уже на главном потоке — прямой вызов допустим
                let _ = old.deferral().Complete();
            }

            // тот же адрес после отвеченной подачи — креды не приняли
            let attempts = {
                let mut last = last_lock();
                let attempts = if last.uri == uri && last.answered {
                    last.attempts.saturating_add(1)
                } else {
                    1
                };
                last.uri = uri.clone();
                last.tab = tab_id.clone();
                last.attempts = attempts;
                last.answered = false;
                attempts
            };
            let last_username = last_lock().last_username.clone();

            let deferral = args.GetDeferral()?;
            let (host, realm) = describe_challenge(&uri, &challenge);
            println!("[auth] челлендж {uri} (вкладка {tab_id}, попытка {attempts})");
            *pending_lock() = Some(PendingAuth {
                args: ComSend(args),
                deferral: ComSend(deferral),
                tab_id: tab_id.clone(),
                host: host.clone(),
                realm: realm.clone(),
                uri: uri.clone(),
                attempts,
            });

            let view = AuthChallengeView {
                uri,
                host,
                realm,
                attempts,
                last_username,
            };
            let _ = crate::bridge::emit::<crate::bridge::AuthChallengeEvent>(&app, &view);
            Ok(())
        })),
        std::ptr::null_mut(),
    );
    if let Err(e) = res {
        eprintln!("auth: BasicAuthenticationRequested не установлен: {e}");
    }
}

/// Хост и realm челленджа (хост — из URL, realm — из Challenge).
#[cfg(windows)]
fn describe_challenge(uri: &str, challenge: &str) -> (String, String) {
    let host = url::Url::parse(uri)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| {
                match u.port() {
                    Some(p) if p != 80 && p != 443 => format!("{h}:{p}"),
                    _ => h.to_string(),
                }
            })
        })
        .unwrap_or_default();
    (host, realm_of(challenge))
}

#[cfg(test)]
mod tests {
    use super::realm_of;

    #[test]
    fn realm_из_заголовка() {
        assert_eq!(realm_of("Basic realm=\"Router Console\""), "Router Console");
        assert_eq!(realm_of("Basic realm=Keenetic"), "Keenetic");
        assert_eq!(realm_of("Basic"), "");
        assert_eq!(realm_of("Digest realm=\"Wi-Fi\", nonce=abc"), "Wi-Fi");
        assert_eq!(realm_of("realmless site"), ""); // слово «realm» без «=»
    }

    #[test]
    fn realm_обрезан_до_80_символов() {
        let long = "x".repeat(120);
        assert_eq!(realm_of(&format!("Basic realm=\"{long}\"")), "x".repeat(80));
    }
}
