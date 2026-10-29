#!/usr/bin/env python3
"""duopulse-060: прогон Vosk (python) на тест-аудио с замером времени.

Результат: results/vosk_runs.json + тексты results/v_<model>_<audio>.txt
"""
import json
import subprocess
import sys
import time
import wave
from pathlib import Path

from vosk import Model, KaldiRecognizer

P = Path(r'C:/Users/CUSTOM/AppData/Local/Temp/duopulse-asr-proto')
MODELS = {
    'vosk-small-en': P / 'models' / 'vosk-model-small-en-us-0.15',
    'vosk-small-ru': P / 'models' / 'vosk-model-small-ru-0.22',
}
AUDIO = {
    'en_david': ('vosk-small-en', P / 'audio' / 'en_david.wav'),
    'en_zira': ('vosk-small-en', P / 'audio' / 'en_zira.wav'),
    'ru_belkin': ('vosk-small-ru', P / 'audio' / 'ru_belkin_150s.wav'),
}

runs = []
models = {}
for mname, mdir in MODELS.items():
    t0 = time.perf_counter()
    models[mname] = Model(str(mdir))
    print(f'load {mname}: {time.perf_counter()-t0:.2f}s', flush=True)

for aname, (mname, apath) in AUDIO.items():
    wf = wave.open(str(apath), 'rb')
    rec = KaldiRecognizer(models[mname], wf.getframerate())
    rec.SetWords(False)
    t0 = time.perf_counter()
    chunks = 0
    final_text = []
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        chunks += 1
        if rec.AcceptWaveform(data):
            final_text.append(json.loads(rec.Result()).get('text', ''))
    final_text.append(json.loads(rec.FinalResult()).get('text', ''))
    dt = time.perf_counter() - t0
    dur = wf.getnframes() / float(wf.getframerate())
    text = ' '.join(final_text)
    (P / 'results' / f'v_{mname}_{aname}.txt').write_text(text, encoding='utf-8')
    runs.append({
        'engine': 'vosk', 'model': mname, 'audio': aname,
        'audio_s': round(dur, 1), 'wall_s': round(dt, 2),
        'rtf': round(dur / dt, 2),
    })
    print(runs[-1], flush=True)

(P / 'results' / 'vosk_runs.json').write_text(
    json.dumps(runs, ensure_ascii=False, indent=1), encoding='utf-8')
print('DONE')
