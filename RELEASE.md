# XLerp 2.14.5

轻量级自托管进销存 / ERP 首发版本。

## 下载

| 平台 | 文件 | 说明 |
|---|---|---|
| Docker（AMD64） | `xlerp-2.14.5-docker-amd64.tar.gz` | 群晖、威联通、Unraid、绿联、极空间、飞牛等 x86 NAS，`docker load` 导入 |
| Docker（ARM64） | `xlerp-2.14.5-docker-arm64.tar.gz` | 树莓派、ARM 架构 NAS |
| Windows | `xlerp-2.14.5-windows-x64-setup.exe` | Windows 10 / 11 64 位，双击安装，自带 Node.js |
| Android | `xlerp-2.14.5-android.apk` | Android 7.0 及以上 |
| 飞牛 fnOS | `xlerp-2.14.5.fpk` | 飞牛应用中心手动安装 |

也可以直接用镜像：`ghcr.io/desstg/xlerp:latest`

## Docker 快速开始

```bash
docker run -d --name xlerp --restart unless-stopped \
  -p 8686:8686 -v ./xlerp-data:/data \
  -e XERP_ADMIN_PASSWORD=你的初始密码 \
  ghcr.io/desstg/xlerp:latest
```

浏览器打开 `http://NAS地址:8686`，账号 `admin`，密码是上面设的（不设则 `admin123`，登录后请立刻改）。

离线镜像包：

```bash
docker load -i xlerp-2.14.5-docker-amd64.tar.gz
docker run -d --name xlerp --restart unless-stopped \
  -p 8686:8686 -v ./xlerp-data:/data ghcr.io/desstg/xlerp:latest
```

## Windows 安装

双击 `xlerp-2.14.5-windows-x64-setup.exe`，向导里设端口（默认 8686）和管理员密码。装入后以后台服务运行（任务计划程序「XLerp」，SYSTEM 身份开机自启），不用登录 Windows。数据在 `C:\ProgramData\XERP`，升级和卸载都不删。

局域网其他电脑访问 `http://本机IP:8686`。

## Android 安装

安装 `xlerp-2.14.5-android.apk`，手机连上和服务端同一个 Wi-Fi，首次打开填服务端地址或点「自动查找」。

> 如果之前装过别的包名的 XLerp，签名不同时需要先卸载再装（本版用 CI 临时证书签名）。

## ⚠️ 关于 Android 签名

本首发版本的 APK 由 CI 临时证书签名（未配置正式密钥）。**这意味着后续版本如果换了密钥，无法覆盖安装**，需要先卸载。

要长期升级，请在仓库 Settings → Secrets 里配置：

- `ANDROID_KEYSTORE_B64`：`release.jks` 的 base64
- `ANDROID_KEYSTORE_PROPS_B64`：`keystore.properties` 的 base64

本地生成方式：

```powershell
# 生成密钥
keytool -genkeypair -v -keystore release.jks -alias xerp -keyalg RSA -keysize 2048 -validity 10000
# 转 base64
[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks")) | Set-Content ks.txt
"storeFile=release.jks`nstorePassword=你的密码`nkeyAlias=xerp`nkeyPassword=你的密码" | Set-Content props.txt
[Convert]::ToBase64String([IO.File]::ReadAllBytes("props.txt")) | Set-Content props.b64.txt
```

把 `ks.txt` 和 `props.b64.txt` 的内容分别填进两个 Secret。**务必备份 release.jks**，丢了以后就没法覆盖升级。

## 功能

- 商品 / 库存 / 多仓库 / 批次保质期 / 序列号 / 多单位与包装条码
- 入库出库单、销售单、采购单、退货单，支持审核流程、自动发货、自动入库
- 盘点单、调拨单、收发存汇总、库龄分析、补货建议
- 客户供应商往来、应收应付、对账单、独立收付款
- 财务收支、报销审批、人事档案、统计报表
- 角色权限、操作日志、多公司多账套
- 手机端：开单、扫码、货品库存、明细、收支、盘点

完整功能列表见 [README](https://github.com/desstg/XLerp#功能)。

## 数据安全

- 数据全部存在本地 SQLite（容器 `/data` 或 `C:\ProgramData\XERP`），不上传任何服务器
- 每日自动备份，保留 30 天
- 支持 JSON 备份导出 / 导入
- 完全离线可用，不依赖外部服务

## 许可证

AGPL-3.0
