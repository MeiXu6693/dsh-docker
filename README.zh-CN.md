<h1 align="center">DSH — DeepSeek Harness 容器版</h1>

<p align="center">把 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>（在浏览器里驱动的 AI 编程智能体）装进一个自包含镜像，任何 Docker 主机都能跑：一个端口、两个卷、一条命令。</p>

<p align="center"><a href="README.md">English</a> · <b>中文说明</b><br>
<a href="https://github.com/MeiXu6693/dsh-docker/actions/workflows/validate.yml"><img src="https://github.com/MeiXu6693/dsh-docker/actions/workflows/validate.yml/badge.svg" alt="validate"></a>
<a href="https://github.com/MeiXu6693/dsh-docker/releases"><img src="https://img.shields.io/github/v/release/MeiXu6693/dsh-docker?label=tracking&color=orange" alt="tracking"></a>
<img src="https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-lightgrey" alt="platforms">
<img src="https://img.shields.io/badge/license-MIT-green" alt="license"></p>

## 这个镜像的优势

| | 自己跑上游 | `ghcr.io/meixu6693/dsh` |
|---|---|---|
| 启动 | 自己装 npm 包、手工配置 | `docker compose up -d` |
| 没有 Landlock 的内核上（Unraid 7.x、部分设备内核）的命令沙箱 | 起不来 | 可用——内置 bubblewrap，[`compose.yaml`](compose.yaml) 里已带那两个 `--security-opt` |
| 从另一台机器用 DeepSeek **账号**登录 | 登录页还没打开就失败 | 内置，只多一步粘贴（[说明](docs/remote-signin.zh-CN.md)） |
| 插件要调用的命令行工具 | 自己挂到 `PATH` 上 | 装在 `/data` 下，[启动时自动挂上](docs/extending.zh-CN.md)，并扛过 `docker pull` 与重建 |
| 带宽受限时的加载加速 | 取决于自行配置的服务或代理 | 两种模式共用 [gzip 策略](docs/architecture.zh-CN.md#响应压缩)，减少静态资源、插件脚本和会话列表的传输量；无需响应缓存或额外服务 |
| 跟随上游 | 你自己的活 | 每小时：取版本 → 构建 amd64 + arm64 → 冒烟 → 全绿才发布 |

**已知限制。** 单用户设计——没有账户体系，能打开界面的人就是同一个工作区主人。从另一台机器用 DeepSeek **账号**登录要多一步粘贴（粘进页面自己弹出的面板），用 API Key 则完全不需要。镜像约 0.9 GB。

## 快速开始

```bash
docker compose up -d          # compose.yaml 里已经带好下面的设置
```

打开 **`http://<你的主机>:8080`**，用户名 `dsh`；口令只在日志里打印过一次：

```bash
docker logs dsh | grep -i password
```

<details>
<summary>不用 Compose，直接 <code>docker run</code></summary>

```bash
docker run -d --name dsh --restart unless-stopped -p 8080:8080 \
  -e ALLOWED_CLIENTS=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10 \
  -v "$PWD/dsh/data:/data" \
  -v "$PWD/dsh/workspace:/workspace" \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  ghcr.io/meixu6693/dsh:latest
```

</details>

**然后：** 设 `DSH_PASSWORD`、把智能体指向你的项目（目录选择器默认落在 `/workspace`，`~/workspace` 是指向它的软链）、填 API Key 或用账号登录。

`403`、`SANDBOX_UNAVAILABLE`、或登录标签页停在 `127.0.0.1`？三种都在[常见问题](#常见问题)里，附能分辨“真故障”与“误报”的命令。

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
| `DSH_PASSWORD` | 未设 | 口令门禁的密码（也可用 `DSH_PASSWORD_FILE`）。未设 = 首启生成并打印一次。 |
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
