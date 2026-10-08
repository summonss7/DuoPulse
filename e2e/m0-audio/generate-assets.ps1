# DuoPulse duopulse-006 — генератор поканальных аудио-тестов 5.1/7.1.
# Требования: PowerShell 5+ (SAPI TTS), ffmpeg в PATH.
# Продукты складываются в e2e\m0-audio\assets\, промежуточные — в _tmp\audio-build\.
#
# Каждому каналу — свой отрезок (сегмент SEG секунд): голосовая метка (SAPI,
# en-US) поверх опорного тона своей частоты. В любой момент активен ровно один
# канал: анализатором (RMS по окнам) легко проверить, что канал звучит только
# в своём окне и не «утёк» в соседние.

param(
  [int]$Seg = 2   # длительность сегмента одного канала, сек (голос ~1.4 с + хвост тона)
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # e2e
$root = Split-Path -Parent $root           # репо
$build = Join-Path $root '_tmp\audio-build'
$assets = Join-Path $PSScriptRoot 'assets'
New-Item -ItemType Directory -Force -Path $build | Out-Null
New-Item -ItemType Directory -Force -Path $assets | Out-Null

# ---- канал -> (метка, частота опорного тона Гц) ------------------------------
$chans = [ordered]@{
  FL  = @{ label = 'Front Left';   freq = 262 }
  FR  = @{ label = 'Front Right';  freq = 330 }
  FC  = @{ label = 'Center';       freq = 392 }
  LFE = @{ label = 'Subwoofer';    freq = 70  }
  BL  = @{ label = 'Back Left';    freq = 466 }
  BR  = @{ label = 'Back Right';   freq = 523 }
  SL  = @{ label = 'Side Left';    freq = 587 }
  SR  = @{ label = 'Side Right';   freq = 659 }
}

# ---- 1. Голосовые метки (SAPI -> моно WAV 48k/16) ---------------------------
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice('Microsoft David Desktop')
$synth.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

foreach ($k in $chans.Keys) {
  $wav = Join-Path $build ("voice_$k.wav")
  $synth.SetOutputToWaveFile($wav, $fmt)
  $synth.Speak($chans[$k].label)
  $synth.SetOutputToNull()
  Write-Host "TTS: $k -> $wav"
}

# ---- 2. Сегмент канала: голос + тихий тон, ровно $Seg секунд -----------------
foreach ($k in $chans.Keys) {
  $f = $chans[$k].freq
  $out = Join-Path $build ("seg_$k.wav")
  $fc = "[0:a]apad=whole_dur=$Seg,volume=1.0,afade=t=in:st=0:d=0.03[v];" +
        "[1:a]atrim=duration=$Seg,volume=0.10,afade=t=out:st=$($Seg-0.15):d=0.15[t];" +
        "[v][t]amix=inputs=2:normalize=0[out]"
  ffmpeg -hide_banner -loglevel error -y `
    -i (Join-Path $build "voice_$k.wav") `
    -f lavfi -i "sine=frequency=$f`:sample_rate=48000" `
    -filter_complex $fc `
    -map "[out]" -ac 1 -c:a pcm_s16le $out
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg seg_$k failed" }
  Write-Host "SEG: $k"
}

function Join-Inputs($keys) { # список seg_XX.wav -> массив аргументов ffmpeg
  $a = @()
  foreach ($k in $keys) { $a += '-i'; $a += (Join-Path $build "seg_$k.wav") }
  $a
}

# ---- 3. Сборка многоканальных файлов ----------------------------------------
# Каждый сегмент сдвигается на своё временное окно (adelay) и обрезается до
# полной длины файла (apad), затем join собирает каналы с правильной маской.
$layoutCh = @{
  '5.1'    = @('FL','FR','FC','LFE','BL','BR')
  '7.1'    = @('FL','FR','FC','LFE','BL','BR','SL','SR')
  'stereo' = @('FL','FR')
}

function Build-JoinFilter($layout, [int]$offset) {
  # $offset — индекс первого аудиовхода в общем списке входов ffmpeg
  $chNames = $layoutCh[$layout]
  $n = $chNames.Count
  $total = $n * $Seg
  $parts = @()
  for ($i = 0; $i -lt $n; $i++) {
    $ms = $i * $Seg * 1000
    $inIdx = $offset + $i
    $parts += "[${inIdx}:a]adelay=$ms`:all=1,apad=whole_dur=$total[c$i]"
  }
  $maps = (0..($n - 1) | ForEach-Object { "$_.0-$($chNames[$_])" }) -join '|'
  $pads = (0..($n - 1) | ForEach-Object { "[c$_]" }) -join ''
  $parts += "${pads}join=inputs=$n`:channel_layout=$layout`:map=$maps[a]"
  ($parts -join ';')
}

$in51  = Join-Inputs @('FL','FR','FC','LFE','BL','BR')
$in71  = Join-Inputs @('FL','FR','FC','LFE','BL','BR','SL','SR')
$in20  = Join-Inputs @('FL','FR')

$f51 = Build-JoinFilter '5.1' 0
$f71 = Build-JoinFilter '7.1' 0
$f20 = Build-JoinFilter 'stereo' 0

# WAV (несжатый PCM, WAVE_FORMAT_EXTENSIBLE с маской каналов)
ffmpeg -hide_banner -loglevel error -y $in51 -filter_complex $f51 -map "[a]" -c:a pcm_s16le (Join-Path $assets 'test-5.1.wav')
ffmpeg -hide_banner -loglevel error -y $in71 -filter_complex $f71 -map "[a]" -c:a pcm_s16le (Join-Path $assets 'test-7.1.wav')
ffmpeg -hide_banner -loglevel error -y $in20 -filter_complex $f20 -map "[a]" -c:a pcm_s16le (Join-Path $assets 'test-2.0.wav')

# Чёрное видео с подписью активного канала (drawtext) — контейнер для кодеков
function DrawText($keys, $w, $h) {
  $parts = @()
  $i = 0
  foreach ($k in $keys) {
    $st = $i * $Seg; $en = ($i + 1) * $Seg
    $parts += "drawtext=fontfile='C\:/Windows/Fonts/consola.ttf':text='$($chans[$k].label)':fontcolor=white:fontsize=$([int]($h/12)):x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,$st,$en)'"
    $i++
  }
  ($parts -join ',')
}

function MakeMp4($name, $keys, $acodec, $abit, $layout) {
  $in = Join-Inputs $keys
  $dur = $keys.Count * $Seg
  $fa = Build-JoinFilter $layout 1   # вход 0 — видео (color)
  $fc = "[0:v]$(DrawText $keys 640 360)[v];$fa"
  ffmpeg -hide_banner -loglevel error -y `
    -f lavfi -i "color=c=0x101418:s=640x360:r=24:d=$dur" `
    $in `
    -filter_complex $fc `
    -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p `
    -c:a $acodec -b:a $abit -movflags +faststart -shortest `
    (Join-Path $assets $name)
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg $name failed" }
}

MakeMp4 'test-5.1-aac.mp4'  @('FL','FR','FC','LFE','BL','BR')           'aac' 384k '5.1'
MakeMp4 'test-7.1-aac.mp4'  @('FL','FR','FC','LFE','BL','BR','SL','SR') 'aac' 512k '7.1'
MakeMp4 'test-5.1-ac3.mp4'  @('FL','FR','FC','LFE','BL','BR')           'ac3' 384k '5.1'

# FLAC 5.1 и Opus 5.1 (контейнер ogg)
ffmpeg -hide_banner -loglevel error -y $in51 -filter_complex $f51 -map "[a]" -c:a flac (Join-Path $assets 'test-5.1.flac')
ffmpeg -hide_banner -loglevel error -y $in51 -filter_complex $f51 -map "[a]" -c:a libopus -b:a 256k (Join-Path $assets 'test-5.1.opus.ogg')

Write-Host "`n=== Готово. Файлы в $assets ==="
Get-ChildItem $assets | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}} | Format-Table -AutoSize
