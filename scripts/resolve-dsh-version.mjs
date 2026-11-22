#!/usr/bin/env node
/**
 * Resolve which DeepSeek Harness version this image should ship.
 *
 * Why not `npm view @deepseek-ai/dsh version`? Because the npm `latest` tag is
 * not the newest release: on 2026-10-15 the dist-tags were
 *
 *     latest: 0.2.0-rc.2   next: 0.2.0-rc.2   alpha: 0.2.1-alpha.3
 *
 * while upstream had already published 0.2.1-alpha.2/3 under `alpha`. Trusting
 * `latest` would silently *downgrade* the image. So we enumerate every
 * published version, sort by semver (prereleases included, per spec precedence)
 * and take the highest selectable one.
 *
 * "Selectable" excludes {@link BLOCKED_VERSIONS}: a release whose own dependency
 * closure cannot start is not something this pipeline can salvage, and picking
 * an older release only hides it. See the comment on that table.
 *
 * Output (stdout): one `key=value` line per fact, suitable for $GITHUB_OUTPUT.
 *   version=<highest selectable semver published>
 *   stable=<highest semver without a prerelease suffix, or empty>
 *   node=<engines.node exact version, or project fallback>
 *   dist_tags=<comma separated tag:version pairs>
 *   published_versions=<number of parseable published versions>
 *   blocked=<comma separated published versions excluded by BLOCKED_VERSIONS, or empty>
 *
 * Flags:
 *   --version=<x.y.z>   use this exact published version instead of resolving
 *   --pick=all|stable   which version to report as `version` (default: all)
 *   --json              print a JSON object instead of key=value lines
 *   --registry=<url>    npm registry to query (default: https://registry.npmjs.org)
 *   --fallback-node=…   Node version to use when upstream gives a range or no version
 */
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/**
 * Published upstream releases this image must never select.
 *
 * A release that cannot start is not a build the pipeline may work around: there is no
 * image to verify, and re-selecting an older release only hides the failure. So the
 * resolver never returns one of these — not automatically, and not through the manual
 * `version` input — and `scripts/test-resolve-dsh-version.mjs` proves both.
 *
 * Each entry states the measured failure, the date, and what clears it. A new upstream
 * release is selected automatically, so the entry is simply dropped then; if only the
 * missing dependency is published, the same version becomes buildable and the entry has
 * to be removed by hand. Do not add an entry for a release that merely behaves
 * differently (a changed API, a moved endpoint): the smoke gate reports those, and a red
 * gate is how a compatibility break is supposed to look.
 */
export const BLOCKED_VERSIONS = new Map([
  [
    '0.2.3-alpha.1',
    'unstartable (measured 2026-11-22): `@deepseek-ai/dsh-app-boot` imports ' +
      '`EntryValidationError` from `@deepseek-ai/cordis-plugin-loader`, which does not export it. ' +
      '1.1.0 is the newest published loader and the dependency range `~1.1.0` admits nothing ' +
      'else, so `node lib/bin.js` exits with that SyntaxError before `dsh web` prints a launch ' +
      'token and the container never serves. Clear this entry when a release whose closure ' +
      'exports `EntryValidationError` is published.',
  ],
])

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return fallback
  const [, value] = hit.split('=')
  return value === undefined ? true : value
}

/** Parse `1.2.3-alpha.4+build` into comparable parts, or return undefined. */
function parseSemver(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim())
  if (match === null) return undefined
  return {
    raw: match[0].replace(/^v/, ''),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
    isPrerelease: match[4] !== undefined,
  }
}

function comparePrereleaseIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1 // numeric identifiers rank below alphanumeric ones
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence; a version without a prerelease outranks one with it. */
function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const delta = comparePrereleaseIdentifiers(left, right)
    if (delta !== 0) return delta
  }
  return 0
}

/**
 * Parse every published version, drop the ones that are not semver, and sort by
 * descending precedence.
 * @param published - published version strings, as the packument lists them.
 * @returns comparable versions, highest first.
 */
