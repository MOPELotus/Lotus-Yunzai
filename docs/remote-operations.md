# 远程运维

Linux 宿主可以在绑定机器人的主人好友私聊中，通过 TOTP 执行运维命令或收发文件。服务默认关闭。

在运行宿主的系统用户自己的私用终端中，进入 Lotus-Yunzai 目录，运行 `bun --no-env-file scripts/remote-otp.ts setup`。使用支持 TOTP 的验证器扫描终端二维码。更换验证器时运行同一脚本的 `reset`。凭据保存在 `data/remote-auth/`，仅该系统用户可以访问。

完成配对后，可在管理面板的「业务设置 → 远程运维」管理启停、超时、Shell 白名单和上传覆盖。也可直接修改 `config/remote.yaml`：

```yaml
enable: true
shells: [sh, bash, zsh]
timeout_ms: 30000
allow_admin: false
allow_overwrite_upload: false
```

将下列命令中的 `<验证码>` 替换为验证器显示的六位数字。每个验证码仅能完成一次授权。

| 私聊命令 | 行为 |
| --- | --- |
| `#远程2FA状态` | 查询本机配对状态 |
| `#远程spawn <验证码> sh uptime` | 以宿主身份运行已启用的 Shell |
| `#远程管理员spawn <验证码> sh uptime` | 仅在显式启用且宿主本来就是 root 时运行 |
| `#远程下载 <验证码> example.txt` | 发送 `data/remote/files/example.txt` |
| `#远程上传 <验证码> example.txt` | 从本条消息附件写入文件 |
| `#远程上传覆盖 <验证码> example.txt` | 用本条消息附件原子替换文件 |

上传要求 OneBot 或 Milky 在该条消息中提供文件附件。目标目录须事先建立，且从工作区到运维文件的目录均须为真实目录，单个文件上限 16 MiB。提示文件发送结果未确认时，先查看当前私聊再决定是否重发。运维命令可以访问宿主系统用户本来有权访问的文件和进程。下载和上传只可访问运维文件目录。授权记录保存在 `data/remote-auth/operations.jsonl`，包含时间、操作类型、使用协议和发起账号。
