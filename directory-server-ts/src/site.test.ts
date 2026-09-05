import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Seed } from './seed.ts';
import { HEADERS, MANIFEST_PATH, readSiteManifest, withSiteLock, writeSite } from './site.ts';

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

  it('refuses a seed older than the one the manifest names', async () => {
    const hour = 3_600_000;
    const older = seed('{"version":3,"consensus":"older"}');
    const newer = seed('{"version":3,"consensus":"newer"}', new Date(VALID_AFTER.getTime() + hour));

    await writeSite(site, newer);
    await expect(writeSite(site, older)).rejects.toThrow('already has a newer seed');
    expect((await readSiteManifest(site))?.url).toBe(`/api/directory/${newer.name}.json.gz`);
    expect(await seedFiles()).toEqual([`${newer.name}.json.gz`]);
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

describe('withSiteLock', () => {
  const lock = () => path.join(site, '.lock');

  it('holds the lock while publishing and releases it after, even on failure', async () => {
    const held: string[] = [];
    const result = await withSiteLock(site, async () => {
      held.push(await fs.readFile(lock(), 'utf8'));
      return 'published';
    });
    expect(result).toBe('published');
    expect(held).toEqual([String(process.pid)]);
    expect(await fs.exists(lock())).toBe(false);

    await expect(
      withSiteLock(site, async () => {
        throw new Error('deploy failed');
      }),
    ).rejects.toThrow('deploy failed');
    expect(await fs.exists(lock())).toBe(false);
  });

  it('fails at once while another running process holds the lock', async () => {
    await fs.writeFile(lock(), String(process.pid));
    await expect(withSiteLock(site, async () => 'published')).rejects.toThrow(
      `another publish (pid ${process.pid}) holds`,
    );
    expect(await fs.readFile(lock(), 'utf8')).toBe(String(process.pid));
  });

  it('takes over a lock whose owner is gone', async () => {
    const gone = Bun.spawnSync(['true']).pid;
    await fs.writeFile(lock(), String(gone));
    expect(await withSiteLock(site, async () => 'published')).toBe('published');
    expect(await fs.exists(lock())).toBe(false);
  });
});
