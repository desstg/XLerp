# XLerp Windows background service (scheduled task running as SYSTEM at boot).
# Called by the installer / uninstaller:
#   xerp-service.ps1 -Action install   -AppDir <dir> -DataDir <dir> -Port 8686 -Mode server|client -ClientServer <url>
#   xerp-service.ps1 -Action uninstall -AppDir <dir>
#   xerp-service.ps1 -Action stop      -AppDir <dir>
#   xerp-service.ps1 -Action reconfig  -AppDir <dir> -DataDir <dir>   (rebuild task from config.json)
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI.
param(
  [Parameter(Mandatory = $true)][ValidateSet('install', 'uninstall', 'stop', 'reconfig')][string]$Action,
  [Parameter(Mandatory = $true)][string]$AppDir,
  [string]$DataDir = (Join-Path $env:ProgramData 'XERP'),
  [int]$Port = 8686,
  [string]$Mode = '',
  [string]$ClientServer = ''
)
$ErrorActionPreference = 'Stop'
$TaskName = 'XLerp'
$RuleName = 'xerp-tcp-in'
$AppDir = $AppDir.TrimEnd('\')
$LogFile = Join-Path $DataDir 'install.log'
function Log($m) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m) } catch {} }

function Stop-Xerp {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
  # Only kill node.exe processes that belong to this installation
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 800
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if ($Action -eq 'stop') { Stop-Xerp; Log 'stopped'; exit 0 }

if ($Action -eq 'uninstall') {
  Stop-Xerp
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch {}
  try { Remove-NetFirewallRule -Name $RuleName -ErrorAction Stop } catch {}
  Log 'uninstalled (data kept)'
  exit 0
}

# ---- install / upgrade / reconfig ----
# reconfig: only rebuild the scheduled task from config.json (used after changing mode in the UI)
# reconfig: only rebuild the scheduled task (mode comes from config.json when -Mode is empty)
Stop-Xerp
$node = Join-Path $AppDir 'node.exe'
$pwdFile = Join-Path $DataDir 'admin-password.txt'

# Run mode:
#   server (default) -> portal.js, data lives in $DataDir, LAN clients can connect
#   client           -> client.js, proxies everything to the remote server, no local data
# Installer always passes -Mode explicitly ('server' or 'client'), which wins.
# Only when -Mode is empty (plain -Action reconfig) do we fall back to config.json.
$runMode = 'server'
$runRemote = ''
$ModeIn = ([string]$Mode).Trim().ToLowerInvariant()
if ($ModeIn -like 'client*') {
  $runMode = 'client'; $runRemote = ([string]$ClientServer).Trim()
} elseif ($ModeIn -like 'server*') {
  $runMode = 'server'; $runRemote = ''
} else {
  $cfgPath = Join-Path $DataDir 'config.json'
  if (Test-Path $cfgPath) {
    try {
      $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
      if ([string]$cfg.mode -like 'client*') { $runMode = 'client'; $runRemote = [string]$cfg.clientServer }
    } catch { Log ('config.json parse failed: ' + $_.Exception.Message) }
  }
}

# Persist the choice so a later reconfig sees the same thing
try {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $cfgPath = Join-Path $DataDir 'config.json'
  $cfgObj = @{ mode = $runMode; clientServer = $runRemote }
  if (Test-Path $cfgPath) {
    $old = Get-Content $cfgPath -Raw | ConvertFrom-Json
    foreach ($p in $old.PSObject.Properties) { if ($p.Name -ne 'mode' -and $p.Name -ne 'clientServer') { $cfgObj[$p.Name] = $p.Value } }
  }
  $cfgObj | ConvertTo-Json -Depth 8 | Set-Content -Path $cfgPath -Encoding UTF8
} catch { Log ('config.json write failed: ' + $_.Exception.Message) }

if ($runMode -eq 'client') {
  # client.js listens on its own port and proxies /api to the remote server
  $clientPort = 18686
  $argLine = '"' + (Join-Path $AppDir 'client.js') + '" --port ' + $clientPort + ' --server "' + $runRemote + '" --no-browser'
  $act = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $AppDir
  $trg = New-ScheduledTaskTrigger -AtStartup
  $pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Principal $pri -Settings $set `
    -Description "XLerp client (http://127.0.0.1:$clientPort -> $runRemote)" -Force | Out-Null
  # No inbound firewall rule: client mode does not accept connections from other machines
  try { Remove-NetFirewallRule -Name $RuleName -ErrorAction Stop } catch {}
  Log "task registered, CLIENT mode, port $clientPort, remote $runRemote"
  Start-ScheduledTask -TaskName $TaskName
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$clientPort/local/ping"
      if ($r.Content -match 'XERP-Client') { Log 'client is up'; exit 0 }
    } catch {}
  }
  Log "client did not answer on port $clientPort within 20s"
  exit 0
}

$argLine = '"' + (Join-Path $AppDir 'portal.js') + '" --data "' + $DataDir + '" --port ' + $Port + ' --admin-password-file "' + $pwdFile + '"'

$act = New-ScheduledTaskAction -Execute $node -Argument $argLine -WorkingDirectory $AppDir
$trg = New-ScheduledTaskTrigger -AtStartup
$pri = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
# No time limit (scheduled tasks stop after 72h by default), restart if it crashes
$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Principal $pri -Settings $set `
  -Description "XLerp server (http://127.0.0.1:$Port)" -Force | Out-Null
Log "task registered, port $Port, data $DataDir"

# Allow other computers on the same LAN only
try { Remove-NetFirewallRule -Name $RuleName -ErrorAction Stop } catch {}
try {
  New-NetFirewallRule -Name $RuleName -DisplayName "XLerp (TCP $Port)" -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
  Log 'firewall rule added (LocalSubnet)'
} catch { Log ('firewall rule failed: ' + $_.Exception.Message) }

Start-ScheduledTask -TaskName $TaskName
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/api/ping"
    if ($r.Content -match 'XERP') { Log 'server is up'; exit 0 }
  } catch {}
}
Log "server did not answer on port $Port within 20s; see $DataDir\logs"
exit 0
