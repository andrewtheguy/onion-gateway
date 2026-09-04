// The gateway in a browser, against the sample site in onion/, which the
// container there publishes as an onion service. Headless Chrome opens
// http://<address>.onion.intor.localhost on Vite's dev server, and everything
// it then sees came through the service worker, over Tor. Five phases, each
// building on the last:
//
//   1. static content: the page, its style sheet, script and image, a text
//      file, a gzip-encoded one, a megabyte of fixed bytes, and a 404
//   2. dynamic content: a form POST answered with a page, and a script's
//      PUT, POST with a binary body, and DELETE, echoed back as JSON
//   3. WebSocket: the page opens one to the onion and echoes text and bytes
//   4. cookie auth: a counter cookie round-trips, a gated page and API refuse
//      a visitor, a username-and-password sign-in opens them, a sign-out
//      shuts them again
//   5. sign-in for a gated WebSocket: refused signed out, an echo signed in
//
//   e2e/run.sh                       # everything, from containers to teardown
//
// or, with the pieces up already:
//
//   onion/onion.sh start && eval "$(onion/onion.sh env)"
//   bun run test:e2e                 # with a directory backend serving a seed
//
// Environment:
//   SAMPLE_ONION        http://<address>.onion, what `onion.sh env` prints
//   DIRECTORY_BACKEND   the directory backend to proxy `/api` to, as a port
//                       or an origin; 127.0.0.1:5180 without one. It must be
//                       serving a seed already: the manifest answers 503
//                       until a backend's first build lands, and the worker
//                       would fall back to a Tor download if it asked in that
//                       window — a path that also works, but not the one this
//                       suite is here to drive.
//   BRIDGE_URL          a bridge instead of the public one, with
//   BRIDGE_FINGERPRINT  its identity; both or neither. Without one the worker
//                       bootstraps across the public Snowflake bridge.
//                       webtor-rs's scripts/local-bridge prints both.
//   CHROME_PATH         Chrome-family binary; without one, the usual places
//                       on Linux and macOS are tried.

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll as after, beforeAll as before, describe, it } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import {
  HELLO_TEXT,
  PASSWORD,
  SCRIPT_RAN_TEXT,
  STATIC,
  STYLED_COLOR,
  USERNAME,
} from './onion/server.ts';

const GATEWAY = path.resolve(import.meta.dirname, '..', 'gateway');
const SAMPLE_ONION = process.env.SAMPLE_ONION;
const BRIDGE_URL = process.env.BRIDGE_URL;
const BRIDGE_FINGERPRINT = process.env.BRIDGE_FINGERPRINT;
const DIRECTORY_BACKEND = process.env.DIRECTORY_BACKEND ?? '5180';
const DIRECTORY_BACKEND_ORIGIN = /^\d+$/.test(DIRECTORY_BACKEND)
  ? `http://127.0.0.1:${DIRECTORY_BACKEND}`
  : DIRECTORY_BACKEND;
/** Any name under `.localhost` does; the browser resolves them all to loopback. */
const GATEWAY_HOST = 'intor.localhost';

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Install, bootstrap, and a first rendezvous with the onion. */
const FIRST_PAGE_TIMEOUT_MS = 4 * 60_000;
/** A request on the circuit the first page built. */
const PAGE_TIMEOUT_MS = 90_000;
/**
 * How long the site may keep not answering at first. Its tor publishes the
 * descriptor a while after bootstrapping, and until then the gateway can only
 * show its error page; a reload asks again.
 */
const REACHABLE_DEADLINE_MS = 4 * 60_000;
/** How long a later page may keep failing: a restarted worker, a lost circuit. */
const RETRY_DEADLINE_MS = 2 * 60_000;
const CASE_TIMEOUT = 6 * 60_000;

/**
 * Whether the gateway carries a page's WebSockets to the onion. It does not
 * yet — a service worker never sees a `new WebSocket()`, so it would take a
 * shim on the page relaying to the worker's `connectWebSocket` — and until
 * it does, the cases that need one (phase 3 and phase 5) are skipped rather
 * than left red. Flip this when the gateway gets that path; the cases are
 * what it has to pass.
 */
