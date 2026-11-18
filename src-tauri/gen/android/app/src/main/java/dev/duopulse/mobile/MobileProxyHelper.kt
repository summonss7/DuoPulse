package dev.duopulse.mobile

import android.content.Context
import android.util.Log
import android.widget.Toast
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature

/*
 * Прокси WebView приложения (duopulse-170, паритет-мобайл 7/8 — маршрутизация
 * трафика через тоннель WireGuard): у WebView нет SOCKS-параметра (как
 * --proxy-server у WebView2 десктопа), но androidx.webkit ProxyController
 * ставит единый HTTP-прокси для ВСЕХ WebView приложения (UI Tauri и web-
 * оверлей). Rust-роутер процесса (vpn/router.rs) поднял HTTP-листенер
 * CONNECT/absolute-form на 127.0.0.1:<port> с теми же режимами Direct/Wg и
 * fail-closed — мобильная ветка говорит с ним языком HTTP-прокси:
 *   - https-цели → CONNECT-туннель через роутер;
 *   - http-цели → absolute-form запросы (Chromium не шлёт CONNECT на
 *     открытый http) — роутер переписывает в origin-form и несёт маршрутом.
 * Внутренние источники приложения уходят мимо прокси (bypass): *.localhost —
 * это asset.localhost (UI Tauri), ipc.localhost (invoke), mobilevideo.localhost
 * (видео из «Открыть с помощью»); loopback-цели и без того вне прокса.
 *
 * Прокси действует на НОВЫЕ запросы — открытые страницы перезагружаются
 * (MobileWebHelper.reloadForProxy), о чём UI честно сообщает тостом
 * (допустимость перезагрузки — карточка duopulse-170). Повторный apply с тем
 * же портом ничего не перезагружает (тумблер профилей не дёргает страницу).
 * Rust зовёт apply/clear через JNI (mobile_vpn.rs) при включении/выключении
 * тоннеля: (Context, String) → String — поверхность MobileWebHelper.
 */
object MobileProxyHelper {
  private const val TAG = "DuoPulseProxy"

  /** Порт применённого прокси (0 — прокси снят): дедуп перезагрузок. */
  @Volatile private var appliedPort = 0

  /** Внутренние хосты приложения — мимо прокси (см. шапку). */
  private val BYPASS_RULES = listOf("*.localhost", "localhost", "127.0.0.1")

  /** Включить прокси WebView: arg — «127.0.0.1:<http_port>» от Rust-роутера. */
  @JvmStatic fun apply(context: Context, hostPort: String): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    val port = hostPort.substringAfterLast(':').trim().toIntOrNull()
    if (port == null || port <= 0) return "error: порт прокси не разобран: $hostPort"
    act.runOnUiThread {
      if (appliedPort == port) return@runOnUiThread
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
        Log.w(TAG, "ProxyController не поддержан WebView — трафик остаётся прямым")
        return@runOnUiThread
      }
      val builder = ProxyConfig.Builder().addProxyRule("http://127.0.0.1:$port")
      for (rule in BYPASS_RULES) builder.addBypassRule(rule)
      ProxyController.getInstance().setProxyOverride(builder.build(), act.mainExecutor) {
        appliedPort = port
        Log.d(TAG, "прокси WebView применён :$port — перезагружаю открытые страницы")
        Toast.makeText(act, "VPN: страницы перезагружены", Toast.LENGTH_SHORT).show()
        MobileWebHelper.reloadForProxy()
      }
    }
    return "ok"
  }

  /** Снять прокси WebView (тоннель выключен — Direct без перезапуска). */
  @JvmStatic fun clear(context: Context, unused: String): String {
    val act = MainActivity.current ?: return "error: активность не готова"
    act.runOnUiThread {
      if (appliedPort == 0) return@runOnUiThread
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return@runOnUiThread
      ProxyController.getInstance().clearProxyOverride(act.mainExecutor) {
        appliedPort = 0
        Log.d(TAG, "прокси WebView снят — перезагружаю открытые страницы")
        Toast.makeText(act, "VPN выключен: страницы перезагружены", Toast.LENGTH_SHORT).show()
        MobileWebHelper.reloadForProxy()
      }
    }
    return "ok"
  }
}
