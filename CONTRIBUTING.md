**English** · [中文](CONTRIBUTING.zh-CN.md)

# Maintainer handbook

This repository builds and publishes the container image `ghcr.io/meixu6693/dsh`. The
**Unraid side** — the Community Applications template, the icon, the CA submission notes
and the migration guide — lives in [MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid).
Nothing here may depend on that repository: the image must build and publish on its own.

User-facing content is in [README.md](README.md) (English, the default) and
[README.zh-CN.md](README.zh-CN.md) (Chinese); the two are kept in sync, so update both
whenever you change one. `scripts/check-docs.mjs` enforces what a script can: anchors and
relative links that resolve, a `*.zh-CN.md` page linking the translated variant, and the two
tracks of a document having the same number of `##` sections and the same setting names.

## Repository layout

```
.
├── Dockerfile                 # three-stage build: DSH deps → Caddy binary → runtime
├── docker/
│   ├── entrypoint.sh          # validate env, prepare volumes, pick mode, start Caddy + DSH
│   ├── Caddyfile.edge         # PUBLIC_URL set: rewrite Host to the public authority, reject foreign Origin
│   ├── Caddyfile.lan          # PUBLIC_URL empty: pin Host to loopback, strip Origin
│   ├── Caddyfile.common       # response encoding shared by both modes
│   └── healthcheck.sh         # container HEALTHCHECK
├── compose.yaml               # non-Unraid users: the same settings as the CA template
├── scripts/                   # version resolution, dependency pruning, static gates, smoke test
├── docs/                      # security, sandbox, remote sign-in, architecture, extending
└── .github/workflows/         # validate (every push) + release (tracks upstream releases)
```

## Local build and self-checks

```bash
# Build (the version number comes from npm, see below)
docker build \
  --build-arg DSH_VERSION=0.2.1-alpha.4 \
  --build-arg NODE_VERSION=24.21.0 \
  --build-arg CADDY_VERSION=2.11.7 \
  -t dsh:local .

# Smoke: really starts a container and asserts /healthz, the password gate, remote sign-in,
# the token bootstrap, cross-site 403, both Caddy configs and the bwrap sandbox
bash scripts/smoke.sh dsh:local

# Static gates: exactly what CI runs (syntax, the documentation gate, and the
# well-formedness of every YAML/JSON)
bash scripts/check-static.sh
```

> `check-static.sh` needs `python3` for the well-formedness section. On a host without it,
> `ALLOW_MISSING_PYTHON=1 bash scripts/check-static.sh` skips that section — **skipping is
> not allowed in CI**; there a missing python3 fails outright.

## How the upstream version is resolved

```bash
node scripts/resolve-dsh-version.mjs --json
node scripts/resolve-dsh-version.mjs --version=0.2.1-alpha.4
```

**Do not read only npm's `latest` tag.** Measured: `@deepseek-ai/dsh`'s `latest` lags
behind `alpha` (2026-10-15: `latest`=`0.2.0-rc.2`, `alpha`=`0.2.1-alpha.3`), so a pipeline
that reads only `latest` silently downgrades. The script enumerates every published
version and takes the highest by semver; prereleases participate per the spec.

## Releasing

| Workflow | Trigger | What it does |
|---|---|---|
| `validate` | Every push and PR | Static gates + shellcheck + hadolint + `caddy validate` + script end-to-end |
| `release` | Hourly cron (:17), pushes touching the image, manual | Resolve version → **static gates** → build amd64 → smoke → push amd64+arm64 (`:<version>`, `:latest`, `:<channel>`) → create the `dsh-v<version>` tag and Release |

Release tags are spelled `dsh-v<version>` to match upstream's own scheme
(`deepseek-ai/deepseek-harness` releases as `dsh-v0.2.1-alpha.5`), so one version reads
the same in both repositories. The **image** tags stay un-prefixed (`:0.2.1-alpha.5`),
because those mirror the npm version they were built from.

**The gates are shared**: the verify step in `release` runs exactly the
`scripts/check-static.sh` that `validate` uses, so **a commit that fails the checks
publishes nothing** (the publish and release jobs are skipped). The two used to be
independent and a red commit could still publish — don't change that back.

Manual release: Actions → `release` → *Run workflow*.

| Input | Description |
|---|---|
| `version` | Empty = resolve the highest version automatically; you can also name an exact version |
| `force` | Checked = rebuild even if the `dsh-v<version>` tag already exists (re-publishing the same version, or refreshing an image after a Dockerfile change) |

Running it again for an already-published version takes the **skip branch**: `resolve`
sees the tag already exists → `build=false` → everything after that is skipped, so no
build time is wasted. **A push that only changes this repository's docs or scripts does
not republish anything** — use `force`.

## Repository settings to confirm

| Setting | Where | What happens if you don't |
|---|---|---|
| Workflow permissions = **Read and write** | Settings → Actions → General | Pushing to GHCR returns 403 (in read-only mode `packages: write` is not granted) |
| **Manage Actions access** on the `dsh` package = this repository, role **Write** | Package settings → Manage Actions access → Add repository | `docker push` fails with `denied: permission_denied`. GitHub Actions only gets automatic access to a package from the repository the package is *linked* to; a build that runs in another repository (as this one does, after being split out of `dsh-unraid`) must be granted access explicitly |
| GHCR package visibility = **Public** | Package settings → Change visibility | An anonymous `docker pull` returns 401 |

Also: **a public repository with no activity for 60 consecutive days gets its scheduled
workflows disabled automatically.** If upstream goes quiet for a long time, open the
Actions page and click *Enable workflow* once.

## Acceptance on a real machine (outside CI)

CI only proves the image starts and passes its assertions; **whether it really runs on the
target platform** still needs a separate check (historically this step caught an edge-mode
defect that CI missed). The essentials:

```bash
docker pull ghcr.io/meixu6693/dsh:latest          # not logged in: confirm the package is public
docker run -d --name dsh-acceptance -p 127.0.0.1:18099:8080 \
  -e PUBLIC_URL=http://127.0.0.1:18099 -e TZ=Asia/Shanghai \
  -v /tmp/dsh-accept/data:/data -v /tmp/dsh-accept/workspace:/workspace \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  ghcr.io/meixu6693/dsh:latest
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/healthz   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18099/          # 303 (with a dsh-auth cookie)
docker exec -u 1000 dsh-acceptance bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all -- /bin/sh -c 'echo SANDBOX_OK'
```

Verify with **a separate port and temporary volumes**; don't touch a running instance.
`bwrap` only works as uid 1000 — as root it always fails, which says nothing about the
container.

## Unraid users

The Community Applications template, the icon and the Unraid-specific documentation are
maintained in [MeiXu6693/dsh-unraid](https://github.com/MeiXu6693/dsh-unraid). Two
things couple the two repositories, and both are deliberate:

1. the template's `<Repository>` points at this image's `:latest` tag, so no version
   handshake is needed (the template is snapshotted when a user installs it — see that
   repository's `docs/ca-pitfalls.md`);
2. the template's `Extra Parameters` carry the two `--security-opt` values documented in
   [docs/sandbox.md](docs/sandbox.md).

**Renaming or removing an environment variable is a breaking change for installed
templates.** Both repositories' CI check what it can, but nothing verifies the
template→entrypoint contract across repositories, so announce the change in the Unraid
forum thread and update `templates/dsh.xml` there in the same breath.
