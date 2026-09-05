// The gateway: a service worker that owns one origin,
// `http://<address>.onion.<root>`, and answers every request on it by
// making the same request of `http://<address>.onion` over Tor. The Tor
// client lives in the worker, bootstrapped over Snowflake from a directory
// the gateway's backend serves (see directory.ts); no page on the origin
// ever sees it, only the responses. The onion's cookies live here too, since
// the browser keeps none for a response a worker made up. A page's WebSockets
// come through here as well: a worker never sees a WebSocket handshake, so
// every HTML document goes out with a script that replaces the page's
// `WebSocket` with one relaying to this worker (websocket-shim.js), and the
// worker opens the socket over Tor and carries the messages both ways.
//
// Two things a service worker forbids shape this file. `import()` is not
// allowed here, so the WASM package is imported statically and instantiated
// lazily; and top-level `await` is not allowed either, so every listener is
// registered synchronously and the bootstrap begins on the first request.

import init, { WebtorClient } from '@andrewtheguy/webtor-wasm';
import webtorWasmUrl from '@andrewtheguy/webtor-wasm/webtor_wasm_bg.wasm?url';
import { cookieJar } from './cookies';
import { directoryUrl, loadDirectory } from './directory';
import { gatewayHosts, isOnionHost, subdomainForm } from './gateway-host';
import { bootstrapPage, errorPage } from './gateway-pages';
import { WEBSOCKET_SHIM_PATH, scriptNonce, shimTag, withShim } from './html-shim';
import type {
  GatewayKeepAlive,
  GatewayLevel,
  GatewayLine,
  GatewayPhase,
  GatewayProgress,
  GatewaySocketOpen,
  GatewaySubscribe,
  SocketToPage,
  SocketToWorker,
} from './protocol';
import websocketShim from './websocket-shim.js?raw';

declare const self: ServiceWorkerGlobalScope;

/** Long enough for a first rendezvous, which can take minutes over Snowflake. */
const REQUEST_TIMEOUT_MS = 240_000;

/**
 * The most one response may occupy. The client buffers a response whole, and
 * its own default of 8 MiB is sized for an API call; a static site's
 * downloads run larger, and this worker has nothing else to hold in memory.
 */
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/**
 * The most a request body may weigh. It is buffered whole here and once more
 * in the client, so this is a bound on memory, not on what a site may accept.
 */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * The most one WebSocket message may carry, either way. A browser's own
 * sockets have no such limit; the client assembles a message whole before
 * handing it over, and this bounds what one holds.
 */
const MAX_SOCKET_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Request headers that are not carried to the onion as the page sent them.
 * Everything else is: a page's `Content-Type`, `Authorization` or
 * `X-Requested-With` is what makes its request mean what it means.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  // Set here, from the request itself, in the onion's terms.
  'accept-encoding',
  'cookie',
  'origin',
  'referer',
  // Set by the client from the framing it puts on the wire.
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  // Conditional: a `304` carries a `Content-Length` and no body, which the
  // client would wait on until the stream ended.
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  // About a connection this worker is not the end of.
  'expect',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
]);

/**
 * Response headers not passed to the page: the ones about the onion
 * connection rather than the content, and `Set-Cookie`, which goes into the
 * jar here — the browser would drop it from a worker's response anyway.
 */
const WITHHELD_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
]);

/** Statuses `Response` refuses a body for. */
const BODYLESS_STATUSES = new Set([101, 204, 205, 304]);

/** `Content-Encoding`s the worker undoes itself; see `toResponse`. */
const DECODABLE_ENCODINGS = new Set(['gzip', 'deflate', 'deflate-raw']);

/** The most bootstrap lines kept for the page that follows it. */
const MAX_LINES = 200;

/**
 * What the onion is told it may compress with: the codings above and nothing
 * else, so a `br` or `zstd` body the worker could not undo never arrives.
 * (`deflate-raw` is a `DecompressionStream` format, not an HTTP coding.)
 */
