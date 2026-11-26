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
 * and take the highest.
 *
 * Output (stdout): one `key=value` line per fact, suitable for $GITHUB_OUTPUT.
 *   version=<selected version>
 *   newest=true|false, whether that version is the highest published
 *   stable=<highest semver without a prerelease suffix, or empty>
 *   node=<exact Node version to build with>
 *   engines_node_raw=<the selected release's engines.node, verbatim>
 *   node_source=engines-exact|engines-range-floor|fallback
 *   dist_tags=<comma separated tag:version pairs>
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

const flag = (args, name, fallback) => {
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
 * Which exact Node version to build with, from upstream's `engines.node`.
 *
 * An exact version is used verbatim — that is what upstream tested. A range cannot be
 * built as-is, so the project fallback is used, but only while it still satisfies the
 * range. When upstream raises its floor above the fallback, keeping the fallback ships a
 * runtime upstream no longer supports: measured 2026-11-22, `dsh` 0.2.3-alpha.2 declares
 * `^24.22.3 || >=26.13.1`, and that is exactly the shape a stale fallback (24.21.0)
 * silently missed — including the November 2026 undici security fixes that release names.
 * The range's own lowest named version is then the reproducible answer, preferring the
 * fallback's major so a patch-level floor bump does not also change the Node line.
 *
 * This is deliberately not a semver-range evaluator: only the floors a range names are
 * read, which covers `^`, `~`, `>=` and `||` shapes upstream uses.
 *
 * @param enginesNode - upstream's `engines.node`, or anything else.
 * @param fallback - the project fallback, an exact version.
 * @returns `{ node, source }`, source being `engines-exact`, `engines-range-floor` or `fallback`.
 */
export function resolveNodeVersion(enginesNode, fallback) {
  const range = typeof enginesNode === 'string' ? enginesNode.trim() : ''
  const fallbackVersion = /^\d+\.\d+\.\d+$/.test(String(fallback)) ? String(fallback) : '24.22.3'
  if (/^\d+\.\d+\.\d+$/.test(range)) return { node: range, source: 'engines-exact' }
  if (range === '') return { node: fallbackVersion, source: 'fallback' }
  const floors = [...range.matchAll(/(\d+)\.(\d+)\.(\d+)/g)]
    .map((match) => parseSemver(match[0]))
    .filter((value) => value !== undefined)
  if (floors.length === 0) return { node: fallbackVersion, source: 'fallback' }
  const current = parseSemver(fallbackVersion)
  const sameMajor = floors.filter((value) => value.major === current.major).sort(compareSemver)[0]
  const lowest = [...floors].sort(compareSemver)[0]
  const candidate = sameMajor ?? lowest
  if (compareSemver(candidate, current) <= 0) return { node: fallbackVersion, source: 'fallback' }
  return { node: candidate.raw, source: 'engines-range-floor' }
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
  const args = process.argv.slice(2)
  const registry = String(flag(args, 'registry', 'https://registry.npmjs.org')).replace(/\/+$/, '')
  const pick = String(flag(args, 'pick', 'all'))
  const asJson = Boolean(flag(args, 'json', false))
  const fallbackNode = String(flag(args, 'fallback-node', process.env.DEFAULT_NODE_VERSION ?? '24.22.3'))
  const packageName = String(flag(args, 'package', '@deepseek-ai/dsh'))

  if (!['all', 'stable'].includes(pick)) {
    console.error(`resolve-dsh-version: --pick must be "all" or "stable" (got "${pick}")`)
    process.exit(2)
  }

  const packument = await fetchJson(`${registry}/${encodeURIComponent(packageName)}`)
  const versions = Object.keys(packument.versions ?? {})
    .map((value) => parseSemver(value))
    .filter((value) => value !== undefined)
    .sort((a, b) => compareSemver(b, a))

  if (versions.length === 0) {
    console.error(`resolve-dsh-version: ${packageName} has no parseable published versions`)
    process.exit(1)
  }

  const highest = versions[0]
  const highestStable = versions.find((value) => !value.isPrerelease)
  const requested = String(flag(args, 'version', '')).trim()
  let selected = pick === 'stable' ? highestStable : highest

  if (requested !== '' && requested !== 'true') {
    const exact = versions.find((value) => value.raw === requested || value.raw === requested.replace(/^v/, ''))
    if (exact === undefined) {
      console.error(`resolve-dsh-version: ${requested} is not published under ${packageName}`)
      process.exit(1)
    }
    selected = exact
  }

  if (selected === undefined) {
    console.error(`resolve-dsh-version: ${packageName} has no stable (non-prerelease) version`)
    process.exit(1)
  }

  const manifest = packument.versions[selected.raw] ?? {}
  const enginesNode = typeof manifest.engines?.node === 'string' ? manifest.engines.node.trim() : ''
  const { node: nodeVersion, source: nodeSource } = resolveNodeVersion(enginesNode, fallbackNode)
  const distTags = Object.entries(packument['dist-tags'] ?? {})
    .map(([tag, value]) => `${tag}:${value}`)
    .sort()
    .join(',')

  const result = {
    package: packageName,
    version: selected.raw,
    newest: selected.raw === highest.raw ? 'true' : 'false',
    stable: highestStable?.raw ?? '',
    node: nodeVersion,
    engines_node_raw: enginesNode,
    node_source: nodeSource,
    dist_tags: distTags,
    published_versions: versions.length,
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
