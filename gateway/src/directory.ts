// Where a fresh Tor directory comes from: two URLs any backend can serve.
//
// The worker never stores a directory. IndexedDB is per origin and every
// onion is an origin of its own, so storing one there meant a copy of some
// forty megabytes per site visited. Instead every worker under the gateway
// asks the same two URLs on the gateway's own host, and the browser's HTTP
// cache — which is per site, not per origin — holds the one answer for all
// of them. The backend is whatever answers those URLs the way the README
// describes under "The directory endpoints".
//
//   GET <manifest URL>          {"url", "validAfter", "freshUntil", "validUntil", "bytes", "relays"}
//   GET <manifest.url>          the seed, as `directorySeed` takes it; immutable, uniquely named.
//                               A `url` ending in `.gz` is the seed gzipped, from a host that
//                               serves files as they are and caps their size; it is inflated here.
//
// Both answer with `Access-Control-Allow-Origin: *`, since the worker asking
// is on an onion's origin, not the gateway's.

/** What a backend says about the seed it currently serves. */
export interface DirectoryManifest {
  /** The seed's URL, absolute or relative to the manifest's own. */
  url: string;
  validAfter: string;
  freshUntil: string;
  validUntil: string;
  bytes: number;
  relays: number;
}

export interface LoadedDirectory {
  /** The seed, as `directorySeed` takes it. */
  seed: string;
  manifest: DirectoryManifest;
  /** Where the seed came from, resolved. */
  seedUrl: string;
}

/** The manifest is tiny and changes; asking is cheap. */
const MANIFEST_TIMEOUT_MS = 15_000;
/** The seed is tens of megabytes, from a host expected to be near. */
const SEED_TIMEOUT_MS = 120_000;

/**
 * The manifest URL: `configured` when the deployment names one — a backend
 * on another host, say, or a path on the gateway host, which it is resolved
 * against — and the gateway host's own `/api/directory` otherwise, which is
 * where the dev server proxies and the example backend answers.
 */
export function directoryUrl(
  configured: string | undefined,
  protocol: string,
  rootHost: string,
): string {
  const gateway = `${protocol}//${rootHost}/`;
  if (configured) return new URL(configured, gateway).href;
  return `${gateway}api/directory`;
}

/**
 * The seed the backend at `manifestUrl` currently serves. Throws when there
 * is none to be had — the backend is down, has not built one yet, or answered
 * with something that is not a seed — so the caller can fall back to letting
 * the client download a directory over Tor.
 */
export async function loadDirectory(
  manifestUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<LoadedDirectory> {
  const manifestResponse = await fetchFn(manifestUrl, {
    // The manifest names the current seed, so a cached copy is exactly what
    // must not be used; the seed it points to is what the cache is for.
    cache: 'no-cache',
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!manifestResponse.ok) {
    throw new Error(`the directory manifest answered HTTP ${manifestResponse.status}`);
  }
  const manifest = asManifest(await manifestResponse.json());
  const seedUrl = new URL(manifest.url, manifestUrl).href;

  const seedResponse = await fetchFn(seedUrl, { signal: AbortSignal.timeout(SEED_TIMEOUT_MS) });
  if (!seedResponse.ok) {
    throw new Error(`the directory seed answered HTTP ${seedResponse.status}`);
  }
  const seed = await seedText(seedResponse, new URL(seedUrl).pathname.endsWith('.gz'));
  if (!seed.startsWith('{"version":')) {
    throw new Error('the directory seed is not one');
  }
  return { seed, manifest, seedUrl };
}

/** The seed as text: the body, inflated first when the URL said it is gzipped. */
async function seedText(response: Response, gzipped: boolean): Promise<string> {
  if (!gzipped) return response.text();
  if (!response.body) throw new Error('the directory seed has no body');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
}

function asManifest(value: unknown): DirectoryManifest {
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    typeof record.url !== 'string' ||
    typeof record.validAfter !== 'string' ||
    typeof record.freshUntil !== 'string' ||
    typeof record.validUntil !== 'string' ||
    typeof record.bytes !== 'number' ||
    typeof record.relays !== 'number'
  ) {
    throw new Error('the directory manifest is malformed');
  }
  return record as unknown as DirectoryManifest;
}
