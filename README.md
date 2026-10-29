<h1 align="center">DSH — DeepSeek Harness 容器版</h1>

<p align="center">把 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（在浏览器里驱动的 AI 编程智能体）装进一个自包含镜像，任何 Docker 主机都能跑：一个端口、两个卷、一条命令。</p>

<p align="center"><b>中文</b> · <a href="README.en.md">English</a><br>
<a href="https://github.com/MeiXu6693/dsh-docker/actions/workflows/validate.yml"><img src="https://github.com/MeiXu6693/dsh-docker/actions/workflows/validate.yml/badge.svg" alt="validate"></a>
<a href="https://github.com/MeiXu6693/dsh-docker/releases"><img src="https://img.shields.io/github/v/release/MeiXu6693/dsh-docker?label=tracking&color=orange" alt="tracking"></a>
<img src="https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-lightgrey" alt="platforms">
<img src="https://img.shields.io/badge/license-MIT-green" alt="license"></p>

## 你能用它做什么

把 DSH 部署在自己的服务器或 NAS 上，然后在电脑、平板等设备的浏览器里打开它，让 AI 智能体
在你指定的项目目录中工作。适合希望长期运行 DSH、从多台设备访问的人。

- **部署简单：** 使用 Docker Compose 启动；Unraid 用户可从 Community Applications 安装。
- **数据留在自己的存储中：** 会话、配置和项目分别保存在挂载目录，更新或重建容器后仍可使用。
- **远程登录更方便：** 在另一台设备使用 DeepSeek 账号登录时，按页面提示粘贴一次地址即可；使用 API Key 则无需这一步。[了解远程登录](docs/remote-signin.zh-CN.md)
- **适配 Unraid：** 内置命令沙箱所需的工具，支持没有 Landlock 的 Unraid 内核；仍需保留安装配置中的安全选项。[了解沙箱](docs/sandbox.zh-CN.md)
- **访问更流畅：** 压缩部分网页资源和会话列表，减少网络传输量，在带宽受限时有助于页面加载；实际效果取决于网络和内容。
- **更新有验证：** 自动检查 DSH 和部分组件的新版本，构建并通过测试后发布镜像；你可以选择何时拉取更新。

这个镜像采用**单用户设计**：能访问界面的人共享同一个工作区身份，并不提供多用户隔离。
访问公网时需要配置 HTTPS 和合适的访问控制。镜像大小约 0.9 GB。

## 快速开始

