# Фикстуры субтитров (задача 3.1, карточка duopulse-022)

Входы юнит-тестов парсеров `src-tauri/src/subtitles/` (подключаются через
`include_str!`, тесты не зависят от рабочего каталога). Ожидаемые значения —
в `#[cfg(test)]`-блоках соответствующих парсеров.

| Файл | Формат | Что проверяет |
|---|---|---|
| `sample.srt` | SubRip, CRLF | happy path: многострочный текст, теги `<i>`, границы cue |
| `srt-edge.srt` | SubRip, BOM | BOM, мс через точку, cue без номера, перекрытие |
| `srt-broken.srt` | SubRip | негативный: битые тайминги, блок без тайминга, cue без текста |
| `sample.vtt` | WebVTT | заголовок, NOTE/STYLE/REGION, настройки cue, сущности, короткие таймстампы |
| `vtt-edge.vtt` | WebVTT, BOM | BOM, мс через запятую, перекрытие |
| `vtt-broken.vtt` | WebVTT | негативный: нет заголовка WEBVTT, блоки без тайминга, конец < начала |
| `timedtext.xml` | YouTube XML `<transcript>` | сущности (в т.ч. двойное экранирование `&amp;#39;`), перенос строки, тег `<font>` |
| `timedtext-legacy.xml` | YouTube XML `<timedtext><p>` | старый формат: атрибуты t/d в миллисекундах |
| `timedtext.json3` | YouTube JSON3 | нарастающая прокрутка `aAppend`-событий (duopulse-094), пропуск служебных событий без segs |
| `timedtext-asr.json3` | YouTube JSON3, ASR | пословный режим автосубтитров (duopulse-094): слово в момент речи, видно последние две строки, cue без смены текста продлеваются |
| `timedtext-broken.xml` | YouTube XML | негативный: нет start/dur, битые атрибуты, незакрытый элемент |
| `timedtext-broken.json3` | YouTube JSON3 | негативный: обрезанный JSON |

YouTube-фикстуры ручные, по структуре ответов `api/timedtext` (`fmt` без
параметра — XML, `fmt=json3` — JSON3); снапшоты реальных player-ответов —
`e2e/fixtures/youtube/` (задачи 3.3/3.8).
