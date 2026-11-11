//! Child-webview панелей хрома (карточка duopulse-090).
//!
//! Панели хрома (главное меню, прокси, VPN, duo, подсказки omnibox) содержат
//! интерактивные контролы — тумблеры, инпуты, слайдеры — нативное меню muda
//! (шаблон 086) их не размещает. Механизм — «составные нативным окном» в
//! варианте child-webview: панель — webview-инстанс В ОКНЕ main (как вкладки),
//! грузит тот же UI-бандл (index.html?panel=<kind>), панельный режим показывает
//! только нужную панель. Композитор WebView2 стыкует webview в порядке
//! создания (спайк 086): панель создаётся ПОСЛЕ вкладок и рисуется над ними;
//! созданный позже webview (новая вкладка) сносит панель — Core закрывает её
//! при любом новом webview (единое «одно окно»).
//!
//! Отдельное POPUP-ОКНО (WebviewWindow) не состоялось даже видимым с рождения:
//! webview не начинал загрузку страницы — 45+ с ни CDP-цели, ни title, белое
//! полотно (окно-оверлей спайка 086 вёл себя так же). Child-webview вкладок
//! рендерится, ресайзится и переключается — проверено всем браузером.
//!
//! Транспорт: ui_panel_open {kind, x, y, w, h} — x/y/w/h логические
//! координаты UI-webview (= клиентские окна main); закрытие — ui_panel_close
//! (Escape в панели, клик по хрому вне якоря, выбор пункта, blur omnibox);
//! подгонка размера под контент — ui_panel_fit. UI-webview узнаёт о закрытии
//! событием «chrome-panel-closed». Клик по КОНТЕНТУ страницы шлёт content-скрипт
//! сообщением dp-close-panel (обработчик в main.rs) — выпадающая панель
//! закрывается кликом мимо, как нативный дропдаун.

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

/// Метка webview панелей (роутер UI-бандла различает через ?panel=<kind>;
/// capability default.json пускает её к IPC как окно хрома).
pub const PANEL_WEBVIEW: &str = "chrome-panel";

/// Поколение панели: растёт на каждое закрытие/открытие — отложенное
/// разрушение срабатывает, только если за окно ожидания НЕ открыли новую.
/// Рост ДО разрушения/создания + сериализация главного потока дают
/// атомарность без мьютексов (блокирующий wv.close из побочного потока
/// замораживал spawn_tab — висячий tabs.open, поймано subtitles-стендом 090).
static PANEL_GEN: AtomicU64 = AtomicU64::new(0);
/// Число незавершённых отложенных разрушений: создателю нового webview
/// нужно дождаться их (wv.close() панельного webview конкурирует с
/// созданием и вешает add_child — висячий tabs.open, subtitles-стенд 090).
static PANEL_PENDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Закрыть панель: скрыть webview и оповестить UI («кнопки-тумблеры»
/// сбрасывают состояние по событию «chrome-panel-closed»); разрушение —
/// ОТЛОЖЕННО (250 мс, в очереди главного потока — без блокировки вызывающего).
/// Синхронный close на глазах у вызывающей панели рвал гонку «выбор пункта →
/// closePanel() → tabs.open»: webview умирал до доставки invoke и вкладка не
/// открывалась (поймано style-стендом 090). Разрушение нужно отложить и
/// потому, что ответ уже ушедшего invoke не должен терять вебвью раньше, чем
/// команда исполнится (tabs.open создаёт новый webview и закрывает панель
/// сам — close_if_open).
pub fn close(app: &AppHandle) {
    let gen = PANEL_GEN.fetch_add(1, Ordering::SeqCst);
    if let Some(wv) = app.get_webview(PANEL_WEBVIEW) {
        let _ = wv.hide();
        let app2 = app.clone();
        PANEL_PENDING.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(250));
            let app3 = app2.clone();
            let _ = app2.run_on_main_thread(move || {
                // поколение сменилось — открыли/закрыли ещё раз: не трогаем
                if PANEL_GEN.load(Ordering::SeqCst) == gen + 1 {
                    if let Some(wv) = app3.get_webview(PANEL_WEBVIEW) {
                        let _ = wv.close();
                    }
                }
                PANEL_PENDING.fetch_sub(1, Ordering::SeqCst);
            });
        });
    }
    let _ = tauri::Emitter::emit(app, "chrome-panel-closed", ());
}

