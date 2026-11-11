package dev.duopulse.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // duopulse-119: PDF из «Открыть с помощью» (ACTION_VIEW) — холодный старт
    MobilePdfHelper.handle(this, intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // duopulse-119: launchMode=singleTask — файл при живом приложении
    MobilePdfHelper.handle(this, intent)
  }
}
