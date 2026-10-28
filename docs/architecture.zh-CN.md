[English](architecture.md) · **中文**

# 整体是怎么搭的

一个容器、两个进程、一个端口：

```text
浏览器 ──▶ :8080  Caddy（内置）  ──▶ 127.0.0.1:3080  DSH
                    ├─ 可选口令门禁（默认开启）
                    ├─ 白名单：ALLOWED_CLIENTS
                    ├─ 安全响应头、Host/Origin 校验
                    └─ /healthz 供容器健康检查
```

- **反向代理已经内置在镜像里。** 对外提供服务的是 Caddy，它转发给只监听回环的 DSH——所以你发布的那个端口是唯一入口，而安全响应头、跨站请求拦截、"远程无意义端点"的拒绝都在这一层完成。你不需要额外安装或配置任何代理。
- **认证是可选的，而且只是一个开关。** `AUTH_MODE=builtin`（默认）会用浏览器常见的登录框要一次口令，随后以 Cookie 保持登录（该 Cookie 同样覆盖 WebSocket 握手）；`AUTH_MODE=none` 则把鉴权交给前面那一层（带 SSO 的反向代理、VPN、可信内网）。填其它值容器会**拒绝启动**，而不是"看起来有认证"地裸奔——另外**永远不要叠两层登录**。无论哪种模式，容器自身的健康检查都保持免认证。
- **白名单也在同一层。** `ALLOWED_CLIENTS` 决定谁能连进来；回环永远放行，这正是健康检查能工作的原因。
- **以非特权身份运行。** 以 `PUID`/`PGID` 运行（默认 `1000:1000`）、不挂 docker socket、除你映射的两个卷之外不碰任何宿主目录。凭据存在 `/data`——这就是那个卷必须持久化的原因。
- **命令沙箱有两条腿**：bubblewrap（本镜像内置，多数社区镜像没有）与 Landlock（上游的 `landlock-run`，要求内核编入了它）。没有 Landlock 时，正是 bubblewrap 加上那两个 `--security-opt` 把模型生成的命令关在工作区里：[sandbox.zh-CN.md](sandbox.zh-CN.md)。
- **明文 HTTP 上的口令在公网上不安全。** 门禁保护的是应用而不是链路：对外暴露前，请在它前面终止 TLS。细节见 [security.zh-CN.md](security.zh-CN.md)。

前两条背后的规则——两种模式、Host/Origin 的处理、白名单——见 [security.zh-CN.md](security.zh-CN.md)；沙箱的两条腿见 [sandbox.zh-CN.md](sandbox.zh-CN.md)。

## 响应压缩

两种模式都导入 `/etc/caddy/Caddyfile.common`。共用策略会为 `/assets/`、`/plugins/`、
远程登录脚本、部署脚本以及 `/api/session/list` 中成功的 GET 响应协商 gzip，最小体积为
1024 字节，并明确限制为 JavaScript、CSS、JSON、SVG、WASM 与未压缩字体的 MIME 类型。
这覆盖了运行时生成、上游可能没有预压缩版本的插件脚本；上游已经编码的响应直接透传。

HTML 和其他 API 路径沿用原处理。Range 请求、WebSocket 升级、事件流、错误响应和二进制
下载不参与压缩；此策略不增加缓存，也不改变认证、Host/Origin 校验或端口。Caddy 的 HTTP
传输本身已默认复用上游连接。

外层反向代理需要保留 `Accept-Encoding`，内置压缩才能协商成功。如果外层为修改响应正文
清空了该头，应由外层负责压缩修改后的响应。机制见 Caddy 的
[encode](https://caddyserver.com/docs/caddyfile/directives/encode) 和
[reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 文档。

`scripts/test-proxy-compression.mjs` 会用受控回环上游运行两份生产 Caddyfile，检查解压后
正文一致、编码协商、条件请求、字节范围、上游已编码响应、SSE 交付及 WebSocket 帧。
PR 验证使用固定版本的 Caddy 二进制运行它；镜像冒烟在一次性测试容器内运行同一组断言，
让发布验证也覆盖这些行为。
