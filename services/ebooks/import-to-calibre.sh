#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SchoolHub — import downloaded epubs into the Calibre library Calibre-web reads
#
# Run this AFTER download-content.sh, from anywhere in the repo:
#
#   ./services/ebooks/import-to-calibre.sh
#
# What it does: runs `calibredb add` over everything in the import folder.
# calibredb reads each book's real metadata out of the file itself, files it
# into the library folder, and CREATES that library (metadata.db) the first
# time. Calibre-web can only ever *open* an existing library — it has no
# "create database" button — so this step has to happen before you point
# Calibre-web at /books.
#
# Re-running is safe: books already in the library are ignored.
#
# TWO WAYS TO GET calibredb, tried in this order:
#
#   image      run calibredb from the official linuxserver/calibre image as a
#              one-off container. Needs ~1.2GB of image pulled once, works
#              every time, and doesn't depend on the ebooks container at all.
#              THIS IS THE DEFAULT because it is the one that reliably works.
#
#   container  use the calibredb that DOCKER_MODS=linuxserver/mods:universal-calibre
#              installs inside the running ebooks container. Lighter, but the
#              mod is downloaded when that container starts, so it silently
#              isn't there on a machine that was offline at the time.
#
#   ./import-to-calibre.sh --method container   # force the mod path
#   ./import-to-calibre.sh --method image       # force the one-off container
#
# After it finishes, in Calibre-web (http://schoolhub.local/ebooks):
#   log in with admin / admin123, then Admin -> Edit Database Configuration
#   and set the location to /books.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE="${EBOOKS_SERVICE:-ebooks}"
DUPLICATE_POLICY="${DUPLICATE_POLICY:-ignore}"     # ignore | overwrite | new_record
CALIBRE_IMAGE="${CALIBRE_IMAGE:-lscr.io/linuxserver/calibre:latest}"
METHOD="auto"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --method) METHOD="$2"; shift 2 ;;
        -h|--help) awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

cd "$REPO_ROOT"
command -v docker >/dev/null 2>&1 || die "docker not found"

# Where the folders actually live (.env may point them elsewhere).
LIBRARY_DIR="${EBOOKS_LIBRARY_DIR:-./services/ebooks/library}"
IMPORT_DIR="${EBOOKS_IMPORT_DIR:-./services/ebooks/import}"
PUID_VAL=1000; PGID_VAL=1000
if [[ -f .env ]]; then
    LIBRARY_DIR="$(grep -E '^EBOOKS_LIBRARY_DIR=' .env | tail -n1 | cut -d= -f2- || echo "$LIBRARY_DIR")"
    IMPORT_DIR="$(grep -E '^EBOOKS_IMPORT_DIR=' .env | tail -n1 | cut -d= -f2- || echo "$IMPORT_DIR")"
    PUID_VAL="$(grep -E '^PUID=' .env | tail -n1 | cut -d= -f2- || echo 1000)"
    PGID_VAL="$(grep -E '^PGID=' .env | tail -n1 | cut -d= -f2- || echo 1000)"
fi
LIBRARY_DIR="$(cd -- "$LIBRARY_DIR" 2>/dev/null && pwd)" || die "library dir not found: $LIBRARY_DIR"
IMPORT_DIR="$(cd -- "$IMPORT_DIR" 2>/dev/null && pwd)" || die "import dir not found: $IMPORT_DIR"

count="$(find "$IMPORT_DIR" -maxdepth 1 -name '*.epub' | wc -l | tr -d ' ')"
log "$count epub file(s) staged in $IMPORT_DIR"
[[ "$count" -gt 0 ]] || die "nothing to import — run ./services/ebooks/download-content.sh first"

# ---------------------------------------------------------------------------

import_via_container() {
    docker compose ps --services --filter status=running 2>/dev/null | grep -qx "$SERVICE" \
        || { warn "the '$SERVICE' container isn't running"; return 1; }
    docker compose exec -T "$SERVICE" sh -c 'command -v calibredb' >/dev/null 2>&1 \
        || { warn "calibredb is not installed in the $SERVICE container (the universal-calibre mod didn't load)"; return 1; }

    log "importing with the calibredb inside the $SERVICE container"
    # -u abc: the linuxserver.io images run their app as the PUID/PGID user.
    docker compose exec -T -u abc "$SERVICE" \
        calibredb add --recurse --with-library /books "--automerge=$DUPLICATE_POLICY" /import
}

import_via_image() {
    log "importing with calibredb from $CALIBRE_IMAGE (one-off container)"
    log "  first run pulls ~1.2GB; after that it's cached"
    # HOME must be writable: calibre wants a config dir, and uid 1000 has no
    # home inside this image.
    docker run --rm --user "$PUID_VAL:$PGID_VAL" -e HOME=/tmp \
        -v "$LIBRARY_DIR:/books" \
        -v "$IMPORT_DIR:/import:ro" \
        --entrypoint /usr/bin/calibredb "$CALIBRE_IMAGE" \
        add --recurse --with-library /books "--automerge=$DUPLICATE_POLICY" /import
}

case "$METHOD" in
    container) import_via_container || die "the in-container method failed — try --method image" ;;
    image)     import_via_image ;;
    auto)      import_via_image || { warn "one-off container failed, trying the in-container mod"; import_via_container || die "both import methods failed"; } ;;
    *) die "unknown --method '$METHOD' (use: auto, image, container)" ;;
esac

if [[ -f "$LIBRARY_DIR/metadata.db" ]]; then
    log "library is at $LIBRARY_DIR ($(du -sh "$LIBRARY_DIR" | cut -f1), metadata.db present)"
else
    warn "no metadata.db in $LIBRARY_DIR — the import did not create a library"
fi

log "done."
log ""
log "In Calibre-web (http://schoolhub.local/ebooks):"
log "  1. log in with  admin / admin123  and change that password"
log "  2. Admin -> Edit Database Configuration -> location:  /books"
