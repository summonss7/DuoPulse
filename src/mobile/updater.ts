// OTA мобильной DuoPulse из центра Aila (этап 3 карточки duopulse-083;
// концепция — D:\Scheduler\UPDATES-SYSTEM.md §3–5, механика — novagrid-063):
// тихая проверка манифеста /updates/duopulse/manifest.json при старте
// (калитка 10 минут по метке localStorage, образец lecards-027) + кнопка
// «Проверить обновления» на стартовом экране. Доступная версия — баннер
// «⬆ Доступна версия X» с notes; «Обновить» скачивает APK (прогресс —
// событие обёртки, sha256 сверяет Rust) и открывает системный установщик
// (needs-permission — пользователь разрешает источник и жмёт «Обновить»
// снова). Недоступный центр деградирует тихо: при ручной проверке — честное
// «не удалось», при тихой — ничего (§5). Десктоп обновляется своим
// tauri-plugin-updater по latest.json — ветки не пересекаются.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Ассет манифеста канала (зеркало Rust UpdateAsset, camelCase). */
export interface MobileUpdateAsset {
  name: string;
  url: string;
  size?: number;
  sha256?: string;
}

/** Ответ updater_check обёртки. */
export interface MobileUpdateCheck {
  status: "latest" | "available" | "network-error" | "bad-manifest";
  current: string;
  latest: string | null;
  notes: string | null;
  publishedAt: string | null;
  asset: MobileUpdateAsset | null;
  error: string | null;
}

/** Состояние баннера обновления (чем себя рендерить). */
export type UpdaterUi =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string | null }
  | { kind: "downloading"; version: string; downloaded: number; total: number }
  | { kind: "installing"; version: string }
  | { kind: "needs-permission" }
  | { kind: "latest"; version: string }
  | { kind: "error"; message: string };

/** Калитка тихой проверки: сессии на телефоне короткие, канал живой —
 * 10 минут (lecards-027; десктоп DuoPulse проверяет раз в сутки). */
export const SILENT_CHECK_PERIOD_MS = 10 * 60 * 1000;

const LAST_CHECK_KEY = "duopulse.mobile.update.lastCheck";

/** Тихая проверка нужна: ещё не проверяли или вышел период. */
export function shouldSilentCheck(lastCheck: number | null, now: number, periodMs = SILENT_CHECK_PERIOD_MS): boolean {
  return lastCheck === null || now - lastCheck > periodMs;
}

/** Чтение метки последней проверки (битое — «не проверяли»). */
export function readLastCheck(storage: Pick<Storage, "getItem"> = localStorage): number | null {
  const raw = storage.getItem(LAST_CHECK_KEY);
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Исход проверки → состояние UI: тихая без обновления ничего не показывает
 * (баннер не мелькает), ручная честно говорит «последняя»/ошибку. */
export function uiFromCheck(r: MobileUpdateCheck, manual: boolean): UpdaterUi {
  switch (r.status) {
    case "available":
      return { kind: "available", version: r.latest ?? "", notes: r.notes };
    case "latest":
      return manual ? { kind: "latest", version: r.current } : { kind: "idle" };
    default:
      // network-error | bad-manifest
      return manual
        ? { kind: "error", message: r.error ?? "не удалось проверить обновления" }
        : { kind: "idle" };
  }
}

/** Мегабайты для строки прогресса (без дробей — плашка узкая). */
export function mb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} МБ`;
}

export interface MobileUpdater {
  init(): Promise<void>;
  check(manual: boolean): Promise<void>;
  install(): Promise<void>;
}

/** Контроллер OTA. render — перерисовка баннера при каждом изменении
 * состояния; вызовы обёртки идут только с мобильной платформы (модуль
 * импортирует мобильный UI, где платформа уже проверена в main.ts). */
export function createMobileUpdater(
  render: (ui: UpdaterUi) => void,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): MobileUpdater {
  let ui: UpdaterUi = { kind: "idle" };
  let asset: MobileUpdateAsset | null = null;
  // версия доступного обновления (для текстов downloading/installing; живёт
  // дольше состояния available — install может стартовать из needs-permission)
  let pendingVersion = "";
  let subscribed = false;

  const setUi = (next: UpdaterUi): void => {
    ui = next;
    render(ui);
  };

  /** Подписка на прогресс скачивания — один раз (событие обёртки). */
  const subscribeProgress = (): void => {
    if (subscribed) return;
    subscribed = true;
    void listen<{ downloaded: number; total: number }>("duopulse:mobile-updater-progress", (e) => {
      const p = e.payload;
      if (ui.kind === "downloading" && p && typeof p.downloaded === "number") {
        setUi({ ...ui, downloaded: p.downloaded, total: p.total || ui.total });
      }
    }).catch(() => undefined);
  };

  return {
    async init(): Promise<void> {
      subscribeProgress();
      if (shouldSilentCheck(readLastCheck(storage), Date.now())) {
        await this.check(false);
      }
    },

    async check(manual: boolean): Promise<void> {
      if (ui.kind === "checking" || ui.kind === "downloading") return;
      if (manual) setUi({ kind: "checking" });
      let r: MobileUpdateCheck;
      try {
        r = await invoke<MobileUpdateCheck>("updater_check");
      } catch (err) {
        // команда обёртки не должна бросать (статусы внутри), но и этот путь
        // деградируем честно: ручная — ошибка, тихая — тишина
        setUi(
          manual
            ? { kind: "error", message: err instanceof Error ? err.message : String(err) }
            : { kind: "idle" },
        );
        return;
      }
      try {
        storage.setItem(LAST_CHECK_KEY, String(Date.now()));
      } catch {
        /* метка переживёт только сеанс — не критично */
      }
      asset = r.asset;
      if (r.status === "available") pendingVersion = r.latest ?? "";
      setUi(uiFromCheck(r, manual));
    },

    async install(): Promise<void> {
      const a = asset;
      if (!a?.sha256 || !a.url) return;
      const version = ui.kind === "available" ? ui.version : pendingVersion;
      setUi({ kind: "downloading", version, downloaded: 0, total: a.size ?? 0 });
      try {
        const path = await invoke<string>("updater_download", { url: a.url, sha256: a.sha256, size: a.size ?? 0 });
        const res = await invoke<"started" | "needs-permission">("updater_install", { path });
        // системный установщик открыт: приложение продолжает жить, Android
        // сам допоставит; needs-permission — источник разрешают и жмут снова
        setUi(res === "needs-permission" ? { kind: "needs-permission" } : { kind: "installing", version });
      } catch (err) {
        setUi({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
