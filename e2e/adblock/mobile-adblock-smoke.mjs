// E2E-смоук полного адблока мобильной ветки (карточка duopulse-144):
// движок adblock-rs (EasyList + uBO + quick-fixes) в web-оверлее.
// Проверки:
//   1) подгрузки рекламных хостов EasyList режутся ДВИЖКОМ (logcat
//      adblock-engine:), а не только лёгким хост-листом duopulse-139
//      (rubiconproject/adform/yieldmo в AD_HOSTS не входят);
//   2) контрольный локальный ресурс жив (движок не рвёт страницу);
//   3) тумблер выкл (mobile_adblock_set_enabled) = прежнее поведение:
//      движковых строк нет, лёгкий список (doubleclick) работает;
//   4) состояние тумблера переживает рестарт приложения (settings.json);
//   5) тяжёлая страница не роняет приложение, память в норме (dumpsys);
//   6) косметика: на странице с хост-правилами (m.youtube результаты)
//      в документе появляется наш <style> с display:none!important.
// Управление: adb + CDP webview_devtools_remote (конвенция 9223 — см.
// e2e/youtube/mobile-fullscreen.mjs; мёртвые цели прошлых сессий висят в
// /json вечно — цели ищем по URL каждый раз). APK и эмулятор подняты
// запускающим: adb install -r <apk>; am start; adb forward tcp:9223
// localabstract:webview_devtools_remote_<pid>. Смоук сам поднимает
// локальный сервер страниц (10.0.2.2:8901 из эмулятора).
//   node e2e/adblock/mobile-adblock-smoke.mjs
// Результат — e2e/adblock/mobile-adblock-smoke-last-run.json (gitignore,
// рантайм-артефакт). Скриншоты — %TEMP%/duopulse-144-*.png.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PORT = process.env.CDP_PORT || 9223;
const PKG = "dev.duopulse.mobile";
// 8899 (порт старых стендов) на этой машине попадает в Windows excluded-
// range (Hyper-V): слушаем 8901, эмулятор ходит через 10.0.2.2:8901
const HTTP_PORT = Number(process.env.DP144_HTTP_PORT || 8901);
const HERE = join(dirname(fileURLToPath(import.meta.url)), "mobile-smoke");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "mobile-adblock-smoke-last-run.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERIAL = process.env.ANDROID_SERIAL ||
  execFileSync("adb", ["devices"], { encoding: "utf8" })
    .split("\n").slice(1).find((l) => l.endsWith("device"))?.split("\t")[0] || "";
