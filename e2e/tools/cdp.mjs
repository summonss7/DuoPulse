// CDP-помощник для e2e-проверок DuoPulse (WebView2/Edge remote debugging, порт 9222,
// переопределяется переменной CDP_PORT).
// Использование:
//   node e2e/tools/cdp.mjs <подстрока-URL> eval "<js-выражение>"
//   node e2e/tools/cdp.mjs <подстрока-URL> shot <файл.png>
//   node e2e/tools/cdp.mjs <подстрока-URL> shotfull <файл.png>
//   node e2e/tools/cdp.mjs <подстрока-URL> console <мс-слушать>
//   node e2e/tools/cdp.mjs <подстрока-URL> click <x,y>   — trusted-клик (Input domain)
import fs from "node:fs";

const [, , match, mode, arg] = process.argv;
if (!match || !mode) {
  console.error("usage: node cdp.mjs <url-substr> eval|shot|shotfull|console|click <arg>");
  process.exit(2);
}

const targets = await (await fetch(`http://localhost:${process.env.CDP_PORT || 9222}/json`)).json();
const t = targets.find((x) => x.type === "page" && x.url.includes(match));
if (!t) {
  console.error("no CDP target matching:", match, "| have:", targets.map((x) => x.url).join(", "));
  process.exit(1);
}

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    const text = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    console.log("[console." + m.params.type + "]", text.slice(0, 500));
  } else if (m.method === "Runtime.exceptionThrown") {
    console.log("[console.exception]", JSON.stringify(m.params.exceptionDetails).slice(0, 500));
  }
};
function send(method, params = {}) {
  return new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await send("Runtime.enable");

if (mode === "eval") {
  const r = await send("Runtime.evaluate", { expression: arg, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) console.log("EXCEPTION:", JSON.stringify(r.exceptionDetails.exception ?? r.exceptionDetails).slice(0, 800));
  else console.log(JSON.stringify(r.result?.value ?? r.result, null, 1)?.slice(0, 4000));
} else if (mode === "shot") {
  await send("Page.enable");
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(arg, Buffer.from(r.data, "base64"));
  console.log("saved:", arg);
} else if (mode === "shotfull") {
  await send("Page.enable");
  const metrics = await send("Page.getLayoutMetrics");
  const { width, height } = metrics.contentSize;
  await send("Emulation.setDeviceMetricsOverride", {
    width: Math.ceil(width), height: Math.ceil(height), deviceScaleFactor: 1, mobile: false,
  });
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  fs.writeFileSync(arg, Buffer.from(r.data, "base64"));
  await send("Emulation.clearDeviceMetricsOverride");
  console.log("saved:", arg, `(${Math.ceil(width)}x${Math.ceil(height)})`);
} else if (mode === "click") {
  const [x, y] = arg.split(",").map(Number);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1,
    });
  }
  console.log("clicked", x, y);
} else if (mode === "console") {
  await send("Page.enable");
  await new Promise((r) => setTimeout(r, Number(arg || 5000)));
}
ws.close();
process.exit(0);
