---
id: duopulse-239
title: Стенды e2e/bookmarks и e2e/settings оставляют осиротевший vite на 5173 после прогона — vite.kill() глушит только npm-оболочку
status: todo
priority: 3
created: 2026-11-23
updated: 2026-11-23
session: ""
build: false
---
## Задача
Стенды e2e/bookmarks/bmbar.mjs, bm-drag.mjs, bm-groups.mjs, nested.mjs, run.mjs и
e2e/settings/run.mjs поднимают dev-сервер как `spawn("npm", ["run", "dev"], { shell: true })`
и в уборке зовут `vite.kill()`. На Windows это глушит только npm-оболочку: дерево
cmd.exe → node vite остаётся висеть на порту 5173 (поймано в сеансе duopulse-235 на
bm-favicon.mjs — там уже поправлено на `taskkill /PID <vite.pid> /T /F`; тот же приём
с комментарием «vite.kill() на Windows убивает только npm-оболочку» принят в стендах
e2e/bridge, omnibox, passwords, proxy-a, session, sleep, style, subtitles, tabs, vpn,
adblock). Осиротевший vite — известная грабля «остатки процессов вешают стенды»:
следующий прогон подхватывает чужой/несвежий бандл либо не может занять порт.

Заменить в перечисленных стендах `vite.kill()` на глушение дерева
(`taskkill /PID <vite.pid> /T /F` в try/catch — образец e2e/tabs/run.mjs), остальную
уборку не трогать. Правок программы нет — только стенды.

## Критерии готовности
- [ ] В e2e/bookmarks/bmbar.mjs, bm-drag.mjs, bm-groups.mjs, nested.mjs, run.mjs и e2e/settings/run.mjs уборка глушит дерево npm→cmd→vite (taskkill /T), а не только оболочку; `vite.kill()` в этих файлах не остался
- [ ] Каждый исправленный стенд прогнан на собранном debug-exe: ИТОГ PASS, после выхода порт 5173 свободен (netstat) и процесса node vite проекта нет
- [ ] CHANGELOG дописан (дата-время начала и окончания, как проверено), коммит и push выполнены

## Журнал
- 23.11.2026, 22:28: карточка заведена по ходу duopulse-235 (стенд bm-favicon.mjs поправлен там же, гонян дважды — 8/8, порт после уборки свободен).
