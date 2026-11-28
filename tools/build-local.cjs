// 把 src/server.js 改造成浏览器可运行的 server-local.js
//
// 思路：不重写业务逻辑，只做「外科手术」：
//   保留 —— 通用工具、业务常量、模块/权限、业务逻辑、初始化、路由
//   替换 —— 顶部的 require 区（换成 shim）、数据库段（换成 IndexedDB 版 LocalDB）
//   删除 —— 目录/日志/配置、演示数据、物流运费、快递鸟、远程访问、消息通知、HTTP 服务
//
// 输出：src/local/server-local.js（运行时由 index.html 加载）
//
// 用法：node tools/build-local.mjs
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'server.js');
const OUT = path.join(ROOT, 'src', 'local', 'server-local.js');

const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const lines = raw.split(/\r?\n/);

/** 找到某段注释标题所在行（1-based） */
function mark(re) {
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) throw new Error('找不到标记：' + re);
  return i;   // 0-based
}

const seg = {
  top:        mark(/^\/\* =+ 目录 \/ 日志 \/ 配置/),   // 从这里开始是「要替换的头」
  dbStart:    mark(/^\/\* =+ 数据库/),
  commonStart: mark(/^\/\* =+ 通用工具/),
  demoStart:  mark(/^\/\* =+ 演示数据/),
  userStart:  mark(/^\/\* =+ 用户 \/ 会话/),
  bizStart:   mark(/^\/\* =+ 业务逻辑/),
  shipStart:  mark(/^\/\* =+ 物流运费/),
  kdnStart:   mark(/^\/\* =+ 快递鸟/),
  remoteStart: mark(/^\/\* =+ 远程访问/),
  initStart:  mark(/^\/\* =+ 初始化/),
  routeStart: mark(/^\/\* =+ 路由/),
  notifyStart: mark(/^\/\* =+ 消息通知/),
  httpStart:  mark(/^\/\* =+ HTTP 服务/),
};

const slice = (a, b) => lines.slice(a, b).join('\n');

// ---------- 1. 头部：常量 + shim require ----------
// server.js 前 seg.top 行包含 'use strict'、require、VERSION、DATA_DIR 等。
// 我们只保留 VERSION 之前的部分，其余重写。
const headEnd = lines.findIndex(l => /^const VERSION = /.test(l));
if (headEnd < 0) throw new Error('找不到 VERSION 行');
const versionLine = lines[headEnd];
const argvLine = lines[headEnd + 1] || '';

const header = `'use strict';
/**
 * XLerp 单机版（浏览器内运行）—— 由 tools/build-local.mjs 从 src/server.js 自动生成
 * 不要手动改这个文件，改 server.js 后重新构建。
 *
 * 与服务器版的唯一区别：
 *   - require() / Buffer / process / fs / crypto 由 src/local/shim.js 提供
 *   - 数据层由 SQLite 换成 IndexedDB（src/local/db.js + src/local/sqlshim.js）
 *   - 不含 HTTP 服务、日志文件、远程访问、快递鸟、消息推送、演示数据
 * 业务规则（库存、批次、成本、单据状态机、权限）与服务器版完全一致。
 */
${versionLine}
const argv = [];
const arg = (name, def) => def;

/* ---- 日期与日志工具（原 server.js「目录/日志/配置」段里的纯函数，日志部分去掉） ---- */
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { const x = new Date(d); return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()); }
function today() { return fmtDate(new Date()); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 864e5); }
function log() {}   // 单机版不写日志文件

/* ---- 运行时配置（原 server.js 从 config.json 读，单机版用固定值） ---- */
const config = { port: 0, host: '', sessionDays: 30 };
/* ---- 路径常量（单机版没有真实文件系统，给显示用的虚拟路径） ---- */
const DATA_DIR = '/local';
const LOG_DIR = '/local/logs';
const BACKUP_DIR = '/local/backups';
/* ---- 被切掉的段里、路由仍会引用的少量函数：给桩 ---- */
const fbUnread = () => 0;              // 未读反馈数（单机版没有反馈系统）
const PLAT = 'local';                  // 平台标识
const STATS = null;                    // 匿名统计（单机版关闭）
`;

