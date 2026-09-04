// The sample onion site the gateway is tested against: one file with a page
// of static assets, a form and a JSON echo, two WebSocket endpoints, and a
// username-and-password sign-in that gates a page, an API call and one of
// the sockets behind a session cookie. The container in this directory puts
// it behind a Tor onion service; gateway.test.ts drives it through the
// gateway in headless Chrome, phase by phase.
//
// It also runs bare, for looking at it without Tor in the way:
//
//   PORT=8000 bun e2e/onion/server.ts

/** The one account. */
export const USERNAME = 'alice';
export const PASSWORD = 'wonderland';

/** The cookie a signed-in request carries; its value is a server-side token. */
const SESSION_COOKIE = 'session';
/** How many times this visitor has seen `/`. */
const VISITS_COOKIE = 'visits';

const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT = 'text/plain; charset=utf-8';

/** Which WebSocket a connection is, and who opened it. */
export interface SocketData {
  kind: 'echo' | 'private';
  user: string | null;
}

/** Something that can be sent to: a Bun `ServerWebSocket`, or a stand-in. */
export interface Sendable {
  data: SocketData;
  send(message: string | Uint8Array): unknown;
}

/** Live sessions, token to username. Nothing outlives the process. */
const sessions = new Map<string, string>();

// --- Static assets ---------------------------------------------------------

/** One MiB of bytes fixed by a seed, so a test can check them after transit. */
export function blob(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(1024 * 1024);
  let state = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 4) {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[i] = state & 0xff;
    bytes[i + 1] = (state >>> 8) & 0xff;
    bytes[i + 2] = (state >>> 16) & 0xff;
    bytes[i + 3] = state >>> 24;
  }
  return bytes;
}

/** A 1×1 opaque PNG, the smallest image a browser will measure. */
const PIXEL_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

export const HELLO_TEXT = 'Hello from the onion.\n';
/** The colour `site.css` gives `#styled`, as `getComputedStyle` reports it. */
export const STYLED_COLOR = 'rgb(171, 205, 239)';
export const SCRIPT_RAN_TEXT = 'script ran';

export interface StaticAsset {
  type: string;
  body: Uint8Array<ArrayBuffer>;
  /** Served with `Content-Encoding: gzip` to a request that accepts it. */
  gzip?: boolean;
}

const encoder = new TextEncoder();

/** Every file under `/static/`, by path. Exported so a test knows the bytes. */
export const STATIC: Record<string, StaticAsset> = {
  '/static/site.css': {
    type: 'text/css; charset=utf-8',
    body: encoder.encode(`body { background: rgb(18, 52, 86); color: #eee; font-family: sans-serif; }\n#styled { color: ${STYLED_COLOR}; }\n`),
  },
  '/static/app.js': {
    type: 'text/javascript; charset=utf-8',
    body: encoder.encode(`document.getElementById('script-ran').textContent = ${JSON.stringify(SCRIPT_RAN_TEXT)};\n`),
  },
  '/static/pixel.png': { type: 'image/png', body: PIXEL_PNG },
  '/static/hello.txt': { type: TEXT, body: encoder.encode(HELLO_TEXT) },
  '/static/compressed.txt': { type: TEXT, body: encoder.encode(HELLO_TEXT), gzip: true },
  '/static/blob.bin': { type: 'application/octet-stream', body: blob() },
};

// --- Helpers ---------------------------------------------------------------

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** A percent-encoded value decoded, or as it came when it is not one. */
function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The `Cookie` header as a map, last value winning for a repeated name. */
export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header?.split(';') ?? []) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== '') cookies[name] = decoded(pair.slice(separator + 1).trim());
  }
  return cookies;
}

/** The user the request's session cookie names, or `null`. */
function userOf(request: Request): string | null {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  return token === undefined ? null : (sessions.get(token) ?? null);
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': TEXT, ...headers } });
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store' },
  });
}

