import { describe, expect, it } from 'bun:test';
import { Authorities } from './authority.ts';
import { CERTIFICATES, certificate, consensus, microdescriptor } from './fixtures.ts';
import { DIGESTS_PER_REQUEST } from './seed.ts';

/**
 * Authorities that answer from a table instead of the network: the consensus
 * and certificates always, and each microdescriptor batch as `batches` says.
 */
function fake(
  relays: number,
  batches: (index: number) => string | Error,
  certificates: string = CERTIFICATES,
) {
  const authorities = new Authorities(['http://authority.test']);
  const asked: string[] = [];
  let batch = 0;
  authorities.get = async (path: string) => {
    asked.push(path);
    if (path.startsWith('/tor/status-vote/')) return consensus(relays, 5);
    if (path.startsWith('/tor/keys/')) return certificates;
    const answer = batches(batch++);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { authorities, asked };
}

/** Batch `index` of the microdescriptors, `count` of them, the last missing its final newline. */
function batch(index: number, count = DIGESTS_PER_REQUEST): string {
  return Array.from({ length: count }, (_, offset) => microdescriptor(index * DIGESTS_PER_REQUEST + offset))
    .join('')
    .replace(/\n$/, '');
}

describe('building a seed', () => {
  it('survives a batch no authority serves when most microdescriptors arrived', async () => {
    const relays = DIGESTS_PER_REQUEST * 2 + 20;
    const logged: string[] = [];
    const { authorities, asked } = fake(relays, (index) =>
      index === 2 ? new Error('no directory authority served it') : batch(index),
    );
    const seed = await authorities.buildSeed((line) => logged.push(line));
    expect(asked.filter((path) => path.startsWith('/tor/micro/d/'))).toHaveLength(3);
    expect(logged.some((line) => line.startsWith('Microdescriptor batch 3/3 failed'))).toBe(true);
    expect(seed.relays).toBe(relays);
    // Each body was made to end its last line, so the documents stay apart.
    const { microdescriptors } = JSON.parse(seed.encoded) as { microdescriptors: string };
    expect(microdescriptors.match(/^onion-key$/gm)).toHaveLength(DIGESTS_PER_REQUEST * 2);
    expect(microdescriptors.includes('xonion-key')).toBe(false);
  });

  it('refuses a seed when too many microdescriptors are missing', async () => {
    const { authorities } = fake(DIGESTS_PER_REQUEST * 2, (index) =>
      index === 1 ? new Error('no directory authority served it') : batch(index),
    );
    await expect(authorities.buildSeed()).rejects.toThrow('too few for a seed');
  });

  it('does not let a repeated batch stand in for the missing ones', async () => {
    // Two batches wanted, the first served twice: as many microdescriptors as
    // asked for, but half the relays still have none.
    const { authorities } = fake(DIGESTS_PER_REQUEST * 2, () => batch(0));
    await expect(authorities.buildSeed()).rejects.toThrow('too few for a seed');
  });

  it('does not let repeated or unrelated certificates reach the threshold', async () => {
    const repeated = fake(120, batch, certificate(0).repeat(5));
    await expect(repeated.authorities.buildSeed()).rejects.toThrow(
      'certificates for 1 signing authorities',
    );
    // Four of the five signers' certificates, and one for an authority that did not sign.
    const stranger = fake(120, batch, CERTIFICATES.replace(certificate(4), certificate(5)));
    await expect(stranger.authorities.buildSeed()).rejects.toThrow(
      'certificates for 4 signing authorities',
    );
  });
});
