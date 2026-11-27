# 构建 Windows 安装包：dist\xerp-<版本>-windows-x64-setup.exe
# 需要：Windows、本机已安装 Node.js（x64，会把 node.exe 一起打进安装包）、Inno Setup 6（winget install JRSoftware.InnoSetup）
# ⚠ 本文件必须存成「UTF-8 带 BOM」。没有 BOM 时 Windows PowerShell 5.1（CI 上用的就是它）
#   会按 ANSI 读，中文注释全变乱码，直接 ParserError。改完文件务必确认前三字节是 EF BB BF。
$ErrorActionPreference = 'Stop'
$Root  = Split-Path $PSScriptRoot -Parent
$Win   = $PSScriptRoot
$Stage = Join-Path $Win 'build'
$Dist  = Join-Path $Root 'dist'
$Utf8Bom = New-Object Text.UTF8Encoding $true
function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

$Version = [regex]::Match((Get-Content (Join-Path $Root 'src\server.js') -Raw), "const VERSION = '([\d.]+)'").Groups[1].Value
if (-not $Version) { throw '读不到 src\server.js 里的 VERSION' }

$Iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Iscc) { throw '找不到 Inno Setup 6，请先运行：winget install JRSoftware.InnoSetup' }

# 找真正的 node.exe：优先用 setup-node / nvm 设的 RUNNER_TOOL_CACHE，其次 PATH
# （CI 上 `Get-Command node` 有时拿到的是 .cmd shim 或符号链接，Copy-Item 复制过去是个坏文件）
$Node = $null
# 本地没有 RUNNER_TOOL_CACHE（那是 CI 上 setup-node 才有的），所以先过滤掉空值再拼路径
$cands = @()
if ($env:RUNNER_TOOL_CACHE) { $cands += (Join-Path $env:RUNNER_TOOL_CACHE 'node') }
if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'nodejs') }
if ($env:NODE_HOME) { $cands += $env:NODE_HOME }
foreach ($cand in $cands) {
  if (-not $cand -or -not (Test-Path $cand)) { continue }
  $exe = Get-ChildItem -Path $cand -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
         Where-Object { $_.DirectoryName -notmatch 'node_modules' } | Select-Object -First 1
  if ($exe) { $Node = $exe.FullName; break }
}
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $src = $cmd.Source
    # shim / 符号链接 → 找同目录下真正的 node.exe
    if ($src -notmatch '\.exe$') {
      $real = Join-Path (Split-Path $src -Parent) 'node.exe'
      if (Test-Path $real) { $src = $real }
    }
    if (Test-Path $src) { $Node = $src }
  }
}
if (-not $Node) { throw '找不到 node.exe，请安装 Node.js x64 22.13+' }
Write-Host "node.exe: $Node"
$NodeVer = (& $Node -p process.version) + " " + (& $Node -p process.arch)
if ($NodeVer -notmatch 'x64$') { throw "需要 x64 的 Node.js，当前是 $NodeVer" }
if ([int]($NodeVer -replace '^v(\d+).*', '$1') -lt 22) { throw "需要 Node.js 22.13 以上，当前是 $NodeVer" }

# ---------- 1. 暂存 ----------
Step "Staging XLerp $Version (Node $NodeVer)"
Remove-Item $Stage -Recurse -Force -ErrorAction SilentlyContinue
$App = Join-Path $Stage 'app'
New-Item -ItemType Directory -Force -Path $App, $Dist | Out-Null
Copy-Item $Node (Join-Path $App 'node.exe')
$NodeLicense = Join-Path (Split-Path $Node) 'LICENSE'
if (Test-Path $NodeLicense) { Copy-Item $NodeLicense (Join-Path $App 'node-LICENSE.txt') }
else {  # Node.js 安装目录里没有 LICENSE 时，从官方仓库取对应版本的（MIT 要求随程序附带许可声明）
  $tag = & $Node -p process.version
  Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/nodejs/node/$tag/LICENSE" -OutFile (Join-Path $App 'node-LICENSE.txt')
}
Copy-Item (Join-Path $Root 'src\server.js'), (Join-Path $Root 'src\portal.js'), (Join-Path $Root 'src\index.html'), (Join-Path $Root 'src\client.js') $App
Copy-Item (Join-Path $Root 'src\vendor') $App -Recurse
Copy-Item (Join-Path $Win 'xerp-service.ps1') $App
Copy-Item (Join-Path $Win 'ChineseSimplified.isl') $Stage