function page(status: number, title: string, body: string, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': HTML, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/static/site.css">
</head>
<body>
<nav><a href="/">Home</a> · <a href="/private">Private</a> · <a href="/login">Sign in</a></nav>
${body}
</body>
</html>
`,
    { status, headers },
  );
}

/**
 * A `303 See Other`, the answer a form POST gets, so that the browser GETs
 * the result rather than offering to POST again on a reload.
 */
function seeOther(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'content-type': TEXT });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(`See ${location}\n`, { status: 303, headers });
}

/**
 * Whether a state-changing request came from this site: `Origin` has to be
 * this host, the one the request was made to. A gateway forwarding a form
 * has to say the onion's name here rather than its own.
 */
function sameOrigin(request: Request): boolean {
  const host = request.headers.get('host');
  const origin = request.headers.get('origin');
  return host !== null && origin !== null && origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

function crossSite(request: Request): Response {
  const origin = request.headers.get('origin') ?? '(none)';
  const host = request.headers.get('host') ?? '(none)';
  return text(403, `Cross-site request refused: Origin ${origin} does not match Host ${host}\n`);
}

function whoLine(user: string | null): string {
  return `<p id="who">${user ? `Signed in as ${escape(user)}` : 'Not signed in'}</p>`;
}

// --- Pages -----------------------------------------------------------------

/** Phase 1's page: every kind of static subresource, and phase 4's counter. */
function home(request: Request): Response {
  const cookies = parseCookies(request.headers.get('cookie'));
  const visits = (Number.parseInt(cookies[VISITS_COOKIE] ?? '0', 10) || 0) + 1;
  return page(
    200,
    'Sample onion',
    `<h1>Sample onion</h1>
<p id="styled">Styled by the style sheet</p>
<p id="script-ran">script did not run</p>
<img id="pixel" src="/static/pixel.png" alt="one pixel" width="1" height="1">
<p id="visits">Visit ${visits}</p>
${whoLine(userOf(request))}
<form id="note" method="post" action="/notes">
  <label>Note <input name="text" autocomplete="off"></label>
  <button type="submit">Post</button>
</form>
<form id="logout" method="post" action="/logout"><button type="submit">Sign out</button></form>
<p><a href="/static/hello.txt">hello.txt</a> · <a href="/echo">echo</a></p>
<script src="/static/app.js"></script>`,
    [`${VISITS_COOKIE}=${visits}; Path=/`],
  );
}

function staticAsset(request: Request, asset: StaticAsset): Response {
  const headers = new Headers({ 'content-type': asset.type, 'cache-control': 'no-store' });
  let body: Uint8Array<ArrayBuffer> = asset.body;
  if (asset.gzip && /\bgzip\b/.test(request.headers.get('accept-encoding') ?? '')) {
    body = Bun.gzipSync(asset.body);
    headers.set('content-encoding', 'gzip');
  }
  return new Response(body, { status: 200, headers });
}

/** Phase 2: a form POST answered with a page, not a redirect. */
async function notes(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return crossSite(request);
  const form = new URLSearchParams(await request.text());
  const note = form.get('text') ?? '';
  return page(
    200,
    'Posted',
    `<h1>Posted</h1>
<p id="posted">You posted: ${escape(note)}</p>
<p><a href="/">Back</a></p>`,
  );
}

/** Phase 2: everything about a request, as JSON, for a test to read back. */
async function echo(request: Request, url: URL): Promise<Response> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = new Uint8Array(await request.arrayBuffer()) as Uint8Array<ArrayBuffer>;
  const digest = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  return json(200, {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    cookies: parseCookies(request.headers.get('cookie')),
    bodyBytes: body.byteLength,
    bodySha256: digest,
    body: new TextDecoder().decode(body),
  });
}

/** Phase 4 and 5: the sign-in page. */
function loginPage(url: URL, user: string | null): Response {
  const error = url.searchParams.has('error');
  return page(
    error ? 401 : 200,
    'Sign in',
    `<h1>Sign in</h1>
${whoLine(user)}
${error ? '<p id="error">Wrong username or password</p>' : ''}
<form id="login" method="post" action="/login">
  <label>Username <input name="username" autocomplete="off"></label>
  <label>Password <input name="password" type="password" autocomplete="off"></label>
  <button type="submit">Sign in</button>
</form>`,
  );
}

async function login(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return crossSite(request);
  const form = new URLSearchParams(await request.text());
  if (form.get('username') !== USERNAME || form.get('password') !== PASSWORD) {
    return seeOther('/login?error');
  }
  const token = crypto.randomUUID();
  sessions.set(token, USERNAME);
  return seeOther('/private', [`${SESSION_COOKIE}=${token}; Path=/; HttpOnly`]);
}

function logout(request: Request): Response {
  if (!sameOrigin(request)) return crossSite(request);
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (token !== undefined) sessions.delete(token);
  return seeOther('/', [`${SESSION_COOKIE}=; Path=/; Max-Age=0`]);
}

function signInFirst(): Response {
  return page(
    401,
    'Sign in first',
    `<h1>Sign in first</h1>
<p>This page is for signed-in visitors. <a href="/login">Sign in</a>.</p>`,
  );
}

/** Phase 4: a page only a session cookie opens. */
function privatePage(user: string | null): Response {
  if (user === null) return signInFirst();
  return page(
    200,
    'Private',
    `<h1>Private</h1>
${whoLine(user)}
<form id="logout" method="post" action="/logout"><button type="submit">Sign out</button></form>`,
  );
}

// --- WebSockets ------------------------------------------------------------

/** What each socket says on open. */
export function greeting(data: SocketData): string {
  return data.kind === 'private' ? `welcome ${data.user}` : 'welcome';
}

/** What each socket answers a message with: the echo, or the echo signed. */
export function reply(data: SocketData, message: string | Uint8Array): string | Uint8Array {
  if (typeof message !== 'string') return message;
  return data.kind === 'private' ? `${data.user}: ${message}` : message;
}

/** Bun's handlers, shared by every socket; `ws.data` says which it is. */
export const websocket = {
  open(ws: Sendable): void {
    ws.send(greeting(ws.data));
  },
  message(ws: Sendable, message: string | Buffer): void {
    ws.send(reply(ws.data, typeof message === 'string' ? message : new Uint8Array(message)));
  },
};

/** Whether the request asks to become a WebSocket. */
function wantsUpgrade(request: Request): boolean {
  return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
}

/**
 * Take the request over as a WebSocket carrying `data`, or say why not. The
 * upgrade itself is the server's, passed in so the handler runs without one.
 */
function socket(
  request: Request,
  data: SocketData,
  upgrade: (data: SocketData) => boolean,
): Response | undefined {
  if (!wantsUpgrade(request)) return text(426, 'This is a WebSocket endpoint\n', { upgrade: 'websocket' });
  return upgrade(data) ? undefined : text(500, 'The upgrade failed\n');
}

// --- Routing ---------------------------------------------------------------

/**
 * Answer one request. `upgrade` turns the request into a WebSocket with the
 * data it is handed and says whether it did; a handler that upgraded
 * returns nothing, as Bun's `fetch` does. Exported so the site can be
 * tested without a socket.
 */
export async function handle(
  request: Request,
  upgrade: (data: SocketData) => boolean = () => false,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const get = method === 'GET' || method === 'HEAD';
  const asset = STATIC[url.pathname];
  if (asset) return get ? staticAsset(request, asset) : text(405, 'GET only\n');
  switch (url.pathname) {
    case '/':
      return get ? home(request) : text(405, 'GET only\n');
    case '/notes':
      return method === 'POST' ? notes(request) : text(405, 'POST only\n');
    case '/echo':
      return echo(request, url);
    case '/login':
      if (get) return loginPage(url, userOf(request));
      return method === 'POST' ? login(request) : text(405, 'GET or POST\n');
    case '/logout':
      return method === 'POST' ? logout(request) : text(405, 'POST only\n');
    case '/private':
      return get ? privatePage(userOf(request)) : text(405, 'GET only\n');
    case '/api/me': {
      const user = userOf(request);
      return user === null ? json(401, { error: 'not signed in' }) : json(200, { user });
    }
    case '/ws/echo':
      return socket(request, { kind: 'echo', user: userOf(request) }, upgrade);
    case '/ws/private': {
      const user = userOf(request);
      if (user === null) return signInFirst();
      return socket(request, { kind: 'private', user }, upgrade);
    }
    default:
      return text(404, `Nothing at ${url.pathname}\n`);
  }
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8000);
  // Loopback only: tor in the same container forwards the onion's port 80
  // here, and nothing else is meant to reach it.
  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port,
    fetch: (request, server) => handle(request, (data) => server.upgrade(request, { data })),
    websocket,
  });
  console.log(`sample site on http://127.0.0.1:${server.port}/`);
}
