<h1 align="center">DSH — DeepSeek Harness in a container</h1>

<p align="center"><a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> — a coding agent you drive from the browser — in one self-contained image for any Docker host. One port, two volumes, one command.</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">中文说明</a><br>
<a href="https://github.com/MeiXu6693/dsh-docker/actions/workflows/validate.yml"><img src="https://github.com/MeiXu6693/dsh-docker/actions/workflows/validate.yml/badge.svg" alt="validate"></a>
<a href="https://github.com/MeiXu6693/dsh-docker/releases"><img src="https://img.shields.io/github/v/release/MeiXu6693/dsh-docker?label=tracking&color=orange" alt="tracking"></a>
<img src="https://img.shields.io/badge/platforms-amd64%20%7C%20arm64-lightgrey" alt="platforms">
<img src="https://img.shields.io/badge/license-MIT-green" alt="license"></p>

## Why this image

| | Running upstream yourself | `ghcr.io/meixu6693/dsh` |
|---|---|---|
| Start | the npm package, wired up by hand | `docker compose up -d` |
| Command sandbox on a kernel without Landlock (Unraid 7.x, some appliance kernels) | will not start | works — bubblewrap is bundled, the two `--security-opt` values are in [`compose.yaml`](compose.yaml) |
| DeepSeek **account** sign-in from another machine | fails before the login page opens | built in, one paste step ([details](docs/remote-signin.md)) |
| The CLIs your plugins shell out to | you put them on `PATH` | install under `/data`, [picked up at start](docs/extending.md) — and survive `docker pull` + recreate |
| Larger frontend responses | depends on the server or proxy you configure | [shared gzip policy](docs/architecture.md#response-compression) for assets, plugin bundles and the session list in both modes |
| Keeping up with upstream | your job | hourly: resolve → build amd64 + arm64 → smoke test → publish, and only if every check passes |

**Known limits.** Single-user by design — there is no account database, so everyone who
reaches the UI acts as the same owner. A DeepSeek **account** sign-in from another machine
costs one paste into a panel the page shows by itself; an API key skips it entirely. About
0.9 GB on disk.

## Quick start

```bash
docker compose up -d          # compose.yaml already carries the settings below
```

Open **`http://<your-host>:8080`** and log in as `dsh`; the password was printed once:

```bash
docker logs dsh | grep -i password
```

<details>
<summary>Plain <code>docker run</code> instead</summary>

```bash
docker run -d --name dsh --restart unless-stopped -p 8080:8080 \
  -e ALLOWED_CLIENTS=127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10 \
  -e DSH_PASSWORD='change-this-password' \
  -v "$PWD/dsh/data:/data" \
  -v "$PWD/dsh/workspace:/workspace" \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  ghcr.io/meixu6693/dsh:latest
```

</details>

**Then:** set `DSH_PASSWORD`, point the agent at your project (the directory picker opens in
`/workspace`, where `~/workspace` is a symlink), and add an API key — or sign in with your
DeepSeek account.

`403`, `SANDBOX_UNAVAILABLE`, or a login tab that dies on `127.0.0.1`? All three are in
[Problems](#problems), with the commands that tell a real failure from a false alarm.

## Settings you may need

| Setting | Default | What it does |
|---|---|---|
| `8080` | — | The only port to publish. DSH listens on `127.0.0.1:3080` inside; a bundled proxy serves `:8080`. |
| `/data` · `/workspace` | — | Sessions, credentials and the agent home · your projects. **Both must be persistent.** |
| `ALLOWED_CLIENTS` | loopback only | Who may connect at all: IPs/CIDRs (and hostnames, matched against `Host`). |
| `PUBLIC_URL` | empty | Public origin (`https://dsh.example.com`) when a reverse proxy is in front; leave empty for LAN/Tailscale only. |
| `DSH_TRUSTED_HOSTS` | empty | Extra accepted `host[:port]` authorities, comma separated; only used together with `PUBLIC_URL`. |
| `TRUSTED_PROXY_CIDRS` | empty | Only when a reverse proxy is in front: Caddy then reads `X-Forwarded-For` from these peers only, so `ALLOWED_CLIENTS` sees the real client address. |
| `AUTH_MODE` | `builtin` | `builtin` = password gate inside the container; `none` = your proxy authenticates. Any other value refuses to start. |
| `DSH_PASSWORD` | unset | Password for the built-in gate (or `DSH_PASSWORD_FILE`). **Required when `AUTH_MODE=builtin`**; set it, or set `AUTH_MODE=none` behind an authenticating proxy. |
| `AUTH_USER` | `dsh` | User name for the built-in gate. |
| `REMOTE_SIGNIN` | `on` | DeepSeek **account** sign-in from a remote browser: loads [dsh-remote-signin](https://github.com/MeiXu6693/dsh-remote-signin), which puts the paste panel into the page. `off` = upstream's loopback-only behaviour. |
| `PUID` · `PGID` | `1000` · `1000` | The uid:gid everything runs as, and the ownership the writable paths are handed to at start. Match whatever already owns your `/data`; **on Unraid that is `99` · `100`** (see [On Unraid](#on-unraid)). |
| `UMASK` | `022` | File mode mask for the processes the container starts; `002` for a group-writable workspace. |
| `TZ` | `Asia/Shanghai` in `compose.yaml` | Container time zone. |

Already running SSO (Authelia, Authentik, a NAS portal, …)? `AUTH_MODE=none` plus
`PUBLIC_URL`, and **do not stack a second login** — the proxy itself has to be in
`ALLOWED_CLIENTS`, and [docs/security.md](docs/security.md) explains that trade-off:

```yaml
# compose.yaml overrides, behind an authenticating reverse proxy
environment:
  AUTH_MODE: none                       # the proxy authenticates
  PUBLIC_URL: https://dsh.example.com   # Host is rewritten to it; foreign Origins are rejected
  TRUSTED_PROXY_CIDRS: 172.30.0.0/24    # optional: judge the real client IP from X-Forwarded-For
```

`/data`, `/workspace`, `/home/node` and Caddy's state are handed to `PUID:PGID` at every
start — ownership only, never contents or modes, and only where DSH writes. Tell it which
pair that is with `PUID`/`PGID`; the default `1000:1000` is this image's own account, and
the wrong pair is what makes a NAS deployment fail with `EACCES` on its own profile.

## Your own CLI tools and plugins

Install under `/data` as **PUID** (`1000` by default, `99` on Unraid), restart the
container, and they survive `docker pull` and a recreate — the entrypoint then puts them on
the DSH process's `PATH`. A global `npm i -g` as root does none of that, and neither does
an install run through a `docker exec` that forgot `-u`. Both recipes:
[docs/extending.md](docs/extending.md).

## Update

```bash
docker pull ghcr.io/meixu6693/dsh:latest
docker compose up -d          # or recreate your own container
```

Everything in `/data` and `/workspace` survives.

| Tag | Meaning |
|---|---|
| `:latest` | Newest build, upstream prereleases included |
| `:0.2.1-alpha.5` | Pin an exact version |
| `:alpha` · `:rc` · `:stable` | Follow one upstream channel |

An hourly job checks upstream, rebuilds and smoke-tests the image, and publishes only when the checks pass. Upstream currently ships alpha/rc builds, so `:latest` moves often — pin a version tag if you would rather update on your own schedule.

## Problems

| Symptom | Fix |
|---|---|
| “dsh web authentication required; reopen the URL printed by dsh web” | **Just reload the page.** The browser is holding a session cookie this DSH no longer accepts (it happens after an image update, a container recreation, or another DSH on the same host — cookies ignore ports). The container notices and renews the session by itself; opening `http://<host>:<port>/renew` manually, or clearing that site's cookies, does the same thing. |
| A tool reports `SANDBOX_UNAVAILABLE` | The two `--security-opt` values are missing from your run command (they live in `Extra Parameters` on Unraid). Put them back. When you check, two things mislead people: `systempaths=unconfined` never appears in `docker inspect`'s `SecurityOpt` (it shows up as empty `MaskedPaths`/`ReadonlyPaths` instead), and bwrap only works as the **unprivileged identity DSH runs as** — `PUID:PGID`, `1000:1000` unless you changed it. Test the way DSH does: `docker exec -u <PUID>:<PGID> <container> bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true` → exit 0. Run as root (`docker exec`'s default) it always fails with *Creating new namespace failed*, which says nothing about the container. `--cap-add SYS_ADMIN` and `--privileged` are not needed, and both weaken the container. |
| `EACCES` / `Permission denied` on `/data/...` after an install you did by hand | The install ran as root: `docker exec` defaults to the container's root, even for `dsh plugin`. The start after it hands the volume back to `PUID:PGID` and says so in `docker logs`; redo the install with `docker exec -u <PUID>:<PGID> …` so it does not come back. |
| Files in `appdata` keep changing owner, or a second container "steals" the volume | One volume, one container: two containers with different `PUID`/`PGID` on the same `/data` rewrite each other's ownership at every start. Give each its own volume, or give them the same pair. |
| The browser gets `403` | Your address is not in `ALLOWED_CLIENTS`; a plain `docker run` allows loopback only. |
| “登录失败 / 操作未完成” when signing in with a DeepSeek account | Upstream only accepts a **loopback** browser origin, so the login tab is redirected to `127.0.0.1` and dies there. **That is the step the plugin finishes:** a panel has appeared in the DSH page by then — copy the dead page's address into it. Do it within ~10 minutes and in the same container (an update or a container recreation discards the attempt). If the panel does not appear, the plugin is not loaded: set `REMOTE_SIGNIN=on` (it is the default) and check `docker logs <container> \| grep remote-signin`. Prefer no paste? Tunnel once and use a loopback origin: `ssh -L 3081:127.0.0.1:<published port> user@<server>`, then open `http://127.0.0.1:3081`. |
| Updated, but nothing changed | Recreate the container — a running container keeps the image it started with. |
| Page never finishes loading | `PUBLIC_URL` must match the address you actually open (scheme + host, no path). `docker logs <container> \| head -30` prints the mode it chose. |

## On Unraid

Unraid needs no special build: install the Community Applications entry **DSH** and keep
its `Extra Parameters` as shipped — the two `--security-opt` values are what the sandbox
needs on an Unraid kernel. **Set the template's `PUID`/`PGID` to `99`/`100`**: Unraid's
`appdata` belongs to `nobody:users`, and that pair is what makes the container's files and
yours the same files. With it, `Tools → New Permissions` and the Fix Common Problems tools
stay safe to use on this appdata — they rewrite ownership to `99:100`, which the container
then simply agrees with. Unraid-specific notes (the template's fields, migrating from
another DSH image) and the
[forum support thread](https://forums.unraid.net/topic/200908-support-dsh-deepseek-harness-ai-coding-agent-in-your-browser/)
are at **[MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid)**.

## Learn more

| Document | Contents |
|---|---|
| [docs/security.md](docs/security.md) | Password gate, host/origin checks, `ALLOWED_CLIENTS`, 403 troubleshooting |
| [docs/sandbox.md](docs/sandbox.md) | Why the agent's command sandbox needs bubblewrap and those two `--security-opt` values |
| [docs/remote-signin.md](docs/remote-signin.md) | Signing in with a DeepSeek **account** from another machine |
| [docs/architecture.md](docs/architecture.md) | What runs inside the container, layer by layer |
| [docs/extending.md](docs/extending.md) | CLI tools and plugins that survive an update |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Building, testing, releasing |

## Support

- **This image (build, container, docs):** [GitHub Issues](https://github.com/MeiXu6693/dsh-docker/issues) — please include `docker logs <container> | head -30`, your host OS and kernel (`uname -r`), and how `PUBLIC_URL` / `ALLOWED_CLIENTS` are set.
- **Unraid template and Community Applications:** the [forum thread](https://forums.unraid.net/topic/200908-support-dsh-deepseek-harness-ai-coding-agent-in-your-browser/) (the CA entry links there) or [MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid).
- **Problems inside DSH itself** (models, plugins, UI): [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

## License

MIT — see [LICENSE](LICENSE). DeepSeek Harness itself is MIT, published by DeepSeek; this repository only packages it.

Not affiliated with, endorsed by or authorised by DeepSeek or Lime Technology.
