# 准备 Android 签名证书（在 GitHub Actions 里调用）
# 有 Secrets 就用正式证书，没有或格式不对就生成一次性临时证书，保证能出包
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:USERPROFILE '.xerp-android'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$ksFile  = Join-Path $dir 'release.jks'
$ppFile  = Join-Path $dir 'keystore.properties'

# Secret 里粘贴的 base64 常带换行 / 空格 / BOM，甚至 data:...;base64, 前缀，统一清洗
function Clean-B64([string]$s) {
  if (-not $s) { return '' }
  $s = $s -replace [regex]::Escape([string][char]0xFEFF), ''
  $s = $s -replace '^data:[^,]*,', ''
  $s = $s -replace '\s', ''
  return $s
}

$ks = Clean-B64 $env:KS_B64
$pp = Clean-B64 $env:PROPS_B64
$decoded = $false

if ($ks -and $pp) {
  $err = ''
  try {
    $ksBytes = [Convert]::FromBase64String($ks)
    $ppBytes = [Convert]::FromBase64String($pp)
    if ($ksBytes.Length -lt 1024) {
      $err = 'release.jks only ' + $ksBytes.Length + ' bytes'
    } else {
      [IO.File]::WriteAllBytes($ksFile, $ksBytes)
      [IO.File]::WriteAllBytes($ppFile, $ppBytes)
      $propsText = [Text.Encoding]::UTF8.GetString($ppBytes)
      if (($propsText -notmatch 'storePassword') -or ($propsText -notmatch 'keyAlias')) {
        $err = 'keystore.properties missing storePassword / keyAlias'
      } else {
        Write-Host ('Using release keystore from Secrets, jks ' + $ksBytes.Length + ' bytes')
        $decoded = $true
      }
    }
  } catch {
    $err = $_.Exception.Message
  }
  if (-not $decoded) {
    Write-Host ('::warning::Secret decode failed: ' + $err + ' -- falling back to a throwaway keystore')
  }
}

if (-not $decoded) {
  Write-Host '::warning::Signing with a temporary keystore. This APK cannot upgrade an already-installed release build.'
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
  $pw = -join (1..24 | ForEach-Object { $chars | Get-Random })
  $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
  & $keytool -genkeypair -v -keystore $ksFile -alias xerp -keyalg RSA -keysize 2048 -validity 10000 `
      -storepass $pw -keypass $pw -dname 'CN=XLerp,O=XLerp,C=CN'
  if ($LASTEXITCODE -ne 0) { throw 'keytool failed' }
  $lines = @(
    'storeFile=' + $ksFile,
    'storePassword=' + $pw,
    'keyAlias=xerp',
    'keyPassword=' + $pw,
    ''
  )
  [IO.File]::WriteAllText($ppFile, ($lines -join "`n"), (New-Object Text.UTF8Encoding $false))
}

Write-Host ('keystore ready: ' + $ksFile)