const ACCEPT_ENCODING = 'gzip, deflate';

/**
 * A bridge to use instead of the public one, from `.env.local`:
 *
 *   VITE_BRIDGE_URL=ws://localhost:8080/
 *   VITE_BRIDGE_FINGERPRINT=<what scripts/local-bridge prints>
 *
 * Both or neither — a URL without an identity would be a request to trust
 * whatever answers.
 */
const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL;
const BRIDGE_FINGERPRINT = import.meta.env.VITE_BRIDGE_FINGERPRINT;

if (Boolean(BRIDGE_URL) !== Boolean(BRIDGE_FINGERPRINT)) {
  throw new Error('Set VITE_BRIDGE_URL and VITE_BRIDGE_FINGERPRINT together, or neither');
}

/** Which subdomain each onion has under the root; see gateway-host.ts. */
const hosts = gatewayHosts(subdomainForm(import.meta.env.VITE_BARE_ONION_SUBDOMAIN));

const here = new URL(self.location.href);
const gateway = hosts.parse(here.hostname);
/** The gateway's own host with its port, which is what onion URLs map onto. */
const rootHost = gateway && `${gateway.root}${here.port ? `:${here.port}` : ''}`;

/**
 * Where a fresh directory comes from: the gateway host's own endpoints, or
 * a backend elsewhere named by `VITE_DIRECTORY_URL`. Every onion's worker
 * asks the same URL, and the browser caches the one seed for all of them.
 */
const directoryManifestUrl =
  rootHost && directoryUrl(import.meta.env.VITE_DIRECTORY_URL, here.protocol, rootHost);
const cookies = cookieJar('webtor-onion-gateway-cookies', gateway?.onion ?? '');

type TorClient = Awaited<ReturnType<typeof WebtorClient.create>>;

/** What `connectWebSocket` resolves to; the package types it loosely. */
interface OnionSocket {
  readonly headers: Headers;
  send(text: string): Promise<unknown>;
  sendBinary(bytes: Uint8Array): Promise<unknown>;
  receive(): Promise<{ type: 'text'; text: string } | { type: 'binary'; bytes: Uint8Array } | null>;
  close(): Promise<unknown>;
}

// The bootstrap's state, kept in module scope: a browser stops an idle
// service worker after roughly half a minute, and every restart begins here
// again, with nothing kept; the directory is fetched afresh, from the
// browser's HTTP cache when it holds one.
let bootstrap: Promise<TorClient> | null = null;
let phase: GatewayPhase = 'starting';
let failure: string | null = null;
let lines: GatewayLine[] = [];
/** Pages that asked to follow the bootstrap, by client id. */
const subscribers = new Set<string>();

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progress(): GatewayProgress {
  return { type: 'progress', onion: gateway?.onion ?? '', phase, lines, failure };
}

async function broadcast(): Promise<void> {
  const update = progress();
  for (const id of subscribers) {
    const client = await self.clients.get(id);
    if (client) client.postMessage(update);
    else subscribers.delete(id);
  }
}

function log(level: GatewayLevel, message: string): void {
  lines = [...lines, { at: Date.now(), level, message }].slice(-MAX_LINES);
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`[gateway] ${message}`);
  void broadcast();
}

async function createClient(onion: string): Promise<TorClient> {
  phase = 'starting';
  failure = null;
  lines = [];
  log('info', `Gateway for ${onion}`);
  await init({ module_or_path: webtorWasmUrl });
  const seed = await loadSeed();
  const client: TorClient = await WebtorClient.create({
    // Only the WebSocket bridge: the WebRTC one needs `RTCPeerConnection`,
    // which a worker does not have.
    bridge: 'websocket',
    ...(BRIDGE_URL && BRIDGE_FINGERPRINT
      ? { bridgeUrl: BRIDGE_URL, bridgeFingerprint: BRIDGE_FINGERPRINT }
      : {}),
    ...(seed ? { directorySeed: seed } : {}),
    // The worker's console is out of sight; the lines go to the page instead.
    onLog: (message: string, level: GatewayLevel) => log(level, message),
  });
  phase = 'ready';
  log('success', 'Tor client bootstrapped');
  return client;
}

