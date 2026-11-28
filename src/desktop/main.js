'use strict';
/**
 * 小林进销存 桌面版外壳（Electron）
 *
 * 作用：把原来的「浏览器标签页」变成程序自己的窗口。
 *   - 窗口是 Electron 原生窗口，有自己的图标、任务栏按钮、标题栏、托盘
 *   - 服务器模式：先在本机后台拉起 portal.js（数据在本机），窗口加载 http://127.0.0.1:PORT/
 *   - 客户端模式：先在本机拉起 client.js（它把 /api 转发到远端服务器），窗口加载 http://127.0.0.1:18686/
 *   - 随安装包分发的 xlerp-service.ps1 仍然是「后台服务」，负责开机自启、让手机/别的电脑能连；
 *     本 exe 只负责开窗，两者共用同一个数据目录和端口，所以同时存在也不会冲突。
 *
 * 运行参数（安装器在快捷方式里写死，一般不用改）：
 *   --mode=server|client  --port=8686  --server=http://ip:8686
 *   --data=<数据目录>      --trigger-startup
 * 写法一律 --key=value：Chromium 会把「--server http://x」当成非法开关，进程直接退出。
 */
const { app, BrowserWindow, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const APP_NAME = '小林进销存';
const argv = process.argv.slice(1);
/**
 * 取参数值，同时支持两种写法：
 *   --server=http://1.2.3.4:8686   （推荐：Chromium 不会去解析它）
 *   --server http://1.2.3.4:8686
 * 注意：值以 http/https 开头的不要写成空格分隔的独立参数——Chromium 会把
 * 「--server http://...」当成非法开关直接退出（exit -1），窗口根本起不来。
 */
function arg(name, def) {
  const eq = '--' + name + '=';
  const hit = argv.find(a => a.startsWith(eq));
  if (hit) return hit.slice(eq.length);
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const has = n => argv.includes('--' + n);

/* ================= 路径 / 参数 ================= */
// 安装目录：
//   Windows 打包后 = XLerp.exe 所在目录（那里才有 node.exe / portal.js / index.html）
//   开发态 = 项目根（src/desktop 的上一级）
const APP_DIR = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
// 数据目录：%ProgramData%\XERP，可用 --data 或环境变量 ERP_DATA 覆盖
const DATA_DIR = path.resolve(arg('data', process.env.ERP_DATA || path.join(process.env.ProgramData || os.homedir(), 'XERP')));
const MODE = String(arg('mode', 'server')).toLowerCase().startsWith('client') ? 'client' : 'server';
// 客户端模式的代理端口固定 18686（和 xerp-service.ps1 里的 $clientPort 一致）。
// 安装器传的 --port 是「服务器模式的服务端口」，客户端模式下不能拿它用，
// 否则窗口会去连 8686 那个本机服务（甚至是空的临时实例），而不是转发到远端。
const CLIENT_PORT = +arg('client-port', 0) || 18686;
const PORT = MODE === 'client' ? CLIENT_PORT : (+arg('port', 8686) || 8686);
const REMOTE = String(arg('server', '')).trim();
// 安装器 [Run] 里的那一行：装完直接弹窗。这时后台服务已经装好并在跑，
// 只要开窗指过去就行，不能再起一个实例去抢端口。
const FROM_INSTALLER = has('trigger-startup');

const LOG_DIR = path.join(DATA_DIR, 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
const log = (...m) => {
  const line = new Date().toLocaleString('zh-CN', { hour12: false }) + '  ' + m.join(' ');
  try { process.stdout.write(line + '\n'); } catch (e) {}
  try { fs.appendFileSync(path.join(LOG_DIR, 'desktop.log'), line + '\r\n'); } catch (e) {}
};
// 出问题时第一眼要看的就是这几个值，启动时就写一行
log(`启动 APP_DIR=${APP_DIR} DATA_DIR=${DATA_DIR} 模式=${MODE} 端口=${PORT}` +
  (FROM_INSTALLER ? ' (安装完自动打开)' : ''));

const cfgFile = path.join(DATA_DIR, 'config.json');
function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return {}; } }
function remoteUrl() { return REMOTE || String(readCfg().clientServer || ''); }

/* ================= 本地服务 ================= */
let child = null;
const HOST = '127.0.0.1';
let usingPort = PORT;

function ping(port, pathname, ms = 1200) {
  return new Promise(resolve => {
    const req = http.get({ host: HOST, port, path: pathname, timeout: ms }, r => {
      let d = ''; r.setEncoding('utf8');
      r.on('data', c => (d += c));
      r.on('end', () => { try { resolve({ ok: true, json: JSON.parse(d) }); } catch (e) { resolve({ ok: true, json: null }); } });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
    req.on('error', () => resolve({ ok: false }));
  });
}
async function waitPing(port, pathname, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const r = await ping(port, pathname); if (r.ok) return r; await new Promise(s => setTimeout(s, 250)); }
  return { ok: false };
}
function freePort(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}
/**
 * 选一个能和正在运行的服务错开的临时端口。
 * Windows 默认不共享端口：服务占着 8686 时桌面临时实例必须换端口，
 * 但 config.json 里的 port / cloud / tunnelSecret 不能动，只能启动完再写回去。
 */
async function pickTabPort() {
  const cfg = readCfg();
  const reserved = new Set([+cfg.port || 0, PORT, 18686, 9001]);
  for (let p = 8687; p < 8787; p++) {
    if (reserved.has(p)) continue;
    if (await freePort(p)) return p;
  }
  return 0;
}
function snapshotConfig() { try { return fs.readFileSync(cfgFile); } catch (e) { return null; } }
function restoreConfig(buf) { if (!buf) return; try { fs.writeFileSync(cfgFile, buf); } catch (e) {} }

// 断开残留的旧实例（重装、换机器后孤儿进程会一直占着端口）
function killOrphans(port) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve();
    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { try { Stop-Process -Id $_.OwningProcess -Force -ErrorAction Stop } catch {} }`],
    { windowsHide: true, stdio: 'ignore' });
    ps.on('exit', () => setTimeout(resolve, 600));
    ps.on('error', () => resolve());
    setTimeout(resolve, 4000);
  });
}

function startProcess(file, args, tag) {
  let p;
  try {
    p = spawn(process.execPath, [file, ...args], {
      cwd: APP_DIR,
      // 自己已经是 Electron 进程，子进程必须当普通 node 跑，否则会再开一个窗口
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', XERP_DESKTOP: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) { log(tag, '启动失败', e.message); return null; }
  p.stdout.on('data', d => log(tag, String(d).trim()));
  p.stderr.on('data', d => log(tag, String(d).trim()));
  p.on('exit', code => log(tag, '退出，代码', code));
  p.on('error', e => log(tag, '进程错误', e.message));
  return p;
}

/** 本机服务在不在：在就复用，不在就拉一个；skipSpawn 时只检查不启动 */
async function ensureLocal(skipSpawn) {
  if (MODE === 'client') {
    if ((await ping(PORT, '/local/ping')).ok) return PORT;
    if (skipSpawn) return null;
    child = startProcess(path.join(APP_DIR, 'client.js'), ['--port', String(PORT), '--server', remoteUrl(), '--no-browser'], 'client');
    return (await waitPing(PORT, '/local/ping', 20000)).ok ? PORT : null;
  }
  if ((await ping(PORT, '/api/ping')).ok) return PORT;
  if (skipSpawn) return null;
  if (!(await freePort(PORT))) await killOrphans(PORT);   // 端口被别人占着，先让一让
  const pwdFile = path.join(DATA_DIR, 'admin-password.txt');
  const extra = pwdFile && fs.existsSync(pwdFile) ? ['--admin-password-file', pwdFile] : [];
  child = startProcess(path.join(APP_DIR, 'portal.js'), ['--data', DATA_DIR, '--port', String(PORT), ...extra], 'server');
  return (await waitPing(PORT, '/api/ping', 40000)).ok ? PORT : null;
}

// 临时实例：换端口，数据目录和正式服务共用。只在服务器模式下用得上——
// 客户端模式的界面必须来自远端服务器，绝不能在本机起一个空库冒充。
async function startTabInstance() {
  if (MODE === 'client') throw new Error('客户端模式不允许启动本机实例');
  const tport = await pickTabPort();
  if (!tport) throw new Error('本机没有可用端口');
  usingPort = tport;
  const snap = snapshotConfig();
  child = startProcess(path.join(APP_DIR, 'portal.js'), ['--data', DATA_DIR, '--port', String(tport)], 'tab');
  const w = await waitPing(tport, '/api/ping', 40000);
  restoreConfig(snap);       // 服务端一启动就会把 --port 写进 config.json，这里改回原来的
  if (!w.ok) throw new Error('本机服务启动失败');
  log('临时实例已启动，端口', tport);
  return tport;
}

/* ================= 窗口 ================= */
let win = null, splash = null, tray = null, quitting = false;
const ICON_PNG = path.join(__dirname, 'icon.png');
const ICON_ICO = path.join(__dirname, 'icon.ico');
const iconFor = () => (fs.existsSync(ICON_ICO) ? ICON_ICO : fs.existsSync(ICON_PNG) ? ICON_PNG : undefined);

const baseUrl = port => `http://${HOST}:${port}/`;

async function makeShell() {
  const target = await ensureLocal(FROM_INSTALLER);
  if (target) return baseUrl(target);
  // 客户端模式绝不能退到「本机临时实例」——那会显示一个几乎空的本地库，
  // 让人以为数据丢了。连不上就明确报错，让用户去查服务器地址/网络。
  if (MODE === 'client') {
    throw new Error(
      '连不上服务器：' + (remoteUrl() || '(未配置服务器地址)') + '\n\n' +
      '请检查：\n' +
      '1) 服务器那台机器开着、XLerp 服务在跑；\n' +
      '2) 地址和端口对不对（例如 http://192.168.31.4:8686）；\n' +
      '3) 两台机器在同一个局域网。'
    );
  }
  return baseUrl(await startTabInstance());
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 680,
    show: false,
    backgroundColor: '#f5f7fb',
    title: APP_NAME,
    icon: iconFor(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    if (splash && !splash.isDestroyed()) splash.close();
    win.show(); win.focus();
  });
  win.on('page-title-updated', e => { e.preventDefault(); win.setTitle(APP_NAME); });
  // 站内链接自己开，外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!u.startsWith(baseUrl(usingPort)) && /^https?:/i.test(u)) { shell.openExternal(u); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: iconFor() } };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (/^https?:/i.test(u) && !u.startsWith(baseUrl(usingPort))) { e.preventDefault(); shell.openExternal(u); }
  });
  // 打印走系统打印对话框（送货单、对账单要出纸）
  win.webContents.on('before-input-event', (e, input) => {
    if (!input.control || input.type !== 'keyDown') return;
    if (input.key.toLowerCase() === 'p') win.webContents.print({});
  });
  win.on('closed', () => { win = null; });
  win.loadURL(url);
  return win;
}

