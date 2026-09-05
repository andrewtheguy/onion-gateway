// The page's `WebSocket`, replaced. A service worker never sees a WebSocket
// handshake, so the gateway's worker puts this script first in every HTML
// document it serves; from then on a `new WebSocket()` for this origin, or
// for the onion's own `ws://<address>.onion/…`, is opened by the worker
// through its Tor client and relayed over a `MessageChannel`, and one for
// anywhere else goes to the browser's own `WebSocket` as before. The messages
// on the channel are the `SocketToWorker` and `SocketToPage` shapes in
// protocol.ts.
//
// Plain JavaScript, served byte for byte by the worker at a URL of its own:
// a page's `Content-Security-Policy` of `script-src 'self'` allows a script
// from this origin and forbids an inline one. It replaces nothing when the
// page is not on a gateway origin or has no service worker to speak to.

(() => {
  'use strict';

  // The address is the first label whether or not `.onion` follows it: the
  // worker serving this script is on a gateway origin of one form or the
  // other, and only the address is needed here.
  const gateway = /^([a-z2-7]{56})(?:\.onion)?\./.exec(location.hostname);
  const worker = navigator.serviceWorker;
  const NativeWebSocket = globalThis.WebSocket;
  if (!gateway || !worker || !NativeWebSocket) return;
  const onion = `${gateway[1]}.onion`;

  const CONNECTING = 0;
  const OPEN = 1;
  const CLOSING = 2;
  const CLOSED = 3;
  /**
   * How often a page with a socket open nudges the worker. A browser stops an
   * idle service worker within about half a minute, and the sockets it
   * carries would go with it; a message is what counts as activity.
   */
  const KEEP_ALIVE_MS = 10_000;
  const utf8 = new TextEncoder();

  /** Sockets not yet closed, for the keep-alive. */
  const live = new Set();
  let keepAlive = null;

  function track(socket) {
    live.add(socket);
    if (keepAlive === null) {
      keepAlive = setInterval(() => {
        if (worker.controller) worker.controller.postMessage({ type: 'keepalive' });
      }, KEEP_ALIVE_MS);
    }
  }

  function untrack(socket) {
    live.delete(socket);
    if (live.size === 0 && keepAlive !== null) {
      clearInterval(keepAlive);
      keepAlive = null;
    }
  }

  /**
   * The URL a `new WebSocket(url)` means, resolved the way the browser does
   * it — relative to the page, with `http:` and `https:` read as `ws:` and
   * `wss:` — or `null` for one the browser's own constructor should refuse.
   */
  function resolve(url) {
    let parsed;
    try {
      parsed = new URL(String(url), location.href);
    } catch {
      return null;
    }
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    return parsed;
  }

  /**
   * Whether the worker answers for `url`: this origin, whatever the scheme,
   * or the onion itself over `ws:`. A fragment is left to the browser, which
   * refuses it. Any other onion goes to the browser too, to fail there, the
   * way the worker treats a fetch of one.
   */
  function isOurs(url) {
    if (url.hash !== '') return false;
    if ((url.protocol === 'ws:' || url.protocol === 'wss:') && url.host === location.host) return true;
    return (
      url.protocol === 'ws:' &&
      url.hostname === onion &&
      (url.port === '' || url.port === '80')
    );
  }

  /** `data` as the string or `ArrayBuffer` the channel carries, and its size in bytes. */
  function outgoing(data) {
    if (typeof data === 'string') {
      return { size: utf8.encode(data).byteLength, payload: Promise.resolve(data) };
    }
    if (data instanceof Blob) return { size: data.size, payload: data.arrayBuffer() };
    if (data instanceof ArrayBuffer) {
      return { size: data.byteLength, payload: Promise.resolve(data.slice(0)) };
    }
    if (ArrayBuffer.isView(data)) {
      const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      return { size: copy.byteLength, payload: Promise.resolve(copy) };
    }
    // Anything else is sent as text, as the browser's own does.
    const text = String(data);
    return { size: utf8.encode(text).byteLength, payload: Promise.resolve(text) };
  }

  class GatewayWebSocket extends EventTarget {
    #url;
    #readyState = CONNECTING;
    #protocol = '';
    #binaryType = 'blob';
    #bufferedAmount = 0;
    /** The channel to the worker, until the socket is closed. */
    #port = null;
    /** Sends and the close, each after the last, so a `Blob` keeps its place. */
    #queue = Promise.resolve();

    constructor(url, protocols = []) {
      const resolved = resolve(url);
      if (resolved === null || !isOurs(resolved)) return new NativeWebSocket(url, protocols);
      super();
      this.#url = resolved.href;
      const offered = typeof protocols === 'string' ? [protocols] : Array.from(protocols, String);
      if (new Set(offered).size !== offered.length) {
        throw new DOMException(`The subprotocol list has a duplicate: ${offered.join(', ')}`, 'SyntaxError');
      }
      const controller = worker.controller;
      if (!controller) {
        queueMicrotask(() => this.#fail('the gateway is not controlling this page'));
        return;
      }
      const channel = new MessageChannel();
      this.#port = channel.port1;
      this.#port.onmessage = (event) => this.#receive(event.data);
      controller.postMessage({ type: 'websocket', url: this.#url, protocols: offered }, [channel.port2]);
      track(this);
    }

    get url() {
      return this.#url;
    }

    get readyState() {
      return this.#readyState;
    }

    get protocol() {
      return this.#protocol;
    }

    get extensions() {
      return '';
    }

    get bufferedAmount() {
      return this.#bufferedAmount;
    }

    get binaryType() {
      return this.#binaryType;
    }

    set binaryType(value) {
      // An unknown value is ignored, as for any enumerated attribute.
      if (value === 'blob' || value === 'arraybuffer') this.#binaryType = value;
    }

    send(data) {
      if (this.#readyState === CONNECTING) {
        throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      }
      if (this.#readyState !== OPEN) return;
      const { size, payload } = outgoing(data);
      this.#bufferedAmount += size;
      this.#queue = this.#queue.then(
        () => payload.then((message) => {
          this.#bufferedAmount -= size;
          if (this.#port === null) return;
          this.#port.postMessage({ type: 'send', data: message }, typeof message === 'string' ? [] : [message]);
        }),
        () => undefined,
      ).catch(() => {
        // A Blob that could not be read; nothing to send for it.
        this.#bufferedAmount -= size;
      });
    }

    close(code, reason = '') {
      if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
        throw new DOMException(
          `Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. ${code} is neither.`,
          'InvalidAccessError',
        );
      }
      const text = String(reason);
      if (utf8.encode(text).byteLength > 123) {
        throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", 'SyntaxError');
      }
      if (this.#readyState === CLOSING || this.#readyState === CLOSED) return;
      this.#readyState = CLOSING;
      if (this.#port === null) {
        // Never reached the worker; there is nothing to wait for.
        this.#finish(1006, '', false);
        return;
      }
      const message = { type: 'close', code: code === undefined ? 1000 : code, reason: text };
      this.#queue = this.#queue.then(() => {
        if (this.#port !== null) this.#port.postMessage(message);
      });
    }

    #receive(message) {
      switch (message.type) {
        case 'open':
          if (this.#readyState !== CONNECTING) return;
          this.#readyState = OPEN;
          this.#protocol = message.protocol;
          this.dispatchEvent(new Event('open'));
          return;
        case 'message': {
          if (this.#readyState !== OPEN) return;
          let data = message.data;
          if (typeof data !== 'string' && this.#binaryType === 'blob') data = new Blob([data]);
          this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.#url).origin }));
          return;
        }
        case 'error':
          console.error(`WebSocket connection to '${this.#url}' failed: ${message.message}`);
          this.dispatchEvent(new Event('error'));
          return;
        case 'close':
          this.#finish(message.code, message.reason, message.wasClean);
          return;
        default:
          return;
      }
    }

    #fail(detail) {
      console.error(`WebSocket connection to '${this.#url}' failed: ${detail}`);
      this.dispatchEvent(new Event('error'));
      this.#finish(1006, '', false);
    }

    #finish(code, reason, wasClean) {
      if (this.#readyState === CLOSED) return;
      this.#readyState = CLOSED;
      if (this.#port !== null) {
        this.#port.close();
        this.#port = null;
      }
      untrack(this);
      this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean }));
    }
  }

  // `onopen` and the rest are event handler attributes: setting one
  // registers a listener, in order with any added by `addEventListener`.
  for (const name of ['open', 'message', 'error', 'close']) {
    const handlers = new WeakMap();
    Object.defineProperty(GatewayWebSocket.prototype, `on${name}`, {
      configurable: true,
      enumerable: true,
      get() {
        return handlers.get(this) ?? null;
      },
      set(handler) {
        const previous = handlers.get(this);
        if (previous) this.removeEventListener(name, previous);
        if (typeof handler === 'function') {
          handlers.set(this, handler);
          this.addEventListener(name, handler);
        } else {
          handlers.delete(this);
        }
      },
    });
  }

  for (const [name, value] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
    Object.defineProperty(GatewayWebSocket, name, { value, enumerable: true });
    Object.defineProperty(GatewayWebSocket.prototype, name, { value, enumerable: true });
  }
  Object.defineProperty(GatewayWebSocket, 'name', { value: 'WebSocket' });
  Object.defineProperty(GatewayWebSocket.prototype, Symbol.toStringTag, { value: 'WebSocket', configurable: true });

  globalThis.WebSocket = GatewayWebSocket;
})();