/**
 * The seed the backend serves, or `null` to let the client download a
 * directory over Tor — slow, but not wrong, so a backend that is down or not
 * yet ready costs time rather than the page.
 */
async function loadSeed(): Promise<string | null> {
  if (!directoryManifestUrl) return null;
  try {
    const { seed, manifest, seedUrl } = await loadDirectory(directoryManifestUrl);
    log(
      'info',
      `Tor directory: ${manifest.relays} relays from ${seedUrl}, valid until ${manifest.validUntil}`,
    );
    return seed;
  } catch (error) {
    log(
      'warn',
      `No Tor directory from ${directoryManifestUrl} (${describe(error)}); downloading one over Tor`,
    );
    return null;
  }
}

/** The client, starting a bootstrap if none is under way. */
function client(onion: string): Promise<TorClient> {
  bootstrap ??= createClient(onion).catch((error: unknown) => {
    bootstrap = null;
    phase = 'failed';
    failure = describe(error);
    log('error', `Bootstrap failed: ${failure}`);
    throw error;
  });
  return bootstrap;
}

/**
 * The onion URL a request on this origin stands for, or `null` when the
 * request is not for this origin's onion. A page's absolute URL to its own
 * `http://<address>.onion/…` counts too, since that is what its links and
 * assets often say; a URL to any *other* onion does not, and goes to the
 * network to fail there, because answering it here would let one site read
 * another across origins with no CORS check in the way.
 */
function onionUrl(url: URL): string | null {
  if (!gateway) return null;
  const sameOrigin = url.origin === here.origin;
  const ownOnion =
    url.protocol === 'http:' &&
    url.hostname === gateway.onion &&
    (url.port === '' || url.port === '80');
  return sameOrigin || ownOnion ? `http://${gateway.onion}${url.pathname}${url.search}` : null;
}

/**
 * The onion WebSocket URL a page's socket URL stands for, or `null` when it
 * is not this origin's onion — the same rule as `onionUrl`, for `ws:` and
 * `wss:` on this origin and `ws:` on the onion itself. `wss:` to the origin
 * is taken as it is: the page may be on `https:` and say the scheme it sees.
 */
function socketTarget(url: URL): string | null {
  if (!gateway || url.hash !== '') return null;
  const sameHost = (url.protocol === 'ws:' || url.protocol === 'wss:') && url.host === here.host;
  const ownOnion =
    url.protocol === 'ws:' &&
    url.hostname === gateway.onion &&
    (url.port === '' || url.port === '80');
  return sameHost || ownOnion ? `ws://${gateway.onion}${url.pathname}${url.search}` : null;
}

/**
 * Where a redirect points, said in gateway terms. A `Location` on an onion
 * over plain HTTP — this one or another — becomes that onion's gateway
 * origin, so following it stays inside the gateway; anything else is passed
 * on as the onion said it.
 */
function rewriteLocation(location: string, target: string): string {
  if (!rootHost) return location;
  let resolved: URL;
  try {
    resolved = new URL(location, target);
  } catch {
    return location;
  }
  if (resolved.protocol !== 'http:' || !isOnionHost(resolved.hostname)) return location;
  if (resolved.port !== '' && resolved.port !== '80') return location;
  return hosts.url(
    resolved.hostname,
    rootHost,
    `${resolved.pathname}${resolved.search}${resolved.hash}`,
  );
}

interface Upstream {
  status: number;
  headers: Headers;
  bytes(): Uint8Array;
}

/**
 * A `Response` for what the onion sent. The body arrives whole, so the
 * connection-level headers describe a transfer that is over and are dropped.
 * A compressed body is decompressed here too: the browser inflates only what
 * came off its own network stack, not what a worker hands it, and a
 * `Content-Encoding` left on a synthetic response would make the page
 * unreadable. An HTML document a navigation asked for gets the WebSocket
 * shim put first in it, with the nonce its `Content-Security-Policy` asks of
 * scripts, if it asks for one.
 */
