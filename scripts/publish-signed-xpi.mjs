#!/usr/bin/env node
// Downloads the Mozilla-signed XPI of a released version from addons.mozilla.org
// and attaches it to the matching GitHub release, publishing the release draft.
//
// Usage:
//   node scripts/publish-signed-xpi.mjs --tag v1.2.3 [--wait-minutes 20] [--dry-run]
//   node scripts/publish-signed-xpi.mjs --all-pending [--wait-minutes 0] [--dry-run]
//
// A version that is not signed yet is not an error: the script reports it and
// exits with 0, so the scheduled "Attach signed XPI" workflow can pick it up later.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AMO_API = 'https://addons.mozilla.org/api/v5';
const POLL_INTERVAL_MS = 60_000;

function parseArgs(argv) {
  const options = { tag: null, allPending: false, waitMinutes: 0, dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--tag':
        options.tag = argv[i += 1];
        break;
      case '--all-pending':
        options.allPending = true;
        break;
      case '--wait-minutes':
        options.waitMinutes = Number(argv[i += 1]);
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.tag && !options.allPending) {
    throw new Error('Either --tag <tag> or --all-pending is required.');
  }
  if (!Number.isFinite(options.waitMinutes) || options.waitMinutes < 0) {
    throw new Error('--wait-minutes expects a non-negative number.');
  }

  return options;
}

function readAddonId() {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  const id = manifest.browser_specific_settings?.gecko?.id;

  if (!id) {
    throw new Error('No browser_specific_settings.gecko.id in manifest.json.');
  }

  return id;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function versionFromTag(tag) {
  return tag.replace(/^v/, '');
}

function note(message) {
  console.log(message);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    appendFileSync(summaryFile, `${message}\n`);
  }
}

// Draft releases tagged v* that have no XPI asset yet.
function findPendingTags() {
  const releases = JSON.parse(gh(['release', 'list', '--limit', '50', '--json', 'tagName,isDraft']));
  const pending = [];

  for (const release of releases) {
    if (!release.isDraft || !release.tagName.startsWith('v')) {
      continue;
    }

    const { assets } = JSON.parse(gh(['release', 'view', release.tagName, '--json', 'assets']));
    if (!assets.some((asset) => asset.name.endsWith('.xpi'))) {
      pending.push(release.tagName);
    }
  }

  return pending;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });

  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchPublicVersions(addonId) {
  const url = `${AMO_API}/addons/addon/${encodeURIComponent(addonId)}/versions/?page_size=20`;
  const { results } = await fetchJson(url);
  const byVersion = new Map();

  for (const entry of results ?? []) {
    if (entry.file?.status === 'public' && entry.file.url) {
      byVersion.set(entry.version, entry.file);
    }
  }

  return byVersion;
}

async function downloadSignedFile(file, version) {
  const response = await fetch(file.url);

  if (!response.ok) {
    throw new Error(`Download of ${file.url} failed: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = String(file.hash).split(':');

  if (!algorithm || !expected) {
    throw new Error(`Unexpected hash format from AMO: ${file.hash}`);
  }

  const actual = createHash(algorithm).update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${file.url}: expected ${algorithm}:${expected}, got ${algorithm}:${actual}`);
  }

  const target = path.join(mkdtempSync(path.join(tmpdir(), 'signed-xpi-')), `sci-hub-opener-${version}.xpi`);
  writeFileSync(target, bytes);
  console.log(`Downloaded ${file.url} (${bytes.length} bytes, ${algorithm} verified) to ${target}`);

  return target;
}

async function attach(tag, file, { dryRun }) {
  const version = versionFromTag(tag);
  const xpiPath = await downloadSignedFile(file, version);

  if (dryRun) {
    note(`Dry run: would attach ${path.basename(xpiPath)} to release ${tag} and publish it.`);
    return;
  }

  gh(['release', 'upload', tag, xpiPath, '--clobber']);
  gh(['release', 'edit', tag, '--draft=false']);
  note(`Attached the signed XPI for ${version} to release ${tag} and published the release.`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const addonId = readAddonId();
  const pending = options.tag ? [options.tag] : findPendingTags();

  if (pending.length === 0) {
    console.log('No draft releases are waiting for a signed XPI.');
    return;
  }

  console.log(`Waiting for signed builds of ${addonId}: ${pending.join(', ')}`);

  const deadline = Date.now() + options.waitMinutes * 60_000;
  let remaining = pending;

  for (;;) {
    const publicVersions = await fetchPublicVersions(addonId);
    const stillPending = [];

    for (const tag of remaining) {
      const file = publicVersions.get(versionFromTag(tag));

      if (file) {
        await attach(tag, file, options);
      } else {
        stillPending.push(tag);
      }
    }

    remaining = stillPending;

    if (remaining.length === 0 || Date.now() + POLL_INTERVAL_MS > deadline) {
      break;
    }

    console.log(`Not signed yet: ${remaining.join(', ')}. Checking again in 60s.`);
    await sleep(POLL_INTERVAL_MS);
  }

  for (const tag of remaining) {
    const version = versionFromTag(tag);
    console.log(`::warning::Version ${version} is not approved on addons.mozilla.org yet; release ${tag} stays a draft.`);
    note(`Version ${version} is still in review on addons.mozilla.org. The "Attach signed XPI" workflow will publish release ${tag} once the signed file is available.`);
  }
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
});