Unraid 用户可在 **Apps** 中搜索并安装 **DSH**，设置数据目录、工作区目录和登录密码；
见[在 Unraid 上](#在-unraid-上)。其他 Docker 主机可使用下面的 Compose 步骤。

1. 在服务器上新建目录并下载配置：

   ```bash
   mkdir -p dsh && cd dsh
   curl -fsSLO https://raw.githubusercontent.com/MeiXu6693/dsh-docker/main/compose.yaml
   ```

2. 在同一目录新建或编辑 `.env`，设置你自己的登录密码。密码至少 8 个字符，不能包含空白；
   妥善保护此文件。默认用户名是 `dsh`。

   ```dotenv
   DSH_PASSWORD=替换为你自己的密码
   ```

3. 启动容器，在浏览器打开 **`http://<服务器地址>:8080`**，用 `dsh` 和刚设置的密码登录：

   ```bash
   docker compose up -d
   ```

随后在界面中选择项目目录（默认从 `/workspace` 开始），并配置 API Key 或登录 DeepSeek 账号。
Compose 默认将当前目录下的 `data/` 和 `workspace/` 挂载进容器，请妥善保存这两个目录。
需要公网访问时，请先配置提供 HTTPS 和身份认证的反向代理。

<details>
<summary>不使用 Compose：直接运行容器</summary>

```bash
docker run -d --name dsh --restart unless-stopped -p 8080:8080 \
  -e ALLOWED_CLIENTS=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10 \
  -e DSH_PASSWORD='替换为你自己的密码' \
  -v "$PWD/dsh/data:/data" \
  -v "$PWD/dsh/workspace:/workspace" \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  ghcr.io/meixu6693/dsh:latest
```

</details>

遇到 `403`、`SANDBOX_UNAVAILABLE` 或登录页停在 `127.0.0.1`？请查看[常见问题](#常见问题)。

## 可能会用到的设置

| 设置 | 默认 | 作用 |
|---|---|---|
| `8080` | — | 唯一需要发布的端口。DSH 自身只监听容器内的 `127.0.0.1:3080`，由内置代理对外提供 `:8080`。 |
| `/data` · `/workspace` | — | 会话、凭据、智能体主目录 · 你的项目。**两者都必须持久化。** |
| `ALLOWED_CLIENTS` | 仅回环 | 谁能连进来：IP/CIDR（也可以写域名，按 `Host` 匹配）。 |
| `PUBLIC_URL` | 空 | 前面有反向代理时填对外地址（`https://dsh.example.com`）；只在局域网/Tailscale 用就留空。 |
| `DSH_TRUSTED_HOSTS` | 空 | 额外可信的 `host[:port]`，逗号分隔；只在设置了 `PUBLIC_URL` 时生效。 |
| `TRUSTED_PROXY_CIDRS` | 空 | 仅当前面有反向代理时填写：Caddy 只对这些来源读取 `X-Forwarded-For`，让 `ALLOWED_CLIENTS` 看到真实客户端地址。 |
| `AUTH_MODE` | `builtin` | `builtin` = 容器内口令门禁；`none` = 交给前面的代理鉴权。填其它值容器会拒绝启动。 |
| `DSH_PASSWORD` | 未设 | 口令门禁的密码（也可用 `DSH_PASSWORD_FILE`）。默认 `AUTH_MODE=builtin` 时必填；可设置此项，或通过 `DSH_PASSWORD_FILE` 提供。 |
| `AUTH_USER` | `dsh` | 口令门禁的用户名。 |
| `REMOTE_SIGNIN` | `on` | 远程浏览器用 DeepSeek **账号**登录：加载 [dsh-remote-signin](https://github.com/MeiXu6693/dsh-remote-signin)，由它把粘贴面板注入页面。`off` = 回到上游「仅回环」行为。 |
| `PUID` · `PGID` | `1000` · `1000` | 容器一切进程的运行 uid:gid，也是启动时把可写路径交出去的属主。填**已经拥有你 `/data` 的那个身份**；**Unraid 上是 `99` · `100`**（见[在 Unraid 上](#在-unraid-上)）。 |
| `UMASK` | `022` | 容器启动的进程的文件权限掩码；共享可写工作区用 `002`。 |
| `TZ` | `compose.yaml` 里是 `Asia/Shanghai` | 容器时区。 |

已经上了 SSO（Authelia、Authentik、NAS 自带门户……）？`AUTH_MODE=none` 加 `PUBLIC_URL`，**不要再叠一层登录**——代理自身必须在 `ALLOWED_CLIENTS` 里，取舍见 [docs/security.zh-CN.md](docs/security.zh-CN.md)：

```yaml
# 放在鉴权反代后面的容器，compose.yaml 的覆盖写法
environment:
  AUTH_MODE: none                       # 由前面的代理鉴权
  PUBLIC_URL: https://dsh.example.com   # Host 会被改写成它；外来 Origin 一律拒绝
  TRUSTED_PROXY_CIDRS: 172.30.0.0/24    # 可选：按 X-Forwarded-For 判定真实客户端 IP
```

`/data`、`/workspace`、`/home/node` 与 Caddy 的状态目录会在每次启动时交给 `PUID:PGID`
——**只改属主，不动内容与权限位**，而且只动 DSH 自己要写的地方。这对身份由 `PUID`/`PGID`
指定：默认 `1000:1000` 就是镜像自带账号；填错正是 NAS 上出现「读不了自己的 profile、报
`EACCES`」的原因。

## 自己装的工具与插件

装到 `/data` 下、用 **PUID**（默认 `1000`，Unraid 上是 `99`）装，再重启容器，它们就能扛过
`docker pull` 与重建——entrypoint 会把它们挂到 DSH 进程的 `PATH` 上。用 root 跑
`docker exec … npm i -g` 则一样都做不到，忘了 `-u` 的 `docker exec` 同样不行。两份配方：
[docs/extending.zh-CN.md](docs/extending.zh-CN.md)。

## 更新

```bash
docker pull ghcr.io/meixu6693/dsh:latest
docker compose up -d          # 或重建你自己的容器
```

`/data` 与 `/workspace` 里的东西都不会动。

| 标签 | 含义 |
|---|---|
| `:latest` | 最新构建（含上游预发布版） |
| `:0.2.1-alpha.5` | 该 DSH 版本首次发布的构建 |
| `:0.2.1-alpha.5-r1` | 第二次发布的构建；后续依次为 `-r2`、`-r3` 等 |
| `:alpha` · `:rc` · `:stable` | 跟随某个上游通道 |

每小时有定时任务检查上游、重建并做冒烟测试，全部通过才发布。上游目前只有 alpha/rc，`:latest` 更新较频繁——想自己掌握节奏就固定带构建序号的标签。

公共压缩策略在拉取包含该变更的镜像并重建容器后生效，无需新增设置或依赖。它减少传输量，
实际收益取决于内容、带宽与可用 CPU，不会加速模型推理。若外层代理为替换响应正文而清空
`Accept-Encoding`，应在外层完成替换后压缩。会话列表标记为 `private, no-store`；
静态资源原有缓存策略与身份认证继续生效。

**组件更新。** 每小时发布流程跟踪 DSH、Caddy 最新稳定 GitHub Release，以及远程登录插件
最高稳定 Git tag。即使 DSH 版本未变，组件变化也会触发重建，验证通过后才发布。
运行时 Node 跟随上游 `engines.node` 指定的精确版本；若为版本范围或未指定，使用项目默认值 `24.21.0`。首次构建使用 `0.2.1-rc.4`，
第二次使用 `0.2.1-rc.4-r1`，第三次使用 `-r2`；DSH 升版后重新从不带后缀开始。
组件更新或强制重建递增构建计数。所有版本标签（包含不带后缀的首发标签）和 GitHub Release
均保留，只有 `latest` 与通道标签跟随最新构建。固定版本标签或 digest 可保留指定构建。
详见[组件版本策略](CONTRIBUTING.zh-CN.md#组件版本策略)。

## 安全

压缩不缓存响应或认证成功结果；口令门禁、访问白名单、Host/Origin 校验与 Cookie 引导继续生效。
私有会话列表使用 `Cache-Control: private, no-store`，但这不会清除浏览器已保存的数据；
静态资源仍需版本化 URL 或正确的缓存验证器。

HTTPS 响应压缩在秘密与攻击者可控文本混合时，可能产生 BREACH 类长度侧信道。
当前策略排除登录 HTML、凭据与令牌端点、错误响应、Range、事件流和 WebSocket 升级。
会话列表仍参与压缩：若未来内容混入秘密和攻击者可控文本，应重新评估，或在所有执行压缩的层
排除该路由。身份认证与 `no-store` 不能消除此风险。范围与部署注意事项见
[压缩安全说明](docs/security.zh-CN.md#响应压缩)。

## 常见问题

| 现象 | 处理 |
|---|---|
| 页面提示 “dsh web authentication required; reopen the URL printed by dsh web” | **刷新页面即可。** 这是浏览器持有一个 DSH 已不再接受的会话 Cookie（镜像更新、容器重建、或同主机另一个 DSH 实例都会造成——Cookie 不区分端口）。容器自己会发现并重新签发会话；手动打开 `http://<主机>:<端口>/renew`、或清掉该站点 Cookie，效果相同。 |
| 工具报 `SANDBOX_UNAVAILABLE` | 启动参数里少了那两个 `--security-opt`（Unraid 上它们在 **Extra Parameters** 里），补回去。自查时有两个坑：`systempaths=unconfined` **不会**出现在 `docker inspect` 的 `SecurityOpt` 里（它表现为 `MaskedPaths`/`ReadonlyPaths` 变空），而 bwrap **只在 DSH 运行的那个非特权身份下可用**——也就是 `PUID:PGID`，没改过就是 `1000:1000`。所以要按 DSH 的方式测：`docker exec -u <PUID>:<PGID> <容器> bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true` → exit 0。用 root（`docker exec` 默认身份）测必然报 *Creating new namespace failed*，那不能说明容器有问题；`--cap-add SYS_ADMIN` 与 `--privileged` 都不需要，而且都会削弱容器隔离。 |
| 手动装完东西后 `/data/...` 报 `EACCES` / `Permission denied` | 那次安装是以 root 跑的：`docker exec` 默认就是容器里的 root，`dsh plugin` 也一样。**下一次启动会把卷的属主交回 `PUID:PGID` 并在 `docker logs` 里说明**；重做那次安装时请带 `-u <PUID>:<PGID>`，否则还会再来一遍。 |
| `appdata` 里的属主反复变化，或第二个容器「抢」走了卷 | 一个卷只给一个容器：两个不同 `PUID`/`PGID` 的容器挂同一个 `/data`，每次启动都会互相重写属主。给它们各自的卷，或让它们用同一对身份。 |
| 浏览器拿到 `403` | 你的地址不在 `ALLOWED_CLIENTS` 里；裸 `docker run` 默认只放行回环。 |
| 用 DeepSeek 账号登录报「登录失败 / 操作未完成」 | 上游只接受**回环**来源，于是登录标签页被重定向到 `127.0.0.1` 后死在那里。**这一步正是插件负责收尾的：**那时 DSH 页面里已经自动出现粘贴面板——把那个打不开页面的地址粘进去。请**在约 10 分钟内、同一个容器里**完成（更新或重建容器都会作废这次尝试）。面板若没出现，就是插件没加载：把 `REMOTE_SIGNIN` 设为 `on`（本来就是默认值），并用 `docker logs <容器名> \| grep remote-signin` 看原因。不想粘贴？开一次隧道用回环地址登录：`ssh -L 3081:127.0.0.1:<发布端口> user@<服务器>`，再打开 `http://127.0.0.1:3081`。 |
| 更新了却没变化 | 重建容器——正在运行的容器一直用它启动时的那份镜像。 |
| 页面一直转圈 | `PUBLIC_URL` 必须与你实际打开的地址一致（协议 + 主机，不带路径）。`docker logs <容器名> \| head -30` 会打印它选定的模式。 |

## 在 Unraid 上

Unraid 不需要专门的构建：在 Community Applications 里装 **DSH**，并保留模板自带的
**Extra Parameters**——那两个 `--security-opt` 是沙箱在 Unraid 内核上工作的前提。
**把模板里的 `PUID`/`PGID` 设为 `99`/`100`**：Unraid 的 `appdata` 属于 `nobody:users`，
这一对身份让容器的文件和你的文件是同一批文件。设好之后，`工具 → New Permissions` 与
Fix Common Problems 那套权限工具在这个 appdata 上可以放心跑——它们把属主改写成 `99:100`，
而容器本来就认同这个身份。Unraid 相关的说明（模板字段、从别的 DSH 镜像迁移）与论坛
[支持帖](https://forums.unraid.net/topic/200908-support-dsh-deepseek-harness-ai-coding-agent-in-your-browser/)
都在 **[MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid)**。

## 更多文档

| 文档 | 内容 |
|---|---|
| [docs/security.zh-CN.md](docs/security.zh-CN.md) | 口令门禁、Host/Origin 校验、`ALLOWED_CLIENTS`、403 排障 |
| [docs/sandbox.zh-CN.md](docs/sandbox.zh-CN.md) | 为什么命令沙箱需要 bubblewrap 与那两个 `--security-opt` |
| [docs/remote-signin.zh-CN.md](docs/remote-signin.zh-CN.md) | 从另一台机器用 DeepSeek **账号**登录 |
| [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) | 容器里逐层跑着什么 |
| [docs/extending.zh-CN.md](docs/extending.zh-CN.md) | 能扛过更新的命令行工具与插件 |
| [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) | 构建、测试、发布 |

## 支持

- **本镜像（构建、容器、文档）：**[GitHub Issues](https://github.com/MeiXu6693/dsh-docker/issues)——请附上 `docker logs <容器名> | head -30`、宿主系统与内核版本（`uname -r`）、以及 `PUBLIC_URL` / `ALLOWED_CLIENTS` 的设置方式。
- **Unraid 模板与 Community Applications：**[论坛帖](https://forums.unraid.net/topic/200908-support-dsh-deepseek-harness-ai-coding-agent-in-your-browser/)（CA 条目就指向那里）或 [MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid)。
- **DSH 自身的问题**（模型、插件、界面）：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

## 许可

MIT，见 [LICENSE](LICENSE)。DeepSeek Harness 本身由 DeepSeek 以 MIT 发布，本仓库只做打包。

与 DeepSeek、Lime Technology 均无隶属或授权关系。
