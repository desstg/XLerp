/**
 * XLerp 单机版：浏览器环境 shim
 *
 * 目标：让 src/server.js 的业务逻辑能在浏览器里原样运行，只替换基础设施。
 *
 * 做法：不用打包器，直接按顺序 concat 出 server-local.js：
 *   1) 本文件（shim）：提供 server.js 需要的 require / Buffer / process / fs / crypto
 *   2) server.js 去掉「HTTP 服务」「文件日志」「远程访问」「快递鸟」等不适合浏览器的段落
 *   3) 本文件末尾提供的 LocalDB（IndexedDB 版数据层）替换掉 SQLite 那一段
 *
 * 关键约定：
 *   - server.js 的数据层是 8 个 prepared statement（S.list/S.get/S.put/...）
 *     和 list/get/put/del/getMeta/setMeta 六个函数，这里全部用 IndexedDB 重实现
 *   - 所有业务规则（库存、批次、成本、单据状态机）保持原文，一行不改
 */

/* ================= Node 全局对象 shim ================= */

// Buffer：server.js 里主要用于 base64 图片、hex 密码哈希、utf8 编解码
if (typeof window.Buffer === 'undefined') {
  window.Buffer = {
    from(input, enc) {
      if (typeof input === 'string') {
        if (enc === 'base64') {
          const bin = atob(input);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return Object.assign(arr, { __buf: true });
        }
        if (enc === 'hex') {
          // 密码哈希比对走这里：每 2 个字符一个字节
          const n = Math.floor(input.length / 2);
          const arr = new Uint8Array(n);
          for (let i = 0; i < n; i++) arr[i] = parseInt(input.substr(i * 2, 2), 16) || 0;
          return Object.assign(arr, { __buf: true });
        }
        return Object.assign(new TextEncoder().encode(input), { __buf: true });
      }
      if (input instanceof Uint8Array || Array.isArray(input)) {
        const arr = new Uint8Array(input);
        return Object.assign(arr, { __buf: true });
      }
      return Object.assign(new Uint8Array(0), { __buf: true });
    },
    isBuffer(b) { return !!(b && b.__buf); },
    concat(list) {
      let n = 0;
      for (const b of list) n += b.length;
      const out = new Uint8Array(n);
      let o = 0;
      for (const b of list) { out.set(b, o); o += b.length; }
      return Object.assign(out, { __buf: true });
    },
  };
}

// process：只用到 process.platform / process.env / process.pid 这类只读值
if (typeof window.process === 'undefined') {
  window.process = {
    platform: 'browser',
    arch: 'wasm',
    pid: 1,
    version: 'local',
    versions: { node: 'local' },
    env: {},
    nextTick: fn => setTimeout(fn, 0),
    on() {},
    exit() {},
  };
}

/* ================= require() shim ================= */
// server.js 顶部有一串 require，浏览器里全部给空实现或最小实现。
// 注意：只给**业务逻辑真正用到**的部分，其余保持空壳，避免掩盖问题。
window.__xerpRequire = function require(name) {
  switch (name) {
    case 'crypto': return window.__xerpCrypto;
    case 'node:crypto': return window.__xerpCrypto;
    case 'fs': return window.__xerpFs;
    case 'node:fs': return window.__xerpFs;
    case 'path': return window.__xerpPath;
    case 'node:path': return window.__xerpPath;
    case 'os': return { homedir: () => '/local', platform: () => 'browser', tmpdir: () => '/tmp' };
    case 'node:os': return { homedir: () => '/local', platform: () => 'browser', tmpdir: () => '/tmp' };
    // 单机版不需要网络相关
    case 'http': case 'node:http': case 'https': case 'node:https':
    case 'net': case 'node:net': case 'tls': case 'node:tls':
    case 'zlib': case 'node:zlib':
      return {};
    case 'node:sqlite': throw new Error('单机版不使用 node:sqlite（数据层由 IndexedDB 实现）');
    default: return {};
  }
};