# ---------- 1b. 图标：用我们自己的图标（dist\xerp-icon.png），打成多尺寸 .ico ----------
Step 'Generating icon'
Add-Type -AssemblyName System.Drawing
# 源图：dist\xerp-icon.png（192×192，XL 圆角蓝绿）。有更高分辨率的就优先用大的。
$iconSrc = @(
  (Join-Path $Root 'dist\xerp-icon.png'),
  (Join-Path $Root 'src\desktop\icon.png')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iconSrc) { throw '找不到图标源文件 dist\xerp-icon.png' }
Write-Host "  icon source: $iconSrc"
$srcImg = [Drawing.Image]::FromFile((Resolve-Path $iconSrc))
# ICO 标准尺寸，256 也放（Explorer 大图标视图要用）；高位图更清晰
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = foreach ($s in $sizes) {
  $bmp = New-Object Drawing.Bitmap $s, $s
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
  $g.SmoothingMode = 'AntiAlias'; $g.CompositingQuality = 'HighQuality'
  $g.Clear([Drawing.Color]::Transparent)
  $g.DrawImage($srcImg, 0, 0, $s, $s)
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  ,$ms.ToArray()
}
$srcImg.Dispose()
# ICO 文件：6 字节头 + 16 字节/项的目录 + 各尺寸 PNG 数据
$out = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter $out
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $bw.Write([byte]($s % 256)); $bw.Write([byte]($s % 256)); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$d.Length); $bw.Write([uint32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
$bw.Flush(); [IO.File]::WriteAllBytes((Join-Path $Stage 'xerp.ico'), $out.ToArray())
$bw.Dispose(); $out.Dispose()
Write-Host ("  已生成 xerp.ico（" + $sizes.Count + " 个尺寸，来自我们自己的图标）")

# ---------- 1c. 桌面窗口：Electron 运行时 ----------
# 装出来的是「小林进销存.exe」自己的窗口，不是浏览器标签页。
# asar 里就是 src\desktop（main.js / preload.js / icon.*），界面仍由同目录的 index.html + portal.js 提供。
Step 'Bundling Electron desktop shell'
$DesktopSrc = Join-Path $Root 'src\desktop'
$ElectronVer = (& $Node -p "require('$(($DesktopSrc -replace '\\','/'))/package.json').electronVersion" 2>$null)
if (-not $ElectronVer) {
  $pkg = Get-Content (Join-Path $DesktopSrc 'package.json') -Raw | ConvertFrom-Json
  $ElectronVer = $pkg.electronVersion
}
if (-not $ElectronVer) { $ElectronVer = '38.8.6' }
Write-Host "electron: $ElectronVer"

$ElectronDist = Join-Path $Stage 'electron'
New-Item -ItemType Directory -Force -Path $ElectronDist | Out-Null
$Zip = Join-Path $Stage "electron-v$ElectronVer-win32-x64.zip"
$mirror = 'https://npmmirror.com/mirrors/electron'
$official = 'https://github.com/electron/electron/releases/download'
$got = $false
foreach ($u in @("$mirror/$ElectronVer/electron-v$ElectronVer-win32-x64.zip", "$official/v$ElectronVer/electron-v$ElectronVer-win32-x64.zip")) {
  try {
    Write-Host "  downloading $u"
    Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $Zip -TimeoutSec 900
    $got = $true; break
  } catch { Write-Host "  失败：$($_.Exception.Message)" }
}
if (-not $got) { throw "下载 Electron $ElectronVer 运行时失败" }
Expand-Archive -Path $Zip -DestinationPath $ElectronDist -Force
Remove-Item $Zip -Force
if (-not (Test-Path (Join-Path $ElectronDist 'electron.exe'))) { throw 'Electron 运行时解压后没有 electron.exe' }

# 只留中文语言包，省 5 MB
Get-ChildItem (Join-Path $ElectronDist 'locales') -Filter '*.pak' |
  Where-Object { $_.Name -ne 'zh-CN.pak' } | Remove-Item -Force

# 我们的图标：把 electron.exe 改成 XLerp.exe 并换图标（不换的话任务栏是 Electron 默认蓝球）
$exe = Join-Path $ElectronDist 'electron.exe'
$outExe = Join-Path $ElectronDist 'XLerp.exe'
Copy-Item $exe $outExe -Force
Remove-Item $exe -Force
Copy-Item (Join-Path $Stage 'xerp.ico') (Join-Path $ElectronDist 'xerp.ico') -Force
try {
  $sig = @"
using System;
using System.Runtime.InteropServices;
public class IconRes {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@
  if (-not ('IconRes' -as [type])) { Add-Type -TypeDefinition $sig }
  # ICO 结构：6 字节头 + 16 字节/项的目录 + 各尺寸数据。
  # RT_ICON(3) 存每个尺寸的位图，RT_GROUP_ICON(14) 是索引表（内容 = 6 字节头 + 12 字节/项的目录）。
  $ico = [IO.File]::ReadAllBytes((Join-Path $Stage 'xerp.ico'))
  $count = [BitConverter]::ToUInt16($ico, 4)
  $h = [IconRes]::BeginUpdateResource($outExe, $false)
  if ($h -eq [IntPtr]::Zero) { throw "BeginUpdateResource 失败 $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $group = New-Object IO.MemoryStream
  $gw = New-Object IO.BinaryWriter $group
  $gw.Write([uint16]0); $gw.Write([uint16]1); $gw.Write([uint16]$count)   # 保留 + 类型 1(图标) + 数量
  for ($i = 0; $i -lt $count; $i++) {
    $e = 6 + 16 * $i
    $w = $ico[$e]; $hh = $ico[$e + 1]; $cc = $ico[$e + 2]
    $planes = [BitConverter]::ToUInt16($ico, $e + 4)
    $bpp = [BitConverter]::ToUInt16($ico, $e + 6)
    $len = [BitConverter]::ToUInt32($ico, $e + 8)
    $off = [BitConverter]::ToUInt32($ico, $e + 12)
    $data = New-Object byte[] $len
    [Array]::Copy($ico, $off, $data, 0, $len)
    $id = $i + 1
    if (-not [IconRes]::UpdateResource($h, [IntPtr]3, [IntPtr]$id, 0, $data, [uint32]$len)) { throw "写 RT_ICON $id 失败" }
    $gw.Write([byte]$w); $gw.Write([byte]$hh); $gw.Write([byte]$cc); $gw.Write([byte]0)
    $gw.Write([uint16]$planes); $gw.Write([uint16]$bpp); $gw.Write([uint32]$len); $gw.Write([uint16]$id)
  }
  $gw.Flush()
  $groupBytes = $group.ToArray()
  if (-not [IconRes]::UpdateResource($h, [IntPtr]14, [IntPtr]1, 0, $groupBytes, [uint32]$groupBytes.Length)) { throw '写 RT_GROUP_ICON 失败' }
  $gw.Dispose(); $group.Dispose()
  if (-not [IconRes]::EndUpdateResource($h, $false)) { throw 'EndUpdateResource 失败' }
  Write-Host "  图标已替换（$count 个尺寸）"
} catch { throw "替换 XLerp.exe 图标失败：$($_.Exception.Message)" }

# 桌面外壳打进 app.asar（Electron 原生支持 asar；官方 @electron/asar 一次打包，不手写格式）
# 只打必需文件：src\desktop 下的 node_modules（开发时装 electron 用的）和下载的 zip 不能进包
$ResDir = Join-Path $ElectronDist 'resources'
if (Test-Path (Join-Path $ResDir 'default_app.asar')) { Remove-Item (Join-Path $ResDir 'default_app.asar') -Force }
$ShellDir = Join-Path $Stage 'shell'
Remove-Item $ShellDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $ShellDir | Out-Null
foreach ($f in 'main.js', 'preload.js', 'package.json', 'icon.png', 'icon.ico') {
  $s = Join-Path $DesktopSrc $f
  if (Test-Path $s) { Copy-Item $s $ShellDir -Force }
  elseif ($f -ne 'icon.ico') { throw "src\desktop 缺 $f" }
}
$AsarCli = Join-Path $Stage 'node_modules\.bin\asar.cmd'
if (-not (Test-Path $AsarCli)) {
  Push-Location $Stage
  try {
    & npm install @electron/asar --no-save --no-audit --no-fund --loglevel=error
  } finally { Pop-Location }
}
if (Test-Path $AsarCli) {
  & $AsarCli pack $ShellDir (Join-Path $ResDir 'app.asar')
} else {
  # npm 装不上时退回 npx
  Push-Location $Stage
  try { & npx --yes @electron/asar pack $ShellDir (Join-Path $ResDir 'app.asar') } finally { Pop-Location }
}
$asarSize = (Get-Item (Join-Path $ResDir 'app.asar') -ErrorAction SilentlyContinue).Length
if (-not $asarSize) { throw '生成 app.asar 失败' }
if ($asarSize -gt 5MB) { throw "app.asar 太大（$([math]::Round($asarSize/1MB,1)) MB），说明把 node_modules 打进去了" }
Write-Host ("  app.asar {0:N0} KB" -f ($asarSize/1KB))

# 运行时并进 app 目录：安装包只装 {app} 一个目录，桌面程序就是 {app}\XLerp.exe
Get-ChildItem $ElectronDist -Force | Copy-Item -Destination $App -Recurse -Force
if (-not (Test-Path (Join-Path $App 'XLerp.exe'))) { throw 'app 目录里没有 XLerp.exe' }

$readme = @"
小林进销存 $Version（Windows 版）

【打开】
双击桌面「小林进销存」，或开始菜单 → 小林进销存 → 打开 小林进销存。
打开的是程序自己的窗口（不是浏览器标签页），可以最小化到托盘；关掉窗口后再点图标就能重新打开。
默认端口 8686，账号 admin，密码为安装时设置的密码。

【两部分】
  1) XLerp.exe   桌面窗口，你自己用的界面
  2) 后台服务      任务计划程序里名为「XLerp」的任务，以 SYSTEM 身份开机自动启动，异常退出 1 分钟后自动重启
                  手机 App、局域网其他电脑连的就是它，不需要登录 Windows，也不用保持任何窗口打开
服务器模式数据在这台电脑；客户端模式数据在对方服务器上，本机只做显示。
安装时已在 Windows 防火墙里放行该端口，仅允许同一局域网访问。请不要把端口映射到公网。
完全离线可用，不需要连接互联网。

【数据】
全部数据保存在 C:\ProgramData\XERP（安装时可以改到别的盘）：
  erp.db       数据库
  backups\     每日自动备份（保留 30 天）
  logs\        运行日志（desktop.log 是窗口日志，server-*.log 是服务日志）
升级（直接运行新版安装包覆盖安装）和卸载都不会删除数据。

【常见问题】
窗口打不开：看 C:\ProgramData\XERP\logs\desktop.log；服务是否正常可以访问 http://127.0.0.1:端口/api/ping，
  能看到 {"ok":true,"app":"XERP",...} 说明后台服务正常；
端口被占用：重新运行安装包，在「服务设置」里换一个端口。
忘记管理员密码：用另一个管理员账号在 系统设置 → 用户管理 里重置。

反馈与更新：http://101.201.141.121/xerp/
"@
[IO.File]::WriteAllText((Join-Path $App '使用说明.txt'), ($readme -replace "`r?`n", "`r`n"), $Utf8Bom)

# ---------- 3. 编译安装包（.iss 统一转成带 BOM 的 UTF-8，Inno 才能正确读中文） ----------
Step 'Compiling installer'
$iss = Join-Path $Stage 'xerp.iss'
[IO.File]::WriteAllText($iss, [IO.File]::ReadAllText((Join-Path $Win 'xerp.iss'), [Text.Encoding]::UTF8), $Utf8Bom)
& $Iscc /Q "/DAppVersion=$Version" "/DStageDir=$Stage" "/DOutDir=$Dist" $iss
if ($LASTEXITCODE -ne 0) { throw "ISCC 失败（$LASTEXITCODE）" }
$exe = Join-Path $Dist "xlerp-$Version-windows-x64-setup.exe"
Step ("Done: $exe ({0:N1} MB)" -f ((Get-Item $exe).Length / 1MB))
