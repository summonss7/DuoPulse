// Мини-SOCKS5-сервер для e2e стенда прокси/роутера (карточки duopulse-009/037).
// Только CONNECT, без аутентификации (RFC 1928) — или с обязательной
// RFC 1929 (login/password), если задан auth: прогоняет путь «роутер →
// внешний прокси с креденшалами из DPAPI» (задача 6.1).
// Запуск вручную: node e2e/proxy-a/socks5.mjs [порт]
import net from "node:net";

export function startSocks5({ port = 0, log = () => {}, auth = null } = {}) {
  const connects = [];
  const authResults = [];

  const server = net.createServer((socket) => {
    socket.on("error", () => {});

    const handleRequest = (req) => {
      if (req[0] !== 0x05 || req[1] !== 0x01) {
        socket.end(Buffer.from([0x05, 0x07])); // поддерживаем только CONNECT
        return;
      }
      const atyp = req[3];
      let host;
      let offset;
      if (atyp === 0x01) {
        host = `${req[4]}.${req[5]}.${req[6]}.${req[7]}`;
        offset = 8;
      } else if (atyp === 0x03) {
        const len = req[4];
        host = req.subarray(5, 5 + len).toString("latin1");
        offset = 5 + len;
      } else if (atyp === 0x04) {
        const b = req.subarray(4, 20);
        host = [0, 2, 4, 6, 8, 10, 12, 14].map((i) => b.subarray(i, i + 2).toString("hex")).join(":");
        offset = 20;
      } else {
        socket.destroy();
        return;
      }
      const portBig = req[offset] * 256 + req[offset + 1];
      const target = `${host}:${portBig}`;
      log(`CONNECT ${target}`);
      connects.push(target);

      const upstream = net.connect({ host, port: portBig }, () => {
        // успешный ответ: VER REP RSV ATYP IP PORT
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", () => {
        socket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      });
      socket.on("close", () => upstream.destroy());
    };

    socket.once("data", (greeting) => {
      if (greeting[0] !== 0x05) {
        socket.destroy(); // не SOCKS5
        return;
      }
      if (auth) {
        // требуем RFC 1929 (метод 0x02)
        if (!greeting.includes(0x02)) {
          socket.destroy();
          return;
        }
        socket.write(Buffer.from([0x05, 0x02]));
        socket.once("data", (a) => {
          if (a[0] !== 0x01) {
            socket.destroy();
            return;
          }
          const ulen = a[1];
          const user = a.subarray(2, 2 + ulen).toString("latin1");
          const plen = a[2 + ulen];
          const pass = a.subarray(3 + ulen, 3 + ulen + plen).toString("latin1");
          const ok = user === auth.user && pass === auth.pass;
          authResults.push(ok);
          log(`AUTH ${user}:${"•".repeat(pass.length)} ${ok ? "ok" : "FAIL"}`);
          if (!ok) {
            socket.end(Buffer.from([0x01, 0x01]));
            return;
          }
          socket.write(Buffer.from([0x01, 0x00]));
          socket.once("data", handleRequest);
        });
      } else {
        if (!greeting.includes(0x00)) {
          socket.destroy(); // нет метода «без аутентификации»
          return;
        }
        socket.write(Buffer.from([0x05, 0x00])); // выбран no-auth
        socket.once("data", handleRequest);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, connects, authResults }),
    );
  });
}

// --- самостоятельный запуск: node socks5.mjs [порт] -------------------------
if (process.argv[1]?.endsWith("socks5.mjs")) {
  const { server, port } = await startSocks5({
    port: Number(process.argv[2]) || 0,
    log: (m) => console.log(`[socks5] ${m}`),
  });
  console.log(`SOCKS5 listening on 127.0.0.1:${port}`);
  process.on("SIGINT", () => server.close(() => process.exit(0)));
}
