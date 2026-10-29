#!/usr/bin/env python3
"""duopulse-060: WER всех прогонов (whisper tiny/base/small + vosk) против эталонов.

en: эталон — скрипт TTS (audio/en_*.txt).
ru: эталон — полный текст Wikisource; 150-с фрагмент выравнивается по первым
    словам гипотезы (LibriVox читает текст близко к изданию), WER считается
    по выровненному отрезку той же длины в словах.
Результат: results/wer_summary.json + печать таблицы.
"""
import json
import re
import unicodedata
from pathlib import Path

P = Path(r'C:/Users/CUSTOM/AppData/Local/Temp/duopulse-asr-proto')
WER = P / 'wer.py'


def norm_words(text: str) -> list[str]:
    text = unicodedata.normalize('NFKC', text).lower().replace('ё', 'е')
    return re.findall(r'[0-9a-zа-я\u0301]+', text)


def wer(ref: list[str], hyp: list[str]) -> float:
    d = [[0] * (len(hyp) + 1) for _ in range(len(ref) + 1)]
    for i in range(len(ref) + 1):
        d[i][0] = i
    for j in range(len(hyp) + 1):
        d[0][j] = j
    for i in range(1, len(ref) + 1):
        for j in range(1, len(hyp) + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    return d[len(ref)][len(hyp)] / max(1, len(ref))


def ru_ref_slice(hyp_words: list[str], ref_words: list[str]) -> list[str]:
    """Найти начало фрагмента: окно из первых 12 слов гипотезы, минимум ошибок
    среди всех позиций эталона; отрезок — той же длины, что гипотеза."""
    probe = hyp_words[:12]
    best, best_i = None, 0
    for i in range(0, min(len(ref_words), 20000) - 12):
        window = ref_words[i:i + 12]
        err = sum(1 for a, b in zip(window, probe) if a != b)
        if best is None or err < best:
            best, best_i = err, i
    n = len(hyp_words)
    return ref_words[best_i:best_i + n]


runs = []
for engine, models in (
    ('whisper', {'tiny': 'tiny', 'base': 'base', 'small': 'small'}),
    ('vosk', {'vosk-small-en': 'vosk-small-en', 'vosk-small-ru': 'vosk-small-ru'}),
):
    for mname in models:
        for aname in ('en_david', 'en_zira', 'ru_belkin'):
            f = P / 'results' / f"{'w' if engine == 'whisper' else 'v'}_{mname}_{aname}.txt"
            if not f.exists():
                continue
            hyp = norm_words(f.read_text(encoding='utf-8'))
            if aname.startswith('en_'):
                ref = norm_words((P / 'audio' / f'{aname}.txt').read_text(encoding='utf-8-sig'))
            else:
                full = norm_words((P / 'audio' / 'ru_belkin_wikisource.txt').read_text(encoding='utf-8'))
                ref = ru_ref_slice(hyp, full)
            runs.append({
                'engine': engine, 'model': mname, 'audio': aname,
                'ref_words': len(ref), 'hyp_words': len(hyp),
                'wer_pct': round(wer(ref, hyp) * 100, 1),
            })

(P / 'results' / 'wer_summary.json').write_text(
    json.dumps(runs, ensure_ascii=False, indent=1), encoding='utf-8')
for r in runs:
    print(r)
