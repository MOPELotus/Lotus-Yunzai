# 固定旧版签到副本的执行与回接

此流程只用于独立、已停机的副本，一轮只处理北京时间当天已经到期、已确认未提交的范围。只需查看结果时使用默认预检。显式 `--execute` 会用副本档案完成旧版换票，并可实际发送其获授权的签到请求。演练应使用合成档案与隔离传输。

旧接收方来自 MOPELotus 的 Lotus-ReFactor，固定到 `5aa3a7058885e7879b4e9bb1fc6b89b28cbe3a1e`。本目录的补丁只用于副本接收，旧版本身继续适用其原有许可。

## 准备

1. 停止副本对应的新旧宿主，关掉它们的自动重启。保留原始数据副本。原机运行目录、新版代码所在目录与演练目录分别独立。
2. 在当前安装目录之外创建权限为 `0700` 的演练目录。从已有旧源码仓库独立克隆到 `legacy`，检出完整提交 `5aa3a7058885e7879b4e9bb1fc6b89b28cbe3a1e`，应用本仓提供的接收补丁，保留检出的 HEAD。
3. 把新版样本的 `data/users` 和 `data/schedules` 复制到 `modern/data`，把旧版样本的同名目录复制到 `legacy/data`。使用实际目录与普通文件，保留旧版当天历史以便识别已运行档案。无旧计划时保留空的 `legacy/data/schedules`。按旧仓库锁文件准备该副本的运行依赖。

```sh
reviewed_receiver_patch="$(pwd)/scripts/compat/lotus-refactor-5aa3a70-checkin-receiver.patch"
printf 'd8ffd99b7542987ad6eb8ff99f1c8e6d079eef85b35cdf9d7c862e54d834982c  %s\n' "$reviewed_receiver_patch" | sha256sum -c -
workspace="$(mktemp -d /var/tmp/lotus-checkin-transfer.XXXXXX)"
version=5aa3a7058885e7879b4e9bb1fc6b89b28cbe3a1e
git clone --no-local --no-hardlinks --no-checkout "$old_source_repo" "$workspace/legacy"
git -C "$workspace/legacy" switch --detach "$version"
git -C "$workspace/legacy" apply "$reviewed_receiver_patch"
mkdir -p "$workspace/modern/data/schedules" "$workspace/modern/data/users"
mkdir -p "$workspace/legacy/data/schedules" "$workspace/legacy/data/users"
cp -R "$modern_sample/data/users/." "$workspace/modern/data/users/"
cp -R "$modern_sample/data/schedules/." "$workspace/modern/data/schedules/"
cp -R "$legacy_sample/data/users/." "$workspace/legacy/data/users/"
if test -d "$legacy_sample/data/schedules"; then
  cp -R "$legacy_sample/data/schedules/." "$workspace/legacy/data/schedules/"
fi
```

从新版仓库根目录运行上述命令。将 `old_source_repo`、`modern_sample` 和 `legacy_sample` 分别设为已有的旧源码仓库路径和两份独立样本根目录。旧副本保持分离 HEAD 和补丁的三处未提交改动。命令会核对旧 Git 根、HEAD、三份文件摘要以及其他文件的工作区状态。

新版使用本仓 `packageManager` 固定的 Bun 版本。旧副本使用 `pnpm@10.12.4` 和检出提交的 `pnpm-lock.yaml`。先冻结安装，再用本仓的原生库恢复工具准备旧版 Skia。工具按旧包标记的版本下载对应平台构建并核对 SHA-256。以下命令从新版根目录运行。

```sh
(cd "$workspace/legacy" && pnpm install --frozen-lockfile --ignore-scripts)
LOTUS_CHECKIN_LEGACY_ROOT="$workspace/legacy" bun --no-env-file -e '
  import { pathToFileURL } from "node:url";
  import { recoverSkiaBinary } from "./scripts/skia-binary.ts";
  await recoverSkiaBinary(pathToFileURL(Bun.env.LOTUS_CHECKIN_LEGACY_ROOT + "/"));
'
```

离线副本应在联网环境提前完成以上两步。执行前在各自代码目录用 `bun --version`、`pnpm --version` 和 `git rev-parse HEAD` 对照固定版本。

## 预检、执行和回接

从包含新命令的新版代码目录执行下面第一条命令，核对 `profiles`、`forums`、`games`。预检没有任何签到网络请求。两边档案的账号或设置不一致、旧计划已有执行记录的项目保留在各自历史里。长久存放的历史计划仍可用 `prepare-legacy-checkin-schedule.ts` 只读预检。

```sh
today="$(TZ=Asia/Shanghai date +%F)"
bun --no-env-file scripts/run-legacy-checkin-transfer.ts "$workspace" "$today"
bun --no-env-file scripts/run-legacy-checkin-transfer.ts --execute "$workspace" "$today"
```

执行时同日调度互斥。旧轮次账放在演练根下的私有 `checkin-run-*` 目录，旧版原计划只读。命令返回 `executed` 表示已领取和对账的档案数。查看新版原副本的 `modern/data/schedules/<日期>.json`，只有回执证实未提交且仍在当日窗口的目标留在 `communityRetry` 里，现有调度会在 `nextAt` 接回。

遇到 `legacy-unconfirmed` 时保留账和原样本。先按当日官方签到状态核对未知项，再决定是否人工处理。直接重跑命令不会重新领取被冻结的档案。确认副本账后可正常重启其新版调度，已处理项目不会再次发写。整个流程只在演练根下执行。

## 网络来源

预检完全本地。执行由旧版账户和签到客户端调用其固定源码中的米游社接口，账号换票来自 `passport-api.mihoyo.com`，角色读取与多数国内游戏来自 `api-takumi.mihoyo.com`，绝区零来自 `act-nap-api.mihoyo.com`，社区状态与签到来自 `bbs-api.miyoushe.com`。入口使用 Bun 的 `fetch`，不加载机器人的代理配置或 `.env`。如需确认直连环境，可在命令前置下列清理。需要代理的环境按现用 Bun 的进程变量配置，并核对 HTTPS 代理及免代理规则来自这个副本进程。

```sh
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
    -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
    bun --no-env-file scripts/run-legacy-checkin-transfer.ts --execute "$workspace" "$today"
```
