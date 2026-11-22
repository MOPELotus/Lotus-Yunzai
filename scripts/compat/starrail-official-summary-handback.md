# 星铁官方汇总的离线交还

仅适用旧 Lotus-ReFactor `e28c6df` 与 `5aa3a70` 和 Lotus-Yunzai 的 v1 官方小程序汇总。旧版从插件自身 `data/starRailGachaJson/<QQ>/<UID>.json` 读取，现代版从宿主同名数据目录读取。六池、档案、国服区服和精确 ID 都须一致。真实逐抽档继续用 `prepare-legacy-star-rail-gacha.ts`。

## 交给旧版

先停止两侧该档的写入和自动同步。核对两侧所选已登录档案的账号、QQ、UID、档案槽和区服，分别准备完整的官方汇总根副本。保留一份实际将交给旧端的现代文件原件直到重新接管。

```sh
bun --no-env-file scripts/prepare-legacy-star-rail-summary.ts to-old ./old-summary ./modern-summary "$qq" "$uid" "$region"
bun --no-env-file scripts/prepare-legacy-star-rail-summary.ts to-old --export ./out ./old-summary ./modern-summary "$qq" "$uid" "$region"
```

准备命令本身只在现存的独立导出目录写文件。输出文件名包含其 SHA-256，权限为 0600。首次向没有此记录的旧档交还时，可直接保留并复制已核现代原件，无需制造旧空档。确认实际旧副本目标仍与基准摘要一致，再应用导出文件。旧版当前可以直接读原字节。如果旧端要继续刷新，保留现代原件供交回恢复。

## 交回新版

停止旧侧刷新及新版写入。以之前交出的原样现代文件为基准，以本轮停止后的旧文件为续写副本。

```sh
bun --no-env-file scripts/prepare-legacy-star-rail-summary.ts to-modern ./handoff-baseline ./continued-old-summary "$qq" "$uid" "$region"
bun --no-env-file scripts/prepare-legacy-star-rail-summary.ts to-modern --export ./out ./handoff-baseline ./continued-old-summary "$qq" "$uid" "$region"
```

成功时保留两个阶段已有五星、旧端新增记录和累计，已核时刻由交还前原件恢复。旧版把未知 UP 写成 `false` 时，恢复原来的未知。两侧都停止，且新版实际目标仍保持基准摘要时，才能人工把结果放入新版路径并恢复写入。原件与输出继续分离。

操作会拒绝不同账号、同一档两边分叉、计数倒退、标识冲突、明确时间或 UP 冲突及可能含凭据的异常文件。此时保留两份，核对同档官方记录后再处理。聚合累计不能把两分支机械相加。
