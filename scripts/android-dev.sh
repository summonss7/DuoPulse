#!/usr/bin/env bash
# DuoPulse Android dev mode (duopulse-081, образец novagrid android-dev.sh):
# vite-девсервер на :5173 (devUrl в src-tauri/tauri.conf.json) +
# `tauri android dev <device>` — собирает мобильную lib, ставит debug-APK на
# устройство/эмулятор и перезагружает WebView с дев-сервера (HMR внутри
# Android WebView). Ctrl+C гасит оба. Устройство: первый из подключённых (adb),
# иначе — аргумент: npm run android:dev -- emulator-5554.
# Без устройства CLI виснет в интерактивном выборе — стартуйте эмулятор
# (AVD lecards_test, android-36 x86_64) или Device Manager Android Studio.
# Пререквизиты (по умолчанию — эта машина, env переопределяет):
#   ANDROID_HOME, NDK_HOME, JAVA_HOME + rust-таргеты android — как в android-build.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# тулчейн по умолчанию (как в android-build.sh)
export ANDROID_HOME="${ANDROID_HOME:-$(cygpath -m "$LOCALAPPDATA/Android/Sdk")}"
if [ -z "${NDK_HOME:-}" ]; then
  NDK_VER="$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"
  export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VER"
fi
export JAVA_HOME="${JAVA_HOME:-$(cygpath -m '/c/Program Files/Android/Android Studio/jbr')}"
export PATH="/c/Users/CUSTOM/msys64/ucrt64/bin:$PATH"

# устройство: аргумент скрипта → первый подключённый adb
ADB="${ANDROID_HOME}/platform-tools/adb"
DEVICE="${1:-}"
if [ -z "$DEVICE" ]; then
  DEVICE="$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
fi
if [ -z "$DEVICE" ]; then
  echo "!! Нет подключённых устройств: запустите эмулятор (emulator -avd lecards_test) или передайте устройство: npm run android:dev -- emulator-5554" >&2
  exit 1
fi
echo "==> Device: $DEVICE"

# vite на 0.0.0.0: эмулятор/телефон не видят localhost хоста, tauri адресует
# devUrl на LAN-IP (TAURI_DEV_HOST) и иначе вечно ждёт «Waiting for your
# frontend dev server to start on http://<lan-ip>:5173/»
npm run dev -- --port 5173 --host 0.0.0.0 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT

(cd src-tauri && node ../node_modules/@tauri-apps/cli/tauri.js android dev "$DEVICE")
