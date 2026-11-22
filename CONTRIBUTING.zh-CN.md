[English](CONTRIBUTING.md) · **中文**

# 维护者手册

本仓库负责构建与发布容器镜像 `ghcr.io/meixu6693/dsh`。**Unraid 那一侧**——Community
Applications 模板、图标、CA 提交说明与迁移指南——在
[MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid)。本仓库不得依赖那个仓库：
镜像必须能独立构建与发布。

面向用户的文档是 [README.md](README.md)（中文，默认）与 [README.en.md](README.en.md)
（英文）；两者保持一致，改一个就同步另一个。`scripts/check-docs.mjs` 负责机器能查的那部分：
锚点与相对链接必须能解析、`*.zh-CN.md` 必须链到对应的中文页、同一文档的两条语言轨必须有
相同数量的 `##` 章节与相同的设置名。

## 仓库结构

```
.
├── Dockerfile                 # 三阶段构建：DSH 依赖 → Caddy 二进制 → 运行时
├── docker/
│   ├── entrypoint.sh          # 校验环境变量、准备卷、选模式、拉起 Caddy + DSH
│   ├── Caddyfile.edge         # 设置了 PUBLIC_URL：把 Host 改写成对外 authority，拒绝外来 Origin
│   ├── Caddyfile.lan          # PUBLIC_URL 为空：把 Host 固定为回环，剥掉 Origin
│   ├── Caddyfile.common       # 两种模式共用的响应压缩
│   └── healthcheck.sh         # 容器 HEALTHCHECK
├── compose.yaml               # 非 Unraid 用户：与 CA 模板同一套设置
├── scripts/                   # 版本解析、依赖瘦身、静态闸门、冒烟测试
├── docs/                      # 安全模型、沙箱、远程登录、整体结构、扩展
└── .github/workflows/         # validate（每次 push）+ release（跟随上游发版）
```

## 本地构建与自检

```bash
# 构建（版本号来自 npm，见下）
docker build \
  --build-arg DSH_VERSION=0.2.1-alpha.4 \
  --build-arg NODE_VERSION=24.21.0 \
  --build-arg CADDY_VERSION=2.11.7 \
  -t dsh:local .

# 冒烟：真的起容器，断言 /healthz、口令门禁、远程登录、令牌引导、跨站 403、
# 两份 Caddy 配置与 bwrap 沙箱
bash scripts/smoke.sh dsh:local

# 静态闸门：与 CI 完全一致（语法、文档闸门，以及所有 YAML/JSON 的结构正确性）
bash scripts/check-static.sh
```

> `check-static.sh` 的结构校验需要 `python3`。本机没有时用
> `ALLOW_MISSING_PYTHON=1 bash scripts/check-static.sh` 跳过该段——**CI 里不允许跳过**，
> 那里缺 python3 直接失败。

## 上游版本是怎么定的

```bash
node scripts/resolve-dsh-version.mjs --json
node scripts/resolve-dsh-version.mjs --version=0.2.1-alpha.4
```

**不要只看 npm 的 `latest` 标签。** 实测：`@deepseek-ai/dsh` 的 `latest` 落后于 `alpha`
（2026-10-15：`latest`=`0.2.0-rc.2`、`alpha`=`0.2.1-alpha.3`），只看 `latest` 的流水线会**静默降级**。
脚本枚举所有已发布版本并按 semver 取最高者，预发布版按规范参与比较。

## 发布

| 工作流 | 触发 | 做什么 |
|---|---|---|
| `validate` | 每次 push / PR | 静态闸门 + shellcheck + hadolint + `caddy validate` + 脚本端到端 |
| `release` | 每小时 :17、触及镜像的 push、手动 | 解析版本 → **静态闸门** → 构建 amd64 → 冒烟 → 推送 amd64+arm64（首次 `:<版本>`、后续 `:<版本>-r<N>`；`:latest`、`:<通道>`）→ 建独立构建 tag 与 Release |

首次构建完全使用上游版本：镜像 `:0.2.1-rc.4` 与 Release `dsh-v0.2.1-rc.4`。
第二次追加 `-r1`，第三次追加 `-r2`；DSH 升版后重新从不带后缀开始。组件更新或强制重建
递增计数。内部 `DSH_REVISION` 从 1 开始计数，因此后缀数字等于构建计数减一。
下个计数取该 DSH 版本已记录的最大构建计数加一，按数字排序，包含草稿以避免冲突。
创建 Release 记录之前失败不消耗计数；所有分支的发布任务串行执行。
历史不带后缀的 Release 视为首次构建；缺少组件元数据时发布新的 `-r1`，保留历史记录。

**闸门是共用的**：`release` 的 verify 步骤跑的就是 `validate` 用的那个 `scripts/check-static.sh`，
所以**检查不过的提交什么都发不出去**（publish 与 release 两个 job 直接跳过）。两者曾经各自独立，
结果红色提交照样能发布——不要改回去。

手动发布：Actions → `release` → *Run workflow*。

| 输入 | 说明 |
|---|---|
| `version` | 留空 = 自动解析最高版本；也可以指定确切版本 |
| `force` | 勾选 = 即使全部组件版本未变，也发布下一个构建序号 |

只有所选 DSH Release 已记录相同的 DSH、Node、Caddy 和远程登录插件版本时，才跳过构建。
缺少组件元数据的历史 Release 会触发新的 `-r1` 构建。`force=true` 可在版本全未变时重建，例如发布代理
配置修复；它不会禁用 Docker 层缓存。只改文档的 push 不触发 release。

