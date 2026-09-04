import { describe, expect, it } from 'bun:test';
import {
  assembleSeed,
  certificatesPath,
  compactUtc,
  countCertificates,
  countMicrodescriptors,
  DIGESTS_PER_REQUEST,
  iso8601,
  microdescriptorPaths,
  summarizeConsensus,
} from './seed.ts';
import { CERTIFICATES, certificate, consensus, digest, microdescriptor, signer } from './fixtures.ts';

describe('summarizing a consensus', () => {
  it('reads the lifetime, relays, digests and known signers', () => {
    const summary = summarizeConsensus(consensus(120, 5));
    expect(summary.validAfter.toISOString()).toBe('2026-09-04T18:00:00.000Z');
    expect(summary.freshUntil.toISOString()).toBe('2026-09-04T19:00:00.000Z');
    expect(summary.validUntil.toISOString()).toBe('2026-09-04T21:00:00.000Z');
    expect(summary.relays).toBe(120);
    expect(summary.digests).toHaveLength(120);
    expect(summary.digests[7]).toBe(digest(7));
    // The unknown authority in the footer is not one.
    expect(summary.signers).toHaveLength(5);
    expect(summary.signers[0]).toEqual(signer(0));
  });

  it('counts an authority signing with two keys once, and wants both certificates', () => {
    const rotating = [signer(0), signer(0, 9), signer(1), signer(2), signer(3)];
    expect(() => summarizeConsensus(consensus(120, rotating))).toThrow('signed by 4 known authorities');
    const summary = summarizeConsensus(consensus(120, [...rotating, signer(4)]));
    expect(summary.signers).toHaveLength(6);
  });

  it('deduplicates digests and ignores relays outside the footer', () => {
    const duplicate = consensus(120, 5).replace(`m ${digest(3)}`, `m ${digest(4)}`);
    expect(summarizeConsensus(duplicate).digests).toHaveLength(119);
  });

  it('refuses a consensus the client could never install', () => {
    expect(() => summarizeConsensus(consensus(120, 4))).toThrow('signed by 4 known authorities');
    expect(() => summarizeConsensus(consensus(50, 5))).toThrow('too few for a seed');
    expect(() => summarizeConsensus('network-status-version 3 microdesc\n')).toThrow('no valid-after line');
  });
});

describe('the documents a seed needs', () => {
  it('names the certificates by sorted lower-case fingerprint pairs', () => {
    expect(
      certificatesPath([
        { id: 'E8A9', sk: 'AAAA' },
        { id: '2710', sk: 'BBBB' },
      ]),
    ).toBe('/tor/keys/fp-sk/2710-bbbb+e8a9-aaaa');
  });

  it('batches microdescriptor digests by the URL length limit', () => {
    const digests = Array.from({ length: DIGESTS_PER_REQUEST * 2 + 1 }, (_, index) => digest(index));
    const paths = microdescriptorPaths(digests);
    expect(paths).toHaveLength(3);
    expect(paths[0]!.startsWith(`/tor/micro/d/${digest(0)}-${digest(1)}-`)).toBe(true);
    expect(paths[2]).toBe(`/tor/micro/d/${digest(DIGESTS_PER_REQUEST * 2)}`);
  });

  it('counts the certificates of the authorities that signed, by identity and signing key', () => {
    const signers = Array.from({ length: 5 }, (_, index) => signer(index));
    expect(countCertificates(CERTIFICATES, signers)).toBe(5);
    // The same certificate five times is one authority; a certificate for a
    // key the consensus was not signed with, or for an authority that did
    // not sign, is none.
    expect(countCertificates(certificate(0).repeat(5), signers)).toBe(1);
    expect(countCertificates(certificate(0, 9) + certificate(5), signers)).toBe(0);
    // Two certificates for one authority rotating keys are still one authority.
    expect(countCertificates(certificate(0) + certificate(0, 9), [signer(0), signer(0, 9)])).toBe(1);
    expect(countCertificates('dir-key-certificate-version 3\nx\n', signers)).toBe(0);
  });

  it('counts the microdescriptors the consensus asked for, by digest', () => {
    const digests = [digest(0), digest(1), digest(2)];
    expect(countMicrodescriptors(microdescriptor(0) + microdescriptor(1), digests)).toBe(2);
    // Repeats and strangers count for nothing.
    expect(countMicrodescriptors(microdescriptor(0).repeat(3), digests)).toBe(1);
    expect(countMicrodescriptors(microdescriptor(7) + 'onion-key\nx\n', digests)).toBe(0);
    expect(countMicrodescriptors('', digests)).toBe(0);
  });
});

describe('assembling a seed', () => {
  it('is the JSON the client installs, named by valid-after and its own hash', () => {
    const body = consensus(120, 5);
    const seed = assembleSeed(body, summarizeConsensus(body), 'certs', 'onion-key\n');
    expect(seed.name).toMatch(/^20260904T180000Z-[0-9a-f]{16}$/);
    expect(JSON.parse(seed.encoded)).toEqual({
      version: 3,
      consensus: body,
      certificates: 'certs',
      microdescriptors: 'onion-key\n',
    });
    expect(seed.encoded.startsWith('{"version":')).toBe(true);
    expect(seed.relays).toBe(120);
    expect(seed.validUntil.toISOString()).toBe('2026-09-04T21:00:00.000Z');

    const other = assembleSeed(body, summarizeConsensus(body), 'certs', 'onion-key\nonion-key\n');
    expect(other.name).not.toBe(seed.name);
  });

  it('formats times the way the manifest and file names carry them', () => {
    const at = new Date('2000-02-29T00:00:00Z');
    expect(iso8601(at)).toBe('2000-02-29T00:00:00Z');
    expect(compactUtc(at)).toBe('20000229T000000Z');
  });
});
