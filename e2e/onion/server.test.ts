// The sample site's handler, without a socket: what each route answers and
// what each WebSocket says. `bun run test` runs this; the container is for
// gateway.test.ts.

import { describe, expect, it } from 'bun:test';
import {
  HELLO_TEXT,
  PASSWORD,
  STATIC,
  USERNAME,
  blob,
  greeting,
  handle,
  parseCookies,
  reply,
  websocket,
  type SocketData,
} from './server';

const HOST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion';
const ORIGIN = `http://${HOST}`;

function request(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('host', HOST);
  if (init.cookie) headers.set('cookie', init.cookie);
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

function form(fields: Record<string, string>, extra: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Sign in and return the session cookie the site handed out. */
async function signIn(): Promise<string> {
  const response = await handle(
    request('/login', form({ username: USERNAME, password: PASSWORD }, { origin: ORIGIN })),
  );
  expect(response!.status).toBe(303);
  expect(response!.headers.get('location')).toBe('/private');
  const [cookie] = response!.headers.getSetCookie();
  expect(cookie).toMatch(/^session=[0-9a-f-]{36}; Path=\/; HttpOnly$/);
  return cookie!.split(';')[0]!;
}

/** A WebSocket request; `upgrade` records what the handler asked for. */
function upgradeRequest(path: string, cookie?: string): Request {
  return request(path, { headers: { upgrade: 'websocket', connection: 'Upgrade' }, cookie });
}

describe('parseCookies', () => {
  it('reads a Cookie header', () => {
    expect(parseCookies('a=1; b=two%20words; =nameless; novalue')).toEqual({ a: '1', b: 'two words' });
    expect(parseCookies(null)).toEqual({});
  });
});

describe('static content', () => {
  it('serves the page with its subresources linked', async () => {
    const response = await handle(request('/'));
    expect(response!.status).toBe(200);
    expect(response!.headers.get('content-type')).toMatch(/text\/html/);
    const html = await response!.text();
    expect(html).toContain('<h1>Sample onion</h1>');
    expect(html).toContain('href="/static/site.css"');
    expect(html).toContain('src="/static/app.js"');
    expect(html).toContain('src="/static/pixel.png"');
  });

  it('serves every asset with its type, and the fixed blob', async () => {
    for (const [path, asset] of Object.entries(STATIC)) {
      if (asset.gzip) continue;
      const response = await handle(request(path));
      expect(response!.status).toBe(200);
      expect(response!.headers.get('content-type')).toBe(asset.type);
      expect(new Uint8Array(await response!.arrayBuffer())).toEqual(asset.body);
    }
    const png = STATIC['/static/pixel.png']!.body;
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(blob().byteLength).toBe(1024 * 1024);
    expect(blob()).toEqual(blob());
  });

  it('gzips the compressed asset for a request that accepts it', async () => {
    const plain = await handle(request('/static/compressed.txt'));
    expect(plain!.headers.get('content-encoding')).toBeNull();
    expect(await plain!.text()).toBe(HELLO_TEXT);

    const gzipped = await handle(
      request('/static/compressed.txt', { headers: { 'accept-encoding': 'gzip, deflate' } }),
    );
    expect(gzipped!.headers.get('content-encoding')).toBe('gzip');
    const body = new Uint8Array(await gzipped!.arrayBuffer());
    expect(new TextDecoder().decode(Bun.gunzipSync(body as Uint8Array<ArrayBuffer>))).toBe(HELLO_TEXT);
  });

  it('answers 404 elsewhere and 405 for a POST to an asset', async () => {
    expect((await handle(request('/nowhere')))!.status).toBe(404);
    expect((await handle(request('/static/hello.txt', { method: 'POST' })))!.status).toBe(405);
  });
});

describe('dynamic content', () => {
  it('shows what a form posted, once Origin matches', async () => {
    const response = await handle(request('/notes', form({ text: '<hi>' }, { origin: ORIGIN })));
    expect(response!.status).toBe(200);
    expect(await response!.text()).toContain('<p id="posted">You posted: &lt;hi&gt;</p>');

    const crossSite = await handle(request('/notes', form({ text: 'x' })));
    expect(crossSite!.status).toBe(403);
    expect(await crossSite!.text()).toContain('Cross-site request refused');
  });

  it('echoes a request, its body hashed', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const response = await handle(
      request('/echo?a=1', {
        method: 'PUT',
        headers: { 'x-requested-with': 'test' },
        body,
        cookie: 'visits=3',
      }),
    );
    const echoed = (await response!.json()) as Record<string, unknown>;
    expect(echoed.method).toBe('PUT');
    expect(echoed.path).toBe('/echo');
    expect(echoed.query).toEqual({ a: '1' });
    expect((echoed.headers as Record<string, string>)['x-requested-with']).toBe('test');
    expect(echoed.cookies).toEqual({ visits: '3' });
    expect(echoed.bodyBytes).toBe(5);
    expect(echoed.bodySha256).toBe(new Bun.CryptoHasher('sha256').update(body).digest('hex'));
  });
});

describe('cookie auth', () => {
  it('counts visits in a cookie', async () => {
    const first = await handle(request('/'));
    expect(await first!.text()).toContain('<p id="visits">Visit 1</p>');
    expect(first!.headers.getSetCookie()).toEqual(['visits=1; Path=/']);
    const later = await handle(request('/', { cookie: 'visits=4' }));
    expect(await later!.text()).toContain('<p id="visits">Visit 5</p>');
  });

  it('gates the private page and the API behind the session', async () => {
    const shutOut = await handle(request('/private'));
    expect(shutOut!.status).toBe(401);
    expect(await shutOut!.text()).toContain('<h1>Sign in first</h1>');
    expect((await handle(request('/api/me')))!.status).toBe(401);

    const cookie = await signIn();
    const opened = await handle(request('/private', { cookie }));
    expect(opened!.status).toBe(200);
    expect(await opened!.text()).toContain(`<p id="who">Signed in as ${USERNAME}</p>`);
    expect(await (await handle(request('/api/me', { cookie })))!.json()).toEqual({ user: USERNAME });
    expect(await (await handle(request('/', { cookie })))!.text()).toContain(
      `<p id="who">Signed in as ${USERNAME}</p>`,
    );

    const out = await handle(request('/logout', { ...form({}, { origin: ORIGIN }), cookie }));
    expect(out!.status).toBe(303);
    expect(out!.headers.getSetCookie()).toEqual(['session=; Path=/; Max-Age=0']);
    // The token is gone on the server too: replaying the cookie opens nothing.
    expect((await handle(request('/private', { cookie })))!.status).toBe(401);
  });

  it('refuses a wrong password and a cross-site sign-in', async () => {
    const wrong = await handle(
      request('/login', form({ username: USERNAME, password: 'nope' }, { origin: ORIGIN })),
    );
    expect(wrong!.status).toBe(303);
    expect(wrong!.headers.get('location')).toBe('/login?error');
    expect(wrong!.headers.getSetCookie()).toEqual([]);

    const errorPage = await handle(request('/login?error'));
    expect(errorPage!.status).toBe(401);
    expect(await errorPage!.text()).toContain('<p id="error">Wrong username or password</p>');

    const crossSite = await handle(request('/login', form({ username: USERNAME, password: PASSWORD })));
    expect(crossSite!.status).toBe(403);
  });
});

describe('WebSockets', () => {
  it('upgrades the echo socket for anyone', async () => {
    const upgraded: SocketData[] = [];
    const response = await handle(upgradeRequest('/ws/echo'), (data) => {
      upgraded.push(data);
      return true;
    });
    expect(response).toBeUndefined();
    expect(upgraded).toEqual([{ kind: 'echo', user: null }]);
  });

  it('asks a plain GET to upgrade', async () => {
    const response = await handle(request('/ws/echo'));
    expect(response!.status).toBe(426);
    expect(response!.headers.get('upgrade')).toBe('websocket');
  });

  it('upgrades the private socket only with a session', async () => {
    const shutOut = await handle(upgradeRequest('/ws/private'), () => {
      throw new Error('upgraded without a session');
    });
    expect(shutOut!.status).toBe(401);

    const cookie = await signIn();
    const upgraded: SocketData[] = [];
    const response = await handle(upgradeRequest('/ws/private', cookie), (data) => {
      upgraded.push(data);
      return true;
    });
    expect(response).toBeUndefined();
    expect(upgraded).toEqual([{ kind: 'private', user: USERNAME }]);
  });

  it('greets, echoes text, echoes bytes, and signs the private echo', () => {
    const echo: SocketData = { kind: 'echo', user: null };
    const priv: SocketData = { kind: 'private', user: USERNAME };
    expect(greeting(echo)).toBe('welcome');
    expect(greeting(priv)).toBe(`welcome ${USERNAME}`);
    expect(reply(echo, 'hi')).toBe('hi');
    expect(reply(priv, 'hi')).toBe(`${USERNAME}: hi`);
    expect(reply(priv, new Uint8Array([7, 8]))).toEqual(new Uint8Array([7, 8]));

    const sent: (string | Uint8Array)[] = [];
    const ws = { data: priv, send: (message: string | Uint8Array) => sent.push(message) };
    websocket.open(ws);
    websocket.message(ws, 'a message');
    websocket.message(ws, Buffer.from([1, 2, 3]));
    expect(sent).toEqual([`welcome ${USERNAME}`, `${USERNAME}: a message`, new Uint8Array([1, 2, 3])]);
  });
});
