# Lotus-Yunzai

Lotus-Yunzai 是用 Bun 和 TypeScript 开发的云崽机器人宿主。当前版本支持从终端和 OneBot 11 私聊、群聊发送 `#状态` 查询宿主运行状态。

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


## 接入 OneBot 11

在宿主的环境变量中设置 `LOTUS_ONEBOT_TOKEN`，再运行 `bun app.ts`。同一台机器上的 OneBot 11 客户端使用反向 WebSocket 的 Universal 模式，连接 `ws://127.0.0.1:25360/OneBotv11`，访问令牌与宿主相同。

`LOTUS_ONEBOT_PORT` 可修改监听端口，默认是 `25360`。宿主只监听本机地址。连接后，在群聊或私聊中发送纯文本 `#状态`。协议字段见 [OneBot 11 反向 WebSocket 规范](https://github.com/botuniverse/onebot-11/blob/master/communication/ws-reverse.md)。

## 插件

宿主启动时检查仓库根目录下的 `plugins/`。识别到已归并的旧插件、已登记的鸣潮插件或重复安装时，会在导入入口前写出拒载原因。可从包名、仓库来源及 `lotusYunzai.games` 识别插件。跨游戏插件应在 `games` 中声明所有提供的游戏功能。

目前可加载带 `lotusYunzai.entry` 的模块。例如在 `plugins/hello/package.json` 写入以下内容。

```json
{
  "name": "hello",
  "type": "module",
  "lotusYunzai": { "entry": "./index.ts" }
}
```

在同一目录建立 `index.ts`，由默认导出的 `commands` 提供指令。处理函数接收指令后的参数，可返回字符串或 `Promise<string>`。

```ts
export default {
  commands: {
    "#问候": (name: string) => `你好，${name || "朋友"}！`,
  },
};
```

### V3 消息插件

旧版云崽的 JS 插件可以放在 `plugins/`。目录包优先加载 `index.js`，支持导出的插件类和 `apps` 对象。没有 `index.js` 时，检查目录里的 JS 文件和 `apps/` 下的 JS 文件。也可以直接放入 `plugins/example/`，或者在 `plugins/` 放单个 JS 文件。

目前支持通过 `plugin` 注册普通文本消息规则、优先级和群主或群管理员权限，以及调用 `e.reply` 或 `this.reply` 回复消息。OneBot 支持文本、@、QQ 表情、图片、语音、视频和引用，可在同一次回复中混合使用。发送媒体时可传协议端能访问的文件地址或字节缓冲区。旧插件可使用全局 `segment` 构造消息段，宿主也接受 OneBot 的 `{ type, data }` 结构。管理员权限取自协议端提供的群身份，主人权限暂未开放。需要初始化、定时任务、Handler、合并转发或其他旧宿主接口的插件仍需适配。
