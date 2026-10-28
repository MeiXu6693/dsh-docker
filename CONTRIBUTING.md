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
| `release` | Hourly cron (:17), pushes touching the image, manual | Resolve version → **static gates** → build amd64 → smoke → push amd64+arm64 (first `:<version>`, then `:<version>-r<N>`; `:latest`, `:<channel>`) → create a build-specific tag and Release |

The first build preserves the upstream version exactly: image `:0.2.1-rc.4` and Release
`dsh-v0.2.1-rc.4`. The second build adds `-r1`, the third `-r2`; a new DSH version starts
without a suffix. Component updates and forced builds increment the counter. Internally,
`DSH_REVISION` counts builds from 1, so the suffix is revision minus one. The next counter
is one above the highest recorded build for that DSH version, using numeric order and
including drafts to avoid collisions. A failure before any Release is recorded does not
consume a counter. Release runs are serialized across branches. Historical unsuffixed
releases count as the first build; missing metadata triggers a new `-r1` build.

**The gates are shared**: the verify step in `release` runs exactly the
`scripts/check-static.sh` that `validate` uses, so **a commit that fails the checks
publishes nothing** (the publish and release jobs are skipped). The two used to be
independent and a red commit could still publish — don't change that back.

Manual release: Actions → `release` → *Run workflow*.

| Input | Description |
|---|---|
| `version` | Empty = resolve the highest version automatically; you can also name an exact version |
| `force` | Checked = publish the next build revision even if all component versions are unchanged |

A run skips building only when the selected DSH release already records the same DSH,
Node, Caddy and remote sign-in versions. A legacy release without component metadata is
followed by an `-r1` build. `force=true` also rebuilds unchanged inputs, for example to ship a proxy
configuration fix without changing any component version. Force does not disable Docker's
layer cache. Documentation-only pushes do not trigger release.

## Component version policy

| Component | Selection during release |
|---|---|
| DSH | Highest published semver, including prereleases, or the manual `version` input |
| Node | Exact upstream `engines.node` when provided; ranges or missing values use `DEFAULT_NODE_VERSION=24.21.0` |
| Caddy | Latest stable GitHub Release from `caddyserver/caddy`, with Linux amd64 and arm64 assets required |
| Remote sign-in plugin | Highest stable semver Git tag from `MeiXu6693/dsh-remote-signin`; prerelease tags are excluded (the project does not currently publish GitHub Releases) |
| pnpm | Dockerfile `PNPM_VERSION=12` selects within major 12 when its install layer runs |
| OS packages and npm transitive dependencies | Resolve when install layers run; reused build cache can retain older results |

`scripts/resolve-component-versions.mjs` resolves components once per release and passes
the same exact values to verification and publishing. API errors or incomplete Caddy
releases stop the run rather than silently selecting an older version. Static gates,
both-mode proxy assertions and the full image smoke must pass before publication. Changes
to upstream APIs can therefore block an automatic update until compatibility is restored.

Release notes record the versions and a `dsh-build-inputs` marker for the next comparison;
do not remove that marker when editing notes. Every published revision gets a new image
tag and Release targeting the workflow commit. The workflow never edits a previous build
Release or moves its Git tag. Only `latest` and channel tags are moving aliases; the unsuffixed DSH tag retains
the first build. Pin a versioned tag or digest for reproducible deployment, and pull and
recreate containers to apply updates. `/etc/dsh-version` records the build revision too.

Direct `docker build` still uses the Dockerfile's explicit Caddy and plugin defaults;
automatic selection is performed by release CI. Pass `CADDY_VERSION` and
`REMOTE_SIGNIN_VERSION` build arguments to reproduce a selected release locally.
Validation CI also resolves the current stable Caddy. Runtime Node follows exact upstream requirements through the same image tests. Changing
the fallback requires updating the project default and Dockerfile default explicitly.

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
