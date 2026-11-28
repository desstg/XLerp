// 验证单机版的完整记账链路：商品 → 客户 → 采购 → 入库 → 销售 → 发货 → 收款
// 重点检查库存数字（这是最容易算错的地方）
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

const stores = {};
const fakeIDB = {
  open() {
    const req = {};
    setTimeout(() => {
      req.result = {
        objectStoreNames: { contains: n => n in stores },
        createObjectStore(n) { stores[n] = []; return {}; },
        transaction(names) {
          const tx = { oncomplete: null, onerror: null };
          tx.objectStore = name => ({
            getAll() { const q = {}; setTimeout(() => { q.result = (stores[name] || []).slice(); q.onsuccess && q.onsuccess(); }, 0); return q; },
            put(v) { (stores[name] = stores[name] || []).push(v); return {}; },
            clear() { stores[name] = []; return {}; },
          });
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 1);
          return tx;
        },
      };
      req.onsuccess && req.onsuccess({ target: req });
    }, 0);
    return req;
  },
};

const sb = {
  console, setTimeout, clearTimeout, Date, Math, JSON, Number, String, Object, Array, Error, RegExp, Map, Set, Promise,
  parseInt, parseFloat, isNaN, isFinite,
  TextEncoder: require('node:util').TextEncoder,
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  crypto: {
    getRandomValues: a => { a.set(require('node:crypto').randomBytes(a.length)); return a; },
    randomUUID: () => require('node:crypto').randomUUID(),
  },
  indexedDB: fakeIDB,
  URLSearchParams,
};
sb.window = sb; sb.self = sb;
const ctx = vm.createContext(sb);
const load = r => vm.runInContext(fs.readFileSync(path.join(ROOT, r), 'utf8'), ctx, { filename: r });

load('src/local/shim.js');
ctx.require = ctx.__xerpRequire;
load('src/local/sqlshim.js');
load('src/local/db.js');
load('src/local/server-local.js');

const call = (m, u, b, t) => vm.runInContext(
  `XerpLocal.dispatch(${JSON.stringify(m)},${JSON.stringify(u)},${JSON.stringify(b)},${JSON.stringify(t)})`, ctx);
const ok = (label, cond, extra = '') => console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);

