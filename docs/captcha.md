# 验证码

机器人遇到已支持的米游社风险挑战后，依次使用内置本地识别、配置的 TTOCR、人工验证页。两个自动节点每轮分别最多尝试 5 次，人工节点每轮最多一个链接，整条链最多 2 轮。未启用、未配置、额度不足或处于冷却期的节点会跳过。

每次识别或业务明确拒绝后，下一次尝试重新获取挑战。v3 的 challenge、validate 和 v4 的 lot_number 均不复用。身份失效、账号风险码 10041、请求限频、网络故障和业务写入结果不明会停止续交。验证证明仍须由原业务接受；页面显示已提交不等于签到或兑换成功。

## 自动验证配置

本地识别随机器人一起安装，默认启用。遇到验证码时直接内部调用，不需要启动识别服务、配置端口或填写本地地址。

如需调整开关或使用 TTOCR，在 `config/global.yaml` 配置，重启机器人生效：

```yaml
captcha:
  enable: true
  providers: [local, ttocr, manual]
  local:
    enable: true
    timeout_ms: 120000
  ttocr:
    enable: false
    key: ''
    api: http://api.ttocr.com/api/recognize
    resapi: http://api.ttocr.com/api/results
    itemid: 388
    itemid_v4: 488
    timeout_ms: 60000
    poll_interval_ms: 2000
  manual:
    enable: true
```

默认启用本地节点，TTOCR 需要填写自己的 key。`providers` 可调整顺序或移除不使用的节点；旧名称 `test_nine`、`gtmanual` 分别映射到 `local`、`manual`。旧本地 `endpoint` 字段不再使用。

本地识别器取自 [Lotus-Captcha](https://github.com/MOPELotus/Lotus-Captcha) 的 v3/v4 协议、识别算法和必要资源，已移入 `packages/captcha`。无需另行克隆该仓库、安装识别服务或维护第二份配置。

模型在整体初始化阶段下载：统一执行 `bun run bootstrap` 会完成整体初始化并检查所有运行模型，下载缺失文件并按固定大小及 SHA256 校验，保存在 `data/captcha/models/`。已有有效缓存直接复用。主人发送 `#初始化环境`（兼容 `#初始化工具环境`、`#初始化签到环境`）也会准备模型。

正常处理验证码时只读取本地模型，不启动下载。缺少模型会进入现有有限重试与回退，并可重新执行整体初始化补齐。计算在机器人内部按需启动的 worker 中执行，取消和停机时释放；没有本地 HTTP 中转。每次调用只执行一次本地识别，五次尝试与两轮回退统一由宿主控制。业务提供的 v4 `risk_type` 原样传入。

TTOCR 的 v3 使用项目 388，v4 使用 488；v4 表单中的 `gt` 是 `captcha_id`，同时传递完整 `ts_risktype`。轮询间隔至少 2 秒，同一结果 ID 串行查询。4039 表示本题连接主机或代理失败，会结束该题；明确 IP 封禁会让本进程内的 TTOCR 冷却 30 分钟，其他节点继续。key 和服务原始响应不进入用户通知或重试日志。

## 人工验证配置

在 `config/server.yaml` 的现有 HTTP 或 HTTPS 监听配置中填写：

```yaml
captcha:
  url: https://你的验证域名
```

验证码与主服务可使用不同域名，例如：

```yaml
url: https://bot.example.com
panel_url: https://bot.example.com
captcha:
  url: https://gt.example.com
```

两个域名均可反代到同一个 HTTP 监听端口；验证码域名须转发 `/captcha/manual/` 路径。`url`、`panel_url` 和 `captcha.url` 分别控制主服务、面板与人工验证的外部链接。

也可使用 `LOTUS_CAPTCHA_PUBLIC_URL` 覆盖。公开地址必须为 HTTPS，本机回环测试允许 HTTP。反向代理需要保留公开域名的 Host，并转发 `/captcha/manual/`；公开地址包含额外路径时，代理应先剥去这段额外路径。

人工页面与机器人共用监听端口，不需要启动独立 GT-Manual 服务。链接默认 180 秒有效，点击开始后只认领一次，终态结果领取后删除。取消原操作、账号变化或进程重启都会使旧操作无法继续。页面只取得验证参数，不取得账号 Cookie；创建任务和领取结果的内部接口不对公网开放。

验证码通知只发给档案所属 QQ 的好友私聊，或者原业务明确提供的本人通知入口，不发送到群。没有可用通知入口时，自动节点仍可工作。商城后台预约和追踪只运行自动节点；网页即时兑换可以使用人工页面，后续链接不会延长首次人工等待期限。

## 适用业务

- 原神、星铁、绝区零国服签到的内嵌 v3：重新获取签到挑战，回填三项请求头，回读签到状态。
- 三游戏国际服签到的内嵌 v3：保留原活动、国际服凭据和设备，回到原签到接口。
- 社区签到和任务状态：使用该账号的社区 misc 验证接口，再继续原分区动作。
- 已登记的体力、战绩及 tool 读取：保留原请求路径、原响应 trace、游戏和设备，先完成对应业务二次校验再续读。
- 米游币商城 v4：先将极验证明提交给商城校验接口，得到业务 challenge 后复核商品及会话，最多续交一次原兑换请求。

Passport 登录、前瞻自动兑换、未核实的游戏活动和任意外装插件请求不使用这条链。外装 V3 的 `mys.req.err` 不能提供可信档案上下文时继续拒绝接管。

模拟接口测试覆盖重试、换题、二次校验、取消和账号隔离；真实服务是否接受证明仍需从自然触发风控的原业务验证。
