# Debian 13 部署

本机 Mac 和 Debian 共用对局、恢复、语音和控制台逻辑。Mac 可以继续使用 ego；Debian 使用独立 Chromium，通过 `--browser-endpoint http://127.0.0.1:9222` 连接。服务在非 root 用户 `maji-soul` 下运行，root 只负责安装和管理服务。

截至 2026-11-13，ego(lite) 官方[下载页 FAQ](https://lite.ego.app/download)说明 Linux 仍在路线图中，尚无确定发布日期；[路线图](https://lite.ego.app/roadmap)也把 Linux support 列为 Planned。因此这里没有把第三方同名包或社区移植版当作官方 ego-browser 安装。Linux 的 Chromium 连接器是项目自己的适配器。

## 安装

在当前项目目录执行：

```sh
bash scripts/deploy/debian.sh root@192.168.1.2
```

脚本将源码部署到 `/opt/maji-soul`，安装依赖、下载并校验项目固定的 Node 版本、构建 Rust 引擎，启动 Xvfb、Chromium 和独立的 PipeWire 音频会话。Node 存放在 `/opt/maji-soul/runtime`，不依赖 root 的 nvm。首次安装要求服务器已有 Rust 1.93.1 或更新版本。`--prepare-only` 作为第二个参数可仅准备服务器运行环境，暂不安装 npm 依赖和构建引擎。

Xvfb 默认的 Mesa 渲染器可能被 Chromium 的 WebGL 黑名单禁用，表现为雀魂画布一直黑屏。安装器生成 `/etc/maji-soul/browser.env`：检测到 Intel 渲染设备及其 Vulkan ICD 时使用 ANGLE/Vulkan 硬件后端，否则使用 SwiftShader 软件后端；不会把 Intel ICD 路径强加给 ARM 或其他显卡。已有文件会保留，便于按主机调整。参考 Chromium [Linux 硬件渲染文档](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/using-gpu-hardware-in-headless-chrome.md)与 [SwiftShader 文档](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md)。两种模式均保留浏览器沙箱。

本次 Intel UHD630 已验证硬件驱动：`--use-gl=angle --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --disable-software-rasterizer`，并指定 `/usr/share/vulkan/icd.d/intel_icd.json`。软件模式可用于兼容检查，但本机实测只有约 3–4 fps，不适合流畅直播。首轮资源下载需要等待，不能只根据页面标题判断游戏已渲染完成。

部署保留远端数据、登录状态和私密配置，不复制 `.env`、本机数据库、Mac 原生二进制或整个 `.runtime`。只单独复制经过哈希校验的 `liqi.proto`、`liqi.json`。不要混用旧协议与新客户端版本；版本不匹配会阻止自动出牌。

首次部署后安全传入服务配置，或直接在服务器编辑 `/etc/maji-soul/app.env`：

```sh
ssh root@192.168.1.2 'umask 027; cat > /etc/maji-soul/app.env; chown root:maji-soul /etc/maji-soul/app.env; chmod 640 /etc/maji-soul/app.env' < .env
```

`FISH_API_KEY`、`FISH_REFERENCE_ID` 用于中文语音，模型字段用于讲解。B站直接弹幕需要额外的登录 cookie 文件与 `--bili-direct`，部署不会自动传输浏览器账号或 B站 cookie。服务默认启用语音；密钥缺失会明确启动失败，日志不会输出密钥。

直播参数在 `/etc/maji-soul/live.json`。样例中的 `roomId: pending` 是启动占位符，房间准备流程会读取实际房间号。`observeMs` 只是单次观察工作的分片时长，不是直播运行上限。

## 登录和打开控制台

首次必须在服务器浏览器登录雀魂。开启只绑定本机的 VNC，再建立 SSH 隧道：

```sh
ssh root@192.168.1.2 'systemctl start maji-soul-vnc.service'
ssh -N -L 5900:127.0.0.1:5900 -L 17361:127.0.0.1:17361 -L 17362:127.0.0.1:17362 root@192.168.1.2
```

通过 VNC 客户端连接 `127.0.0.1:5900` 完成登录。VNC 不直接开放给局域网，认证依赖 SSH 隧道。登录完成后可以关闭 VNC 服务，浏览器状态保留在 `/var/lib/maji-soul/chromium`：

```sh
ssh root@192.168.1.2 'systemctl stop maji-soul-vnc.service; systemctl enable --now maji-soul.service'
```

服务使用 `--auto-start --audio` 自动开启对局与干净画面转播。控制台地址由服务日志输出，通过上述隧道访问。干净画面为 `http://127.0.0.1:17362/obs`，OBS 覆盖层使用控制台输出的 `obsUrl`。HTTP 会校验 Host 和 Origin，所以隧道两侧端口必须一致；若本机端口被旧控制台占用，先停止旧进程，或同时修改服务端口和隧道两侧端口。

如需保留本机旧控制台，可在服务器 `/etc/maji-soul/console.env` 设置 `MAJI_CONSOLE_PORT=17363` 和 `MAJI_RELAY_PORT=17364`（每行一个），然后重启 `maji-soul.service`。对应使用 `-L 17363:127.0.0.1:17363 -L 17364:127.0.0.1:17364`。未配置此文件时仍使用默认端口。直接运行 CLI 时分别使用 `--port` 和 `--relay-port`，控制台预览、复制地址及访问规则会使用实际转播端口。

2026-11-13 再次核对 `root@192.168.1.2` 的实际配置为 `17361` / `17362`。需要重新连接时执行：

```sh
ssh -N -L 17361:127.0.0.1:17361 -L 17362:127.0.0.1:17362 root@192.168.1.2
```

随后打开 `http://127.0.0.1:17361/`；干净画面为 `http://127.0.0.1:17362/obs`，字幕为 `http://127.0.0.1:17361/obs`。隧道关闭不影响服务器继续运行。

可选角色模式在服务环境设置 `MAJI_AVATAR_ENABLED=true` 与 `MAJI_AVATAR_MODEL / MAJI_AVATAR_PROFILE / MAJI_AVATAR_CORE` 的远端路径，并在部署目录执行 `npm run build:avatar`。OBS 的角色源使用 `http://127.0.0.1:17361/avatar`；调试设置用 `?debug=1`，静音预览用 `?preview=1`。角色语音通过此页面在 OBS 所在机器播放；游戏音频仍遵循下节的远端音轨传输。完整配置见 [Live2D 使用说明](./USAGE.md#live2d-口播与-obs-角色源)，部署验证结果见[角色输出记录](./validation/live2d.md)。

## 音频与直播输出

Linux 使用 FFmpeg 的 `ffprobe` 验证合成音频、`ffplay` 播放。PipeWire 创建名为 `maji_live` 的虚拟输出设备；游戏和语音都送入此设备，采集其 `maji_live.monitor` 就能得到直播音轨。配置通过 `/etc/maji-soul/session.env` 设置，避免依赖桌面用户登录。

OBS 或推流器需要在服务器使用同一个音频会话。SSH 转发的是网页画面，不包含服务器播放的声音；在 Mac OBS 中打开转发的干净画面时，仍需另外传输服务器音轨。此部署不修改既有B站直播间、不包含推流密钥，也不自动开启公开推流。

验证虚拟音轨：

```sh
uid=$(id -u maji-soul)
runuser -u maji-soul -- env XDG_RUNTIME_DIR=/run/user/$uid PULSE_SERVER=unix:/run/user/$uid/pulse/native pactl list short sinks
runuser -u maji-soul -- env XDG_RUNTIME_DIR=/run/user/$uid PULSE_SERVER=unix:/run/user/$uid/pulse/native pactl list short sources
```

## 运维

```sh
systemctl status maji-soul.service maji-soul-browser.service maji-soul-display.service
journalctl -u maji-soul.service -n 100 --no-pager
systemctl restart maji-soul.service
systemctl stop maji-soul.service
```

开机先等待 Chromium 的 Unity 客户端脚本完成加载，避免把启动中的页面误判为版本不符。程序与浏览器意外退出由 systemd 重启；自动对局内部的监控负责暂停旧执行器、重新创建房间和恢复对局。人工停止服务不会被 systemd 自动重启。更新项目可重新运行部署脚本，再启动 `maji-soul.service`；不要在仍有旧执行器运行时手工启动第二份控制台。

全套本地验证可在服务器执行：

```sh
cd /opt/maji-soul
export PATH=/opt/maji-soul/runtime/bin:$PATH
npm run verify
npm run engine:test
```

日志由 journald 管理，SQLite 和运行证据保存在 `/opt/maji-soul/data`。持续运行仍应监测剩余磁盘空间，按业务需要保留和归档证据目录。
