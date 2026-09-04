// What a directory seed is made of, and how one is named.
//
// A seed is the JSON `directorySeed` takes: the microdesc consensus, the
// authority certificates that check its signatures, and the microdescriptors
// of every relay in it. The client verifies the consensus against the
// directory authorities pinned in `webtor-core` before installing any of it,
// so nothing here needs to be trusted; what this module checks is only that
// the documents could ever be installed — enough relays, enough signatures
// from authorities the client knows — so a hopeless seed fails here and not
// in every browser.

import { createHash } from 'node:crypto';

export const CONSENSUS_PATH = '/tor/status-vote/current/consensus-microdesc';
/** The `version` the client's `directorySeed` accepts. */
export const SEED_VERSION = 3;
/**
 * Digests per microdescriptor request. Each is a 43-character path segment,
 * so the batch is bounded by the directory's URL length limit.
 */
export const DIGESTS_PER_REQUEST = 90;

/**
 * v3 identity fingerprints of the directory authorities, the set the client
 * pins (`crates/webtor-core/src/authority.rs` in webtor-rs). The client
 * ignores a signature from anyone else and needs a strict majority of these.
 */
export const AUTHORITY_V3IDENTS: ReadonlySet<string> = new Set([
  '27102BC123E7AF1D4741AE047E160C91ADC76B21', // bastet
  '0232AF901C31A04EE9848595AF9BB7620D4C5B2E', // dannenberg
  'E8A9C45EDE6D711294FADF8E7951F4DE6CA56B58', // dizum
  '70849B868D606BAECFB6128C5E3D782029AA394F', // faravahar
  'ED03BB616EB2F60BEC80151114BB25CEF515B226', // gabelmoo
  '23D15D965BC35114467363C165C4F724B64B4F66', // longclaw
  '49015F787433103580E3B66A1707A00E60F2D15B', // maatuska
  'F533C81CEF0BC0267857C99B2F471ADF249FA232', // moria1
  '2F3DF9CA0E5D36F2685A2DA67184EB8DCB8CBA8C', // tor26
]);
export const CONSENSUS_THRESHOLD = Math.floor(AUTHORITY_V3IDENTS.size / 2) + 1;

/** Floors for a usable consensus, matching what the client refuses to install. */
const MIN_RELAYS_PER_ROLE = 10;
const MIN_HSDIR_RELAYS = 100;

/** A signing authority, as its `directory-signature` line names it. */
export interface Signer {
  /** The authority's v3 identity fingerprint. */
  id: string;
  /** The signing key it used. */
  sk: string;
}

/** What a consensus says about itself, read without checking any of it. */
export interface ConsensusSummary {
  validAfter: Date;
  freshUntil: Date;
  validUntil: Date;
  /** Relays in the consensus. */
  relays: number;
  /** Every relay's microdescriptor digest, deduplicated, in consensus order. */
  digests: string[];
  /**
   * The pinned authorities whose signatures the footer carries, one entry per
   * signing key: an authority rotating keys signs with two, and both
   * certificates are wanted, but it counts once toward the threshold.
   */
  signers: Signer[];
}

/** A seed ready to serve, with everything its manifest says about it. */
export interface Seed {
  /** `<valid-after, compact UTC>-<first 16 hex of the seed's SHA-256>`. */
  name: string;
  /** The seed itself, as `directorySeed` takes it. */
  encoded: string;
  validAfter: Date;
  freshUntil: Date;
  validUntil: Date;
  relays: number;
}

/**
 * Read the consensus's lifetime, its relays and its signers. Throws when the
 * consensus could never be installed: too few relays for a role, or too few
 * signatures from authorities the client knows.
 */
export function summarizeConsensus(consensus: string): ConsensusSummary {
  const validAfter = lifetimeField(consensus, 'valid-after');
  const freshUntil = lifetimeField(consensus, 'fresh-until');
  const validUntil = lifetimeField(consensus, 'valid-until');

  const digests: string[] = [];
  const seen = new Set<string>();
  let relays = 0;
  let middle = 0;
  let hsdir = 0;
  let inFooter = false;
  let current: { digest?: string; flags: Set<string>; bandwidth: number } | null = null;
  const finish = () => {
    if (!current) return;
    relays++;
    if (current.flags.has('HSDir')) hsdir++;
    if (
      current.bandwidth > 0 &&
      current.flags.has('Fast') &&
      current.flags.has('Stable') &&
      current.flags.has('V2Dir')
    ) {
      middle++;
    }
    if (current.digest && !seen.has(current.digest)) {
      seen.add(current.digest);
      digests.push(current.digest);
    }
    current = null;
  };
  const signers = new Map<string, Signer>();

  for (const line of consensus.split('\n')) {
    if (inFooter) {
      if (line.startsWith('directory-signature ')) {
        // `directory-signature [algorithm] <id> <sk>`; the algorithm came
        // later, so the fingerprints are the last two words.
        const words = line.trim().split(/\s+/);
        const id = words.at(-2)?.toUpperCase();
        const sk = words.at(-1)?.toUpperCase();
        if (id && sk && AUTHORITY_V3IDENTS.has(id)) signers.set(`${id}-${sk}`, { id, sk });
      }
      continue;
    }
    if (line.startsWith('directory-footer')) {
      finish();
      inFooter = true;
    } else if (line.startsWith('r ')) {
      finish();
      current = { flags: new Set(), bandwidth: 0 };
    } else if (current && line.startsWith('m ')) {
      current.digest = line.slice(2).trim();
    } else if (current && line.startsWith('s ')) {
      current.flags = new Set(line.slice(2).trim().split(' '));
    } else if (current && line.startsWith('w ')) {
      current.bandwidth = Number(/Bandwidth=(\d+)/.exec(line)?.[1] ?? 0);
    }
  }
  finish();

  if (middle < MIN_RELAYS_PER_ROLE || hsdir < MIN_HSDIR_RELAYS) {
    throw new Error(
      `the consensus has ${relays} relays, ${middle} usable as middles and ${hsdir} HSDirs: too few for a seed`,
    );
  }
  const authorities = countAuthorities([...signers.values()]);
  if (authorities < CONSENSUS_THRESHOLD) {
    throw new Error(
      `the consensus is signed by ${authorities} known authorities; the client needs ${CONSENSUS_THRESHOLD}`,
    );
  }
  return { validAfter, freshUntil, validUntil, relays, digests, signers: [...signers.values()] };
}

