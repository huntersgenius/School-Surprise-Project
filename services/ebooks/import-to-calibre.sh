#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SchoolHub — import downloaded epubs into the Calibre library Calibre-web reads
#
# Run this AFTER download-content.sh, from anywhere in the repo:
#
#   ./services/ebooks/import-to-calibre.sh
#
# What it does: runs `calibredb add` inside the running ebooks container, which
# reads every epub in /import (the folder download-content.sh fills), extracts
# each book's real metadata from the file itself, and files it into /books —
# the Calibre library Calibre-web serves. Re-running is safe: books already in
# the library are ignored, so you can add a few titles and import again.
#
# Requires the stack to be up:  docker compose up -d ebooks
# The `calibredb` binary comes from DOCKER_MODS=linuxserver/mods:universal-calibre
# in docker-compose.yml — the first start after adding that mod takes a few
# minutes while it installs.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE="${EBOOKS_SERVICE:-ebooks}"
DUPLICATE_POLICY="${DUPLICATE_POLICY:-ignore}"   # ignore | overwrite | new_record

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"

command -v docker >/dev/null 2>&1 || die "docker not found"

if ! docker compose ps --services --filter status=running 2>/dev/null | grep -qx "$SERVICE"; then
    die "the '$SERVICE' container isn't running — start it with: docker compose up -d $SERVICE"
fi

log "checking for calibredb inside the container"
if ! docker compose exec -T "$SERVICE" sh -c 'command -v calibredb' >/dev/null 2>&1; then
    warn "calibredb is not installed in the $SERVICE container."
    warn "  It is provided by DOCKER_MODS=linuxserver/mods:universal-calibre."
    warn "  Check that line is present in docker-compose.yml, then:"
    warn "      docker compose up -d --force-recreate $SERVICE"
    warn "  and give it a few minutes on first start (it downloads calibre)."
    die  "aborting"
fi

count="$(docker compose exec -T "$SERVICE" sh -c 'ls -1 /import/*.epub 2>/dev/null | wc -l' | tr -d '\r')"
log "$count epub file(s) staged in /import"
[[ "$count" -gt 0 ]] || die "nothing to import — run ./services/ebooks/download-content.sh first"

log "importing into the Calibre library at /books (duplicates: $DUPLICATE_POLICY)"
# -u abc: the linuxserver.io images run their app as the PUID/PGID user "abc".
# Adding as root would leave files Calibre-web can't write to later.
docker compose exec -T -u abc "$SERVICE" \
    calibredb add --recurse --with-library /books "--automerge=$DUPLICATE_POLICY" /import

log "done."
log ""
log "In the Calibre-web UI (http://schoolhub.local/ebooks):"
log "  first run only — it asks for the library location: enter  /books"
log "  then log in with the Calibre-web default admin / admin123 and change it."
