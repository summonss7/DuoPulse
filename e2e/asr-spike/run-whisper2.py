#!/usr/bin/env python3
"""duopulse-060 (ревизия): прогон whisper.cpp CLI БЕЗ -nt.

Утренний прогон с -nt (no timestamps) на части файлов терял середину
(en_zira, ru base) — путь -nt в whisper-cli ненадёжен; дефолтный вывод
сегментами [t0 --> t1] корректен. Здесь: замер wall time + текст
(таймстампы срезаны) для WER.
Результат: results/whisper_runs2.json + results/w2_<model>_<audio>.txt
"""
import json
import re
import subprocess
import time
from pathlib import Path

P = Path(r'C:/Users/CUSTOM/AppData/Local/Temp/duopulse-asr-proto')
MAIN = P / 'build' / 'bin' / 'whisper-cli.exe'
MODELS = {
    'tiny': P / 'models' / 'ggml-tiny.bin',
    'base': P / 'models' / 'ggml-base.bin',
    'small': P / 'models' / 'ggml-small.bin',
}
AUDIO = {
    'en_david': ('en', P / 'audio' / 'en_david.wav'),
    'en_zira': ('en', P / 'audio' / 'en_zira.wav'),
    'ru_belkin': ('ru', P / 'audio' / 'ru_belkin_150s.wav'),
}
THREADS = '8'
TS = re.compile(r'^\[[^\]]*\]\s*')

runs = []
for mname, mpath in MODELS.items():
    for aname, (lang, apath) in AUDIO.items():
        t0 = time.perf_counter()
        proc = subprocess.run(
            [str(MAIN), '-m', str(mpath), '-f', str(apath), '-l', lang, '-t', THREADS],
            capture_output=True, text=True, encoding='utf-8', errors='replace')
        dt = time.perf_counter() - t0
        dur = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=nw=1:nk=1', str(apath)],
            capture_output=True, text=True).stdout.strip()
        lines = [TS.sub('', ln).strip() for ln in proc.stdout.splitlines()]
        text = ' '.join(x for x in lines if x)
        (P / 'results' / f'w2_{mname}_{aname}.txt').write_text(text, encoding='utf-8')
        runs.append({
            'engine': 'whisper.cpp', 'model': mname, 'audio': aname,
            'lang': lang, 'audio_s': round(float(dur), 1),
            'wall_s': round(dt, 2), 'rtf': round(float(dur) / dt, 2),
            'returncode': proc.returncode, 'words': len(text.split()),
        })
        print(runs[-1], flush=True)

(P / 'results' / 'whisper_runs2.json').write_text(
    json.dumps(runs, ensure_ascii=False, indent=1), encoding='utf-8')
print('DONE')