/** How many distinct authorities `signers` stand for. */
export function countAuthorities(signers: Signer[]): number {
  return new Set(signers.map(({ id }) => id)).size;
}

/** The document that carries every certificate the signers used. */
export function certificatesPath(signers: Signer[]): string {
  const segments = signers.map(({ id, sk }) => `${id.toLowerCase()}-${sk.toLowerCase()}`).sort();
  return `/tor/keys/fp-sk/${segments.join('+')}`;
}

/** The documents that together carry every microdescriptor in `digests`. */
export function microdescriptorPaths(digests: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < digests.length; index += DIGESTS_PER_REQUEST) {
    paths.push(`/tor/micro/d/${digests.slice(index, index + DIGESTS_PER_REQUEST).join('-')}`);
  }
  return paths;
}

/**
 * The distinct authorities among `signers` that `certificates` carries a
 * certificate for, checked by identity fingerprint and signing key. A
 * certificate repeated or one for a key the consensus was not signed with
 * counts for nothing, so an authority that answers with the wrong documents
 * cannot satisfy the threshold by volume.
 */
export function countCertificates(certificates: string, signers: Signer[]): number {
  const wanted = new Set(signers.map(({ id, sk }) => `${id}-${sk}`));
  const matched = new Map<string, Signer>();
  for (const certificate of certificates.split(/^(?=dir-key-certificate-version )/m)) {
    const id = /^fingerprint ([0-9A-Fa-f]{40})$/m.exec(certificate)?.[1]?.toUpperCase();
    const key = /^dir-signing-key\n-----BEGIN RSA PUBLIC KEY-----\n([\s\S]*?)-----END RSA PUBLIC KEY-----$/m.exec(
      certificate,
    )?.[1];
    if (!id || !key) continue;
    // The consensus names a signing key by the SHA-1 of its DER encoding.
    const sk = createHash('sha1')
      .update(Buffer.from(key.replace(/\s+/g, ''), 'base64'))
      .digest('hex')
      .toUpperCase();
    if (wanted.has(`${id}-${sk}`)) matched.set(`${id}-${sk}`, { id, sk });
  }
  return countAuthorities([...matched.values()]);
}

/**
 * How many of `digests` have their microdescriptor in `microdescriptors`. A
 * microdescriptor is named by the SHA-256 of its text, so one that is
 * repeated, or that no relay in the consensus has, counts for nothing.
 */
export function countMicrodescriptors(microdescriptors: string, digests: string[]): number {
  const wanted = new Set(digests);
  const matched = new Set<string>();
  for (const document of microdescriptors.split(/^(?=onion-key$)/m)) {
    if (!document.startsWith('onion-key')) continue;
    const digest = createHash('sha256').update(document).digest('base64').replace(/=+$/, '');
    if (wanted.has(digest)) matched.add(digest);
  }
  return matched.size;
}

/** Put the documents together in the shape the client installs, and name it. */
export function assembleSeed(
  consensus: string,
  summary: ConsensusSummary,
  certificates: string,
  microdescriptors: string,
): Seed {
  const encoded = JSON.stringify({
    version: SEED_VERSION,
    consensus,
    certificates,
    microdescriptors,
  });
  const hash = createHash('sha256').update(encoded).digest('hex');
  return {
    name: `${compactUtc(summary.validAfter)}-${hash.slice(0, 16)}`,
    encoded,
    validAfter: summary.validAfter,
    freshUntil: summary.freshUntil,
    validUntil: summary.validUntil,
    relays: summary.relays,
  };
}

/** `2026-09-04T18:00:00Z`: the form the manifest carries. */
export function iso8601(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `20260904T180000Z`: the form a file name carries. */
export function compactUtc(at: Date): string {
  return iso8601(at).replaceAll('-', '').replaceAll(':', '');
}

/** `valid-after 2026-09-04 18:00:00` and its siblings, which are UTC. */
function lifetimeField(consensus: string, field: string): Date {
  const match = new RegExp(`^${field} (\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}:\\d{2})$`, 'm').exec(
    consensus,
  );
  if (!match) throw new Error(`the consensus has no ${field} line`);
  return new Date(`${match[1]}T${match[2]}Z`);
}
