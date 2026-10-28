#!/usr/bin/env node
import assert from 'node:assert/strict'
import { resolveComponents } from './resolve-component-versions.mjs'

const release = (version = '2.11.7') => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: ['amd64', 'arm64'].map(arch => ({ name: `caddy_${version}_linux_${arch}.tar.gz` })) })
async function resolve({ caddy = release(), tags = ['v0.2.1', 'v0.3.0-rc.1', 'v0.1.0'], body, force = false, fail = false, paginated = false } = {}) {
  return resolveComponents({ dsh: '0.2.1-rc.4', node: '24.21.0', repository: 'owner/repo', force,
    request: async (path) => {
      if (fail) throw new Error('GitHub API 503')
      if (path.endsWith('/releases/latest')) return caddy
      if (path.includes('/tags?')) {
        if (paginated && path.endsWith('page=1')) return Array.from({ length: 100 }, () => ({ name: 'v0.1.0' }))
        return tags.map(name => ({ name }))
      }
      assert.equal(path, '/repos/owner/repo/releases/tags/dsh-v0.2.1-rc.4')
      return body === undefined ? null : { body }
    },
  })
}
const first = await resolve()
assert.equal(first.build, true)
assert.equal(first.remote_signin, 'v0.2.1')
assert.equal(first.node, '24.21.0')
const body = `Release notes\n<!-- dsh-build-inputs: ${first.build_inputs} -->`
assert.equal((await resolve({ body })).build, false)
assert.equal((await resolve({ body, force: true })).build, true)
assert.equal((await resolve({ body: 'Legacy release without metadata' })).build, true)
assert.equal((await resolve({ body, caddy: release('2.12.0') })).build, true)
assert.equal((await resolve({ body, tags: ['v0.2.2', 'v0.2.1'] })).build, true)
assert.equal((await resolve({ tags: ['v0.9.0', 'v0.10.0', 'v1.0.0-beta.1'], paginated: true })).remote_signin, 'v0.10.0')
await assert.rejects(resolve({ caddy: { ...release(), prerelease: true } }), /stable/)
await assert.rejects(resolve({ caddy: { ...release(), assets: [] } }), /missing/)
await assert.rejects(resolve({ tags: ['main', 'v1.0.0-rc.1'] }), /No stable/)
await assert.rejects(resolve({ fail: true }), /503/)
console.log('component resolution passed: change detection, stable tags, pagination, fixed Node, fail closed')

// Exercise the actual DSH resolver: upstream's exact engines.node must not move our pin.
const { createServer } = await import('node:http')
const { execFile } = await import('node:child_process')
const { promisify } = await import('node:util')
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ versions: { '1.0.0': { engines: { node: '99.0.0' } } }, 'dist-tags': { latest: '1.0.0' } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const { stdout } = await promisify(execFile)(process.execPath,
    [new URL('./resolve-dsh-version.mjs', import.meta.url).pathname, '--json', `--registry=http://127.0.0.1:${server.address().port}`],
    { env: { ...process.env, DEFAULT_NODE_VERSION: '24.21.0' } })
  assert.equal(JSON.parse(stdout).node, '24.21.0')
  console.log('upstream engines.node cannot change the runtime Node pin')
} finally {
  await new Promise(resolve => server.close(resolve))
}