## 组件版本策略

| 组件 | 发版时如何选择 |
|---|---|
| DSH | 已发布的最高 semver（含预发布），或手动 `version` 输入 |
| Node | 上游 `engines.node` 指定的精确版本；版本范围或缺失时使用 `DEFAULT_NODE_VERSION=24.21.0` |
| Caddy | `caddyserver/caddy` 最新稳定 GitHub Release，必须具备 Linux amd64 与 arm64 安装包 |
| 远程登录插件 | `MeiXu6693/dsh-remote-signin` 的最高稳定 semver Git tag，排除预发布 tag（该项目目前未发布 GitHub Release） |
| pnpm | Dockerfile 的 `PNPM_VERSION=12`，安装层执行时在主版本 12 内选择 |
| 系统包与 npm 间接依赖 | 安装层执行时从软件源解析；命中构建缓存可能保留旧结果 |

`scripts/resolve-component-versions.mjs` 每次发版只解析一次组件版本，将相同精确值传给
验证和发布。API 错误或 Caddy 安装包不完整时停止，不静默回退旧版本。静态检查、两种模式
的代理断言和完整镜像冒烟通过后才发布；上游接口变化因此可能阻止自动更新，需先修复兼容性。

Release 说明记录组件版本及供下次比较的 `dsh-build-inputs` 标记，编辑说明时应保留该标记。
每次成功发布新建构建标签及指向工作流提交的 Release，不编辑旧构建 Release、不移动已有
Git tag。不带后缀的 DSH 镜像标签保留首次构建，只有 `latest` 与通道标签是移动别名。固定版本标签或
镜像 digest 可复现部署；拉取镜像并重建容器后更新才生效。`/etc/dsh-version` 也记录构建序号。


体积较大的运行层排在版本化应用文件之前；使用 linked COPY，使应用或 Caddy 文件未改变时
可在父层变化后复用其层。CI 构建两个构建序号，检查仅元数据层改变。首次切换新布局时可能
需要一次性下载新层；Node 基础镜像、应用或组件变化、本地清理旧层或冷构建仍可能产生大量
下载。层复用不保证包含安全更新：需要时强制刷新依赖，并保持正常安全更新和冒烟验证。

直接执行 `docker build` 仍使用 Dockerfile 中显式的 Caddy 与插件默认值，自动解析由发布 CI
执行。本地复现某次发布时传入 `CADDY_VERSION` 和 `REMOTE_SIGNIN_VERSION` 构建参数。
验证 CI 也会解析当前稳定 Caddy。运行时 Node 按上游精确版本要求更新，并经过相同镜像测试；
调整兜底版本时，需显式同步修改项目默认值与 Dockerfile 默认值。

## 需要确认的仓库设置

| 设置 | 位置 | 不改会怎样 |
|---|---|---|
| Workflow permissions = **Read and write** | Settings → Actions → General | 推送 GHCR 直接 403（只读模式下 `packages: write` 不会被授予） |
| 包 `dsh` 的 **Manage Actions access** 里加上本仓库、角色 **Write** | Package settings → Manage Actions access → Add repository | `docker push` 报 `denied: permission_denied`。GitHub Actions 只对包**链接到**的那个仓库自动获得权限；构建跑在另一个仓库时（本仓库就是从 `dsh-unraid` 拆出来的）必须显式授权 |
| GHCR 包可见性 = **Public** | Package settings → Change visibility | 匿名 `docker pull` 返回 401 |

另：**公开仓库连续 60 天无活动，定时工作流会被自动停用。** 上游长时间不发版时，去 Actions 页点一次
*Enable workflow*。

## 真机验收（CI 之外）

CI 只能证明镜像能起来、断言能过；**它是否真的能在目标平台上跑**仍需单独验一次（历史上这一步抓到过
CI 没发现的 edge 模式缺陷）。要点：

```bash
docker pull ghcr.io/meixu6693/dsh:latest          # 未登录：确认包是公开的
docker run -d --name dsh-acceptance -p 127.0.0.1:18099:8080 \
  -e PUBLIC_URL=http://127.0.0.1:18099 -e TZ=Asia/Shanghai \
  -v /tmp/dsh-accept/data:/data -v /tmp/dsh-accept/workspace:/workspace \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  ghcr.io/meixu6693/dsh:latest
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/healthz   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/          # 303（带 dsh-auth Cookie）
docker exec -u 1000 dsh-acceptance bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all -- /bin/sh -c 'echo SANDBOX_OK'
```

请用**单独的端口与临时卷**验证，别动正在跑的实例。`bwrap` 只在 uid 1000 下可用——用 root 测必然失败，
那不能说明容器有问题。

## Unraid 用户

Community Applications 模板、图标与 Unraid 专属文档都在
[MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid)。两个仓库之间只有两处耦合，
且都是刻意的：

1. 模板的 `<Repository>` 指向本镜像的 `:latest`，因此不需要版本握手（用户安装时模板会被快照——
   见那个仓库的 `docs/ca-pitfalls.md`）；
2. 模板的 `Extra Parameters` 带着两个 `--security-opt`，说明见 [docs/sandbox.zh-CN.md](docs/sandbox.zh-CN.md)。

**改环境变量名或删掉环境变量，对已安装的模板就是破坏性变更。** 两个仓库的 CI 各自能查的都查了，
但**没有任何东西跨仓库校验"模板 → entrypoint"这份契约**，所以改动要同时在 Unraid 论坛帖里公告，
并同步改那边的 `templates/dsh.xml`。