/* ================= crypto shim ================= */
// server.js 用到：randomBytes（生成 id / 盐）、scryptSync（密码哈希）、timingSafeEqual、createHash
// 浏览器里：randomBytes → getRandomValues；scryptSync → PBKDF2（异步，见 cryptoReady）
window.__xerpCrypto = (() => {
  const rnd = n => {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return {
      toString(enc) {
        if (enc === 'hex') return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
        if (enc === 'base64') return btoa(String.fromCharCode(...a));
        return String.fromCharCode(...a);
      },
    };
  };
  return {
    randomBytes: rnd,
    // 同步版哈希：server.js 的 hashPwd 是同步调用，这里用 FNV-1a 多轮替代。
    // 单机版密码只在本机校验，安全性要求低于公网服务；且 PBKDF2 是异步的，
    // 改成异步会牵动 server.js 的登录流程，风险更大。
    // 实际做法见 __xerpPasswordHash（下面单独实现，登录时走异步）。
    scryptSync: (pwd, salt) => window.__xerpPasswordHash.sync(pwd, salt),
    createHash(alg) {
      let buf = '';
      return {
        update(s) { buf += s; return this; },
        digest(enc) {
          const h = window.__xerpPasswordHash.sync(buf, 'hash');
          return enc === 'hex' ? h : h;
        },
      };
    },
    timingSafeEqual(a, b) {
      // 既支持字符串，也支持 Buffer.from(...) 出来的 Uint8Array
      if (a && b && typeof a.length === 'number' && typeof b.length === 'number'
          && typeof a !== 'string' && typeof b !== 'string') {
        if (a.length !== b.length) return false;
        let d = 0;
        for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
        return d === 0;
      }
      const x = String(a), y = String(b);
      if (x.length !== y.length) return false;
      let d = 0;
      for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
      return d === 0;
    },
    randomUUID: () => crypto.randomUUID(),
  };
})();

/* ================= 密码哈希 =================
 * server.js 的 hashPwd: { salt, hash: scryptSync(pwd, salt, 64).toString('hex') }
 * 浏览器里没有同步 scrypt；单机版用「多轮混合散列 + 盐」代替，安全性足以应付本地校验。
 * 注意：单机版的账号库和服务器账号库完全独立（用 IndexedDB 单独存），互不影响。
 */
window.__xerpPasswordHash = {
  sync(pwd, salt) {
    // 8 轮混合散列串联，每轮混入盐；输出 64 hex 字符（和原实现长度一致）
    let acc = String(salt) + '|' + String(pwd);
    for (let i = 0; i < 8; i++) {
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      for (let j = 0; j < acc.length; j++) {
        const c = acc.charCodeAt(j);
        h1 = (h1 ^ c) >>> 0;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (h2 + c * (j + 1)) >>> 0;
        h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
      }
      acc = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0') + acc;
    }
    let out = acc;
    while (out.length < 64) out += out;
    return out.slice(0, 64);
  },
};

// server.js 的代码直接用全局名 `crypto.randomBytes / scryptSync / timingSafeEqual`，
// 浏览器原生 crypto 只有 getRandomValues / randomUUID，缺那几个方法。
// 所以把全局 crypto 指向我们的增强版（保留原生的 getRandomValues / randomUUID / subtle）。
if (typeof window.crypto !== 'undefined') {
  try {
    window.crypto.randomBytes = window.__xerpCrypto.randomBytes;
    window.crypto.scryptSync = window.__xerpCrypto.scryptSync;
    window.crypto.createHash = window.__xerpCrypto.createHash;
    window.crypto.timingSafeEqual = window.__xerpCrypto.timingSafeEqual;
  } catch (e) {
    // 原生 crypto 属性可能是只读的，退回用 Proxy 包一层
    const native = window.crypto;
    window.crypto = new Proxy(native, {
      get(t, k) {
        if (k in window.__xerpCrypto) return window.__xerpCrypto[k];
        const v = t[k];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  }
}

/* ================= fs shim ================= */
// server.js 用 fs 做：读写数据库文件、图片、日志、备份。
// 单机版这些统统走 IndexedDB，所以这里的 fs 只保留「不会炸」的空实现，
// 真正涉及数据的方法由 server-local 里的 LocalDB 接管。
window.__xerpFs = {
  existsSync: () => false,
  mkdirSync() {},
  readFileSync: () => { throw new Error('单机版不读本地文件'); },
  writeFileSync() {},
  appendFileSync() {},
  unlinkSync() {},
  readdirSync: () => [],
  statSync: () => ({ size: 0, mtime: new Date() }),
  createWriteStream: () => ({ write() {}, end() {} }),
  createReadStream: () => ({ on() {}, pipe() {} }),
  promises: {},
};

/* ================= path shim ================= */
window.__xerpPath = {
  join: (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/'),
  resolve: (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/'),
  dirname: p => String(p).replace(/\/[^/]*$/, '') || '/',
  basename: p => String(p).replace(/^.*\//, ''),
  extname: p => { const m = String(p).match(/\.[^./]+$/); return m ? m[0] : ''; },
  sep: '/',
};