(async () => {
  await ctx.__xerpDB.open();
  vm.runInContext(`XerpLocal.init({company:'测试公司',username:'admin',password:'admin123'})`, ctx);
  const lg = await call('POST', '/api/login', { username: 'admin', password: 'admin123' }, null);
  const T = lg.token;
  console.log('登录 OK，token =', T.slice(0, 10) + '...\n');

  // ---------- 1. 建商品 ----------
  console.log('=== 1. 建货品');
  const p1 = await call('POST', '/api/products', { name: '测试商品A', sku: 'T001', unit: '个', price: 50, cost: 30 }, T);
  const p2 = await call('POST', '/api/products', { name: '测试商品B', sku: 'T002', unit: '个', price: 80, cost: 40 }, T);
  ok('商品A 创建', !!p1.id, 'id=' + p1.id);
  ok('商品B 创建', !!p2.id);

  // ---------- 2. 建客户 / 供应商 ----------
  console.log('\n=== 2. 建客户与供应商');
  const c1 = await call('POST', '/api/customers', { name: '测试客户' }, T);
  const s1 = await call('POST', '/api/suppliers', { name: '测试供应商' }, T);
  ok('客户创建', !!c1.id, 'id=' + c1.id);
  ok('供应商创建', !!s1.id, 'id=' + s1.id);

  // ---------- 3. 采购单：买 100 个 A（单价 30），50 个 B（单价 40）----------
  console.log('\n=== 3. 采购单');
  const po = await call('POST', '/api/orders/purchase', {
    partyId: s1.id, date: '2026-11-28',
    items: [
      { productId: p1.id, qty: 100, price: 30 },
      { productId: p2.id, qty: 50, price: 40 },
    ],
  }, T);
  ok('采购单创建', !!po.id, '单号=' + po.no + ' 状态=' + po.status);
  ok('采购单合计 5000', Math.abs(po.items.reduce((s, i) => s + i.qty * i.price, 0) - 5000) < 0.01);

  // ---------- 4. 审核 + 入库 ----------
  console.log('\n=== 4. 审核 → 入库');
  await call('POST', `/api/orders/purchase/${po.id}/approve`, {}, T);
  const inb = await call('POST', `/api/orders/purchase/${po.id}/inbound`, {}, T);
  ok('入库成功', true);

  let data = await call('GET', '/api/data', null, T);
  let A = data.data.products.find(x => x.id === p1.id);
  let B = data.data.products.find(x => x.id === p2.id);
  ok('商品A 库存 = 100', A.stock === 100, '实际=' + A.stock);
  ok('商品B 库存 = 50', B.stock === 50, '实际=' + B.stock);

  // ---------- 5. 销售单：卖 30 个 A（单价 50）----------
  console.log('\n=== 5. 销售单');
  const so = await call('POST', '/api/orders/sales', {
    partyId: c1.id, date: '2026-11-28',
    items: [{ productId: p1.id, qty: 30, price: 50 }],
  }, T);
  ok('销售单创建', !!so.id, '单号=' + so.no + ' 状态=' + so.status);

  // ---------- 6. 发货 + 完成 ----------
  console.log('\n=== 6. 发货 → 完成');
  await call('POST', `/api/orders/sales/${so.id}/ship`, {}, T);
  await call('POST', `/api/orders/sales/${so.id}/complete`, {}, T);

  data = await call('GET', '/api/data', null, T);
  A = data.data.products.find(x => x.id === p1.id);
  ok('商品A 库存 = 70（100-30）', A.stock === 70, '实际=' + A.stock);
  const so2 = data.data.sales.find(x => x.id === so.id);
  ok('销售单状态 = 已完成', so2.status === '已完成', '实际=' + so2.status);

  // ---------- 7. 收款 ----------
  console.log('\n=== 7. 收款');
  const acct = (data.data.accounts || [])[0];
  ok('资金账户存在', !!acct, acct ? acct.name : '');
  await call('POST', `/api/orders/sales/${so.id}/pay`, { amount: 1500, account: acct.id, date: '2026-11-28' }, T);
  data = await call('GET', '/api/data', null, T);
  const so3 = data.data.sales.find(x => x.id === so.id);
  ok('已收款 1500', Math.abs((so3.received || 0) - 1500) < 0.01, '实际=' + so3.received);

  // ---------- 8. 库存流水 ----------
  console.log('\n=== 8. 库存流水');
  const logs = data.data.stockLogs || [];
  ok('流水条数 >= 3', logs.length >= 3, '实际=' + logs.length);
  const inLog = logs.find(l => l.productId === p1.id && l.kind === '采购入库');
  const outLog = logs.find(l => l.productId === p1.id && l.kind === '销售出库');
  ok('商品A 有入库流水', !!inLog, inLog ? '数量=' + inLog.qty + ' 单号=' + inLog.ref : '');
  ok('商品A 有出库流水', !!outLog, outLog ? '数量=' + outLog.qty + ' 单号=' + outLog.ref : '');

  // ---------- 9. 财务报表 ----------
  console.log('\n=== 9. 财务');
  const fin = data.data.finance || [];
  ok('自动生成收款流水', fin.length >= 1, '条数=' + fin.length);
  const income = fin.filter(f => f.type === 'income');
  ok('收入合计 1500', Math.abs(income.reduce((s, f) => s + f.amount, 0) - 1500) < 0.01);

  console.log('\n=== 全部完成 ===');
  process.exit(0);
})().catch(e => {
  console.error('\n!! 失败:', e.message);
  console.error(e.stack);
  process.exit(1);
});
