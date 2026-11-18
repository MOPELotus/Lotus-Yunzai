# Lotus-Yunzai

Lotus-Yunzai 是用 Bun 和 TypeScript 开发的云崽机器人宿主。当前版本支持从终端和 OneBot 11 私聊、群聊发送 `#状态` 查询宿主运行状态。

## 安装与启动

安装 Git 和 Bun 1.4.4。通过 Git 克隆本仓后，在仓库根目录运行：

```sh
bun scripts/bootstrap.ts
bun app.ts
```

初始化脚本会检出主仓固定的子模块版本，再根据锁文件安装依赖。输入 `#状态` 查看运行状态，输入 `#帮助` 查看系统指令。按 `Ctrl+D` 退出，也可以用管道输入指令：

```sh
printf '#状态\n' | bun app.ts
```

安装完成后，可运行 `bun run typecheck` 单独检查 TypeScript 类型。


## 接入 OneBot 11

在宿主的环境变量中设置 `LOTUS_ONEBOT_TOKEN`，再运行 `bun app.ts`。同一台机器上的 OneBot 11 客户端使用反向 WebSocket 的 Universal 模式，连接 `ws://127.0.0.1:25360/OneBotv11`，访问令牌与宿主相同。

`LOTUS_ONEBOT_PORT` 可修改监听端口，默认是 `25360`。宿主只监听本机地址。连接后，在群聊或私聊中发送纯文本 `#状态`。协议字段见 [OneBot 11 反向 WebSocket 规范](https://github.com/botuniverse/onebot-11/blob/master/communication/ws-reverse.md)。

## Valkey 存储

需要持久化的部署可设置 `LOTUS_VALKEY_URL`，例如 `redis://127.0.0.1:6379/0`。连接带认证的实例时，建议从本机环境加载地址，避免把凭据写进仓库。宿主在加载插件前连接配置的服务，关闭时等插件清理完成再断开。未配置地址时，终端和 OneBot 的基础指令仍可运行。

新模块从 `@lotus-yunzai/storage` 导入 `storage("模块名")`，可读取、写入和删除字符串，设置秒级 TTL，或用 `write()` 在一次事务内提交多笔写入。键使用 `lotus-yunzai:<模块名>:` 前缀。启用了 Valkey 时，依赖全局 `redis` 的旧插件可访问原有键空间及 Redis 事务接口。

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

目前支持通过 `plugin` 注册普通文本消息规则、优先级和群主或群管理员权限，以及调用 `e.reply` 或 `this.reply` 回复消息。OneBot 支持文本、@、QQ 表情、图片、语音、视频和引用，可在同一次回复中混合使用。发送媒体时可传协议端能访问的文件地址或字节缓冲区。旧插件可使用全局 `segment` 构造消息段，宿主也接受 OneBot 的 `{ type, data }` 结构。接收 OneBot 消息段数组时，`e.msg` 是合并后的文本，`e.message` 保留扁平消息段。插件可用 `e.atBot`、`e.at`、`e.reply_id` 和 `e.img` 查看 @、引用和图片。若协议端把整条消息发成字符串，宿主按原文本处理。管理员权限取自协议端提供的群身份，主人权限暂未开放。插件可用 `init()` 初始化资源，并通过 `this.addCleanup(callback)` 注册清理操作。宿主会在初始化失败、`init()` 返回 `"return"` 或关闭时，按相反顺序执行清理回调。终端模式在标准输入结束时关闭，OneBot 模式会继续监听，直到收到 SIGINT 或 SIGTERM。

插件可在构造参数中声明 `handler: [{ key, fn, priority }]`，也可导入 `lib/plugins/handler.js` 的默认导出，并在 `init()` 或插件回调中注册和调用。数字越小越先执行。回调收到 `(e, args, next)`，调用 `next()` 后会继续查找下一个处理器。`Handler.callAll()` 会执行该键下的所有处理器。注册由宿主在插件跳过、加载失败或退出时清理。旧的 `mys.req.err` 键保留给内置服务。

插件可通过 `task` 声明一个任务对象或数组。任务的 `cron` 支持五段（从分钟开始）或六段（从秒开始），使用宿主进程的时区。`fnc` 可以是函数或插件方法名。同名同 cron 的任务只调度一次，上一次执行尚未结束时跳过本次触发。宿主停止时先取消后续触发，等待运行中的任务结束后再清理插件。

需要合并转发或其他旧宿主接口的插件仍需适配。
