#!/usr/bin/env node
/**
 * Checks for which upstream dist-tags become the image's moving tags, run by
 * scripts/check-static.sh — the same gate release CI runs.
 *
 * Offline and pure: `channelTagsFor` takes a packument's `dist-tags` and the version
 * being built.
 */
import assert from 'node:assert/strict'
import { channelTagsFor } from './resolve-dsh-version.mjs'

// The measured split that this rule exists for (2026-11-26): npm's `latest` still
// pointed at 0.2.2-rc.5 while `alpha` had moved to 0.2.3-alpha.2. An alpha build must
// not claim `latest`.
const measured = { latest: '0.2.2-rc.5', next: '0.2.2-rc.5', alpha: '0.2.3-alpha.2' }
assert.deepEqual(channelTagsFor(measured, '0.2.3-alpha.2'), ['alpha'])
assert.deepEqual(channelTagsFor(measured, '0.2.2-rc.5'), ['latest', 'next'])
// A version no dist-tag names is reachable only through its exact version tag.
assert.deepEqual(channelTagsFor(measured, '0.2.2-alpha.2'), [])

// Several tags on one version all move together.
assert.deepEqual(channelTagsFor({ beta: '0.3.0-beta.1', alpha: '0.3.0-beta.1' }, '0.3.0-beta.1'), ['alpha', 'beta'])
// A stable release promoted to `latest` follows the same rule; there is no separate
// `stable` channel invented from the version string.
assert.deepEqual(channelTagsFor({ latest: '0.3.0', next: '0.3.0' }, '0.3.0'), ['latest', 'next'])

// Missing or malformed input never invents an alias.
assert.deepEqual(channelTagsFor(undefined, '0.2.3-alpha.2'), [])
assert.deepEqual(channelTagsFor({}, '0.2.3-alpha.2'), [])
assert.deepEqual(channelTagsFor(measured, ''), [])
assert.deepEqual(channelTagsFor(measured, undefined), [])

// A leading `v` on either side is the same version, not a different one.
assert.deepEqual(channelTagsFor({ alpha: 'v0.2.3-alpha.2' }, '0.2.3-alpha.2'), ['alpha'])
assert.deepEqual(channelTagsFor({ alpha: '0.2.3-alpha.2' }, 'v0.2.3-alpha.2'), ['alpha'])

console.log('resolve-dsh-version: channel tag checks passed')