/// Открыть панель-child-webview у якоря (x/y/w/h — логические координаты
/// UI-webview; контент уточнит размер через ui_panel_fit). focus=false — окно
/// подсказок omnibox: панель не держит фокус (создание child-webview
/// перехватывает фокус ОС — та же ловушка, что у фоновых вкладок
/// duopulse-088; фокус возвращаем UI-webview, иначе набор в адресной строке
/// умирает — duopulse-097).
#[tauri::command]
pub async fn ui_panel_open(
    app: AppHandle,
    kind: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    focus: Option<bool>,
) -> Result<(), String> {
    if !matches!(
        kind.as_str(),
        "main" | "proxy" | "vpn" | "duo" | "suggest" | "pwsave"
    ) {
        return Err(format!("неизвестная панель: {kind}"));
    }
    // предыдущая панель уходит (единое «одно меню на экран»); поколение
    // растёт ДО разрушения — отложенные close() прошлых поколений новую
    // панель не тронут (проверка поколения в run_on_main_thread)
    PANEL_GEN.fetch_add(1, Ordering::SeqCst);
    wait_pending_destroy();
    if let Some(old) = app.get_webview(PANEL_WEBVIEW) {
        let _ = old.close();
    }
    let window = app.get_window("main").ok_or("окно main не найдено")?;
    // в пределах окна main (кламп справа/снизу — панель у правого края кнопок)
    let (win_w, win_h) = {
        let s = window.inner_size().map_err(|e| e.to_string())?;
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        (s.width as f64 / scale, s.height as f64 / scale)
    };
    let w = w.min(win_w);
    let h = h.min(win_h - y);
    let x = x.clamp(0.0, (win_w - w).max(0.0));
    let y = y.clamp(0.0, (win_h - h).max(0.0));
    let url = tauri::WebviewUrl::App(format!("index.html?panel={kind}").into());
    let builder = WebviewBuilder::new(PANEL_WEBVIEW, url)
        // то же окружение WebView2, что у UI-вебконтента (устойчивость к
        // порядку создания — как у вкладок)
        .additional_browser_args(crate::startup_proxy_args());
    window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w, h.max(1.0)),
        )
        .map_err(|e| format!("панель-webview: {e}"))?;
    if !focus.unwrap_or(true) {
        // duopulse-097: окно подсказок без фокуса — создание webview только что
        // перехватило его у omnibox; вернём UI-webview, WebView2 восстановит
        // DOM-фокус последнего элемента (адресной строки), набор продолжается.
        if let Some(ui) = app.get_webview("main") {
            let _ = ui.set_focus();
        }
    }
    Ok(())
}

/// Закрыть панель (Escape в панели, клик по кнопке-тумблеру, выбор пункта,
/// blur omnibox, клик по контенту страницы).
#[tauri::command]
pub async fn ui_panel_close(app: AppHandle) -> Result<(), String> {
    close(&app);
    Ok(())
}

/// Дождаться отложенных разрушений (создание webview поверх конкурирующего
/// wv.close() подвисает — bounded-ожидание ≤600 мс, обычный случай 0 мс).
fn wait_pending_destroy() {
    for _ in 0..60 {
        if PANEL_PENDING.load(Ordering::SeqCst) == 0 {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

/// Новый webview в окне main (вкладка/внутренняя страница) — панель больше не
/// верхняя по композитору: закрываем. Вызывается из TabManager::create.
pub fn close_if_open(app: &AppHandle) {
    if app.get_webview(PANEL_WEBVIEW).is_some() {
        wait_pending_destroy();
        close(app);
    }
}

/// Окно main сдвинуто/ресайзнуто/ушло в fullscreen — якорь панели устарел.
pub fn close_on_main_geometry_change(app: &AppHandle) {
    close_if_open(app);
}

/// Клик по контенту страницы (сообщение dp-close-panel из content-скрипта):
/// выпадающая панель закрывается кликом мимо, как нативный дропдаун.
pub fn on_content_close_message(app: &AppHandle) {
    close_if_open(app);
}

#[cfg(test)]
mod tests {
    #[test]
    fn clamp_держит_в_границах() {
        let (pos, max) = (1200.0f64, 1000.0f64);
        assert_eq!(pos.min(max), 1000.0);
        assert_eq!((-50.0f64).clamp(0.0, max), 0.0);
    }
}
