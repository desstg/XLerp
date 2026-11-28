// 生成「单机版 index.html」：把 index.html + 单机模块全部内联成一个自包含文件
//
// 为什么需要：
//   手机 App 单机模式用 file:///android_asset/index.html 加载界面。
//   file:// 协议下 <script src="local/xxx.js"> 能加载，但 fetch('/api/...') 会失败；
//   更重要的是 WebView 的 file:// 对相对路径和 CORS 有限制，内联最稳。
//
// 做什么：
//   1) 把 <script src="local/*.js"></script> 五行替换成内联 <script>…</script>
//   2) 把 <script src="vendor/*.js"> 也内联（离线时拿不到 /vendor/）
//   3) 输出到 dist/standalone/index.html，供 APK 打包进 assets
//
// 用法：node tools/build-standalone.mjs
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, 'dist', 'standalone');

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
const report = [];

/** 把 <script src="x"></script> 换成内联脚本 */
function inlineScript(tag, relPath) {
  const full = path.join(SRC, relPath);
  if (!fs.existsSync(full)) throw new Error('找不到 ' + relPath);
  const code = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
  report.push([relPath, code.length]);
  // 防止内联代码里的 </script> 提前闭合标签
  const safe = code.replace(/<\/script>/gi, '<\\/script>');
  return `<script>/* ${relPath} */\n${safe}\n</script>`;
}

// 单机模块（顺序不能变：shim → sqlshim → db → server-local → boot）
// index.html 里现在是「按需加载」的探测脚本（服务器模式下不下载这 320 KB），
// 单机版永远要这些模块，所以这里直接把整段探测脚本替换成内联实现。
const localFiles = ['local/shim.js', 'local/sqlshim.js', 'local/db.js', 'local/server-local.js', 'local/boot.js'];
const probeRe = /\<script\>\s*\(function \(\) \{\s*\/\/ 和 local\/boot\.js[\s\S]*?\}\)\(\);\s*\<\/script\>/;
if (!probeRe.test(html)) throw new Error('index.html 里找不到单机模块的按需加载脚本');
const inlined = localFiles.map(f => inlineScript(null, f)).join('\n');
html = html.replace(probeRe, () => inlined);

// 第三方库（图表、Excel）：离线也要能用
const vendorFiles = ['vendor/chart.umd.min.js', 'vendor/xlsx.full.min.js'];
for (const f of vendorFiles) {
  const re = new RegExp(`<script src="${f.replace(/[/.]/g, m => '\\' + m)}"></script>`, 'g');
  if (re.test(html)) html = html.replace(re, () => inlineScript(null, f));
}

// 标记：这是单机版资源，boot 时默认进单机模式
html = html.replace(
  /<head>/i,
  '<head>\n<script>window.XERP_STANDALONE_ASSET = 1;</script>'
);

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, 'index.html');
fs.writeFileSync(outFile, html, 'utf8');

// xlsx（881 KB）不内联进 HTML，单独放在旁边按需加载：
// 只有导出/导入 Excel 时才需要，内联会让首屏多解析 881 KB。
// 单机模式里 loadXLSX() 会请求同目录的 xlsx.full.min.js（见 index.html）。
const xlsxSrc = path.join(SRC, 'vendor', 'xlsx.full.min.js');
if (fs.existsSync(xlsxSrc)) {
  fs.copyFileSync(xlsxSrc, path.join(OUT_DIR, 'xlsx.full.min.js'));
  report.push(['vendor/xlsx.full.min.js（独立文件）', fs.statSync(xlsxSrc).size]);
} else {
  console.warn('  警告：找不到 src/vendor/xlsx.full.min.js，单机模式导出 Excel 会失败');
}

console.log('生成 ' + path.relative(ROOT, outFile));
for (const [f, n] of report) console.log(`  内联 ${f}  ${(n / 1024).toFixed(1)} KB`);
console.log(`  总大小 ${(html.length / 1024 / 1024).toFixed(2)} MB`);
