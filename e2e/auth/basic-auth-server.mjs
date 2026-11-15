// Стенд HTTP Basic-авторизации (карточка duopulse-148): localhost-«роутер» —
// без Authorization отдаёт 401 + WWW-Authenticate: Basic realm="Router Console",
// с верными кредами (admin / routerpass, переопределяется AUTH_USER/AUTH_PASS) —
// страницу «Панель роутера». Порт 8899 (AUTH_PORT). Живой прогон диалога
// авторизации DuoPulse — e2e/auth/stand.mjs.
import http from "node:http";

const USER = process.env.AUTH_USER || "admin";
const PASS = process.env.AUTH_PASS || "routerpass";
const PORT = Number(process.env.AUTH_PORT || 8899);

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || "";
  console.log(`[req] ${req.method} ${req.url} auth=${auth.slice(0, 30) || "нет"}`);
  const expect = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
  if (auth !== expect) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Router Console", charset="UTF-8"' });
    res.end("401 Unauthorized");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Панель роутера</title>` +
      `<h1>ROUTER-OK</h1><p>Стенд e2e/auth (duopulse-148): авторизация принята.</p>`,
  );
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`basic-auth-server: http://127.0.0.1:${PORT} (${USER}:${PASS})`);
});
