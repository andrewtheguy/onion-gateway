/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BRIDGE_URL?: string;
  readonly VITE_BRIDGE_FINGERPRINT?: string;
  /** A directory manifest URL on another host; the gateway host's own by default. */
  readonly VITE_DIRECTORY_URL?: string;
  /** `true` puts each onion at `<address>.<root>`, without the `.onion` label; `<address>.onion.<root>` otherwise. */
  readonly VITE_BARE_ONION_SUBDOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
