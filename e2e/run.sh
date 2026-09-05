#!/bin/sh
# The whole suite, from nothing: the sample onion in its container, a
# directory backend, the dependencies, the five phases, and then the
# teardown. See README.md. Arguments go to `bun test`, so `run.sh -t 'phase 1'`
# runs one phase.
set -eu

HERE=$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(dirname "$HERE")
ONION="$HERE/onion/onion.sh"
DIRECTORY_PORT=${DIRECTORY_PORT:-5180}
LOGS="$HERE/.logs"
mkdir -p "$LOGS"

backend_pid=
onion_was_running=

cleanup() {
    status=$?
    trap - EXIT INT TERM
    if [ -n "$backend_pid" ]; then
        kill "$backend_pid" 2>/dev/null || true
    fi
    # Only what this run started goes down with it; a container that was up
    # before is left as it was, and KEEP_ONION=1 leaves this run's up too.
    if [ -z "$onion_was_running" ] && [ -z "${KEEP_ONION:-}" ]; then
        "$ONION" stop
    fi
    exit "$status"
}
trap cleanup EXIT INT TERM

answers() {
    curl -fsS -o /dev/null "$1" 2>/dev/null
}

# --- 1. The onion ----------------------------------------------------------

case "$("$ONION" status 2>/dev/null | head -n 1)" in
    running*) onion_was_running=1 ;;
esac
"$ONION" start
eval "$("$ONION" env)"
export SAMPLE_ONION

# --- 2. The directory backend ----------------------------------------------

if [ -n "${DIRECTORY_URL:-}" ]; then
    # A published directory: nothing to start, and the suite asks it directly.
    manifest=$DIRECTORY_URL
elif [ -z "${DIRECTORY_BACKEND:-}" ]; then
    origin="http://127.0.0.1:$DIRECTORY_PORT"
    if answers "$origin/api/health"; then
        echo "using the directory backend already listening on $origin" >&2
    else
        echo "building directory-server" >&2
        (cd "$ROOT/directory-server" && cargo build --release --quiet)
        "$ROOT/directory-server/target/release/webtor-directory-server" serve \
            --listen "127.0.0.1:$DIRECTORY_PORT" >"$LOGS/directory-server.log" 2>&1 &
        backend_pid=$!
        echo "directory-server on $origin, logging to $LOGS/directory-server.log" >&2
    fi
    export DIRECTORY_BACKEND=$DIRECTORY_PORT
    manifest="$origin/api/directory"
else
    case "$DIRECTORY_BACKEND" in
        *[!0-9]*) origin=$DIRECTORY_BACKEND ;;
        *) origin="http://127.0.0.1:$DIRECTORY_BACKEND" ;;
    esac
    manifest="$origin/api/directory"
fi

# A backend answers the manifest 503 until its first seed is built, which
# takes it a minute or so; the suite wants the seed to be there.
printf 'waiting for a seed at %s' "$manifest" >&2
waited=0
while ! answers "$manifest"; do
    if [ -n "$backend_pid" ] && ! kill -0 "$backend_pid" 2>/dev/null; then
        echo >&2
        echo "directory-server exited; see $LOGS/directory-server.log" >&2
        exit 1
    fi
    if [ "$waited" -ge 300 ]; then
        echo >&2
        echo "no seed after ${waited}s" >&2
        exit 1
    fi
    printf . >&2
    sleep 2
    waited=$((waited + 2))
done
echo >&2

# --- 3. Dependencies and the suite -----------------------------------------

(cd "$ROOT/gateway" && bun install)
(cd "$HERE" && bun install)
cd "$HERE"
bun test --timeout 600000 gateway.test.ts "$@"
