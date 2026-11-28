/**
 * XLerp 单机模式接入层（前端）
 *
 * 职责：让 index.html 在「单机模式」下不连服务器，改用浏览器内的 IndexedDB。
 *
 * 设计原则（很重要）：
 *   - **不改 index.html 的任何业务逻辑**，只在 api() 最前面加一个钩子
 *   - 单机模式下 api() 直接把请求交给 window.XerpLocal.dispatch()（真 server.js 的业务代码）
 *   - 服务器模式下 api() 走原来的 fetch，一行行为都不变
 *   - 模式存在 localStorage 的 erp_runmode 里：'server'（默认）/ 'local'
 *
 * 加载顺序（在 index.html 的 <script> 之前）：
 *   local/shim.js → local/sqlshim.js → local/db.js → local/server-local.js → local/boot.js（本文件）
 */
(function () {
  'use strict';

  const KEY = 'erp_runmode';
  const LSKEY = 'local_token';

  const isLocal = () => (localStorage.getItem(KEY) || 'server') === 'local';

  function setMode(mode) {
    localStorage.setItem(KEY, mode === 'local' ? 'local' : 'server');
    // 切模式时清掉登录态，避免两种模式串号
    localStorage.removeItem('erp_token');
    localStorage.removeItem(LSKEY);
  }

  /** 单机模式的请求分发：直接调 server.js 的业务代码 */
  async function localApi(method, path, body) {
    // token 两个键都认：单机专用 local_token 优先，其次是前端原有逻辑写的 erp_token
    const token = localStorage.getItem(LSKEY) || localStorage.getItem('erp_token') || '';
    let out;
    try {
      out = await window.XerpLocal.dispatch(method, path, body, token);
    } catch (e) {
      const err = new Error(e.message || '操作失败');
      err.status = e.status || 400;
      throw err;
    }
    // 登录成功：两个键都写上，保证前端后续的 LS.get('token') 也能拿到
    if (path === '/api/login' && out && out.token) {
      localStorage.setItem(LSKEY, out.token);
      localStorage.setItem('erp_token', out.token);
    }
    return out;
  }

  /** 单机模式下的「登录已过期」判断：本地 token 存在且能在 sessions 表里查到 */
  function localTokenValid() {
    const t = localStorage.getItem(LSKEY) || localStorage.getItem('erp_token') || '';
    if (!t) return false;
    try {
      const db = window.__xerpDB;
      const s = (db.sqlTables.sessions || []).find(x => x.token === t);
      if (!s) return false;
      if (s.expires && s.expires < Date.now()) return false;
      return true;
    } catch (e) { return false; }
  }

  /* ---------- 首次进入单机模式的初始化 ---------- */
  async function bootLocal() {
    if (!window.XerpLocal) throw new Error('单机模块未加载');
    await window.XerpLocal.ready();
    const inited = window.XerpLocal.isInitialized();
    return { initialized: inited };
  }

  /* ---------- 首次设置（建账套 + 管理员） ---------- */
  async function setupLocal(opt) {
    await window.XerpLocal.ready();
    const r = window.XerpLocal.init(opt);
    const lg = await localApi('POST', '/api/login', { username: opt.username, password: opt.password });
    localStorage.setItem(LSKEY, lg.token);
    localStorage.setItem('erp_token', lg.token);
    localStorage.setItem('erp_lastUser', JSON.stringify(opt.username));
    // 立刻落盘：下面很可能紧跟一个 location.reload()，等 300ms 的合并写入会来不及
    await window.__xerpDB.flush();
    return lg;
  }

  /* ---------- 单机模式登录 ---------- */
  async function loginLocal(username, password) {
    const r = await localApi('POST', '/api/login', { username, password });
    localStorage.setItem(LSKEY, r.token);
    localStorage.setItem('erp_token', r.token);
    await window.__xerpDB.flush();
    return r;
  }

  function logoutLocal() {
    localStorage.removeItem(LSKEY);
  }

  /* ---------- 导出 / 导入（数据完全在本机，给用户留个备份手段） ---------- */
  function exportData() {
    const db = window.__xerpDB;
    const doc = {};
    for (const [col, m] of db.mem) doc[col] = [...m.values()].map(r => JSON.parse(r.data));
    const meta = {};
    for (const [k, v] of db.meta) meta[k] = JSON.parse(v);
    return {
      app: 'XLerp-Local',
      version: (window.XerpLocal && window.XerpLocal.db) ? 1 : 1,
      exportedAt: new Date().toISOString(),
      data: doc,
      meta,
      sql: db.sqlTables,
      layers: db.layers,
    };
  }

  async function importData(json) {
    const db = window.__xerpDB;
    const j = typeof json === 'string' ? JSON.parse(json) : json;
    if (!j || j.app !== 'XLerp-Local') throw new Error('不是 XLerp 单机版的备份文件');
    db.mem.clear();
    db.meta.clear();
    db.layers = [];
    for (const [col, rows] of Object.entries(j.data || {})) {
      const m = new Map();
      let rid = 1;
      for (const r of rows) m.set(String(r.id), { col, id: String(r.id), rowid: rid++, data: JSON.stringify(r) });
      db.mem.set(col, m);
      db.rowidSeq = Math.max(db.rowidSeq, rid);
    }
    for (const [k, v] of Object.entries(j.meta || {})) db.meta.set(k, JSON.stringify(v));
    db.layers = j.layers || [];
    if (j.sql) Object.assign(db.sqlTables, j.sql);
    await db.flush();
    return true;
  }

  window.XerpLocalMode = {
    isLocal,
    setMode,
    localApi,
    localTokenValid,
    bootLocal,
    setupLocal,
    loginLocal,
    logoutLocal,
    exportData,
    importData,
    KEY,
    LSKEY,
  };
})();
