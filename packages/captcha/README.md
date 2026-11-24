# 本地验证码识别

从 Lotus-Captcha 的本地引擎迁入的 TypeScript 模块，直接由宿主内部调用，不监听端口，不需要独立服务或配置文件。

`prepareCaptchaModels()` 由宿主整体初始化调用，下载并校验 `resources/models.json` 声明的固定模型，缓存于主仓 `data/captcha/models/`。日常识别仅使用已初始化缓存，不在业务处理中下载模型。

`createLocalCaptchaSolver()` 构造时不启动线程或加载推理库；第一次 `solve(challenge, signal)` 才惰性创建 Bun 运行的 TypeScript worker。单次只执行本地协议与识别，不再叠加提供方重试。宿主统一处理五次节点预算、两轮回退及业务二次校验。并发占用时返回 `captcha_busy`，取消会中断任务并回收线程；关闭时释放推理会话和线程。

来源固定版本见 `UPSTREAM.json`，原始来源及许可见 `NOTICE`、`LICENSE`、`licenses/` 与 `third_party/`。未迁入源项目的 HTTP 服务、CLI、TTOCR/人工客户端和重复重试编排。模型本体不提交到仓库。
