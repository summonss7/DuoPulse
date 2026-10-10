$ErrorActionPreference = 'SilentlyContinue'
$render = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
Get-ChildItem $render | ForEach-Object {
  $key = $_
  $state = (Get-ItemProperty $key.PSPath).DeviceState
  $props = Join-Path $key.PSPath 'Properties'
  $p = Get-ItemProperty $props
  $name = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  $desc = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
  $phys = $p.'{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0'
  $stateStr = switch ($state) { 1 {'ACTIVE'} 2 {'DISABLED'} 4 {'NOTPRESENT'} 8 {'UNPLUGGED'} default {"$state"} }
  '{0} | state={1} | PhysSpk=0x{2:X} | {3} | {4}' -f $key.PSChildName.Substring(0,8), $stateStr, [int64]$phys, $name, $desc
}
'--- default devices (role) ---'
$capt = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
# console role mapping via HKCU is complex; show RenderEndpointFormFactor via pkey instead
Get-ChildItem $render | ForEach-Object {
  $props = Join-Path $_.PSPath 'Properties'
  $p = Get-ItemProperty $props
  $ff = $p.'{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},0'
  $name = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
  '{0} | FormFactor={1}' -f $name, $ff
}
