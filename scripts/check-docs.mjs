#!/usr/bin/env node
/**
 * Documentation gate.
 *
 * The README is the front page of this repository and it exists in two languages, which
 * is exactly the setup that drifts: a section added to one file, an anchor renamed, a
 * Chinese page linking the English document. None of that breaks a build, so nothing
 * catches it — this does. No dependencies, no network.
 *
 * Checks:
 *   1. every in-file link `](#anchor)` resolves to a heading of that same file
 *   2. every relative link points at a file that exists
 *   3. a `*.zh-CN.md` page links the `.zh-CN` variant of a page that has one
 *   4. each document and its translation (including README.md / README.en.md) have the same number of `##` sections and
 *      mention the same `SETTING_NAMES` (env vars in code spans)
 *
 * Usage:
 *   node scripts/check-docs.mjs                 # the repository
 *   node scripts/check-docs.mjs --root=<dir>    # any tree (used by --self-test)
 *   node scripts/check-docs.mjs --self-test     # prove the checks still catch things
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every markdown file in the tree, minus the places that hold no documentation. */
function markdownFiles(root) {
  const skip = new Set(['.git', 'node_modules', '.codegraph']);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** GitHub's heading anchor, near enough: links and HTML out, punctuation out, spaces to dashes. */
function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

/** Headings and links of one file, ignoring anything inside a fenced code block. */
function scan(file) {
  const text = readFileSync(file, 'utf8');
  const headings = [];
  const links = [];
  let fence = null;
  let firstHeading = 0;
  text.split('\n').forEach((line, index) => {
    const at = index + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      fence = fence ? null : 'fenced';
      return;
    }
    if (fence) return;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (firstHeading === 0) firstHeading = at;
      headings.push({ level: heading[1].length, text: heading[2] });
    }
    for (const link of line.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)) links.push({ target: link[1], line: at });
  });
  return { text, headings, links, firstHeading };
}

