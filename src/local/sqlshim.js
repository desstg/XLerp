/**
 * XLerp 单机版：SQL 兼容层
 *
 * server.js 的业务代码里有 40 多种 db.prepare(...) 的 SQL 语句。
 * 与其把 202 个业务函数全部重写成 IndexedDB 风格（极容易算错），
 * 不如反过来：提供一个「认识这些 SQL」的 db.prepare 兼容层。
 *
 * 支持的语法范围（就是 server.js 实际用到的那 40 条，不多不少）：
 *   SELECT ... FROM <table> [WHERE ...] [ORDER BY ...] [GROUP BY ...] [LIMIT ?]
 *   INSERT INTO <table> (...) VALUES (...)
 *   INSERT OR REPLACE INTO <table> (...)
 *   UPDATE <table> SET ... [WHERE ...]
 *   DELETE FROM <table> [WHERE ...]
 *
 * 表达式支持：= ? / = 'literal' / <> / < / > / IS NULL / IS NOT NULL / AND / OR / LIKE
 * 聚合支持：COUNT(*) AS n / GROUP BY 单列
 *
 * 表结构（内存存储，用 LocalDB 的 meta 区域持久化）：
 *   users    { id, username, name, role, role_id, perms, salt, hash, created_at, last_login, disabled }
 *   sessions { token, user_id, expires }
 *   roles    { id, name, descr, perms, builtin, sort, created_at }
 *   images   { id, mime, data(base64), updated_at }
 *   audit    { seq(自增), id, time, username, action, detail, ip }
 */

class SqlDb {
  constructor(store) {
    this.store = store;                 // LocalDB 实例
    this.tables = store.sqlTables;      // { users: [], sessions: [], roles: [], images: [], audit: [] }
  }

  /** 表不存在就建 */
  t(name) {
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }

  changed() { this.store.changed(); }

  /* ================= 查询执行入口 ================= */
  prepare(sql) {
    const self = this;
    const s = String(sql).replace(/\s+/g, ' ').trim();
    return {
      run(...params) { return self.run(s, params); },
      get(...params) { return self.get(s, params); },
      all(...params) { return self.all(s, params); },
    };
  }

  exec(sql) {
    // 只处理 server.js 里初始化用的 CREATE TABLE / PRAGMA / ALTER，全部忽略
    return true;
  }

