#!/usr/bin/env bash
# Build the same runtime with two release revisions and ensure only metadata changes.
set -euo pipefail
cd "$(dirname "$0")/.."
tag_base="dsh-layer-reuse-$$"
tmp_dir="$(mktemp -d)"
cleanup() {
    docker image rm "${tag_base}:first" "${tag_base}:second" >/dev/null 2>&1 || true
    rm -rf "${tmp_dir}"
}
trap cleanup EXIT
for revision in 1 2; do
    tag=first
    [[ "${revision}" == 2 ]] && tag=second
    docker build --build-arg DSH_VERSION=0.2.2-alpha.2 \
        --build-arg NODE_VERSION=24.21.0 --build-arg CADDY_VERSION=2.11.7 \
        --build-arg REMOTE_SIGNIN_VERSION=v0.2.1 --build-arg "DSH_REVISION=${revision}" \
        -t "${tag_base}:${tag}" .
    docker image inspect "${tag_base}:${tag}" > "${tmp_dir}/${tag}.json"
done
node - "${tmp_dir}/first.json" "${tmp_dir}/second.json" <<'NODE'
const fs = require('node:fs')
const [a, b] = process.argv.slice(2).map(p => JSON.parse(fs.readFileSync(p, 'utf8'))[0])
const first = a.RootFS.Layers
const second = b.RootFS.Layers
if (first.length !== second.length || first.length < 2 ||
    first.slice(0, -1).some((layer, i) => layer !== second[i]) || first.at(-1) === second.at(-1)) {
  throw new Error('Changing only DSH_REVISION must reuse every non-metadata filesystem layer')
}
if (a.Config.Labels['org.opencontainers.image.revision'] !== '1' ||
    b.Config.Labels['org.opencontainers.image.revision'] !== '2') throw new Error('Image revision labels differ from the requested builds')
console.log(`revision change reused ${first.length - 1} filesystem layers`)
NODE
for revision in 1 2; do
    tag=first
    [[ "${revision}" == 2 ]] && tag=second
    actual="$(docker run --rm --entrypoint cat "${tag_base}:${tag}" /etc/dsh-version)"
    [[ "${actual}" == *"DSH_REVISION=${revision}"* ]] || { echo 'incorrect image version metadata' >&2; exit 1; }
done

# The application runs unprivileged and must be able to traverse the config
# directory and read the remote-sign-in overlay.
docker run --rm --user 1000:1000 --entrypoint sh "${tag_base}:second" \
    -c 'test -x /etc/dsh && test -r /etc/dsh/remote-signin.patch.yml'

# Confirm the reordered runtime still starts, authenticates, streams and runs
# the same application-level smoke assertions as the release pipeline.
bash scripts/smoke.sh "${tag_base}:second"