/** Anchors a file offers, with GitHub's -1/-2 suffixes for repeated headings. */
function anchorsOf(headings) {
  const seen = new Map();
  const anchors = new Set();
  for (const heading of headings) {
    const base = slugify(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Environment-variable-shaped names in code spans; the part of a doc that must not drift. */
function settingNames(text) {
  return new Set([...text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((match) => match[1]));
}

function checkTree(root) {
  const failures = [];
  const files = markdownFiles(root);
  const scans = new Map(files.map((file) => [file, scan(file)]));
  const rel = (file) => relative(root, file).split(sep).join('/') || '.';

  for (const file of files) {
    const { headings, links, firstHeading } = scans.get(file);
    const anchors = anchorsOf(headings);
    const onSameLine = (link, wanted) =>
      links.some((other) => other.line === link.line && other.target.endsWith(wanted));
    for (const link of links) {
      const { target, line } = link;
      if (/^(https?:|mailto:|tel:)/.test(target)) continue;
      if (target.startsWith('#')) {
        const wanted = decode(target.slice(1)).toLowerCase();
        if (!anchors.has(wanted)) {
          failures.push(`${rel(file)}:${line}: anchor "${target}" matches no heading in this file`);
        }
        continue;
      }
      const targetPath = decode(target.split('#')[0]);
      if (targetPath === '') continue;
      if (!existsSync(resolve(dirname(file), targetPath))) {
        failures.push(`${rel(file)}:${line}: link target "${targetPath}" does not exist`);
        continue;
      }
      // A Chinese page must not send its reader into an English document when a
      // translated one sits next to it. Two deliberate exceptions: the language
      // switcher above the title, and a line that names both variants on purpose.
      if (
        (/\.zh-CN\.md$/.test(file) || rel(file) === 'README.md') &&
        targetPath.endsWith('.md') &&
        !targetPath.endsWith('.zh-CN.md') &&
        line > firstHeading &&
        !onSameLine(link, '.zh-CN.md')
      ) {
        const translated = `${targetPath.slice(0, -'.md'.length)}.zh-CN.md`;
        if (resolve(dirname(file), targetPath) !== resolve(root, 'README.md') &&
            resolve(dirname(file), translated) !== file && existsSync(resolve(dirname(file), translated))) {
          failures.push(
            `${rel(file)}:${line}: links "${targetPath}", but ` +
              `"${relative(dirname(file), resolve(dirname(file), translated)).split(sep).join('/')}" exists`,
          );
        }
      }
    }
  }

  // Each document and its translation: same shape, same settings.
  for (const file of files) {
    if (file.endsWith('.zh-CN.md') || rel(file) === 'README.en.md') continue;
    const translated = rel(file) === 'README.md' ? resolve(root, 'README.en.md') : file.replace(/\.md$/, '.zh-CN.md');
    if (!existsSync(translated)) continue;
    const source = scans.get(file);
    const mirror = scans.get(translated);
    const count = (scan) => scan.headings.filter((heading) => heading.level === 2).length;
    if (count(source) !== count(mirror)) {
      failures.push(
        `${rel(file)} has ${count(source)} "##" sections, ${rel(translated)} has ${count(mirror)} — ` +
          'the two are kept in step',
      );
    }
    const sourceNames = settingNames(source.text);
    const mirrorNames = settingNames(mirror.text);
    const missing = [...sourceNames].filter((name) => !mirrorNames.has(name));
    const extra = [...mirrorNames].filter((name) => !sourceNames.has(name));
    if (missing.length || extra.length) {
      failures.push(
        `${rel(file)} / ${rel(translated)} disagree on settings: ` +
          [
            missing.length ? `${missing.join(', ')} only in ${rel(file)}` : '',
            extra.length ? `${extra.join(', ')} only in ${rel(translated)}` : '',
          ]
            .filter(Boolean)
            .join('; '),
      );
    }
  }

  return failures;
}

function report(root, label) {
  const failures = checkTree(root);
  if (failures.length) {
    console.error(`docs gate failed (${label}):`);
    for (const failure of failures) console.error(`  ${failure}`);
    return failures;
  }
  console.log(`docs ok: ${label}`);
  return failures;
}

/** Fixtures that must fail and a fixture that must pass — the gate is only worth having if it bites. */
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-docs-'));
  const write = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  try {
    write('docs/guide.md', '# Guide\n\n## Section\n\nSee [the other one](other.md) and [here](#section).\n');
    write('docs/other.md', '# Other\n\n## A\n\n`ALLOWED_CLIENTS`\n');
    write('docs/guide.zh-CN.md', '# 指南\n\n## 小节\n\n见 [other](other.md)。\n');
    // The translation drifts: one section too many, and it lost a setting name.
    write('docs/other.zh-CN.md', '# 其他\n\n## 甲\n\n## 乙\n\n`AUTH_MODE`\n');
    write('README.md', '# 首页\n\n## 设置\n\n`AUTH_MODE`\n');
    write('README.en.md', '# Readme\n\n## Settings\n\n`AUTH_MODE`\n');
    write('README.zh-CN.md', '# 中文\n\n[首页](README.md)\n');
    write('broken.md', '# Broken\n\n## One\n\n[a](#nope) [b](missing.md)\n');

    const clean = checkTree(root);
    const expected = [
      // guide.zh-CN links the English other.md although a translation exists
      'links "other.md"',
      // the two tracks of docs/other.md no longer describe the same document
      'the two are kept in step',
      'disagree on settings',
      // anchors and link targets that go nowhere
      'broken.md:5: anchor "#nope"',
      'broken.md:5: link target "missing.md" does not exist',
    ];
    const missed = expected.filter((needle) => !clean.some((failure) => failure.includes(needle)));
    const unexpected = clean.filter((failure) => !expected.some((needle) => failure.includes(needle)));
    if (missed.length || unexpected.length) {
      console.error('docs gate self-test FAILED');
      for (const failure of missed) console.error(`  not reported: ${failure}`);
      for (const failure of unexpected) console.error(`  reported though not planted: ${failure}`);
      return 1;
    }
    write('README.en.md', '# Readme\n\n## Settings\n\n`OTHER_SETTING`\n');
    if (!checkTree(root).some((failure) => failure.includes('README.md / README.en.md disagree on settings'))) {
      console.error('docs gate self-test FAILED: README language drift was not reported');
      return 1;
    }
    console.log('docs gate self-test ok: every planted mistake was reported');
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const flag = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`));
const root = flag('root') ? resolve(flag('root').split('=')[1]) : repoRoot;

if (process.argv.includes('--self-test')) process.exit(selfTest());
process.exit(report(root, relative(process.cwd(), root) || '.').length ? 1 : 0);
