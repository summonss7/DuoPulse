//! DNS-резолв строго по маршруту (задача 6.3, docs/02 §6.1–6.2).
//!
//! Правило без утечек (docs/02 §6): DNS-запрос домена уходит тем же
//! маршрутом, что и само соединение —
//!   - туннельный домен (split-правило «tunnel» или режим global): резолвит
//!     ТОЛЬКО DNS-сервер профиля WireGuard через UDP-сокет стека внутри
//!     туннеля ([`crate::vpn::wg::WgSession::resolve`]); к системному
//!     резолверу туннельный маршрут не обращается — утечек нет;
//!   - прямой домен (режим off, прокси-режим без удалённого резолва не
//!     бывает — см. ниже, split-правило «direct»/умолчание): системный
//!     резолвер, как без VPN.
//!
//! Схема `--proxy-server=socks5://…` заставляет Chromium присылать домен
//! неразрешённым (ATYP=domain), поэтому решение «куда резолвить» принимает
//! роутер ПОСЛЕ матчинга split-правила — по имени, до первого DNS-запроса.
//! Внешний прокси (Upstream) получает цель доменом и резолвит её сам
//! (удалённый резолв, RFC 1928) — локальных DNS-запросов тоже нет.
//!
//! Единственное системное исключение — endpoint самого WG-сервера: он
//! резолвится до туннеля системно, как у любого WireGuard-клиента
//! (внутри туннеля пути к нему ещё нет).

use std::net::{IpAddr, SocketAddr, ToSocketAddrs};

/// Резолвер, соответствующий выбранному маршруту соединения.
pub enum Resolver<'a> {
    /// DNS-сервер профиля через туннель WireGuard (без утечек).
    Tunnel(&'a crate::vpn::wg::WgSession),
    /// Системный резолвер (прямой маршрут).
    System,
}

impl Resolver<'_> {
    /// Адрес для TCP-соединения. IP-литералы проходят без DNS-запроса
    /// вовсе; туннель — стек proto-ipv4, IPv6-литерал честно отклоняется.
    pub fn resolve(&self, host: &str, port: u16) -> Result<SocketAddr, String> {
        match self {
            Resolver::Tunnel(session) => match host.trim().parse::<IpAddr>() {
                Ok(IpAddr::V4(v4)) => Ok(SocketAddr::new(IpAddr::V4(v4), port)),
                Ok(IpAddr::V6(_)) => Err(format!("{host}: IPv6 через туннель не поддержан (v1)")),
                Err(_) => session
                    .resolve(host.trim())
                    .map(|ip| SocketAddr::new(IpAddr::V4(ip), port))
                    .map_err(|e| format!("резолв {host} DNS-сервером туннеля: {e}")),
            },
            Resolver::System => resolve_system(host, port),
        }
    }
}

/// Системный резолв (прямой маршрут): IP-литерал — без DNS, иначе
/// getaddrinfo (ToSocketAddrs).
pub fn resolve_system(host: &str, port: u16) -> Result<SocketAddr, String> {
    if let Ok(ip) = host.trim().parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    (host.trim(), port)
        .to_socket_addrs()
        .map_err(|e| format!("резолв {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("резолв {host}: пусто"))
}

// ---------------------------------------------------------------------------
// Тесты: системный путь и литералы (туннельный путь — интеграционно в
// wg.rs/router.rs по loopback-стенду: DNS-ответчик сервера видит запрос,
// системный резолвер — нет).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_resolves_localhost_and_literals() {
        let a = resolve_system("127.0.0.1", 80).unwrap();
        assert_eq!(a, SocketAddr::new(IpAddr::V4([127, 0, 0, 1].into()), 80));

        let a = resolve_system("  localhost  ", 8080).unwrap();
        assert_eq!(a.port(), 8080);
        assert!(a.ip().is_loopback(), "localhost — loopback: {a}");
    }

    #[test]
    fn system_unresolvable_name_is_error() {
        // .test — зарезервированная зона (RFC 6761), в системном DNS её нет.
        assert!(resolve_system("no-such-host.invalid", 80).is_err());
    }
}
