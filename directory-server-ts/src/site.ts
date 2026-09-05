// The directory as a static site: what `bun run tor:publish` uploads to a
// host that serves files and nothing else, Cloudflare Workers static assets
// being the one `wrangler.toml` names.
//
//   <site>/_headers                         CORS and caching, in the host's format
//   <site>/api/directory.json               the manifest
//   <site>/api/directory/<name>.json.gz     a seed, gzipped, and only gzipped
//
// Only the gzipped seed is published: the host caps a file at 25 MiB, a
// seed is some forty megabytes, and gzip roughly halves it. The manifest's
// `url` therefore ends in `.json.gz`, and a client inflates what it fetches.
// The manifest is not at `/api/directory` as the servers answer it, because a
// static host cannot have a file and a directory of the same name; a
// deployment points the client at `/api/directory.json` instead.
//
// The seed a previous manifest named is kept for one more publish, as the
// store does: a worker that read the old manifest a moment ago is still
// fetching it. A seed older than the one the manifest names is refused, so a
// publish that ran long cannot put back what a later one replaced; and
// `withSiteLock` keeps two publishes from laying out and deploying at once.

import fs from 'node:fs/promises';
import path from 'node:path';
import { iso8601, type Seed } from './seed.ts';
import { type Manifest } from './store.ts';

export const MANIFEST_PATH = '/api/directory.json';
export const SEED_URL_PREFIX = '/api/directory/';

/**
 * Cloudflare joins the values of a header set by every matching rule, so the
 * manifest and the seeds get rules whose patterns do not overlap: `.json`
 * is not under `/api/directory/`.
 */
export const HEADERS = `${MANIFEST_PATH}
  Access-Control-Allow-Origin: *
  Cache-Control: no-cache

${SEED_URL_PREFIX}*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/gzip
`;

export function siteManifestFor(seed: Seed): Manifest {
  return {
    url: `${SEED_URL_PREFIX}${seed.name}.json.gz`,
    validAfter: iso8601(seed.validAfter),
    freshUntil: iso8601(seed.freshUntil),
    validUntil: iso8601(seed.validUntil),
    bytes: Buffer.byteLength(seed.encoded),
    relays: seed.relays,
  };
}

/** The seed name a site manifest's `url` ends in. */
function seedName(manifest: Manifest): string {
  return path.posix.basename(manifest.url, '.json.gz');
}

export async function readSiteManifest(site: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(site, MANIFEST_PATH), 'utf8')) as Manifest;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Run `publish` holding the site's lock, so that one process lays out and
 * deploys at a time. The lock is a file created exclusively, holding the
 * owner's pid; one whose owner is gone is taken over. A second publish
 * finding the lock held fails at once rather than waiting: the next hour's
 * run is soon enough.
 */
export async function withSiteLock<T>(site: string, publish: () => Promise<T>): Promise<T> {
  await fs.mkdir(site, { recursive: true });
  const lock = path.join(site, '.lock');
  for (;;) {
    try {
      await fs.writeFile(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = Number(await fs.readFile(lock, 'utf8').catch(() => ''));
    if (owner && isRunning(owner)) {
      throw new Error(`another publish (pid ${owner}) holds ${lock}`);
    }
    // The owner is gone. Renaming is atomic, so of several publishes that
    // find the same stale lock exactly one takes it over; the rest try again.
    const stale = `${lock}.${process.pid}.stale`;
    try {
      await fs.rename(lock, stale);
      await fs.rm(stale, { force: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  try {
    return await publish();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Lay `seed` out as the site's current one: its gzipped form, the manifest
 * naming it, the headers file, and no seed but it and the one the manifest
 * named before. Returns the manifest and the published size. Throws when
 * the manifest already names a newer seed.
 */
export async function writeSite(site: string, seed: Seed): Promise<{ manifest: Manifest; gzipBytes: number }> {
  const seeds = path.join(site, SEED_URL_PREFIX);
  await fs.mkdir(seeds, { recursive: true });
  const previous = await readSiteManifest(site);
  if (previous && new Date(previous.validAfter) > seed.validAfter) {
    throw new Error(`${site} already has a newer seed, valid from ${previous.validAfter}`);
  }
  const keep = new Set([seed.name, ...(previous ? [seedName(previous)] : [])]);

  const gzipped = Bun.gzipSync(Buffer.from(seed.encoded), { level: 9 });
  await fs.writeFile(path.join(seeds, `${seed.name}.json.gz`), gzipped);
  await fs.writeFile(path.join(site, '_headers'), HEADERS);

  const manifest = siteManifestFor(seed);
  const manifestPath = path.join(site, MANIFEST_PATH);
  const partial = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(partial, JSON.stringify(manifest, null, 2));
  await fs.rename(partial, manifestPath);

  for (const entry of await fs.readdir(seeds)) {
    const name = entry.replace(/\.json\.gz$/, '');
    if (name !== entry && !keep.has(name)) {
      await fs.rm(path.join(seeds, entry));
    }
  }
  return { manifest, gzipBytes: gzipped.byteLength };
}
