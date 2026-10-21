//! Маршрутизация сети (docs/02 §6, этап M6): локальный SOCKS5-роутер
//! (задача 6.1), клиент WireGuard (задача 6.2), split-правила и DNS (6.3).

pub mod dns;
pub mod router;
pub mod rules;
pub mod wg;
