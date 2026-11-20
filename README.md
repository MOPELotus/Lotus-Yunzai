# Lotus-Yunzai

基于 Bun 和 TypeScript 的云崽机器人宿主，支持终端和 OneBot 11。

## 快速开始

安装 Git 和 Bun 1.4.4，克隆仓库后在仓库根目录执行：

```sh
bun run bootstrap
bun run start
```

首次启动选择最新版或正式版图鉴，下载需要 Node.js 和 Corepack。无终端时先运行 `bun run init latest` 或 `bun run init live`。

前台按 Ctrl+C 停止。Linux 或 macOS 安装 PM2 后，使用 `bun run start:bg` 后台启动，`bun run stop` 停止，`bun run logs` 查看日志，`bun run status` 查看后台状态。

输入 `#帮助` 查看系统指令，输入 `#状态` 查看运行状态。
