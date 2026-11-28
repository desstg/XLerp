/**
 * XLerp 单机版：IndexedDB 数据层
 *
 * 严格对应 server.js 里 SQLite 的那 8 个 prepared statement：
 *   S.list      SELECT data FROM docs WHERE col = ? ORDER BY rowid DESC
 *   S.get       SELECT data FROM docs WHERE col = ? AND id = ?
 *   S.put       INSERT ... ON CONFLICT DO UPDATE
 *   S.del       DELETE FROM docs WHERE col = ? AND id = ?
 *   S.noExists  SELECT 1 FROM docs WHERE col = ? AND json_extract(data,'$.no') = ?
 *   S.metaGet   SELECT value FROM meta WHERE key = ?
 *   S.metaSet   INSERT INTO meta ... ON CONFLICT DO UPDATE
 *   S.audit     INSERT INTO audit
 * 以及 cost_layers 那 5 个（成本层，移动加权成本要用）
 *
 * 设计要点：
 *   - docs 表用 objectStore('docs')，keyPath = ['col','id']，另加自增 rowid 模拟 SQLite 的 rowid 排序
 *   - 订单列表「ORDER BY rowid DESC」= 按插入顺序倒序，这里用 rowid 反序实现
 *   - 所有方法同步返回（server.js 的业务代码是同步写的），
 *     所以在启动时把整个库**预加载进内存**，写操作先改内存再异步落盘。
 *     单机数据量小（几千条单据），内存完全放得下，且保证业务逻辑零改动。
 */

class LocalDB {
  constructor() {
    this.name = 'xerp-local';
    // v2：sqlTables 从「kv 一条记录」改成「一张表一个 objectStore」，必须升版本才会触发 onupgradeneeded
    this.ver = 2;
    this.idb = null;
    /** @type {Map<string, Map<string, object>>} col -> (id -> {rowid, data}) */
    this.mem = new Map();
    /** @type {Map<string, string>} meta key -> json */
    this.meta = new Map();
    /** @type {Array<object>} 成本层 */
    this.layers = [];
    this.auditLog = [];
    this.rowidSeq = 1;
    this.dirty = false;
    this.flushTimer = null;
    /** SQL 兼容层用的表：users / sessions / roles / images / audit */
    this.sqlTables = { users: [], sessions: [], roles: [], images: [], audit: [] };
    /**
     * SqlDb 实例。必须**在构造时就建好**——server.js 里有模块级语句
     * （如 db.exec('CREATE TABLE ... roles')）在加载阶段就执行，
     * 那时 open() 还没跑。SqlDb 直接持有 this.sqlTables 引用，后面的 load() 填充数据即可。
     */
    this.sql = window.XerpSql ? new window.XerpSql.SqlDb(this) : null;
  }