// ---------- 2. 数据库段：换成 LocalDB 适配 ----------
// 注意：uid / sum / str / round2 / audit / fail / HttpError 都在「通用工具」段里，
// 那段是原样保留的，所以这里**不能**再声明一遍（否则 Identifier already declared）。
const dbShim = `
/* ================= 数据层（IndexedDB，替代 SQLite） ================= */
// 严格对应 server.js 原 SQLite 版的 S.* 与 list/get/put/del 语义，
// 实现在 src/local/db.js。这里只做转发，签名保持一致。
// uid / sum / str / audit 等工具函数在下面的「通用工具」段里（原样保留）。
const LDB = window.__xerpDB;
const list = col => LDB.list(col).map(r => JSON.parse(r.data));
const get = (col, id) => { const r = LDB.get(col, String(id)); return r ? JSON.parse(r.data) : null; };
const put = (col, obj) => LDB.put(col, obj);
const del = (col, id) => LDB.del(col, id);
const getMeta = (k, d) => LDB.metaGet(k, d);
const setMeta = (k, v) => LDB.metaSet(k, v);
function tx(fn) { return fn(); }

// SQL 兼容层：server.js 里 40 多种 db.prepare(...) 语句由它翻译成内存表操作，
// 这样「用户/会话」「角色/权限」「图片」「审计」这些段落一个字都不用改。
// 表数据跟着 LocalDB 一起落到 IndexedDB（见 db.js 的 tables 字段）。
const db = LDB.sql;

// 成本层：对应原 SQLite 的 cost_layers 五个语句（由 LocalDB 实现）
// 用户查询：server.js 里有 S.userById / S.userByName / S.adminCount 三处，
// 它们是 prepared statement 形状（.get()），这里用 SQL 兼容层转一次。
const S = {
  // 注意这里必须是 { run(...) } 形状：通用工具段里的 audit() 写的是 S.audit.run(...)
  audit: { run: (t, u, a, d, ip) => LDB.audit(t, u, a, d, ip) },
  layerAll: { all: (pid, wh) => LDB.layerAll(pid, wh) },
  layerSum: { get: pid => LDB.layerSum(pid) },
  layerIns: { run: rec => LDB.layerIns(rec) },
  layerUpd: { run: (rowid, qty) => LDB.layerUpd(rowid, qty) },
  layerDel: { run: rowid => LDB.layerDel(rowid) },
  layerClear: { run: pid => LDB.layerClear(pid) },
  userById: { get: id => db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(String(id)) },
  userByName: { get: n => db.prepare('SELECT * FROM users WHERE username = ? AND disabled = 0').get(String(n)) },
  adminCount: { get: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() },
  // 单号去重：server.js 里写的是 S.noExists.get(col, no)
  noExists: { get: (col, no) => LDB.noExists(col, no) },
};
`;

// ---------- 3. 拼装 ----------
// 保留段：通用工具 → 演示数据前（去掉演示数据）
//        用户/会话 → 物流运费前（保留业务逻辑）
//        初始化 → 路由结束（保留路由）
// 注意 server.js 里 通用工具 段含 sum/str/fail/audit/HttpError，业务逻辑段含 ORD 等常量
const parts = [];
// 整体包一层 IIFE：server-local.js 里的业务常量（ORD / COLS / AUTO_CATS / METHODS…）
// 和 index.html 主脚本里的同名常量会撞车（SyntaxError: Identifier already declared），
// 所以整个文件必须在独立作用域里跑，只往外暴露 window.XerpLocal。
parts.push('(function () {');
parts.push(header);
parts.push(dbShim);

// 业务常量段（117行那种）在「模块/权限」之前，先看它在哪
// 这里用「通用工具」到「演示数据」之间：包含通用工具 + 业务常量 + 模块/权限
parts.push('/* ---- 通用工具 / 业务常量 / 模块权限（原样保留） ---- */');
parts.push(slice(seg.commonStart, seg.demoStart));

