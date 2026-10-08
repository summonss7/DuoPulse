// DuoPulse duopulse-006 — статический сервер тест-стенда многоканального звука.
// Отдаёт e2e/m0-audio (страницу audio-test.html и assets/) на 127.0.0.1:8788
// с правильными MIME и поддержкой Range (нужно <audio>/<video>).
// Запуск: node e2e/m0-audio/serve.mjs
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = 8788;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const rel = normalize(urlPath).replace(/^([/\\]|\.\.)+/, "");
    const file = join(ROOT, rel === "" || rel === "." ? "audio-test.html" : rel);
    let st;
    try {
      st = statSync(file);
      if (!st.isFile()) throw new Error("not a file");
    } catch {
      res.writeHead(404).end("not found");
      return;
    }
    const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? +m[1] : 0;
      const end = m && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": st.size });
      createReadStream(file).pipe(res);
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`audio-test stand: http://127.0.0.1:${PORT}/audio-test.html`));
