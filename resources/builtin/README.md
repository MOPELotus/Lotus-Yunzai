# 内置运行资源

这里存放机器人默认出图及业务计算所需的公共原始资源，包含背景、字体、图标、角色与装备基础数据、别名、卡池历史和原模板依赖。默认运行不要求旧插件、生产目录或额外主题目录。

- `core/`：登录、档案、签到、体力推送及共享中文与 emoji 字体。
- `games/`：三游面板、抽卡、养成、背包、货币战争、转生所需公共数据和图片。
- `social/`：群设置、点赞、公告、攻略帮助与订阅帮助资源。
- `system/`：状态卡的原 Yenai 公共素材。
- `templates/`：图鉴、体力便笺、调频和星铁挑战固定资源。

各组 SOURCES / sources 文件记录来源仓库、固定提交、原路径、大小与摘要；许可证随组保留。没有复制生产账号、Cookie、个人头像缓存、订阅记录或私有配置。用户显式指定的资源目录仍优先使用。

`manifest.json` 同时覆盖本目录和各插件已有的公共 resources。`bun run bootstrap` 对清单逐件验证大小及 SHA256，缺失或损坏即失败，不再将固定资源缺失降为警告。维护资源时，核对来源与许可证后运行 `bun scripts/update-builtin-resource-manifest.ts` 更新清单，再运行 `bun scripts/verify-builtin-resources.ts`。