// 「演示数据」段里只有 seed()（生成随机演示数据）是浏览器用不到的，
// 后面紧跟着的 writeAll / ensureWh / ensureAccounts / 图片处理 / 账户处理
// 全是业务函数，必须保留。所以：跳过 seed() 函数体，保留该段其余部分。
const seedStart = lines.findIndex((l, i) => i >= seg.demoStart && /^function seed\(\)/.test(l));
if (seedStart < 0) throw new Error('找不到 seed()');
// seed() 到 writeAll 之前
const writeAllStart = lines.findIndex((l, i) => i > seedStart && /^function writeAll\(/.test(l));
if (writeAllStart < 0) throw new Error('找不到 writeAll()');
parts.push('/* ---- 账套工具 / 图片 / 账户（原样保留，跳过 seed 演示数据） ---- */');
parts.push(slice(writeAllStart, seg.userStart));

// 用户/会话 + 业务逻辑（保留到「远程访问」前）
// 注意：物流运费、快递鸟这两段里有 visibleData / publicUser 等被路由依赖的函数，
// 不能因为「单机版用不到快递鸟」就把整段切掉——切了会 ReferenceError。
parts.push('/* ---- 用户会话 / 业务逻辑（原样保留，含物流与快递鸟的工具函数） ---- */');
parts.push(slice(seg.userStart, seg.remoteStart));

// 初始化 + 路由（保留到「消息通知」前）
// 注意：原初始化段会调 seed()（演示数据，已被切掉）和 process.env（浏览器没有），
// 所以这里不用原文，改成单机版自己的初始化，见下面的 xerpInit。
parts.push('/* ---- 路由（原样保留） ---- */');
parts.push(slice(seg.routeStart, seg.notifyStart));

// ---------- 4. 单机版初始化（替代原初始化段） ----------
// 原段依赖 seed()（演示数据）和 process.env，浏览器里都没有。
// 单机版首次启动：空账套 + 一个管理员账号（密码由用户设置）。
parts.push(`
/* ================= 单机版初始化 ================= */
/**
 * 首次启动时建空账套和管理员账号。可重复调用（已初始化就跳过）。
 * @param {object} opt { company, username, password, name }
 */
function xerpInit(opt = {}) {
  const company = String(opt.company || '我的公司');
  if (!getMeta('initialized', false)) {
    tx(() => {
      // 单机版首次启动是空账套，不需要 writeAll（那是给演示数据/备份恢复用的）
      setMeta('settings', { company });
      setMeta('counters', {});
      setMeta('initialized', true);
    });
  }
  tx(ensureWh);
  tx(ensureAccounts);
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (!n) {
    createUser({
      username: String(opt.username || 'admin'),
      name: String(opt.name || '管理员'),
      roleId: 'admin',
      password: String(opt.password || 'admin123'),
    });
  }
  return { initialized: true, users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n };
}

/** 有没有初始化过（用来决定登录页显示「首次设置」还是「登录」） */
function xerpIsInitialized() {
  return !!getMeta('initialized', false) && db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

`);

// ---------- 5. 导出：给浏览器调用的 dispatch ----------
parts.push(`
/* ================= 对外接口（替代 HTTP 服务） ================= */
/**
 * 浏览器里直接调用路由表，替代 fetch。
 * @param {string} method GET/POST/PUT/DELETE
 * @param {string} url    /api/xxx（可带 query）
 * @param {object} body   请求体
 * @param {string} token  登录令牌
 * @returns {Promise<object>} 响应 JSON
 */
async function xerpDispatch(method, url, body, token) {
  const u = String(url);
  const qi = u.indexOf('?');
  const pathPart = qi >= 0 ? u.slice(0, qi) : u;
  const search = qi >= 0 ? u.slice(qi) : '';
  const query = {};
  if (search) for (const [k, v] of new URLSearchParams(search)) query[k] = v;

  // 找匹配的路由
  let hit = null, params = {};
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathPart.match(r.re);
    if (m) { hit = r; params = m.groups || {}; break; }
  }
  if (!hit) { const e = new Error('接口不存在'); e.status = 404; throw e; }

  // 会话：用 server.js 原来的 authUser（它按 token 查 sessions 表并取用户）
  // 注意 ctx.perms 必须是 Set：业务代码里到处是 P.has(...)，不是数组
  let user = null, perms = new Set();
  if (token) {
    const u = authUser({ headers: { authorization: 'Bearer ' + token } });
    if (u) {
      user = u;
      perms = effectivePerms(u);
    }
  }
  if (hit.auth && !user) { const e = new Error('登录已失效，请重新登录'); e.status = 401; throw e; }
  if (hit.admin && !(user && user.role === 'admin')) { const e = new Error('只有管理员能操作'); e.status = 403; throw e; }

  const ctx = { method, url: pathPart, params, query, body: body || {}, user, perms, ip: '' };
  try {
    const out = hit.handler(ctx);
    return out === undefined ? {} : out;
  } catch (e) {
    if (!e.status) e.status = 400;
    throw e;
  }
}

window.XerpLocal = {
  dispatch: xerpDispatch,
  db: LDB,
  init: xerpInit,
  isInitialized: xerpIsInitialized,
  ready: () => LDB.open(),
};
})();   // IIFE 结束
`);

const out = parts.join('\n');
fs.writeFileSync(OUT, out, 'utf8');
console.log(`生成 ${path.relative(ROOT, OUT)}`);
console.log(`  行数: ${out.split('\n').length}`);
console.log(`  大小: ${(out.length / 1024).toFixed(1)} KB`);
