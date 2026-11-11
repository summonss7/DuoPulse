#!/usr/bin/env bash
# DuoPulse Android build (duopulse-081, этап 1/3 мобильной версии — образец
# novagrid android-build.sh):
#   1. сверяет версии package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
#      (+ tauri.android.conf.json, если там своя version) — рассинхрон превращает
#      «последнюю версию» в ложную, падаем сразу;
#   2. собирает фронтенд (dist/, общий с десктопом: npm run build = build-content + vite);
#   3. `tauri android build` → APK из мобильной ветки lib-крейта (src-tauri/lib.rs,
#      gen/android);
#   4. кладёт артефакт в builds/duopulse_<верс>_android_<тип>/DuoPulse-<верс>-android-<тип>.apk
#      (версия + тип в имени — правила проекта). Release-APK дополнительно
#      копируется в КОРЕНЬ builds/ — его сканирует хаб «Скачать» Aila (карточка
#      duopulse-063, Android-чип после aila-370); устаревшие DuoPulse-*-android-release.apk
#      из корня убираются (как setup-файлы в release.mjs: устаревший установщик
#      без апдейтера — ловушка). Debug в хаб не идёт.
#   5. подписанный release-APK публикуется в канал обновлений Aila
#      (манифест v2 — 📡 «в канале» хаба и проверка обновлений в приложении)
#      общим издателем D:\Scheduler\tools\publish-update.cjs (aila-388).
# Подпись release: keystore src-tauri/gen/android/duopulse-release.keystore,
# пароль в gitignored src-tauri/gen/android/keystore.properties (схема
# novagrid-059; нет файла — APK без подписи, на телефон не встанет).
# Тулчейн по умолчанию (env переопределяет): ANDROID_HOME=%LOCALAPPDATA%/Android/Sdk,
# NDK — новейший из $ANDROID_HOME/ndk, JAVA_HOME — jbr Android Studio,
# gnu-тулчейн rust — directory override src-tauri (rustup).
# Usage: scripts/android-build.sh [debug|release] [targets...]   (default release aarch64)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TYPE="${1:-release}"
if [ "$TYPE" = "debug" ] || [ "$TYPE" = "release" ]; then shift || true; else TYPE=release; fi
# таргеты: по умолчанию aarch64 (телефоны) для release; debug — + x86_64 (эмулятор)
if [ $# -gt 0 ]; then TARGETS=("$@"); else
  if [ "$TYPE" = "debug" ]; then TARGETS=(aarch64 x86_64); else TARGETS=(aarch64); fi
fi

VER="$(node -p "require('./package.json').version")"
CONF_VER="$(node -p "require('./src-tauri/tauri.conf.json').version")"
CARGO_VER="$(grep -m1 '^version' src-tauri/Cargo.toml | sed 's/version *= *"\(.*\)"/\1/')"
ACONF_VER="$(node -p "require('./src-tauri/tauri.android.conf.json').version || ''" 2>/dev/null || true)"
if [ "$VER" != "$CONF_VER" ] || [ "$VER" != "$CARGO_VER" ] || { [ -n "$ACONF_VER" ] && [ "$ACONF_VER" != "$VER" ]; }; then
  echo "!! Версии разошлись: package.json=$VER tauri.conf.json=$CONF_VER Cargo.toml=$CARGO_VER tauri.android.conf.json=${ACONF_VER:-<наследует>} — сверьте и повторите" >&2
  exit 1
fi

# тулчейн Android (согласовано с android-dev.sh)
export ANDROID_HOME="${ANDROID_HOME:-$(cygpath -m "$LOCALAPPDATA/Android/Sdk")}"
if [ -z "${NDK_HOME:-}" ]; then
  NDK_VER="$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"
  export NDK_HOME="$ANDROID_HOME/ndk/$NDK_VER"
fi
export JAVA_HOME="${JAVA_HOME:-$(cygpath -m '/c/Program Files/Android/Android Studio/jbr')}"
# gcc хоста для build-скриптов крейтов (gnu-тулчейн rust — directory override
# src-tauri; MinGW для dlltool/windres уже в PATH сборок проекта)
export PATH="/c/Users/CUSTOM/msys64/ucrt64/bin:$PATH"

# 1) фронтенд (тот же dist/, что ест десктоп)
echo "==> Building frontend..."
npm run build

# 2) APK через tauri CLI (cwd src-tauri/: там tauri.conf.json и gen/android);
#    release — режим CLI по умолчанию, отдельный флаг только у debug
echo "==> Building android shell ($TYPE, targets: ${TARGETS[*]})..."
TYPE_FLAG=(); [ "$TYPE" = "debug" ] && TYPE_FLAG=(--debug)
(cd src-tauri && node ../node_modules/@tauri-apps/cli/tauri.js android build "${TYPE_FLAG[@]}" --apk --target "${TARGETS[@]}")

# 3) артефакт → builds/ (версия + тип — правила проекта)
APK_SRC="src-tauri/gen/android/app/build/outputs/apk/universal/$TYPE/app-universal-$TYPE.apk"
[ -f "$APK_SRC" ] || { echo "!! APK не найден: $APK_SRC" >&2; exit 1; }
OUT_DIR="$ROOT/builds/duopulse_${VER}_android_$TYPE"
mkdir -p "$OUT_DIR"

# подпись release: keystore.properties (секрет, в git не входит) + keystore
SIGNED=""
if [ "$TYPE" = "release" ]; then
  if [ -f src-tauri/gen/android/keystore.properties ]; then
    BT="$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
    if MSYS_NO_PATHCONV=1 "$ANDROID_HOME/build-tools/$BT/apksigner.bat" verify --print-certs \
        "$(cygpath -w "$APK_SRC")" >/dev/null 2>&1; then
      SIGNED="yes"
    fi
  fi
  if [ -n "$SIGNED" ]; then
    echo "==> APK подписан (duopulse-release.keystore)"
  else
    echo "!! APK НЕ подписан: нет src-tauri/gen/android/keystore.properties или apksigner failed —" >&2
    echo "   на телефон не встанет. Схема подписи — шапка этого скрипта." >&2
  fi
fi

SUFFIX=""
if [ "$TYPE" = "release" ] && [ -z "$SIGNED" ]; then SUFFIX="-unsigned"; fi
APK_NAME="DuoPulse-$VER-android-$TYPE$SUFFIX.apk"
cp -f "$APK_SRC" "$OUT_DIR/$APK_NAME"
echo "==> Done: ${OUT_DIR#$ROOT/}/$APK_NAME"

# 4) хаб «Скачать» Aila: сервер сканирует корень builds/ (duopulse-063) —
#    свежий release-APK туда, устаревшие — вон (debug не публикуем)
if [ "$TYPE" = "release" ]; then
  HUB_APK="DuoPulse-$VER-android-release$SUFFIX.apk"
  cp -f "$APK_SRC" "$ROOT/builds/$HUB_APK"
  echo "хаб «Скачать» Aila: $HUB_APK — обновлён (корень builds/)"
  # чистка устаревших — только для подписанной сборки: неподписанная кладётся
  # рядом с суффиксом -unsigned и не должна выгонять из хаба последний
  # рабочий подписанный APK
  if [ -n "$SIGNED" ]; then
    # без кавычек вокруг $(ls): иначе весь список — одно слово и цикл не
    # видит устаревшие APK (duopulse-083: 0.1.6 переживал чистку 0.1.8)
    for name in $(ls "$ROOT/builds"); do
      if [ "$name" != "$HUB_APK" ] && [[ "$name" =~ ^DuoPulse-[0-9.]+-android-release(-unsigned)?\.apk$ ]]; then
        rm -f "$ROOT/builds/$name"
        echo "хаб «Скачать» Aila: $name — убран (устарел)"
      fi
    done
  fi

  # 5) канал обновлений Aila (aila-388): каждый мобильный release обязан
  #    попадать и в него — манифест v2 (📡 «в канале» в хабе «Скачать» и
  #    проверка обновлений в самом приложении) раньше двигал только десктоп
  #    (release.mjs), и версия канала отставала от последней Android-сборки
  #    (0.1.16–0.1.20). Издатель общий — publish-update.cjs (aila-163):
  #    manifest.json + history.jsonl + «📦 Обновление …» в «Хабе ИИ».
  #    Notes — последняя запись CHANGELOG (правило: запись дописывается в
  #    конец к моменту релиза). Debug и неподписанные APK в канал не идут;
  #    неуспех публикации — ошибка сборки (канал не должен молча отставать).
  if [ -n "$SIGNED" ] && [ -f "D:/Scheduler/tools/publish-update.cjs" ]; then
    echo "==> Публикация в канал обновлений Aila…"
    MSYS_NO_PATHCONV=1 node "D:/Scheduler/tools/publish-update.cjs" duopulse \
      --version "$VER" \
      --extra "$(cygpath -m "$ROOT/builds/$HUB_APK")" \
      --notes-file "$(cygpath -m "$ROOT/CHANGELOG.md")" \
      || { echo "!! Публикация в канал Aila не удалась — канал отстанет от сборки." \
           "   Aila включена? Повторите: node D:/Scheduler/tools/publish-update.cjs duopulse --version $VER --extra builds/$HUB_APK --notes-file CHANGELOG.md" >&2; exit 1; }
  fi
fi