function createSplash() {
  splash = new BrowserWindow({
    width: 360, height: 200, frame: false, resizable: false, center: true, show: true,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#ffffff',
    icon: iconFor(),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const logo = fs.existsSync(ICON_PNG)
    ? `<img class="logo" src="data:image/png;base64,${fs.readFileSync(ICON_PNG).toString('base64')}">`
    : '<div class="logo">X</div>';
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;color:#334155;
      display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff;overflow:hidden;
      -webkit-user-select:none;user-select:none;border:1px solid #e6ebf2;box-sizing:border-box;border-radius:10px}
    .logo{width:56px;height:56px;border-radius:15px;margin-bottom:14px;display:block}
    div.logo{background:linear-gradient(135deg,#6366f1,#06b6d4);color:#fff;font-size:32px;font-weight:700;
      display:flex;align-items:center;justify-content:center}
    .t{font-size:15px;color:#0f172a;letter-spacing:.5px}
    .s{font-size:12px;color:#94a3b8;margin-top:4px}
    .bar{width:180px;height:3px;border-radius:3px;background:#eef2f7;margin-top:16px;overflow:hidden}
    .bar i{display:block;width:40%;height:100%;border-radius:3px;background:linear-gradient(90deg,#3b82c4,#06b6d4);
      animation:go 1.1s ease-in-out infinite}
    @keyframes go{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
  </style>
  ${logo}<div class="t">${APP_NAME} 正在启动</div>
  <div class="s">${MODE === 'client' ? '连接服务器…' : '加载本机数据…'}</div>
  <div class="bar"><i></i></div>`;
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return splash;
}

function createTray() {
  if (!fs.existsSync(ICON_PNG)) return;
  try {
    tray = new Tray(nativeImage.createFromPath(ICON_PNG).resize({ width: 16, height: 16 }));
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 ' + APP_NAME, click: () => { if (win) { win.show(); win.focus(); } else boot(); } },
      { label: MODE === 'client' ? '重新连接服务器' : '重新加载', click: () => win && win.reload() },
      { type: 'separator' },
      { label: '数据目录', click: () => shell.openPath(DATA_DIR) },
      { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } else boot(); });
  } catch (e) { log('托盘创建失败', e.message); }
}

async function boot() {
  if (!splash || splash.isDestroyed()) createSplash();
  let url;
  try {
    url = await makeShell();
  } catch (e) {
    log('启动失败', e.message);
    if (splash && !splash.isDestroyed()) splash.close();
    const r = dialog.showMessageBoxSync({
      type: 'error', title: APP_NAME, message: APP_NAME + ' 启动失败', detail: String(e.message || e),
      buttons: ['重试', '查看日志', '退出'], defaultId: 0, cancelId: 2,
    });
    if (r === 0) return boot();
    if (r === 1) shell.openPath(LOG_DIR);
    quitting = true; app.quit();
    return;
  }
  log('打开窗口', url, '模式', MODE);
  createWindow(url);
}

/* ================= 生命周期 ================= */
app.setName(APP_NAME);
// 同一个人重复点图标 = 把已有窗口顶到前面。
// 「后台服务」和「桌面窗口」数据目录虽然相同，但那是两个进程、两个程序，不在这里互相踢。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.setAppUserModelId('com.xlerp.desktop');
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createTray();
    boot();
  });
  app.on('activate', () => { if (!win) boot(); });
}

// 关窗口不退出（后台服务还要给手机、别的电脑供货），要退从托盘「退出」
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('before-quit', () => { quitting = true; try { if (child) child.kill(); } catch (e) {} });
process.on('exit', () => { try { if (child) child.kill(); } catch (e) {} });
