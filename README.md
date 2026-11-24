# Lotus-Yunzai

基于 Bun 和 TypeScript 的云崽机器人宿主，支持终端、OneBot 11 和 Milky。

## 快速开始

安装 Git 和 Bun 1.4.4，克隆仓库后在仓库根目录执行：

```sh
bun run bootstrap
bun run start
```

`bootstrap` 一次完成子模块补拉与固定版本核对、依赖安装、管理面板构建、图鉴与主题素材及验证码模型准备。交互终端会询问尚未设置的选项；非交互首次安装默认选择最新版图鉴，也可在同一条命令指定 `bun run bootstrap live` 或 `bun run bootstrap latest`。已有设置和有效缓存会复用。初始化成功后直接启动，不需要另跑 `init`。

前台按 Ctrl+C 停止。Linux 或 macOS 安装 PM2 后，使用 `bun run start:bg` 后台启动，`bun run stop` 停止，`bun run logs` 查看日志，`bun run status` 查看后台状态。后台宿主就绪后异常退出会自动恢复。

输入 `#帮助` 获取使用手册链接，输入 `#状态` 查看运行状态。
