[English](CONTRIBUTING.md) · **中文**

# 维护者手册

本仓库负责构建与发布容器镜像 `ghcr.io/meixu6693/dsh`。**Unraid 那一侧**——Community
Applications 模板、图标、CA 提交说明与迁移指南——在
[MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid)。本仓库不得依赖那个仓库：
镜像必须能独立构建与发布。

面向用户的文档是 [README.md](README.md)（英文，默认）与 [README.zh-CN.md](README.zh-CN.md)
（中文）；两者保持一致，改一个就同步另一个。`scripts/check-docs.mjs` 负责机器能查的那部分：
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
| `release` | 每小时 :17、触及镜像的 push、手动 | 解析版本 → **静态闸门** → 构建 amd64 → 冒烟 → 推送 amd64+arm64（`:<版本>`、`:latest`、`:<通道>`）→ 建 `dsh-v<版本>` tag 与 Release |

Release tag 一律写成 `dsh-v<版本>`，与上游自己的命名一致（`deepseek-ai/deepseek-harness`
的 Release 就是 `dsh-v0.2.1-alpha.5`），这样一个版本在两个仓库里拼写相同、可以直接互相粘贴。
**镜像** tag 保持不带 `v`（`:0.2.1-alpha.5`），因为它对应的是构建所依据的 npm 版本号。

**闸门是共用的**：`release` 的 verify 步骤跑的就是 `validate` 用的那个 `scripts/check-static.sh`，
所以**检查不过的提交什么都发不出去**（publish 与 release 两个 job 直接跳过）。两者曾经各自独立，
结果红色提交照样能发布——不要改回去。

手动发布：Actions → `release` → *Run workflow*。

| 输入 | 说明 |
|---|---|
| `version` | 留空 = 自动解析最高版本；也可以指定确切版本 |
| `force` | 勾选 = 即使 `dsh-v<版本>` tag 已存在也重建（重发同一版本，或改了 Dockerfile 后刷新镜像） |

对已发布的版本再跑一次会走**跳过分支**：`resolve` 看到 tag 已存在 → `build=false` → 后面全部跳过，
不浪费构建时间。**只改本仓库文档或脚本的 push 不会重发任何东西**——要用 `force`。

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
