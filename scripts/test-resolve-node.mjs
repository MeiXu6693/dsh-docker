#!/usr/bin/env node
/**
 * Checks for the Node version the image is built with, run by scripts/check-static.sh — the
 * same gate release CI runs, so a runtime upstream no longer supports cannot ship.
 *
 * Offline and pure: `resolveNodeVersion` takes upstream's `engines.node` and the project
 * fallback as arguments.
 */
import assert from 'node:assert/strict'
import { resolveNodeVersion } from './resolve-dsh-version.mjs'

// An exact upstream requirement is used verbatim.
assert.deepEqual(resolveNodeVersion('24.21.0', '24.22.3'), { node: '24.21.0', source: 'engines-exact' })
assert.deepEqual(resolveNodeVersion('26.13.1', '24.22.3'), { node: '26.13.1', source: 'engines-exact' })

// A range the fallback satisfies keeps the fallback: the pin is a project decision.
assert.deepEqual(resolveNodeVersion('>=24.9.0', '24.22.3'), { node: '24.22.3', source: 'fallback' })
assert.deepEqual(resolveNodeVersion('^24.22.3 || >=26.13.1', '24.22.3'), { node: '24.22.3', source: 'fallback' })
assert.deepEqual(resolveNodeVersion('~24.22.3', '24.22.3'), { node: '24.22.3', source: 'fallback' })
assert.deepEqual(resolveNodeVersion('', '24.22.3'), { node: '24.22.3', source: 'fallback' })
assert.deepEqual(resolveNodeVersion(undefined, '24.22.3'), { node: '24.22.3', source: 'fallback' })
assert.deepEqual(resolveNodeVersion('>=24', '24.22.3'), { node: '24.22.3', source: 'fallback' })

// The measured break: dsh 0.2.3-alpha.2 raised its floor to ^24.22.3, and a stale fallback
// would have shipped 24.21.0 — a runtime upstream no longer supports.
assert.deepEqual(resolveNodeVersion('^24.22.3 || >=26.13.1', '24.21.0'), {
  node: '24.22.3',
  source: 'engines-range-floor',
})
// A floor in another major still beats an unsupported fallback.
assert.deepEqual(resolveNodeVersion('>=26.13.1', '24.22.3'), { node: '26.13.1', source: 'engines-range-floor' })
// Same major is preferred over a lower floor from another one.
assert.deepEqual(resolveNodeVersion('>=24.22.3 || >=26.13.1', '24.21.0'), {
  node: '24.22.3',
  source: 'engines-range-floor',
})
// A malformed fallback cannot leak into a build argument: it degrades to the project
// default, which already satisfies this range.
assert.deepEqual(resolveNodeVersion('^24.22.3', 'not-a-version'), { node: '24.22.3', source: 'fallback' })

console.log('resolve-dsh-version: Node version checks passed')
