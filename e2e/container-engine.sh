# Sourced by onion/onion.sh: which container engine to use. Sets ENGINE.
#
# podman or docker: the commands the script uses are the same in both, apart
# from podman's `container exists` and `image exists`, which `inspect` stands
# in for. CONTAINER_ENGINE names one outright; otherwise the first of the two
# that answers `info` is taken, since a podman binary with no machine behind
# it is on PATH and useless on many desktops.
engine() {
    if [ -n "${CONTAINER_ENGINE:-}" ]; then
        echo "$CONTAINER_ENGINE"
        return
    fi
    for candidate in podman docker; do
        if "$candidate" info >/dev/null 2>&1; then
            echo "$candidate"
            return
        fi
    done
    echo "neither podman nor docker is usable here; set CONTAINER_ENGINE to one that is" >&2
    exit 1
}
ENGINE=$(engine)