const WEBSOCKETS_IMPLEMENTED = false;
const socketCase = it.skipIf(!WEBSOCKETS_IMPLEMENTED);

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const say = (line: string) => console.log(`  ${elapsed().padStart(7)} ${line}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chromePath(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  assert.ok(found, `No Chrome found at ${CHROME_CANDIDATES.join(', ')}; set CHROME_PATH.`);
  return found;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Relay a child's output into the log, one prefixed line at a time. */
function relayOutput(child: ChildProcess, prefix: string): void {
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) say(`[${prefix}] ${line.trim()}`);
    });
  }
}

/** Poll `url` until it answers 200, or `child` exits, or `deadlineMs` passes. */
async function waitForListening(child: ChildProcess, url: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${url} exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`${url} did not start answering in ${deadlineMs / 1000}s`);
    }
    await sleep(250);
  }
}

/** Fail early, and say why, unless the directory backend is serving a seed. */
async function checkBackend(): Promise<void> {
  const url = `${DIRECTORY_BACKEND_ORIGIN}/api/directory`;
  const status = await fetch(url)
    .then((response) => String(response.status))
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  assert.equal(
    status,
    '200',
    `${url} answered ${status}. Start a directory backend there and let it build a seed, or set DIRECTORY_BACKEND.`,
  );
}

/**
 * Vite's dev server on a port of its own, from the gateway directory, with
 * the bridge passed through as the `VITE_` variables the worker reads and
 * `/api` proxied to `backend`. `--host 127.0.0.1` so the port is loopback
 * only; the browser reaches it by name all the same.
 */
async function startVite(port: number, backend: string): Promise<ChildProcess> {
  const vite = path.join(GATEWAY, 'node_modules', '.bin', 'vite');
  assert.ok(existsSync(vite), `${vite} is missing; run bun install in ${GATEWAY}`);
  const env: NodeJS.ProcessEnv = { ...process.env, GATEWAY_DEV_BACKEND: backend };
  if (BRIDGE_URL && BRIDGE_FINGERPRINT) {
    env.VITE_BRIDGE_URL = BRIDGE_URL;
    env.VITE_BRIDGE_FINGERPRINT = BRIDGE_FINGERPRINT;
  }
  const child = spawn(
    vite,
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort', '--clearScreen', 'false'],
    { cwd: GATEWAY, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  relayOutput(child, 'vite');
  await waitForListening(child, `http://127.0.0.1:${port}/`, 30_000);
  return child;
}

function sha256(bytes: Uint8Array<ArrayBuffer>): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

/** What `/echo` says about a request. */
interface Echoed {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  bodyBytes: number;
  bodySha256: string;
  body: string;
}

/** What a page's WebSocket saw, from open to close. */
interface Exchange {
  opened: boolean;
  received: (string | number[])[];
  closeCode: number | null;
  closeReason: string;
  error: string | null;
  /** Nothing more came within the timeout; `error` says so too. */
  timedOut: boolean;
}

/** What a page settled on: the site's page, or a failure the gateway shows. */
type Settled = 'shown' | 'failed';

