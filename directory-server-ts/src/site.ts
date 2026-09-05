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
// fetching it.

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
 * Lay `seed` out as the site's current one: its gzipped form, the manifest
 * naming it, the headers file, and no seed but it and the one the manifest
 * named before. Returns the manifest and the published size.
 */
export async function writeSite(site: string, seed: Seed): Promise<{ manifest: Manifest; gzipBytes: number }> {
  const seeds = path.join(site, SEED_URL_PREFIX);
  await fs.mkdir(seeds, { recursive: true });
  const previous = await readSiteManifest(site);
  const keep = new Set([seed.name, ...(previous ? [seedName(previous)] : [])]);

  const gzipped = Bun.gzipSync(Buffer.from(seed.encoded), { level: 9 });
  await fs.writeFile(path.join(seeds, `${seed.name}.json.gz`), gzipped);
  await fs.writeFile(path.join(site, '_headers'), HEADERS);

  const manifest = siteManifestFor(seed);
  const manifestPath = path.join(site, MANIFEST_PATH);
  await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2));
  await fs.rename(`${manifestPath}.tmp`, manifestPath);

  for (const entry of await fs.readdir(seeds)) {
    const name = entry.replace(/\.json\.gz$/, '');
    if (name !== entry && !keep.has(name)) {
      await fs.rm(path.join(seeds, entry));
    }
  }
  return { manifest, gzipBytes: gzipped.byteLength };
}
