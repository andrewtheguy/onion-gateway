// Test fixtures: a consensus shaped like a real one, small enough to read,
// with microdescriptors and certificates that match it the way real ones do.

import { createHash } from 'node:crypto';
import type { Signer } from './seed.ts';

/** Known authorities, in the order `consensus` has them sign. */
const KNOWN_AUTHORITIES = [
  'E8A9C45EDE6D711294FADF8E7951F4DE6CA56B58',
  '27102BC123E7AF1D4741AE047E160C91ADC76B21',
  'ED03BB616EB2F60BEC80151114BB25CEF515B226',
  '23D15D965BC35114467363C165C4F724B64B4F66',
  '49015F787433103580E3B66A1707A00E60F2D15B',
  'F533C81CEF0BC0267857C99B2F471ADF249FA232',
];

/** Stands in for the DER of signing key `index`; only its digest matters. */
function signingKey(index: number): Buffer {
  return Buffer.from(`signing key ${index}`);
}

/** Known authority `index`, signing with key `keyIndex`. */
export function signer(index: number, keyIndex = index): Signer {
  return {
    id: KNOWN_AUTHORITIES[index]!,
    sk: createHash('sha1').update(signingKey(keyIndex)).digest('hex').toUpperCase(),
  };
}

/**
 * A consensus of `relays` relays, every one Fast, Stable, V2Dir and an HSDir,
 * signed by `signers` known authorities (the first that many, or the given).
 */
export function consensus(relays: number, signers: number | Signer[], extra = ''): string {
  const header = [
    'network-status-version 3 microdesc',
    'vote-status consensus',
    'valid-after 2026-09-04 18:00:00',
    'fresh-until 2026-09-04 19:00:00',
    'valid-until 2026-09-04 21:00:00',
  ];
  const entries = Array.from({ length: relays }, (_, index) => [
    `r relay${index} AAAAAAAAAAAAAAAAAAAAAAAAAAA 2026-09-04 12:00:00 10.0.0.${index % 256} 9001 0`,
    `m ${digest(index)}`,
    's Fast HSDir Running Stable V2Dir Valid',
    'w Bandwidth=1000',
  ]).flat();
  const known =
    typeof signers === 'number' ? Array.from({ length: signers }, (_, index) => signer(index)) : signers;
  const footer = [
    'directory-footer',
    ...known.map(({ id, sk }) => `directory-signature sha256 ${id} ${sk}\n-----BEGIN SIGNATURE-----\nxx\n-----END SIGNATURE-----`),
    'directory-signature 0000000000000000000000000000000000000000 1111\n-----BEGIN SIGNATURE-----\nxx\n-----END SIGNATURE-----',
  ];
  return [...header, ...entries, extra, ...footer].join('\n') + '\n';
}

/** The microdescriptor of relay `index`. */
export function microdescriptor(index: number): string {
  return `onion-key\nntor-onion-key relay${index}\nid ed25519 relay${index}\n`;
}

/** What the consensus names relay `index`'s microdescriptor by: the SHA-256 of its text, unpadded. */
export function digest(index: number): string {
  return createHash('sha256').update(microdescriptor(index)).digest('base64').replace(/=+$/, '');
}

/** The certificate of known authority `index` for signing key `keyIndex`, in shape only. */
export function certificate(index: number, keyIndex = index): string {
  return [
    'dir-key-certificate-version 3',
    `fingerprint ${KNOWN_AUTHORITIES[index]}`,
    'dir-key-published 2026-01-01 00:00:00',
    'dir-key-expires 2027-01-01 00:00:00',
    'dir-identity-key',
    '-----BEGIN RSA PUBLIC KEY-----',
    'aWRlbnRpdHk=',
    '-----END RSA PUBLIC KEY-----',
    'dir-signing-key',
    '-----BEGIN RSA PUBLIC KEY-----',
    signingKey(keyIndex).toString('base64'),
    '-----END RSA PUBLIC KEY-----',
    'dir-key-certification',
    '-----BEGIN SIGNATURE-----',
    'xx',
    '-----END SIGNATURE-----',
    '',
  ].join('\n');
}

/** Certificates enough for the client's threshold. */
export const CERTIFICATES = Array.from({ length: 5 }, (_, index) => certificate(index)).join('');
