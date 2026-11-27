'use strict';
/**
 * 小林进销存 桌面窗口的 preload：只往前端暴露几个「我在原生窗口里」的标记，
 * 前端据此知道这是电脑版（工作台显示运行模式徽章、隐藏"在浏览器打开"之类的提示）。
 * 不开放任何 Node 能力，contextIsolation 保持开启。
 */
const { contextBridge } = require('electron');
const argv = process.argv;
const val = n => { const i = argv.findIndex(a => a === '--' + n); return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : ''; };

try {
  contextBridge.exposeInMainWorld('XerpDesktop', {
    shell: true,                                   // 前端可以据此判断"在 XLerp 桌面窗口里"
    mode: String(val('mode') || 'server').toLowerCase().startsWith('client') ? 'client' : 'server',
    version: process.env.npm_package_version || '',
  });
} catch (e) {}
