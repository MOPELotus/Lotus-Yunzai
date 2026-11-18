# Lotus-Yunzai

Lotus-Yunzai 是用 Bun 和 TypeScript 开发的云崽机器人宿主。当前版本可从终端输入指令，查询宿主运行状态。

## 安装与启动

安装 Bun 1.4.4，然后在仓库根目录运行：

```sh
bun scripts/bootstrap.ts
bun app.ts
```

输入 `#状态` 并按回车查看状态。按 `Ctrl+D` 退出，也可以用管道输入指令：

```sh
printf '#状态\n' | bun app.ts
```

安装完成后，可运行 `bun run typecheck` 单独检查 TypeScript 类型。
