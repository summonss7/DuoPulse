// Микростенд duopulse-066 (диагностика регрессии чека 22 основного стенда):
// пересоздание <video> с тем же videoKey — набор и состояние показа должны
// восстановиться из набор-памяти. Печатает снимок памяти на каждом шаге.
// Запуск: node e2e/subtitles/recreate-video.mjs
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri", "target", "debug", "duopulse.exe");
const CDP_PORT = 9242;
const HTTP_PORT = 8898;
const WWW = path.join(ROOT, "e2e", "subtitles");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(WWW, path.normalize(p).replace(/^([/\\]|\.\.)+/, "") || "testpage.html");
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  const size = statSync(file).size;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": size });
    createReadStream(file).pipe(res);
  }
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/`;

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  const open = new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  open.catch(() => {});
  return {
    send: (method, params = {}) =>
      open.then(
        () =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { res, rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
      ),
  };
}
const evalIn = (ws, expr) =>
  Promise.race([
    ws.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value),
    sleep(15000).then(() => {
      throw new Error("eval-таймаут");
    }),
  ]);
const waitForPage = async (ws, expr, timeoutMs, what) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await evalIn(ws, expr);
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`не дождались: ${what}`);
    await sleep(150);
  }
};
const show = async (tab, label) => {
  const s = await evalIn(tab, `window.__duopulseContent?.state()`);
  console.log(
    `${label}: key=${s?.videoKey} en=${s?.enabled} tr=${s?.engine?.trackCount} mem=${JSON.stringify(s?.setMemory)}`,
  );
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duopulse-recreate-"));
let vite = spawn("npm", ["run", "dev"], { cwd: ROOT, shell: true, stdio: "ignore" });
for (let i = 0; i < 60; i++) {
  try {
    await fetch("http://localhost:5173/");
    break;
  } catch {
    await sleep(500);
  }
}
const app = spawn(EXE, [], {
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    APPDATA: tmp,
    DUOPULSE_START_URL: pageUrl,
    DUOPULSE_ADBLOCK_LISTS: "",
    DUOPULSE_SLEEP_AFTER_SECS: "0",
    WEBVIEW2_USER_DATA_FOLDER: path.join(tmp, "webview2-data"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
  },
});
const appLog = [];
app.stderr?.on("data", (d) => appLog.push(String(d)));

try {
  let target;
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await (await fetch(`http://localhost:${CDP_PORT}/json`)).json();
      target = targets.find((t) => t.type === "page" && t.url.startsWith(pageUrl));
      if (target) break;
    } catch {}
    await sleep(1000);
  }
  const tab = connect(target.webSocketDebuggerUrl);

  await waitForPage(tab, `!!window.__duopulseContent?.state()?.videoKey`, 20000, "детект");
  await waitForPage(tab, `(window.__duopulseContent?.state().videoKey ?? "").endsWith(":30")`, 10000, "ключ с длительностью");
  await evalIn(
    tab,
    `(function () {
       window.__DUOPULSE_TEST_TRACK__ = { id: "test:ru", source: "test", lang: "ru", role: "original",
         cues: [{ startMs: 1000, endMs: 3000, text: "Первая реплика" }] };
       document.dispatchEvent(new CustomEvent("duopulse-test-track"));
       return true;
     })()`,
  );
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "дорожка применена");
  await show(tab, "после применения дорожки");

  // предыстория чека 22 основного стенда: SPA-переход и возврат (ключ
  // пересчитывается с :30 сразу), повторное применение дорожки, смена src
  await evalIn(tab, `history.pushState(null, "", "/watch?v=abc123XYZ")`);
  await waitForPage(tab, `(window.__duopulseContent?.state().videoKey ?? "").includes("watch")`, 4000, "SPA-ключ");
  await show(tab, "после SPA-ухода");
  await evalIn(tab, `history.pushState(null, "", "/")`);
  await waitForPage(tab, `(window.__duopulseContent?.state().videoKey ?? "") === "url:${pageUrl}:30"`, 4000, "возврат на /");
  await show(tab, "после SPA-возврата");
  await evalIn(tab, `document.dispatchEvent(new CustomEvent("duopulse-test-track"))`);
  await waitForPage(tab, `window.__duopulseContent?.state().engine.trackCount === 1`, 5000, "дорожка снова применена");
  await show(tab, "после повторного применения");
  await evalIn(tab, `document.getElementById("v").src = "/assets/testsrc.mp4"`);
  await sleep(1000);
  await show(tab, "после смены src (кейс A)");

  // пересоздание <video> (как чек 22 основного стенда)
  await evalIn(tab, `document.getElementById("v").remove()`);
  await waitForPage(tab, `window.__duopulseContent?.state().videoKey === null`, 5000, "videoKey=null");
  await show(tab, "после удаления видео");
  await evalIn(
    tab,
    `(function () {
       const v = document.createElement("video");
       v.id = "v"; v.muted = true; v.controls = true; v.preload = "auto";
       v.src = "/assets/testsrc.mp4";
       document.body.appendChild(v);
       return true;
     })()`,
  );
  await sleep(1500);
  await show(tab, "переходный детект (~1.5 с после добавления)");
  await waitForPage(tab, `(window.__duopulseContent?.state().videoKey ?? "").endsWith(":30")`, 10000, "уточнённый ключ");
  await show(tab, "уточнённый детект");
  const ok = await evalIn(tab, `window.__duopulseContent?.state().engine.trackCount === 1 && window.__duopulseContent?.state().enabled === true`);
  console.log(ok ? "RECREATE OK" : "RECREATE BROKEN");
  console.log("--- [subtitles] журнал ---");
  for (const l of appLog.join("").split("\n").filter((l) => l.includes("[subtitles]"))) console.log("  " + l.trimEnd());
} finally {
  try {
    app?.kill();
  } catch {}
  try {
    vite?.kill();
  } catch {}
  try {
    execFile("powershell", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='duopulse.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }`], () => {});
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  server.close();
}
