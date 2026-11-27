# 原生组件与兼容性

本文档说明项目原生依赖的 CPU 要求、检测与本机构建判断流程、各组件实际支持边界，以及私有构建缓存 `data/native-build` 的维护方式。

## 总体前提

- 运行时要求：项目锁定 `bun@1.4.4`。官方 x64 运行时最低要求 CPU 支持 `SSE4.2`（Nehalem 及以上），不要求 `AVX`；官方现行仅提供统一 x64 安装包，`baseline` 别名并非额外部署步骤（参见 [Bun CPU 要求](https://bun.sh/docs/installation/#cpu-requirements)）。无 `SSE4.2` 的更老 CPU（如单组件探针使用的 Conroe 模型）不受整项目运行支持。
- 现代机器零编译开销：在指令集兼容的现代机器上，初始化仅使用官方或发行预构建包，不会拉取或准备内部编译链（全新隔离环境下实测 `bun run bootstrap --build-only` 成功，Skia、Sharp、resvg、ONNX、Shotium、Rolldown 六个检测组件均选用预构建包，未触发 SDK 安装）。
- 触发时机与更新策略：原生检测仅在 `bun run init` / `bun run bootstrap`（含 `--build-only`）以及存在更新候选构建时执行。普通启动（`bun run start` / `bun run start:bg`）不会下载或编译原生依赖；不存在每 10 分钟通知任务，也不会在每次定时检查时重编组件。

## 判断流程

1. 执行位置：`bun run init` / `bun run bootstrap` 在同步子模块并完成 `bun install --frozen-lockfile` 后调用 `scripts/native-check.ts`，随后构建管理面板并继续运行资源初始化；`--build-only` 同样执行 `scripts/native-check.ts`，但跳过后续运行资源初始化。
2. CPU 特性采集：在 Linux 上读取 `/proc/cpuinfo` 并对所有 CPU 核心的特性取交集，日志记录架构 `x64` 与 `sse4_2`、`avx`、`avx2`、`bmi1`、`bmi2`、`fma` 标志。若环境不支持读取 `/proc/cpuinfo`，则以独立子进程实际探针结果为准，不臆造 CPU 特性。
3. 指令不兼容判定：仅将退出码 `132` / 信号 `-4`（`SIGILL`）以及明确的 `CPU ISA level is lower than required` 报错识别为指令集不兼容；普通运行错误、文件缺失或超时不会归类为 CPU 指令集问题。
4. 逐组件探测与策略重判：脚本对每个组件单独运行探针并在日志输出「预构建」或「本机构建」选择。对于已有旧包（如 TuneWeave 旧包），即便历史 `/healthz` 检测曾成功，也会按当前 CPU 策略重新判定。
5. 候选更新与超时控制：自动更新候选始终先完成探针验证，验证失败不会替换现有版本。普通构建阶段超时为 15 分钟；当更新流程需要执行源码编译时，构建阶段总超时允许延长至 8 小时。
6. 原子安装与摘要校验：
   - 具备本机构建路线的动态库在安装时先写入临时文件再原子替换，替换后若探针失败则自动恢复原文件。
   - Sharp 本机构建保留所有常用图像格式支持，并校验原生 binding 及私有共享库的 SHA 摘要。
   - TuneWeave 沿用原有升级替换与回滚流程；源码产物安装与发行包安装分别校验各自摘要，不拿源码产物去对比官方发行摘要。

## 组件支持边界与验收核对

| 组件 / 版本 | 自动本机构建路线（Linux x64 `glibc >= 2.28`） | 预构建 / 源码探针与边界说明 |
| :--- | :--- | :--- |
| TuneWeave（旧 Linux beta4） | 已接入 | 缺 `AVX2` 时切换源码构建；已有旧包即使 `/healthz` 成功仍按 CPU 策略重判。在 QEMU 用户态指定 CPU 模型实测中，Nehalem（无 AVX）与 SandyBridge（有 AVX 无 AVX2）运行旧包均 `SIGILL`，Haswell（AVX2）旧包真实视频查询成功；源码构建候选在无 AVX 环境完成真实视频查询后 `/healthz` 仍保持 `200`。 |
| Skia `4.0.1` | 已接入（源码要求 Rust `1.95`） | 预构建包在无 AVX 环境下探针通过，不会仅因缺少 AVX 直接判定为不兼容；源码构建候选在无 AVX 环境下 PNG 探针同样通过。 |
| Sharp `0.35.5`（含 `VIPS 8.18.7`、`CGIF 0.5.4`） | 已接入（同步重建 VIPS 与 CGIF） | 官方 Linux x64 预构建包要求 `SSE4.2`、`glibc >= 2.28`、`Node-API 9`（参见 [Sharp 安装说明](https://sharp.pixelplumbing.com/install/)），QEMU 用户态 Nehalem 模型通过。QEMU 用户态 Conroe（无 SSE4.2）运行旧包 `SIGILL`；源码重建 Sharp + VIPS 8.18.7 + CGIF 0.5.4 后在 Conroe 模型完成 PNG/JPEG/WebP/GIF/TIFF/AVIF 编解码、SVG、缩放、旋转与合成探针（仅作单组件指令探针，整项目 Bun 仍要求 `SSE4.2`）。 |
| resvg `2.6.2` | 已接入 | 预构建包与源码构建产物的 SVG 探针在无 AVX 环境下均通过。 |
| Rolldown `1.2.19` | 已接入（源码要求 Rust `1.99`） | 预构建包在无 AVX 环境下实际打包通过；源码 binding 已完成构建并在无 AVX 环境下加载通过。 |
| 托管 Valkey `8.1.12` | 已接入 | 外部配置（`LOTUS_VALKEY_URL`、`config/redis.yaml` 或 `config/config/redis.yaml`）及系统已有可用 `valkey-server` 均优先，不会为其准备自动编译 SDK。其他类 Unix 平台保留系统 `make`、`cc`、`tar` 源码尝试。 |
| ONNX Runtime `1.31.1`（`Node-API 6`） | **未启用** | 独立子进程实际 `MatMul` 推理在无 AVX 环境下通过。2026-11-27 本轮观察到官方 `microsoft/onnxruntime` 对应源码 URL 返回 404，不采用来源不明的 fork 替代，当前无自动源码配方。 |
| Shotium `0.13.0`（`Node-API 8`） | **未启用** | 通过 CPU 原生兼容层在无 AVX 环境下完成 HTML 截图探针。未接入自动源码配方，不将大型 Chromium 构建视为已验证路线。 |
| FFmpeg | **未启用** | 仍走现有工具安装器的版本与可执行检测（通用 `scripts/native-check.ts` 探针不覆盖 FFmpeg 所有编解码路径）；本轮另对官方构建源 `FFmpeg-Builds/FFmpeg-Builds` 发行包在无 AVX 环境下进行了音频处理与 `libx264`（H.264）编码实验并探针通过。当前无自动源码配方。 |

### CPU 指令探针与物理 GPU 视觉验收

- **CPU 指令探针**：上述老 CPU 型号（Conroe、Nehalem、SandyBridge、Haswell）及无 AVX 实验均通过 QEMU 用户态指定对应 CPU 模型，经独立子进程或实际调用路径完成，用于指令兼容性探针与软件渲染/推理/编解码验证，并非在真实老处理器硬件上完成验收，也不等同于 GPU 硬件加速验证。
- **物理 GPU 视觉验收**：针对 Skia `4.0.1`，除无 AVX 环境的 CPU 离屏 PNG 探针外，另在配备真实物理显卡（NVIDIA RTX A4000）的环境中通过 Vulkan 完成实际渲染并检查输出图像。

### 平台与未启用路线的限制

- **系统与架构边界**：自动编译 SDK 仅支持 **Linux x64（`glibc >= 2.28`）**。`musl`（如 Alpine Linux）、Windows 与 `arm64` 不支持该自动编译路线；这些平台原有的预构建包分发仍照常可用（Windows 不支持无现成 `valkey-server` 时的内置托管 Valkey）。
- **无源码路线的组件处理**：对于 ONNX Runtime、Shotium、FFmpeg 以及任何未纳入自动编译的组件或未来版本，若探针发现指令集或不兼容问题，初始化或更新检查会明确报错并阻止加载损坏的二进制包，不承诺所有架构或后续版本均可自动重编译。

## 编译工具链与 `data/native-build` 缓存维护

- **隔离目录与权限**：自动本机构建所需的源码、私有编译 SDK、依赖锁与构建 SHA 均保存在 `data/native-build` 中。流程不修改系统 `PATH` 或用户 shell 配置，不要求 `sudo`，也无需预先手动安装 Rust 或 Node。
- **依赖与工具链约束**：SDK 由共享的基础 Rust/C/C++ 工具链加上各组件的额外 profile（例如 Sharp 的图像格式构建依赖）组成，并非为各组件分别安装互不共享的最少包；Rust 版本直接从组件源码 `Cargo.toml` / `rust-toolchain.toml` 读取（Skia `4.0.1` 对应 `1.95`，Rolldown `1.2.19` 对应 `1.99`）。工具链 `sysroot` 固定为 `glibc 2.28`，避免启动文件引入 `x86-64-v3`，生成代码按 `x86-64` 基线编译并保留合法的运行时 CPU 分发优化。
- **缓存身份校验与迁移行为**：缓存键同时校验组件版本、源码 SHA、主机 CPU 指令集与系统 libc 族身份、依赖锁、SDK 路径身份及产物 SHA。
  - 源码模式按主机指令集和 libc 族记忆：日常软件更新会保留本机构建状态，在已有对应源码配方且条件满足的前提下，已走本机构建的组件在升级版本时继续沿用本机构建（不承诺所有未来版本均能自动编译）；若更换到不同特性 CPU 会重新判定。
  - SDK 环境绝对路径已纳入缓存身份校验：将整个项目目录迁移至新路径后，不会复用旧绝对路径下的 SDK 环境。
- **清理注意事项**：本机构建产物通过 `rpath` 依赖 `data/native-build` 中的私有动态库。**切勿在服务运行期间删除 `data/native-build`**。如需清理缓存，请先通过 [运维管理](operations.md) 停止服务，再删除 `data/native-build`，并重新执行 `bun run init` 恢复后再启动。
