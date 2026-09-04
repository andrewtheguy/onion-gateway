// What the gateway's service worker tells a page that asked to follow along
// while the Tor client bootstraps. The worker's own interstitial page speaks
// this in plain JavaScript, so the shape is kept deliberately flat.

export type GatewayPhase = 'starting' | 'ready' | 'failed';

export type GatewayLevel = 'info' | 'success' | 'warn' | 'error';

export interface GatewayLine {
  at: number;
  level: GatewayLevel;
  message: string;
}

export interface GatewayProgress {
  type: 'progress';
  onion: string;
  phase: GatewayPhase;
  lines: GatewayLine[];
  /** Why the last bootstrap failed, while `phase` is `failed`. */
  failure: string | null;
}

/** A page's request for the current progress, and for every later change. */
export interface GatewaySubscribe {
  type: 'subscribe';
}

// --- WebSockets -------------------------------------------------------------
//
// A service worker never sees a page's `new WebSocket()`, so the worker puts
// a script into every HTML document it serves that replaces the page's
// `WebSocket` with one speaking this protocol (see websocket-shim.js). The
// shim opens a `MessageChannel`, hands the worker one port along with a
// `GatewaySocketOpen`, and the socket then lives on that port: the page sends
// `SocketToWorker` messages, the worker `SocketToPage` ones. The worker opens
// the socket through the Tor client and relays both ways.

/** A page's request to open a WebSocket; the `MessagePort` comes with it. */
export interface GatewaySocketOpen {
  type: 'websocket';
  /** Absolute, `ws:` or `wss:`; the worker decides whether it is this onion's. */
  url: string;
  /** The subprotocols the page offered, in order. */
  protocols: string[];
}

/**
 * A page with a socket open sends one of these every few seconds: a browser
 * stops an idle service worker within about half a minute, and a message is
 * what counts as activity.
 */
export interface GatewayKeepAlive {
  type: 'keepalive';
}

/** What a page says to the worker on a socket's port. */
export type SocketToWorker =
  | { type: 'send'; data: string | ArrayBuffer }
  | { type: 'close'; code: number; reason: string };

/** What the worker says to a page on a socket's port. */
export type SocketToPage =
  | { type: 'open'; protocol: string }
  | { type: 'message'; data: string | ArrayBuffer }
  /** Always followed by a `close`. */
  | { type: 'error'; message: string }
  | { type: 'close'; code: number; reason: string; wasClean: boolean };
