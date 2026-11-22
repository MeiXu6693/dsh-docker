#!/usr/bin/env node
/**
 * Checks for the version picker, run by scripts/check-static.sh — the same gate release
 * CI runs, so a red picker cannot publish. Offline: the selection is a pure function of
 * the published list, so every case is passed in instead of fetched.
 *
 * The subject is the exclusion list. A release whose closure cannot start must never be
 * selected, not even by naming it through the manual `version` input, and the list has
 * to stay well formed so an entry cannot silently stop matching.
 */
import assert from 'node:assert/strict'
import { BLOCKED_VERSIONS, selectVersion, sortVersions } from './resolve-dsh-version.mjs'

// --- the shipped list is well formed ------------------------------------------------
assert.ok(BLOCKED_VERSIONS.size > 0, 'the exclusion list lost its entry; 0.2.3-alpha.1 cannot start')
for (const [version, reason] of BLOCKED_VERSIONS) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `not an exact published version: ${version}`)
  assert.ok(reason.length > 80, `the reason for ${version} is too short to be evidence`)
  assert.match(reason, /measured \d{4}-\d{2}-\d{2}/, `the reason for ${version} carries no date`)
  assert.match(reason, /Clear this entry/, `the reason for ${version} does not say what clears it`)
}

// --- synthetic list so these checks survive an entry being removed later -------------
const blocked = new Map([
  ['0.2.3-alpha.1', 'synthetic: the reported closure cannot start (measured 2026-11-22); Clear this entry when it can.'],
  ['9.9.9', 'synthetic: not a real version; Clear this entry when it is.'],
])
const published = ['0.2.1', '0.2.2-rc.4', '0.2.2-rc.5', '0.2.3-alpha.1', '9.9.9']

// Semver order, prereleases included, highest first.
assert.deepEqual(sortVersions(published).map((value) => value.raw), [
  '9.9.9', '0.2.3-alpha.1', '0.2.2-rc.5', '0.2.2-rc.4', '0.2.1',
])

// The highest selectable version wins, and the excluded ones are reported, not dropped.
const automatic = selectVersion(published, { blocked })
assert.equal(automatic.selected.raw, '0.2.2-rc.5')
assert.equal(automatic.highest.raw, '0.2.2-rc.5')
assert.deepEqual(automatic.blocked, ['9.9.9', '0.2.3-alpha.1'])

// `--pick=stable` cannot fall back onto an excluded prerelease either.
assert.equal(selectVersion(published, { pick: 'stable', blocked }).selected.raw, '0.2.1')

// Naming an excluded version through the manual input fails and quotes the reason.
for (const [version, reason] of blocked) {
  assert.throws(
    () => selectVersion(published, { requested: version, blocked }),
    (error) => error.message.includes(version) && error.message.includes(reason),
    `the manual input accepted the excluded ${version}`,
  )
}

// An allowed manual version is still honoured, with or without the leading "v", and a
// value-less `--version` (the flag parser's `true`) keeps resolving automatically.
assert.equal(selectVersion(published, { requested: '0.2.2-rc.4', blocked }).selected.raw, '0.2.2-rc.4')
assert.equal(selectVersion(published, { requested: 'v0.2.1', blocked }).selected.raw, '0.2.1')
assert.equal(selectVersion(published, { requested: true, blocked }).selected.raw, '0.2.2-rc.5')
assert.equal(selectVersion(published, { requested: '', blocked }).selected.raw, '0.2.2-rc.5')

// Unknown, empty and unparseable inputs keep failing instead of quietly picking a version.
assert.throws(() => selectVersion(published, { requested: '0.2.9', blocked }), /not published/)
assert.throws(() => selectVersion([], {}), /no parseable published versions/)
assert.throws(() => selectVersion(['0.1.0-rc.1'], { pick: 'stable' }), /no selectable stable/)

// The default is the shipped list: a blocked version cannot be selected by forgetting to
// pass one in. Written against the real table so removing an entry stays legitimate.
const withShippedBlocks = ['0.2.1', ...BLOCKED_VERSIONS.keys()]
assert.ok(!BLOCKED_VERSIONS.has(selectVersion(withShippedBlocks, {}).selected.raw),
  'selectVersion must apply BLOCKED_VERSIONS by default')

// An entry the registry does not have yet must not disturb the run.
assert.equal(selectVersion(['0.2.1'], { blocked }).selected.raw, '0.2.1')

console.log('resolve-dsh-version: selection checks passed')