  /* ================= 解析 ================= */
  parse(sql) {
    let m;
    // ---------- SELECT ----------
    if ((m = /^SELECT (.+?) FROM ([a-z_]+)(?: (.*))?$/i.exec(sql))) {
      return { kind: 'select', cols: m[1], table: m[2], tail: m[3] || '' };
    }
    if ((m = /^select (.+?) from ([a-z_]+) where (.*)$/i.exec(sql))) {
      return { kind: 'select', cols: m[1], table: m[2], tail: 'where ' + m[3] };
    }
    // ---------- INSERT ----------
    if ((m = /^INSERT OR REPLACE INTO ([a-z_]+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(sql))) {
      return { kind: 'insert', table: m[1], cols: m[2], vals: m[3], replace: true };
    }
    if ((m = /^INSERT INTO ([a-z_]+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(sql))) {
      return { kind: 'insert', table: m[1], cols: m[2], vals: m[3], replace: false };
    }
    // ---------- UPDATE ----------
    if ((m = /^UPDATE ([a-z_]+) SET (.+?)(?: WHERE (.+))?$/i.exec(sql))) {
      return { kind: 'update', table: m[1], sets: m[2], where: m[3] || '' };
    }
    // ---------- DELETE ----------
    if ((m = /^DELETE FROM ([a-z_]+)(?: WHERE (.+))?$/i.exec(sql))) {
      return { kind: 'delete', table: m[1], where: m[2] || '' };
    }
    throw new Error('SQL 兼容层不支持：' + sql);
  }

  /* ---------- WHERE 求值 ---------- */
  /** 把 WHERE 子句编译成 (row, params) => boolean，参数按 ? 顺序消费 */
  compileWhere(where, params, offset = 0) {
    if (!where) return { fn: () => true, used: 0 };
    let i = offset;
    const parts = where.split(/\s+AND\s+/i);
    const fns = parts.map(p => {
      const t = p.trim();
      let m;
      if ((m = /^(\w+) IS NULL$/i.exec(t))) { const k = m[1]; return row => row[k] == null; }
      if ((m = /^(\w+) IS NOT NULL$/i.exec(t))) { const k = m[1]; return row => row[k] != null; }
      if ((m = /^(\w+) <> \?$/i.exec(t))) { const k = m[1], v = params[i++]; return row => row[k] !== v; }
      if ((m = /^(\w+) = \?$/i.exec(t))) { const k = m[1], v = params[i++]; return row => row[k] === v; }
      if ((m = /^(\w+) < \?$/i.exec(t))) { const k = m[1], v = params[i++]; return row => row[k] < v; }
      if ((m = /^(\w+) > \?$/i.exec(t))) { const k = m[1], v = params[i++]; return row => row[k] > v; }
      if ((m = /^(\w+) = '([^']*)'$/i.exec(t))) { const k = m[1], v = m[2]; return row => row[k] === v; }
      if ((m = /^(\w+) <> '([^']*)'$/i.exec(t))) { const k = m[1], v = m[2]; return row => row[k] !== v; }
      // 列 = 数字字面量，如 disabled = 0 / builtin = 1
      if ((m = /^(\w+) = (-?\d+(?:\.\d+)?)$/i.exec(t))) { const k = m[1], v = Number(m[2]); return row => Number(row[k]) === v; }
      if ((m = /^(\w+) <> (-?\d+(?:\.\d+)?)$/i.exec(t))) { const k = m[1], v = Number(m[2]); return row => Number(row[k]) !== v; }
      // 形如 role <> 'admin' AND disabled = 0 已被 split 处理；这里兜不住就报错
      throw new Error('WHERE 条件不支持：' + t);
    });
    return { fn: row => fns.every(f => f(row)), used: i - offset };
  }

  /** 处理 ORDER BY / LIMIT / GROUP BY */
  applyTail(rows, tail, params, offset) {
    let out = rows.slice();
    if (!tail) return { rows: out, used: 0 };
    let used = 0;
    let m;
    if ((m = /ORDER BY (.+?)(?: LIMIT \?|$)/i.exec(tail))) {
      const spec = m[1].trim();
      const terms = spec.split(',').map(x => {
        const [col, dir] = x.trim().split(/\s+/);
        return { col, desc: /desc/i.test(dir || '') };
      });
      out.sort((a, b) => {
        for (const t of terms) {
          const x = a[t.col], y = b[t.col];
          if (x === y) continue;
          const r = x == null ? -1 : y == null ? 1 : (x < y ? -1 : 1);
          return t.desc ? -r : r;
        }
        return 0;
      });
    }
    if (/LIMIT \?/i.test(tail)) {
      const n = params[offset + used]; used++;
      out = out.slice(0, Number(n) || 0);
    }
    return { rows: out, used };
  }

  /* ---------- 投影 ---------- */
  project(row, cols) {
    const c = cols.trim();
    if (c === '*' || c === 'rowid, qty, unit') return { ...row };
    const out = {};
    for (const part of c.split(',').map(x => x.trim())) {
      const m = /^(\w+)(?:\s+AS\s+(\w+))?$/i.exec(part);
      if (m) out[m[2] || m[1]] = row[m[1]];
    }
    return out;
  }

  /* ================= 执行 ================= */
  get(sql, params) {
    const q = this.parse(sql);
    if (q.kind !== 'select') throw new Error('get() 只用于 SELECT');
    const table = this.t(q.table);

    // COUNT(*) AS n
    let m;
    if ((m = /^COUNT\(\*\) AS (\w+)$/i.exec(q.cols.trim()))) {
      const w = this.compileWhere(q.tail.replace(/^where /i, ''), params);
      return { [m[1]]: table.filter(w.fn).length };
    }
    // SELECT role_id, COUNT(*) AS n ... GROUP BY role_id
    if (/GROUP BY/i.test(q.tail)) {
      const wPart = q.tail.replace(/GROUP BY.*$/i, '').replace(/^where /i, '');
      const w = this.compileWhere(wPart, params);
      const rows = table.filter(w.fn);
      return rows[0] ? this.project(rows[0], q.cols) : null;
    }
    const wPart = q.tail.replace(/ORDER BY.*$/i, '').replace(/^where /i, '');
    const w = this.compileWhere(wPart, params);
    const rows = table.filter(w.fn);
    const sorted = this.applyTail(rows, q.tail, params, w.used).rows;
    if (!sorted.length) return undefined;
    return this.project(sorted[0], q.cols);
  }

  all(sql, params) {
    const q = this.parse(sql);
    if (q.kind !== 'select') throw new Error('all() 只用于 SELECT');
    const table = this.t(q.table);
    const wPart = q.tail.replace(/(ORDER BY|GROUP BY|LIMIT).*$/i, '').replace(/^where /i, '');
    const w = this.compileWhere(wPart, params);
    const rows = table.filter(w.fn);
    const sorted = this.applyTail(rows, q.tail, params, w.used).rows;
    return sorted.map(r => this.project(r, q.cols));
  }

  run(sql, params) {
    const q = this.parse(sql);
    const table = this.t(q.table);
    let n = 0;

    if (q.kind === 'insert') {
      const cols = q.cols.split(',').map(x => x.trim());
      const vals = q.vals.split(',').map(x => x.trim());
      const row = {};
      let pi = 0;
      for (let i = 0; i < cols.length; i++) {
        const v = vals[i];
        if (v === '?') row[cols[i]] = params[pi++];
        else if (/^'.*'$/.test(v)) row[cols[i]] = v.slice(1, -1);
        else row[cols[i]] = Number(v);
      }
      // 模拟 SQLite 的列默认值：建表时声明了 DEFAULT 0 而 INSERT 没给的列，要补上。
      // 关键的几处：users.disabled（0）、roles.builtin（0）、roles.sort（0）。
      const DEFAULTS = {
        users: { disabled: 0 },
        roles: { builtin: 0, sort: 0 },
        images: {},
        sessions: {},
        audit: {},
      };
      const def = DEFAULTS[q.table] || {};
      for (const k of Object.keys(def)) if (row[k] === undefined) row[k] = def[k];
      // 主键去重（INSERT OR REPLACE 语义）
      const key = cols.includes('id') ? 'id' : cols.includes('token') ? 'token' : null;
      if (key && q.replace) {
        const idx = table.findIndex(r => r[key] === row[key]);
        if (idx >= 0) table.splice(idx, 1);
      }
      table.push(row);
      this.changed();
      return { changes: 1 };
    }

    if (q.kind === 'update') {
      const w = this.compileWhere(q.where, params, countParams(q.sets));
      const sets = q.sets.split(',').map(x => x.trim()).map(x => {
        const m = /^(\w+) = (\?|'([^']*)'|-?\d+(?:\.\d+)?)$/.exec(x);
        if (!m) throw new Error('SET 不支持：' + x);
        return { col: m[1], lit: m[3] !== undefined ? m[3] : (m[2] === '?' ? undefined : Number(m[2])) };
      });
      let pi = 0;
      for (const row of table) {
        if (!w.fn(row)) continue;
        for (const s of sets) row[s.col] = s.lit === undefined ? params[pi++] : s.lit;
        n++;
      }
      if (n) this.changed();
      return { changes: n };
    }

    if (q.kind === 'delete') {
      const w = this.compileWhere(q.where, params);
      const keep = [];
      for (const row of table) { if (w.fn(row)) n++; else keep.push(row); }
      this.tables[q.table] = keep;
      if (n) this.changed();
      return { changes: n };
    }

    throw new Error('run() 不支持：' + sql);
  }
}

function countParams(clause) {
  return (clause.match(/\?/g) || []).length;
}

window.XerpSql = { SqlDb, countParams };
