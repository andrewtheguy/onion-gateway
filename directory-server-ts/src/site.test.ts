import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Seed } from './seed.ts';
import { HEADERS, MANIFEST_PATH, readSiteManifest, writeSite } from './site.ts';

const VALID_AFTER = new Date('2026-09-04T18:00:00Z');
function seed(encoded: string, validAfter = VALID_AFTER): Seed {
  const hour = 3_600_000;
  return {
    name: `${validAfter.toISOString().replace(/[-:]|\.\d{3}/g, '')}-${Bun.hash(encoded).toString(16).padStart(16, '0').slice(0, 16)}`,
    encoded,
    validAfter,
    freshUntil: new Date(validAfter.getTime() + hour),
    validUntil: new Date(validAfter.getTime() + 3 * hour),
    relays: 9000,
  };
}

let site: string;
beforeEach(async () => {
  site = await fs.mkdtemp(path.join(os.tmpdir(), 'webtor-site-'));
});
afterEach(async () => {
  await fs.rm(site, { recursive: true, force: true });
});

const seedFiles = async () => (await fs.readdir(path.join(site, 'api', 'directory'))).sort();

describe('writeSite', () => {
  it('lays out the manifest, the gzipped seed and the headers file', async () => {
    const one = seed('{"version":3,"consensus":"one"}');
    const { manifest, gzipBytes } = await writeSite(site, one);

    expect(manifest).toEqual({
      url: `/api/directory/${one.name}.json.gz`,
      validAfter: '2026-09-04T18:00:00Z',
      freshUntil: '2026-09-04T19:00:00Z',
      validUntil: '2026-09-04T21:00:00Z',
      bytes: Buffer.byteLength(one.encoded),
      relays: 9000,
    });
    expect(await readSiteManifest(site)).toEqual(manifest);
    expect(await fs.readFile(path.join(site, '_headers'), 'utf8')).toBe(HEADERS);

    const gzipped = await fs.readFile(path.join(site, manifest.url));
    expect(gzipped.byteLength).toBe(gzipBytes);
    expect(Buffer.from(Bun.gunzipSync(gzipped)).toString()).toBe(one.encoded);
    expect(await seedFiles()).toEqual([`${one.name}.json.gz`]);
    expect(await fs.readdir(path.join(site, 'api'))).toEqual(['directory', 'directory.json']);
  });

  it('keeps the seed the previous manifest named and drops older ones', async () => {
    const hour = 3_600_000;
    const one = seed('{"version":3,"consensus":"one"}');
    const two = seed('{"version":3,"consensus":"two"}', new Date(VALID_AFTER.getTime() + hour));
    const three = seed('{"version":3,"consensus":"three"}', new Date(VALID_AFTER.getTime() + 2 * hour));

    await writeSite(site, one);
    await writeSite(site, two);
    expect(await seedFiles()).toEqual([`${one.name}.json.gz`, `${two.name}.json.gz`]);

    await writeSite(site, three);
    expect(await seedFiles()).toEqual([`${two.name}.json.gz`, `${three.name}.json.gz`]);
    expect((await readSiteManifest(site))?.url).toBe(`/api/directory/${three.name}.json.gz`);
  });

  it('gives the manifest and the seeds header rules that do not overlap', () => {
    const rules = HEADERS.split('\n').filter((line) => line && !line.startsWith(' '));
    expect(rules).toEqual([MANIFEST_PATH, '/api/directory/*']);
    expect(HEADERS).toContain('Cache-Control: no-cache');
    expect(HEADERS).toContain('Cache-Control: public, max-age=31536000, immutable');
    expect(HEADERS.match(/Access-Control-Allow-Origin: \*/g)).toHaveLength(2);
  });

  it('reads no manifest from an empty site', async () => {
    expect(await readSiteManifest(site)).toBeNull();
  });
});
