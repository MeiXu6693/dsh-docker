#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

const stableVersion = (tag) => /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)
const versionParts = (tag) => tag.replace(/^v/, '').split('.').map(Number)
const compareVersions = (a, b) => {
  const left = versionParts(a), right = versionParts(b)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

export async function resolveComponents({ dsh, node, repository, force = false, request }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(dsh)) throw new Error('Invalid DSH version')
  if (!stableVersion(node) || node.startsWith('v')) throw new Error('Node must be an exact version')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository')
  const caddyRelease = await request('/repos/caddyserver/caddy/releases/latest')
  if (caddyRelease.draft || caddyRelease.prerelease || !stableVersion(caddyRelease.tag_name ?? '')) {
    throw new Error('Caddy latest release must be stable')
  }
  const caddy = caddyRelease.tag_name.replace(/^v/, '')
  for (const arch of ['amd64', 'arm64']) {
    if (!caddyRelease.assets?.some(a => a.name === `caddy_${caddy}_linux_${arch}.tar.gz`)) {
      throw new Error(`Caddy release is missing linux/${arch}`)
    }
  }
  // The plugin publishes Git tags, not GitHub Releases. Ignore prerelease tags
  // and paginate rather than assuming API ordering is semver ordering.
  const tags = []
  for (let page = 1; ; page++) {
    if (page > 20) throw new Error('Plugin tag pagination limit reached')
    const batch = await request(`/repos/MeiXu6693/dsh-remote-signin/tags?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error('Invalid plugin tags response')
    tags.push(...batch.map(t => t.name).filter(t => stableVersion(t ?? '')))
    if (batch.length < 100) break
  }
  tags.sort((a, b) => compareVersions(b, a) || a.localeCompare(b))
  if (!tags.length) throw new Error('No stable remote sign-in tag found')
  const remoteSignin = tags[0]
  const inputs = Buffer.from(JSON.stringify({ dsh, node, caddy, remote_signin: remoteSignin })).toString('base64url')
  // Each published build gets its own release; aliases may move, revision tags do not.
  const baseTag = `dsh-v${dsh}`
  const prefix = `${baseTag}-r`
  const releases = []
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Release pagination limit reached')
    const batch = await request(`/repos/${repository}/releases?per_page=100&page=${page}`)
    if (!Array.isArray(batch)) throw new Error('Invalid releases response')
    releases.push(...batch)
    if (batch.length < 100) break
  }
  const revisions = releases.filter(item => item.tag_name === baseTag || item.tag_name?.startsWith(prefix))
    .map(item => ({ ...item, revision: item.tag_name === baseTag ? 1 : Number(item.tag_name.slice(prefix.length)) + 1 }))
    .filter(item => Number.isSafeInteger(item.revision) && item.revision > 0 &&
      (item.tag_name === baseTag || (item.revision > 1 && item.tag_name === `${prefix}${item.revision - 1}`)))
    .sort((a, b) => b.revision - a.revision)
  const published = revisions.find(item => !item.draft)
  const previous = published?.body?.match(/<!-- dsh-build-inputs: ([A-Za-z0-9_-]+) -->/)?.[1]
  const build = force || previous !== inputs
  const revision = build ? (revisions[0]?.revision ?? 0) + 1 : published.revision
  if (!Number.isSafeInteger(revision)) throw new Error('Build revision overflow')
  const imageVersion = revision === 1 ? dsh : `${dsh}-r${revision - 1}`
  return { caddy, remote_signin: remoteSignin, node, build_inputs: inputs, build,
    revision, image_version: imageVersion, release_tag: `dsh-v${imageVersion}` }

}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const i = a.indexOf('='); if (i < 3) throw new Error('Expected --name=value'); return [a.slice(2, i), a.slice(i + 1)]
  }))
  const result = await resolveComponents({
    dsh: args.dsh, node: args.node ?? '24.21.0', repository: args.repository ?? process.env.GITHUB_REPOSITORY,
    force: args.force === 'true',
    request: async (path, allowMissing = false) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-image-release',
          ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(30_000),
      })
      if (allowMissing && response.status === 404) return null
      if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`)
      return response.json()
    },
  })
  for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
