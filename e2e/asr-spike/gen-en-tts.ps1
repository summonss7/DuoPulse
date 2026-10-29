# duopulse-060: генерация en тест-аудио для ASR-прототипа (SAPI TTS, 16 kHz моно).
# Ground truth — те же предложения, что ниже (файлы .txt рядом с .wav).
$ErrorActionPreference = 'Stop'
$out = 'C:/Users/CUSTOM/AppData/Local/Temp/duopulse-asr-proto/audio'
New-Item -ItemType Directory -Force -Path $out | Out-Null

Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
  16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
  [System.Speech.AudioFormat.AudioChannel]::Mono)

# Два диктора, ~110 секунд каждый: повседневная речь + новости + числа/имена.
$texts = @{
  'david' = @(
    'Welcome to the evening update. Today we are looking at three stories from the world of technology and science.',
    'Researchers at a small laboratory in northern California have built a battery that can charge in under five minutes.',
    'The team tested the design on two hundred cycles and observed almost no loss of capacity.',
    'Meanwhile, engineers in Munich presented a robot that can sort packages twice as fast as last year model.',
    'The machine weighs about forty kilograms and uses a single camera to recognise labels and damaged boxes.',
    'In financial news, the central bank kept the interest rate unchanged at four and a half percent.',
    'Analysts expected a small increase, so markets reacted positively in early trading.',
    'The price of oil dropped by nearly three percent after new supply numbers were published on Tuesday.',
    'Finally, a reminder that the city marathon will close several bridges this Sunday between six and eleven in the morning.',
    'Runners can pick up their numbers at the stadium on Friday and Saturday.',
    'Public transport will run more often, but expect delays near the finish area.',
    'Our next programme starts at nine and covers the history of local railways.',
    'Thank you for listening, and have a pleasant evening.'
  )
  'zira' = @(
    'Good morning, and here is your weather forecast for the weekend.',
    'Saturday will be sunny with a light wind from the south and a high of twenty two degrees.',
    'On Sunday clouds will arrive from the west, and rain is expected after four in the afternoon.',
    'If you are travelling to the mountains, take warm clothes, because nights are already cold there.',
    'Anna Kowalski from our reporting team studied how the city plans to change public transport next year.',
    'Three new tram lines should connect the railway station with the northern districts.',
    'The project costs around sixty million euros and should be finished by spring.',
    'Many residents welcome the plan, but some shop owners worry about construction work on their street.',
    'The city promises short interruptions and a hotline for questions during the works.',
    'In culture news, the local theatre opens the season with a classic play by Anton Chekhov.',
    'Tickets for the first night are already sold out, but extra dates were added in November.',
    'The museum of modern art offers free entry on the first Sunday of every month.',
    'Enjoy your day, and stay with us for traffic updates in ten minutes.'
  )
}

$voices = @{
  'david' = 'Microsoft David Desktop'
  'zira'  = 'Microsoft Zira Desktop'
}

foreach ($k in $texts.Keys) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $synth.SelectVoice($voices[$k])
  $synth.Rate = 0
  $wav = Join-Path $out ("en_$k.wav")
  $txt = Join-Path $out ("en_$k.txt")
  $synth.SetOutputToWaveFile($wav, $fmt)
  foreach ($s in $texts[$k]) { $synth.Speak($s); $synth.Speak(' ') }
  $synth.SetOutputToNull()
  ($texts[$k] -join ' ') | Out-File -FilePath $txt -Encoding utf8
  Write-Host "TTS: $k -> $wav"
}
Get-ChildItem $out | Select-Object Name, Length | Format-Table -AutoSize
