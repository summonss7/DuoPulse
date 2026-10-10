Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object {
  '{0} | {1} | {2}' -f $_.VoiceInfo.Name, $_.VoiceInfo.Culture, $_.VoiceInfo.Gender
}