describe('the onion gateway against the sample onion site', () => {
  let onion: string;
  let origin: string;
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page;

  const text = (selector: string, timeout = PAGE_TIMEOUT_MS) =>
    page.locator(selector).innerText({ timeout });
  /**
   * Wait until `selector` says exactly `expected`. A locator keeps looking
   * through the navigations in between — a form's `303`, or the bootstrap
   * page a restarted worker shows — so this is how a step's outcome is read.
   */
  const expectText = async (selector: string, expected: string) => {
    await page
      .locator(selector)
      .filter({ hasText: new RegExp(`^${expected.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
      .waitFor({ timeout: PAGE_TIMEOUT_MS });
  };

  /**
   * Open `pathAndQuery` on the onion's gateway origin and wait for the onion's
   * answer. In between may come the install page, which registers the
   * worker and reloads; the bootstrap page, which reloads when the client is
   * up; and, if the onion could not be reached, the gateway's error page,
   * which is retried after a pause until `deadlineMs` passes. Returns the
   * HTTP status the document finally arrived with.
   */
  async function visit(pathAndQuery: string, deadlineMs = RETRY_DEADLINE_MS): Promise<number> {
    await page.goto(`${origin}${pathAndQuery}`);
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const handle = await page.waitForFunction(
        (): Settled | false => {
          // A failure box the gateway has shown: the install page's, the
          // bootstrap page's once a bootstrap fails, or the error page's.
          const failure = document.querySelector<HTMLElement>('.failure');
          if (failure !== null && !failure.hidden) return 'failed';
          // The gateway's own app, installing the worker; the bootstrap
          // page, following the client. Both reload themselves.
          if (document.getElementById('root') !== null) return false;
          if (document.title.startsWith('Connecting to ')) return false;
          return 'shown';
        },
        undefined,
        { timeout: FIRST_PAGE_TIMEOUT_MS },
      );
      const settled = (await handle.jsonValue()) as Settled;
      if (settled === 'shown') break;
      const reason = await page.locator('.failure').innerText().catch(() => '(gone)');
      say(`gateway showed a failure for ${pathAndQuery}: ${reason.replaceAll('\n', ' ')}`);
      assert.ok(Date.now() < deadline, `the onion never answered ${pathAndQuery}: ${reason}`);
      await sleep(5_000);
      await page.reload();
    }
    return page.evaluate(
      () =>
        (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming & {
          responseStatus?: number;
        }).responseStatus ?? 0,
    );
  }

  /** `fetch(path, init)` from the page: the status, the headers and the body as text. */
  async function pageFetch(pathAndQuery: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return page.evaluate(
      async ({ pathAndQuery, init }) => {
        const response = await fetch(pathAndQuery, init);
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        return { status: response.status, headers, text: await response.text() };
      },
      { pathAndQuery, init },
    );
  }

  async function echo(init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    const result = await pageFetch('/echo?via=script', init);
    assert.equal(result.status, 200, `echo answered ${result.status}: ${result.text}`);
    return JSON.parse(result.text) as Echoed;
  }

  /**
   * Open a WebSocket from the page to `pathAndQuery` on its own host — what a
   * site's script does — send `sends` once it opens, and collect what comes
   * back until `want` messages have arrived, the socket closes, or the
   * timeout passes.
   */
  async function wsExchange(pathAndQuery: string, sends: (string | number[])[], want: number): Promise<Exchange> {
    return page.evaluate(
      ({ pathAndQuery, sends, want, timeoutMs }) =>
        new Promise<Exchange>((resolve) => {
          const out: Exchange = {
            opened: false,
            received: [],
            closeCode: null,
            closeReason: '',
            error: null,
            timedOut: false,
          };
          let socket: WebSocket;
          const timer = setTimeout(() => {
            out.timedOut = true;
            out.error = `no answer within ${timeoutMs / 1000}s`;
            finish();
          }, timeoutMs);
          const finish = () => {
            clearTimeout(timer);
            try {
              socket.close();
            } catch {
              // Already closed, or never opened.
            }
            resolve(out);
          };
          try {
            socket = new WebSocket(`ws://${location.host}${pathAndQuery}`);
          } catch (error) {
            clearTimeout(timer);
            out.error = String(error);
            resolve(out);
            return;
          }
          socket.binaryType = 'arraybuffer';
          socket.onopen = () => {
            out.opened = true;
            for (const message of sends) socket.send(Array.isArray(message) ? new Uint8Array(message) : message);
          };
          socket.onmessage = (event) => {
            out.received.push(
              typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data as ArrayBuffer)],
            );
            if (out.received.length >= want) finish();
          };
          socket.onerror = () => {
            out.error ??= 'the socket reported an error';
          };
          socket.onclose = (event) => {
            out.closeCode = event.code;
            out.closeReason = event.reason;
            finish();
          };
        }),
      { pathAndQuery, sends, want, timeoutMs: PAGE_TIMEOUT_MS },
    );
  }

  /**
   * The onion turned the socket away: it never opened, and the browser
   * said so by closing it — the handshake's `401` — rather than by leaving
   * it pending until the timeout, which is what a socket nothing answers
   * looks like and proves nothing about the gate.
   */
  function assertRefused(exchange: Exchange, when: string): void {
    const shown = JSON.stringify(exchange);
    assert.equal(exchange.opened, false, `the gated socket opened ${when}: ${shown}`);
    assert.deepEqual(exchange.received, []);
    assert.equal(exchange.timedOut, false, `the gated socket was not answered ${when}: ${shown}`);
    assert.notEqual(exchange.closeCode, null, `the gated socket never closed ${when}: ${shown}`);
  }

  /** Submit the sign-in form on `/login` and wait for the answer. */
  async function signIn(username: string, password: string): Promise<void> {
    await visit('/login');
    await page.fill('#login input[name="username"]', username, { timeout: PAGE_TIMEOUT_MS });
    await page.fill('#login input[name="password"]', password, { timeout: PAGE_TIMEOUT_MS });
    await page.click('#login button');
  }

  before(async () => {
    assert.ok(SAMPLE_ONION, 'SAMPLE_ONION is not set. Start onion/onion.sh and eval its `env`.');
    onion = new URL(SAMPLE_ONION).hostname;
    assert.match(onion, /^[a-z2-7]{56}\.onion$/, `SAMPLE_ONION is ${SAMPLE_ONION}`);
    assert.equal(
      Boolean(BRIDGE_URL),
      Boolean(BRIDGE_FINGERPRINT),
      'BRIDGE_URL and BRIDGE_FINGERPRINT are set together or not at all',
    );

    await checkBackend();
    const port = await freePort();
    vite = await startVite(port, DIRECTORY_BACKEND);
    origin = `http://${onion}.${GATEWAY_HOST}:${port}`;
    say(`gateway at ${origin}`);

    browser = await chromium.launch({ executablePath: chromePath(), headless: true });
    page = await browser.newPage();
    page.on('console', (message) => say(`[page] ${message.text()}`));
    page.on('pageerror', (error) => say(`[page] error: ${error.message}`));
  });

  after(async () => {
    await browser?.close();
    vite?.kill();
  });

  // --- Phase 1: static content ---------------------------------------------

  it('phase 1: installs the worker, bootstraps, and shows the page', async () => {
    const status = await visit('/', REACHABLE_DEADLINE_MS);
    say('onion page shown');
    assert.equal(status, 200);
    assert.equal(await text('h1'), 'Sample onion');
    assert.equal(page.url(), `${origin}/`);
  }, CASE_TIMEOUT);

  it('phase 1: loads the style sheet, the script and the image through the worker', async () => {
    await expectText('#script-ran', SCRIPT_RAN_TEXT);
    const color = await page.evaluate(() => getComputedStyle(document.getElementById('styled')!).color);
    assert.equal(color, STYLED_COLOR);
    await page.waitForFunction(
      () => {
        const image = document.getElementById('pixel') as HTMLImageElement;
        return image.complete && image.naturalWidth > 0;
      },
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
    const size = await page.evaluate(() => {
      const image = document.getElementById('pixel') as HTMLImageElement;
      return [image.naturalWidth, image.naturalHeight];
    });
    assert.deepEqual(size, [1, 1]);
  }, CASE_TIMEOUT);

  it('phase 1: fetches a text file, with its type', async () => {
    const hello = await pageFetch('/static/hello.txt');
    assert.equal(hello.status, 200);
    assert.equal(hello.headers['content-type'], STATIC['/static/hello.txt']!.type);
    assert.equal(hello.text, HELLO_TEXT);
  }, CASE_TIMEOUT);

  it('phase 1: fetches a gzip-encoded file, decoded by the worker', async () => {
    const compressed = await pageFetch('/static/compressed.txt');
    assert.equal(compressed.status, 200);
    assert.equal(compressed.text, HELLO_TEXT);
    assert.equal(compressed.headers['content-encoding'], undefined);
  }, CASE_TIMEOUT);

  it('phase 1: fetches a megabyte of binary intact', async () => {
    const expected = STATIC['/static/blob.bin']!.body;
    const got = await page.evaluate(async () => {
      const response = await fetch('/static/blob.bin');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        length: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      };
    });
    assert.equal(got.status, 200);
    assert.equal(got.type, 'application/octet-stream');
    assert.equal(got.length, expected.byteLength);
    assert.equal(got.sha256, sha256(expected));
  }, CASE_TIMEOUT);

  it('phase 1: passes the status the onion chose to the page', async () => {
    const status = await visit('/nowhere');
    assert.equal(status, 404);
    assert.equal((await page.locator('body').innerText()).trim(), 'Nothing at /nowhere');
  }, CASE_TIMEOUT);

  // --- Phase 2: dynamic content --------------------------------------------

  it('phase 2: submits a form POST and shows the page it was answered with', async () => {
    await visit('/');
    await page.fill('#note input[name="text"]', 'hello from the gateway', { timeout: PAGE_TIMEOUT_MS });
    await page.click('#note button');
    await expectText('#posted', 'You posted: hello from the gateway');
    assert.equal(page.url(), `${origin}/notes`);
  }, CASE_TIMEOUT);

  it("phase 2: carries a script's PUT with its headers, in the onion's terms", async () => {
    const seen = await echo({
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'gateway-test' },
      body: '{"n":1}',
    });
    assert.equal(seen.method, 'PUT');
    assert.equal(seen.path, '/echo');
    assert.deepEqual(seen.query, { via: 'script' });
    assert.equal(seen.body, '{"n":1}');
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['x-requested-with'], 'gateway-test');
    // What the worker says on the page's behalf, in the onion's terms.
    assert.equal(seen.headers.host, onion);
    assert.equal(seen.headers.origin, `http://${onion}`);
    assert.equal(seen.headers.referer, `http://${onion}/notes`);
  }, CASE_TIMEOUT);

  it('phase 2: carries a POST with a binary body intact', async () => {
    const got = await page.evaluate(async () => {
      // Every byte value, in an order a truncated or reordered body would break.
      const bytes = new Uint8Array(100 * 1024);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + (i >> 8)) & 0xff;
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const response = await fetch('/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      return {
        sent: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        echoed: (await response.json()) as { method: string; bodyBytes: number; bodySha256: string },
      };
    });
    assert.equal(got.echoed.method, 'POST');
    assert.equal(got.echoed.bodyBytes, got.sent);
    assert.equal(got.echoed.bodySha256, got.sha256);
  }, CASE_TIMEOUT);

  it('phase 2: carries a bodiless DELETE', async () => {
    const seen = await echo({ method: 'DELETE' });
    assert.equal(seen.method, 'DELETE');
    assert.equal(seen.bodyBytes, 0);
  }, CASE_TIMEOUT);

  // --- Phase 3: WebSocket --------------------------------------------------

  socketCase('phase 3: opens a WebSocket from the page and echoes text and bytes', async () => {
    await visit('/');
    const exchange = await wsExchange('/ws/echo', ['hello onion', [1, 2, 3, 250]], 3);
    say(`ws /ws/echo: ${JSON.stringify(exchange)}`);
    assert.ok(exchange.opened, `the socket never opened: ${exchange.error ?? `closed with ${exchange.closeCode}`}`);
    assert.deepEqual(exchange.received, ['welcome', 'hello onion', [1, 2, 3, 250]]);
  }, CASE_TIMEOUT);

  // --- Phase 4: cookie auth ------------------------------------------------

  it('phase 4: keeps the cookie the onion set and sends it back', async () => {
    await visit('/');
    const before = Number((await text('#visits')).replace('Visit ', ''));
    assert.ok(before >= 1, `#visits says ${before}`);
    await visit('/');
    await expectText('#visits', `Visit ${before + 1}`);
  }, CASE_TIMEOUT);

  it('phase 4: is refused the gated page and API while signed out', async () => {
    const status = await visit('/private');
    assert.equal(status, 401);
    assert.equal(await text('h1'), 'Sign in first');
    const me = await pageFetch('/api/me');
    assert.equal(me.status, 401);
  }, CASE_TIMEOUT);

  it('phase 4: is turned away with the wrong password', async () => {
    await signIn(USERNAME, 'not it');
    await expectText('#error', 'Wrong username or password');
    assert.equal(page.url(), `${origin}/login?error`);
    assert.equal(await text('#who'), 'Not signed in');
    assert.equal((await pageFetch('/api/me')).status, 401);
  }, CASE_TIMEOUT);

  it('phase 4: signs in with the username and password and is let in', async () => {
    await signIn(USERNAME, PASSWORD);
    // The onion answers `303 See Other` to `/private`; the worker rewrites
    // that `Location` into this origin, and the browser follows it here with
    // the session cookie the worker kept.
    await expectText('#who', `Signed in as ${USERNAME}`);
    assert.equal(page.url(), `${origin}/private`);
    assert.equal(await text('h1'), 'Private');

    const me = await pageFetch('/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(JSON.parse(me.text), { user: USERNAME });

    // The jar is the worker's: the page sees none of the onion's cookies,
    // and the HttpOnly session still goes out on its requests.
    assert.equal(await page.evaluate(() => document.cookie), '');
    const seen = await echo();
    assert.match(seen.cookies.session ?? '', /^[0-9a-f-]{36}$/, JSON.stringify(seen.cookies));
    assert.ok(seen.cookies.visits, `no visits cookie in ${JSON.stringify(seen.cookies)}`);

    await visit('/');
    assert.equal(await text('#who'), `Signed in as ${USERNAME}`);
  }, CASE_TIMEOUT);

  it('phase 4: signs out and is refused again', async () => {
    await page.click('#logout button', { timeout: PAGE_TIMEOUT_MS });
    await expectText('#who', 'Not signed in');
    assert.equal(page.url(), `${origin}/`);
    assert.equal((await pageFetch('/api/me')).status, 401);
    assert.equal(await visit('/private'), 401);
  }, CASE_TIMEOUT);

  // --- Phase 5: sign-in for a gated WebSocket ------------------------------

  socketCase('phase 5: is refused the gated WebSocket while signed out', async () => {
    await visit('/');
    const exchange = await wsExchange('/ws/private', ['anyone there?'], 1);
    say(`ws /ws/private signed out: ${JSON.stringify(exchange)}`);
    assertRefused(exchange, 'for a signed-out visitor');
  }, CASE_TIMEOUT);

  socketCase('phase 5: signs in on the login page and echoes over the gated WebSocket', async () => {
    await signIn(USERNAME, PASSWORD);
    await expectText('#who', `Signed in as ${USERNAME}`);
    assert.equal(page.url(), `${origin}/private`);

    const exchange = await wsExchange('/ws/private', ['echo me', [9, 8, 7]], 3);
    say(`ws /ws/private signed in: ${JSON.stringify(exchange)}`);
    assert.ok(exchange.opened, `the socket never opened: ${exchange.error ?? `closed with ${exchange.closeCode}`}`);
    assert.deepEqual(exchange.received, [`welcome ${USERNAME}`, `${USERNAME}: echo me`, [9, 8, 7]]);
  }, CASE_TIMEOUT);

  socketCase('phase 5: loses the gated WebSocket on sign-out', async () => {
    await page.click('#logout button', { timeout: PAGE_TIMEOUT_MS });
    await expectText('#who', 'Not signed in');
    const exchange = await wsExchange('/ws/private', ['still there?'], 1);
    say(`ws /ws/private signed out again: ${JSON.stringify(exchange)}`);
    assertRefused(exchange, 'after sign-out');
  }, CASE_TIMEOUT);
});
