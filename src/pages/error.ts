// DuoPulse — страница ошибки загрузки (карточка duopulse-048, docs/02 §6.2):
// собственная замена ERR-странице Chromium при неудачной навигации внешнего
// сайта — адрес, причина и действие «этот сайт — через туннель»: split-правило
// для хоста (vpn.add_rule — общий стор IPC ↔ роутер, задача 6.3) + подсказка
// включить туннель/split; туннель поднят — сразу повторная загрузка по
// правилу. Контекст (url/code/reason) кладёт init-скриптом Core при замене
// webview вкладки (tabs::show_error_page); без контекста (ручной ввод
// duopulse://error) — заглушка без действий.
import { bridge } from "../bridge";
import type { VpnStatusResult } from "../bridge/gen/types";
import {
  directAction,
  directActionAvailable,
  errorHost,
  routeContextNote,
  tunnelAction,
} from "./error-view";

const err = (e: unknown): void => console.error("error-page:", e);

/** Контекст от Core: чем навигация упала (window.__DUOPULSE_ERROR__). */
interface ErrorContext {
  url: string;
  code: number;
  reason: string;
}

const ctx = (window as { __DUOPULSE_ERROR__?: ErrorContext }).__DUOPULSE_ERROR__;
const host = errorHost(ctx?.url);

document.title = "Не удалось открыть сайт";
document.body.classList.add("internal-page");
document.getElementById("app")?.remove(); // разметка хрома странице не нужна

const root = document.createElement("div");
root.className = "errp";

const ico = document.createElement("span");
ico.className = "err-ico";
ico.innerHTML =
  '<svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 18h24a10 10 0 0 1 10 10v2"/><path d="M13 11 6 18l7 7"/><path d="M30 38h12" opacity="0"/><path d="M33 30l9 9m0-9-9 9"/></svg>';

const title = document.createElement("h1");
title.textContent = "Сайт не открылся";

root.append(ico, title);

const note = document.createElement("p");
note.className = "err-note";
note.setAttribute("role", "status");

if (ctx) {
  const addr = document.createElement("div");
  addr.className = "err-url";
  addr.textContent = ctx.url;
  addr.title = ctx.url;
  const reason = document.createElement("p");
  reason.className = "err-reason";
  reason.textContent = `${ctx.reason} (код ${ctx.code}).`;
  const actions = document.createElement("div");
  actions.className = "err-actions";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "primary";
  retry.textContent = "Повторить";
  retry.addEventListener("click", () => {
    void bridge.nav.navigate({ url: ctx.url }).catch(err);
  });

  actions.append(retry);
  // Split-кнопки — только для адреса с доменом: правило доменное, IP-адрес
  // и внутренние страницы не считаются. Туннель поднят — сайт уже пытались
  // через туннель, первой идёт «напрямую» (карточка duopulse-075: RU-сервисы
  // режут зарубежные IP и в глобальном режиме «не работают»); туннель выключен
  // — сайт шёл напрямую, уместна «через туннель».
  if (host) {
    const mkSplit = (
      route: "tunnel" | "direct",
      title: string,
      decide: typeof tunnelAction,
    ): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = `«${host}» — ${route === "tunnel" ? "через туннель" : "напрямую"}`;
      b.title = title;
      b.addEventListener("click", () => {
        b.disabled = true;
        void bridge.vpn
          .addRule({ domain: host, route })
          .then(async () => {
            // прямому правилу нужен split: глобальный режим переключаем,
            // остальной трафик остаётся в туннеле
            if (route === "direct") {
              const cur = await bridge.vpn.status();
              if (cur.routing === "global") await bridge.vpn.setMode({ mode: "split" });
            }
            return bridge.vpn.status();
          })
          .then((st: VpnStatusResult) => {
            const act = decide(st);
            note.textContent = act.note;
            if (act.retry) void bridge.nav.navigate({ url: ctx.url }).catch(err);
          })
          .catch((e) => {
            b.disabled = false;
            note.textContent = String(e);
            err(e);
          });
      });
      return b;
    };
    actions.append(
      // порядок — по вероятной причине: статус определяет порядок ниже
      mkSplit(
        "tunnel",
        "Добавить split-правило для домена и повторить загрузку",
        tunnelAction,
      ),
    );
    void bridge
      .vpn.status()
      .then((st: VpnStatusResult): void => {
        // Подсказка маршрута (duopulse-114): сайт грузился через туннель/прокси —
        // без контекста «код 9» выглядит багом браузера.
        const hint = routeContextNote(st);
        if (hint) {
          const p = document.createElement("p");
          p.className = "err-route";
          p.textContent = hint;
          root.insertBefore(p, actions);
        }
        // туннель не поднят — сайт и так идёт напрямую, кнопка не нужна
        if (!directActionAvailable(st)) return;
        const first = actions.querySelector("button:not(.primary)");
        const direct = mkSplit(
          "direct",
          "Маршрутировать домен мимо туннеля (split) и повторить загрузку",
          directAction,
        );
        if (first) actions.insertBefore(direct, first);
        else actions.append(direct);
      })
      .catch(err);
  }

  root.append(addr, reason, actions, note);
} else {
  const stub = document.createElement("p");
  stub.className = "err-reason";
  stub.textContent = "Сведений об ошибке нет.";
  root.append(stub);
}

document.body.append(root);