async function toResponse(
  upstream: Upstream,
  target: string,
  headOnly: boolean,
  document: boolean,
): Promise<Response> {
  if (upstream.status < 200 || upstream.status > 599) {
    return new Response(`The onion answered with HTTP status ${upstream.status}`, {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!WITHHELD_RESPONSE_HEADERS.has(name)) headers.set(name, value);
  });
  const location = headers.get('location');
  if (location !== null) headers.set('location', rewriteLocation(location, target));

  let body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null =
    upstream.bytes() as Uint8Array<ArrayBuffer>;
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    // One coding the worker can undo, or nothing: the onion was asked for
    // `gzip, deflate` and a body in anything else — `br`, `zstd`, a stack of
    // codings — cannot be made readable here, and forwarding it as it is
    // would hand the page bytes it cannot read either.
    if (!DECODABLE_ENCODINGS.has(encoding)) {
      return new Response(`The onion answered with an unsupported Content-Encoding: ${encoding}`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    body = new Response(body).body!.pipeThrough(
      new DecompressionStream(encoding as CompressionFormat),
    );
    headers.delete('content-encoding');
  }
  if (headOnly || BODYLESS_STATUSES.has(upstream.status)) body = null;
  else if (document && isHtml(headers.get('content-type'))) {
    const bytes =
      body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    body = withShim(bytes, shimTag(scriptNonce(headers.get('content-security-policy')))) as Uint8Array<ArrayBuffer>;
  }
  return new Response(body, { status: upstream.status, headers });
}

function isHtml(contentType: string | null): boolean {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/** The shim, as the tag put into every document loads it. */
function shimResponse(): Response {
  return new Response(websocketShim, {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
  });
}

function textResponse(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function htmlResponse(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * The `Referer` the onion should see, or `null` for none: the page's own
 * URL, in onion terms, when it was on this gateway. The browser has already
 * applied the page's referrer policy by the time a worker sees the request.
 */
function refererFor(request: Request): string | null {
  if (request.referrer === '' || request.referrer === 'about:client') return null;
  try {
    return onionUrl(new URL(request.referrer));
  } catch {
    return null;
  }
}

/**
 * The request body, whole, or `null` once it has run past
 * `MAX_REQUEST_BYTES`. It is read a chunk at a time and the stream cancelled
 * as soon as the limit is crossed, so a body far past it costs the worker no
 * more memory than the limit itself.
 */
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function answer(request: Request, target: string): Promise<Response> {
  const onion = gateway!.onion;
  const navigation = request.mode === 'navigate';
  const requested = new URL(request.url);
  const method = request.method.toUpperCase();
  const carriesBody = method !== 'GET' && method !== 'HEAD';

  // A GET navigation gets a page to watch the bootstrap from, rather than a
  // tab that spins for a minute or more. Anything else waits: a subresource
  // because the page that asked for it is already showing, a form submission
  // because the bootstrap page would replay it as a GET without its body.
  if (phase !== 'ready' || bootstrap === null) {
    const pending = client(onion);
    if (navigation && !carriesBody) {
      pending.catch(() => undefined);
      return htmlResponse(
        200,
        bootstrapPage(onion, `${requested.pathname}${requested.search}`),
      );
    }
  }

  let tor: TorClient;
  try {
    tor = await client(onion);
  } catch (error) {
    const detail = `The Tor client could not bootstrap: ${describe(error)}`;
    return navigation
      ? htmlResponse(502, errorPage(onion, 'Not connected', detail))
      : textResponse(502, detail);
  }

  let body: Uint8Array | undefined;
  if (carriesBody) {
    const read = await readBody(request);
    if (read === null) {
      const detail = `The request body is over ${MAX_REQUEST_BYTES} bytes, the most this gateway forwards.`;
      return navigation
        ? htmlResponse(413, errorPage(onion, 'Request too large', detail))
        : textResponse(413, detail);
    }
    body = read;
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!DROPPED_REQUEST_HEADERS.has(name)) headers[name] = value;
  });
  // The browser's own `Accept-Encoding` is not exposed to a worker, and what
  // it would ask for includes codings the worker cannot decode.
  headers['accept-encoding'] = ACCEPT_ENCODING;
  // The browser adds `Origin`, `Referer` and `Cookie` after a worker has
  // answered, and in the gateway's terms; the onion wants them in its own,
  // above all for a CSRF check that compares them with its `Host`.
  const referer = refererFor(request);
  if (referer !== null) headers.referer = referer;
  if (carriesBody) headers.origin = `http://${onion}`;
  const cookie = await cookies.headerFor(requested.pathname);
  if (cookie !== null) headers.cookie = cookie;

  try {
    // A HEAD goes out as a GET: the client frames a response by its
    // `Content-Length`, and a HEAD's body never comes.
    const upstream: Upstream = await tor.fetch(target, {
      method: method === 'HEAD' ? 'GET' : method,
      headers,
      ...(body ? { body } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    });
    await cookies.set(upstream.headers.getSetCookie(), requested.pathname);
    return toResponse(upstream, target, method === 'HEAD', navigation);
  } catch (error) {
    const detail = describe(error);
    log('error', `${method} ${requested.pathname}: ${detail}`);
    return navigation
      ? htmlResponse(502, errorPage(onion, 'The onion did not answer', detail))
      : textResponse(502, detail);
  }
}

/**
 * One WebSocket for a page, from the shim's request to the close: open it on
 * the onion through the Tor client, with the jar's cookies and the page's
 * subprotocols on the upgrade, then carry every message either way on
 * `port`. A failure at any point is an `error` and a `close` with 1006 to
 * the page, as the browser reports a socket of its own that failed.
 */
async function relaySocket(port: MessagePort, request: GatewaySocketOpen): Promise<void> {
  const onion = gateway!.onion;
  let socket: OnionSocket | null = null;
  let done = false;
  // What the page asked when it closed, if it did. Set from the port's
  // handlers, which is why it is a property rather than a local: a local
  // assigned in a callback is narrowed to its first value everywhere else.
  const page: { closed: { code: number; reason: string } | null } = { closed: null };
  const tell = (message: SocketToPage, transfer: Transferable[] = []) => {
    if (!done) port.postMessage(message, transfer);
  };
  const finish = (last: SocketToPage & { type: 'close' }) => {
    tell(last);
    done = true;
    port.close();
    void socket?.close().catch(() => undefined);
  };
  const fail = (detail: string) => {
    log('error', `WebSocket ${request.url}: ${detail}`);
    tell({ type: 'error', message: detail });
    finish({ type: 'close', code: 1006, reason: '', wasClean: false });
  };

  let target: string | null = null;
  try {
    target = socketTarget(new URL(request.url));
  } catch {
    // Not a URL at all; refused below.
  }
  if (target === null) return fail(`not this origin's onion`);
  const path = new URL(target).pathname;

  // The page may close before the socket is open; the answer then is the
  // close it asked for, once there is a socket to close.
  port.onmessage = (event: MessageEvent<SocketToWorker>) => {
    if (event.data.type === 'close') page.closed = { code: event.data.code, reason: event.data.reason };
  };

  let tor: TorClient;
  try {
    tor = await client(onion);
  } catch (error) {
    return fail(`The Tor client could not bootstrap: ${describe(error)}`);
  }

  // The upgrade in the onion's terms, as `answer` puts a request: a browser
  // sends `Origin` on every handshake, and the cookies go where a fetch's do.
  const headers: Record<string, string> = { origin: `http://${onion}` };
  const cookie = await cookies.headerFor(path);
  if (cookie !== null) headers.cookie = cookie;
  if (request.protocols.length > 0) headers['sec-websocket-protocol'] = request.protocols.join(', ');

  try {
    socket = (await tor.connectWebSocket(target, {
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxMessageBytes: MAX_SOCKET_MESSAGE_BYTES,
    })) as OnionSocket;
  } catch (error) {
    return fail(describe(error));
  }
  await cookies.set(socket.headers.getSetCookie(), path);
  const protocol = socket.headers.get('sec-websocket-protocol') ?? '';
  if (protocol !== '' && !request.protocols.includes(protocol)) {
    return fail(`the onion chose a subprotocol the page did not offer: ${protocol}`);
  }
  if (page.closed !== null) {
    return finish({ type: 'close', ...page.closed, wasClean: true });
  }
  tell({ type: 'open', protocol });

  // Sends go out in the order the page made them, each after the last has
  // been written, and the close after all of them.
  const opened = socket;
  let sending: Promise<unknown> = Promise.resolve();
  port.onmessage = (event: MessageEvent<SocketToWorker>) => {
    const message = event.data;
    if (message.type === 'send') {
      const data = message.data;
      sending = sending
        .then(() => (typeof data === 'string' ? opened.send(data) : opened.sendBinary(new Uint8Array(data))))
        .catch((error: unknown) => fail(`send failed: ${describe(error)}`));
    } else if (message.type === 'close') {
      page.closed = { code: message.code, reason: message.reason };
      sending = sending.then(() => opened.close()).catch(() => undefined);
    }
  };

  // Everything the onion sends, until one side closes.
  try {
    for (;;) {
      const message = await opened.receive();
      if (message === null) break;
      if (message.type === 'text') {
        tell({ type: 'message', data: message.text });
      } else {
        const { buffer, byteOffset, byteLength } = message.bytes;
        const data = buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
        tell({ type: 'message', data }, [data]);
      }
    }
  } catch (error) {
    if (page.closed === null) return fail(`receive failed: ${describe(error)}`);
  }
  // The client carries no close code either way, so the page hears the code
  // it gave, or a normal closure for one the onion began.
  finish({ type: 'close', ...(page.closed ?? { code: 1000, reason: '' }), wasClean: true });
}

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === here.origin && url.pathname === WEBSOCKET_SHIM_PATH) {
    event.respondWith(shimResponse());
    return;
  }
  const target = onionUrl(url);
  if (target !== null) event.respondWith(answer(event.request, target));
});

