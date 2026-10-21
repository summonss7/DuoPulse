//! Bin петлевого стенда WireGuard для e2e/vpn (задача 6.6, карточка
//! duopulse-042; сервер — в lib.rs этого пакета). Живёт отдельным процессом:
//! ранер e2e/vpn стартует его, импортирует сгенерированный `.conf` в
//! приложение, а «обрыв upstream» для kill-switch — taskkill этого процесса.
//!
//! События — JSONL в stdout (flush после каждой строки):
//!   {"ev":"ready","udp_port":N}                          — сервер поднят
//!   {"ev":"dns","name":"blocked.tun","answer":"10.66.77.1"}
//!   {"ev":"tcp"}                                          — соединение в туннеле
//!   {"ev":"http","method":"GET","path":"/","status":200}
//!   {"ev":"fatal","err":"..."}                            — нить сервера умерла
//!
//! Запуск:
//!   wg-stand --conf <путь-клиентскому-.conf> [--serve /путь=файл:content-type ...]
//! Спец-путь /slow.bin?bytes=N — paced-поток (~8 МБ/с) для обрыва в середине.

use duopulse_wg_stand::{client_conf_text, LoopbackWgServer, ServeFile};
use std::io::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn usage() -> ! {
    eprintln!(
        "использование: wg-stand --conf <файл.conf> [--serve /url-путь=<файл>:<content-type> ...]"
    );
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut conf_path: Option<String> = None;
    let mut serves: Vec<(String, String, String)> = Vec::new(); // url-path, file, content-type
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--conf" => {
                i += 1;
                conf_path = Some(args.get(i).cloned().unwrap_or_else(|| usage()));
            }
            "--serve" => {
                i += 1;
                let spec = args.get(i).cloned().unwrap_or_else(|| usage());
                // /url-путь=<файл>:<content-type>
                let Some((url_path, rest)) = spec.split_once('=') else {
                    usage();
                };
                let (file, ctype) = match rest.rsplit_once(':') {
                    Some((f, c)) => (f.to_string(), c.to_string()),
                    None => (rest.to_string(), "application/octet-stream".into()),
                };
                serves.push((url_path.to_string(), file, ctype));
            }
            _ => usage(),
        }
        i += 1;
    }
    let conf_path = conf_path.unwrap_or_else(|| usage());

    let mut files = Vec::new();
    for (url_path, file, ctype) in serves {
        let body = match std::fs::read(&file) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("не читается файл раздачи {file}: {e}");
                std::process::exit(2);
            }
        };
        files.push(ServeFile {
            path: url_path,
            body: Arc::new(body),
            content_type: ctype,
        });
    }

    // fatal в stdout + признак для main: нить сервера умерла — выходим, чтобы
    // ранер не ждал timeouts от молчащего стенда.
    let fatal = Arc::new(AtomicBool::new(false));
    let stdout_emit: duopulse_wg_stand::EventSink = {
        let fatal = Arc::clone(&fatal);
        Arc::new(move |line: &str| {
            if line.contains("\"ev\":\"fatal\"") {
                fatal.store(true, Ordering::Relaxed);
            }
            let mut out = std::io::stdout().lock();
            let _ = writeln!(out, "{line}");
            let _ = out.flush();
        })
    };

    let server = LoopbackWgServer::start(None, files, Some(Arc::clone(&stdout_emit)));
    let conf = client_conf_text(server.port);
    if let Err(e) = std::fs::write(&conf_path, &conf) {
        eprintln!("не пишется .conf {conf_path}: {e}");
        std::process::exit(2);
    }
    stdout_emit(
        &serde_json::json!({
            "ev": "ready",
            "udp_port": server.port,
            "conf": conf_path,
        })
        .to_string(),
    );

    // Живём, пока ранер не убьёт процесс (kill-switch — это и есть «обрыв
    // upstream»); самостоятельный выход — только по fatal серверной нити.
    while !fatal.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
    std::process::exit(1);
}