const adb = (...args) =>
  execFileSync("adb", SERIAL ? ["-s", SERIAL, ...args] : args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
const shot = (name) => {
  const p = join(tmpdir(), `duopulse-144-${name}.png`);
  const buf = execFileSync("adb",
    SERIAL ? ["-s", SERIAL, "exec-out", "screencap", "-p"] : ["exec-out", "screencap", "-p"],
    { maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(p, buf);
  console.log(`скриншот: ${p}`);
};

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

// --- локальный сервер страниц (ads.html/heavy.html/control.js) -------------
const server = createServer((req, res) => {
  const name = req.url.split("?")[0].replace(/^\//, "") || "ads.html";
  const types = { ".html": "text/html", ".js": "application/javascript" };
  try {
    const body = readFileSync(join(HERE, name));
    res.writeHead(200, { "content-type": types[name.slice(name.lastIndexOf("."))] || "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404).end("nope");
  }
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const pageUrl = (name) => `http://10.0.2.2:${HTTP_PORT}/${name}`;

// --- CDP --------------------------------------------------------------------
async function pageTargets() {
  return (await (await fetch(`http://localhost:${PORT}/json`)).json())
    .filter((x) => x.type === "page");
}
async function connect(urlRe) {
  const t = (await pageTargets()).find((x) => urlRe.test(x.url));
  if (!t) throw new Error(`нет CDP-цели ${urlRe} среди ` +
    (await pageTargets()).map((x) => x.url).join(", "));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const evalJs = (expr) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, {
      // Runtime.evaluate: { result: { value } } — разворачиваем значение,
      // исключение страницы — в reject (иначе «[object Object] is not valid»)
      res: (r) => r?.exceptionDetails
        ? rej(new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 160)))
        : res(r?.result?.value),
      rej,
    });
    ws.send(JSON.stringify({
      id: i, method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
  const invoke = (cmd, args = {}) =>
    evalJs(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  return { url: t.url, evalJs, invoke, close: () => ws.close() };
}

// Каждую фазу подключаемся заново: цели рождаются и умирают вместе с
// WebView оверлея (мёртвые висят в /json — коннект по живому URL)
const ui = () => connect(/^https?:\/\/tauri\.localhost|^tauri:|^about:blank/);

async function waitUi(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try { return await ui(); } catch { await sleep(1000); }
  }
  throw new Error("UI-webview CDP-цель не появилась");
}

const logcat = () => {
  try { return adb("logcat", "-d", "-s", "DuoPulseWeb"); }
  catch { return ""; }
};
const engineLines = (log) => log.split("\n").filter((l) => l.includes("adblock-engine:"));
const hostLines = (log) => log.split("\n").filter((l) => l.includes("adblock: ") && !l.includes("adblock-engine"));

// --- смоук ------------------------------------------------------------------
try {
  // приложение поднято запускающим; ждём UI-webview и готовности движка
  let u = await waitUi();
  let status = (await u.invoke("mobile_adblock_status"));
  check("команда mobile_adblock_status отвечает", typeof status.enabled === "boolean",
    `enabled=${status.enabled} ready=${status.ready}`);
  console.log("ждём списки движка (EasyList/uBO качаются на первый запуск)…");
  const rules = (st) => st.lists.find((l) => l.name === "easylist")?.rules ?? 0;
  for (let i = 0; i < 150 && !(status.ready && rules(status) > 1000); i++) {
    await sleep(2000);
    status = (await u.invoke("mobile_adblock_status"));
    if (i % 10 === 9) console.log(`  …ready=${status.ready} lists=` +
      status.lists.map((l) => `${l.name}:${l.rules}${l.error ? "!" : ""}`).join(" "));
  }
  check("движок готов (списки загружены, EasyList на месте)", status.ready && rules(status) > 1000,
    status.lists.map((l) => `${l.name}=${l.rules}`).join(", "));
  if (status.enabled === false) await u.invoke("mobile_adblock_set_enabled", { on: true });

  // 1-2: движок режет EasyList-хосты, контроль жив
  adb("logcat", "-c");
  await u.invoke("mobile_web_open", { url: pageUrl("ads.html") + "?r=" + Date.now() });
  await sleep(9000);
  let log = logcat();
  shot("ads-engine-on");
  for (const host of ["ads.rubiconproject.com", "track.adform.net", "ad.yieldmo.com"]) {
    check(`движок режет ${host} (EasyList, вне лёгкого списка)`,
      engineLines(log).some((l) => l.includes(host)));
  }
  const blocked1 = (await u.invoke("mobile_adblock_status")).blockedTotal;
  check("счётчик блокировок движка растёт (UI-команда)", blocked1 > 0, `blockedTotal=${blocked1}`);
  const ovAds = await connect(/10\.0\.2\.2:8901/);
  const ctl = await ovAds.evalJs("window.__dp144Control || 'none'");
  check("контрольный ресурс не порезан", ctl === "loaded", `__dp144Control=${ctl}`);
  ovAds.close();

  // 3: тумблер выкл = прежнее поведение (лёгкий список, движок молчит)
  await u.invoke("mobile_adblock_set_enabled", { on: false });
  await sleep(700);
  adb("logcat", "-c");
  await u.invoke("mobile_web_open", { url: pageUrl("ads.html") + "?r=" + Date.now() + "b" });
  await sleep(8000);
  log = logcat();
  shot("ads-engine-off");
  check("выкл: движковых строк нет", engineLines(log).length === 0,
    `${engineLines(log).length} шт.`);
  check("выкл: лёгкий хост-лист работает (doubleclick)",
    hostLines(log).some((l) => l.includes("doubleclick.net")));
  const blocked2 = (await u.invoke("mobile_adblock_status")).blockedTotal;
  check("выкл: счётчик движка не растёт", blocked2 === blocked1, `${blocked1}→${blocked2}`);
  await u.invoke("mobile_adblock_set_enabled", { on: true });
  await sleep(500);

  // 6: косметика на живой странице (m.youtube выдача: хост-правила EasyList)
  try {
    adb("logcat", "-c");
    await u.invoke("mobile_web_open", {
      url: "https://m.youtube.com/results?search_query=cats&dp144=" + Date.now(),
    });
    await sleep(14000);
    const yt = await connect(/m\.youtube\.com\/results/);
    const cosmetic = await yt.evalJs(
      `(() => { const s=[...document.querySelectorAll("style")].map(x=>x.textContent||"");` +
      ` return { styles: s.length, ours: s.some(t => t.includes("display:none!important")) }; })()`);
    check("косметика: наш <style> в документе", cosmetic?.ours === true,
      `styles=${cosmetic?.styles}`);
    yt.close();
  } catch (e) {
    check("косметика: наш <style> в документе", false, String(e).slice(0, 120));
  }

  // 4: состояние переживает рестарт (settings.json мобильного профиля)
  adb("shell", "am", "force-stop", PKG);
  await sleep(1500);
  adb("shell", "am", "start", "-n", `${PKG}/.MainActivity`);
  await sleep(7000);
  adb("forward", `tcp:${PORT}`, `localabstract:webview_devtools_remote_${adb("shell", "pidof", PKG).trim()}`);
  u = await waitUi();
  status = (await u.invoke("mobile_adblock_status"));
  check("после рестарта: тумблер включён (settings.json)", status.enabled === true);
  check("после рестарта: движок из кэша готов", status.ready === true);

  // 5: тяжёлая страница — приложение живо, память в норме
  await u.invoke("mobile_web_open", { url: pageUrl("heavy.html") });
  await sleep(9000);
  shot("heavy");
  const alive = adb("shell", "pidof", PKG).trim().length > 0;
  check("тяжёлая страница: приложение живо", alive);
  const hv = await connect(/10\.0\.2\.2:8901\/heavy/);
  const done = await hv.evalJs("window.__dp144Heavy || 'none'");
  check("тяжёлая страница: JS дошёл до конца", String(done).startsWith("done:"), String(done));
  hv.close();
  const mem = adb("shell", "dumpsys", "meminfo", PKG);
  const total = mem.split("\n").find((l) => l.includes("TOTAL PSS:"))?.trim() || "";
  const mb = Number(total.match(/TOTAL PSS:\s+(\d+)/)?.[1] ?? 0) / 1024;
  check("память в норме (< 600 МБ PSS)", mb > 0 && mb < 600, `${mb.toFixed(1)} МБ`);
  u.close?.();
} catch (e) {
  check("смоук дошёл до конца", false, String(e).slice(0, 200));
} finally {
  server.close();
  const ok = results.every((r) => r.ok);
  writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), ok, results }, null, 2));
  console.log(`\n${ok ? "OK" : "FAIL"}: ${results.filter((r) => r.ok).length}/${results.length}`);
  console.log(`отчёт: ${OUT}`);
  process.exit(ok ? 0 : 1);
}