type PageMessage = GatewaySubscribe | GatewaySocketOpen | GatewayKeepAlive;

/**
 * Whether `value` is a message the shim or the bootstrap page sends, shape
 * and all: a `websocket` one names a URL and lists its subprotocols, and one
 * that does not is not passed on to be opened.
 */
function isPageMessage(value: unknown): value is PageMessage {
  if (typeof value !== 'object' || value === null) return false;
  const { type, url, protocols } = value as { type?: unknown; url?: unknown; protocols?: unknown };
  if (type === 'subscribe' || type === 'keepalive') return true;
  return (
    type === 'websocket' &&
    typeof url === 'string' &&
    Array.isArray(protocols) &&
    protocols.every((protocol) => typeof protocol === 'string')
  );
}

self.addEventListener('message', (event) => {
  const data: unknown = event.data;
  if (!(event.source instanceof Client)) return;
  if (!isPageMessage(data)) {
    // A malformed request for a socket still carried a port. It is answered
    // as a refused socket is, so the page's socket ends rather than waits.
    for (const port of event.ports) {
      port.postMessage({ type: 'error', message: 'malformed request' } satisfies SocketToPage);
      port.postMessage({ type: 'close', code: 1006, reason: '', wasClean: false } satisfies SocketToPage);
      port.close();
    }
    return;
  }
  switch (data.type) {
    case 'subscribe':
      subscribers.add(event.source.id);
      event.source.postMessage(progress());
      return;
    case 'websocket': {
      const [port] = event.ports;
      if (port) void relaySocket(port, data);
      return;
    }
    case 'keepalive':
      // Arriving is the point: it resets the browser's idle clock on this worker.
      return;
  }
});