  /* ---------- 打开 / 预加载 ---------- */
  async open() {
    // 幂等：已经打开且连接还活着就直接返回。
    // 反复 indexedDB.open() 会建多条连接，旧连接上的事务会静默失败（put 不生效）。
    if (this.idb) {
      try {
        // 用一个只读事务探活；连接已关会抛 InvalidStateError
        this.idb.transaction('kv', 'readonly');
        return this;
      } catch (e) {
        this.idb = null;
      }
    }
    this.idb = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, this.ver);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('docs')) {
          const st = db.createObjectStore('docs', { keyPath: ['col', 'id'] });
          st.createIndex('col', 'col');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('layers')) db.createObjectStore('layers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audit')) db.createObjectStore('audit', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        // SQL 兼容层的表：一张表一个 objectStore，逐条 put/getAll。
        // 之前把 5 张表塞进 kv 的一条记录里，put 整个对象快照时会出现「事务成功但读到空数组」，
        // 改成按表存储就没有这个时序问题了。
        // users/roles/images 用 id；sessions 用 token 当主键
        if (!db.objectStoreNames.contains('t_users')) db.createObjectStore('t_users', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('t_sessions')) db.createObjectStore('t_sessions', { keyPath: 'token' });
        if (!db.objectStoreNames.contains('t_roles')) db.createObjectStore('t_roles', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('t_images')) db.createObjectStore('t_images', { keyPath: 'id' });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB 被其他窗口占用'));
    });
    this.idb.onversionchange = () => { try { this.idb.close(); } catch (e) {} this.idb = null; };
    await this.load();
    return this;
  }

  async load() {
    const all = (store) => new Promise((resolve, reject) => {
      let tx;
      try { tx = this.idb.transaction(store, 'readonly'); } catch (e) { return resolve([]); }
      const r = tx.objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
    const docs = await all('docs');
    this.mem.clear();
    for (const d of docs) {
      if (!this.mem.has(d.col)) this.mem.set(d.col, new Map());
      this.mem.get(d.col).set(d.id, d);
      if (d.rowid >= this.rowidSeq) this.rowidSeq = d.rowid + 1;
    }
    this.meta.clear();
    for (const m of await all('meta')) this.meta.set(m.k, m.v);
    this.layers = await all('layers');
    this.auditLog = await all('audit');
    // SQL 兼容层的表：一张表一个 store，直接 getAll
    this.loadedFrom = {};
    for (const t of ['users', 'sessions', 'roles', 'images']) {
      const rows = await all('t_' + t);
      this.sqlTables[t] = rows;
      this.loadedFrom[t] = rows.length;
    }
  }

  /* ---------- 落盘（异步、合并写入） ---------- */
  markDirty() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) this.flush();
    }, 300);
  }

  flush() {
    if (!this.idb) return Promise.resolve(false);
    this.dirty = false;
    const stores = ['docs', 'meta', 'layers', 'audit', 't_users', 't_sessions', 't_roles', 't_images'];
    let tx;
    try {
      tx = this.idb.transaction(stores, 'readwrite');
    } catch (e) {
      this.lastFlushError = 'transaction 创建失败：' + e.message;
      return Promise.resolve(false);
    }
    try {
      const ds = tx.objectStore('docs');
      for (const colMap of this.mem.values()) for (const rec of colMap.values()) ds.put(rec);
      const ms = tx.objectStore('meta');
      for (const [k, v] of this.meta) ms.put({ k, v });
      const ls = tx.objectStore('layers');
      ls.clear();
      for (const l of this.layers) ls.put(l);
      const as = tx.objectStore('audit');
      as.clear();
      for (const a of this.auditLog.slice(-2000)) as.put(a);
      // SQL 表：逐条 put（先清空该表再写，保证和内存一致）
      for (const t of ['users', 'sessions', 'roles', 'images']) {
        const st = tx.objectStore('t_' + t);
        st.clear();
        for (const row of this.sqlTables[t] || []) {
          st.put(row);
        }
      }
    } catch (e) {
      this.lastFlushError = '写入失败：' + e.message;
      return Promise.resolve(false);
    }
    return new Promise(res => {
      tx.oncomplete = () => { this.lastFlushError = null; res(true); };
      tx.onerror = () => { this.lastFlushError = String(tx.error && tx.error.message || tx.error); res(false); };
      tx.onabort = () => { this.lastFlushError = 'aborted: ' + String(tx.error && tx.error.message); res(false); };
    });
  }

  /** 给 SqlDb 用：数据变了就标脏（SqlDb 内部改的是 this.sqlTables） */
  changed() { this.markDirty(); }

  /* ---------- docs 操作（对应 S.*） ---------- */
  _col(col) {
    if (!this.mem.has(col)) this.mem.set(col, new Map());
    return this.mem.get(col);
  }

  /** S.list：该集合全部记录，按 rowid 倒序（最新在前） */
  list(col) {
    const m = this._col(col);
    return [...m.values()].sort((a, b) => b.rowid - a.rowid);
  }

  /** S.get：单条 */
  get(col, id) {
    return this._col(col).get(String(id)) || null;
  }

  /** S.put：有则更新，无则插入 */
  put(col, obj) {
    const m = this._col(col);
    const id = String(obj.id);
    const old = m.get(id);
    const rec = { col, id, rowid: old ? old.rowid : this.rowidSeq++, data: JSON.stringify(obj) };
    m.set(id, rec);
    this.markDirty();
  }

  /** S.del */
  del(col, id) {
    this._col(col).delete(String(id));
    this.markDirty();
  }

  /** S.noExists：查某个字段值是否已存在（server.js 用来生成不重复单号） */
  noExists(col, no) {
    for (const rec of this._col(col).values()) {
      try { if (JSON.parse(rec.data).no === no) return true; } catch (e) {}
    }
    return false;
  }

  /* ---------- meta ---------- */
  metaGet(k, d) {
    const v = this.meta.get(k);
    if (v === undefined) return d;
    try { return JSON.parse(v); } catch (e) { return d; }
  }
  metaSet(k, v) {
    this.meta.set(k, JSON.stringify(v));
    this.markDirty();
  }

  /* ---------- audit ---------- */
  audit(time, username, action, detail, ip) {
    this.auditLog.push({ time, username, action, detail, ip });
    if (this.auditLog.length > 2000) this.auditLog.shift();
    this.markDirty();
  }
  auditList(limit = 200) {
    return this.auditLog.slice(-limit).reverse();
  }

  /* ---------- cost_layers（成本层，移动加权成本用） ---------- */
  layerAll(productId, wh) {
    return this.layers
      .filter(l => l.product_id === productId && l.wh === wh && l.qty > 0.0000001)
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.rowid - b.rowid));
  }
  layerSum(productId) {
    const ls = this.layers.filter(l => l.product_id === productId);
    return {
      q: ls.reduce((s, l) => s + l.qty, 0),
      v: ls.reduce((s, l) => s + l.qty * l.unit, 0),
    };
  }
  layerIns(rec) {
    rec.rowid = this.rowidSeq++;
    this.layers.push(rec);
    this.markDirty();
  }
  layerUpd(rowid, qty) {
    const l = this.layers.find(x => x.rowid === rowid);
    if (l) { l.qty = qty; this.markDirty(); }
  }
  layerDel(rowid) {
    this.layers = this.layers.filter(x => x.rowid !== rowid);
    this.markDirty();
  }
  layerClear(productId) {
    this.layers = this.layers.filter(x => x.product_id !== productId);
    this.markDirty();
  }

  /* ---------- 清库（导出/重置用） ---------- */
  async wipe() {
    this.mem.clear();
    this.meta.clear();
    this.layers = [];
    this.auditLog = [];
    this.rowidSeq = 1;
    await this.flush();
  }
}

window.__xerpDB = new LocalDB();