export function sortVersions(published) {
  return published
    .map((value) => parseSemver(value))
    .filter((value) => value !== undefined)
    .sort((a, b) => compareSemver(b, a))
}

/**
 * Choose the version to build. Pure and offline so the checks can call it directly.
 * @param published - published version strings.
 * @param options - `{ pick, requested, blocked, packageName }`; `requested` is the
 *   operator's `--version` value (`true` when the flag carried no value).
 * @returns `{ selected, highest, highestStable, blocked }`.
 */
export function selectVersion(published, options = {}) {
  const {
    pick = 'all',
    requested = '',
    blocked = BLOCKED_VERSIONS,
    packageName = '@deepseek-ai/dsh',
  } = options
  const versions = sortVersions(published)
  if (versions.length === 0) throw new Error(`${packageName} has no parseable published versions`)
  const skipped = versions.filter((value) => blocked.has(value.raw)).map((value) => value.raw)
  const allowed = versions.filter((value) => !blocked.has(value.raw))
  const highest = allowed[0]
  const highestStable = allowed.find((value) => !value.isPrerelease)

  const wanted = String(requested ?? '').trim()
  if (wanted !== '' && wanted !== 'true') {
    const exact = versions.find((value) => value.raw === wanted || value.raw === wanted.replace(/^v/, ''))
    if (exact === undefined) throw new Error(`${wanted} is not published under ${packageName}`)
    if (blocked.has(exact.raw)) {
      throw new Error(`${exact.raw} is excluded and cannot be built: ${blocked.get(exact.raw)}`)
    }
    return { selected: exact, highest, highestStable, blocked: skipped }
  }

  const selected = pick === 'stable' ? highestStable : highest
  if (selected === undefined) {
    throw new Error(
      pick === 'stable'
        ? `${packageName} has no selectable stable (non-prerelease) version`
        : `${packageName} has no selectable published version`,
    )
  }
  return { selected, highest, highestStable, blocked: skipped }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-image-release' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`${url} responded ${response.status}`)
  return response.json()
}

async function main() {
  const registry = String(flag('registry', 'https://registry.npmjs.org')).replace(/\/+$/, '')
  const pick = String(flag('pick', 'all'))
  const asJson = Boolean(flag('json', false))
  const fallbackNode = String(flag('fallback-node', process.env.DEFAULT_NODE_VERSION ?? '24.21.0'))
  const packageName = String(flag('package', '@deepseek-ai/dsh'))

  if (!['all', 'stable'].includes(pick)) {
    console.error(`resolve-dsh-version: --pick must be "all" or "stable" (got "${pick}")`)
    process.exit(2)
  }

  const packument = await fetchJson(`${registry}/${encodeURIComponent(packageName)}`)
  const published = Object.keys(packument.versions ?? {})
  const { selected, highestStable, blocked } = selectVersion(published, {
    pick,
    requested: flag('version', ''),
    packageName,
  })

  const manifest = packument.versions[selected.raw] ?? {}
  const enginesNode = typeof manifest.engines?.node === 'string' ? manifest.engines.node.trim() : ''
  const nodeVersion = /^\d+\.\d+\.\d+$/.test(enginesNode) ? enginesNode : fallbackNode
  const distTags = Object.entries(packument['dist-tags'] ?? {})
    .map(([tag, value]) => `${tag}:${value}`)
    .sort()
    .join(',')

  const result = {
    package: packageName,
    version: selected.raw,
    stable: highestStable?.raw ?? '',
    node: nodeVersion,
    engines_node_raw: enginesNode,
    dist_tags: distTags,
    published_versions: sortVersions(published).length,
    blocked: blocked.join(','),
    pick,
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    for (const [key, value] of Object.entries(result)) {
      process.stdout.write(`${key}=${value}\n`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`resolve-dsh-version: ${error.message}`)
    process.exitCode = 1
  })
}
