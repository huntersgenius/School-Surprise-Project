#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SchoolHub — seed the news site with sample posts and the right base URL
#
# Run this ONCE, after the news container has started for the first time and
# unpacked its Grav install:
#
#   docker compose up -d news
#   sleep 30                       # give Grav time to install itself
#   ./services/news/seed-content.sh
#   docker compose restart news
#
# It copies services/news/seed/ into the live Grav install:
#   seed/pages/*   -> user/pages/    three sample posts
#   seed/config/*  -> user/config/   site title + custom_base_url
#
# Existing files are never overwritten unless you pass --force, so running it
# again after teachers have written real posts is harmless.
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SEED_DIR="$REPO_ROOT/services/news/seed"
GRAV_DATA="${NEWS_DATA_DIR:-$REPO_ROOT/services/news/data}"
FORCE=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${1:-}" == "--force" ]] && FORCE=1

# ---- find the Grav install -------------------------------------------------
# The linuxserver.io image unpacks Grav somewhere under /config (currently
# /config/www), so locate user/pages rather than hardcoding the path.
log "looking for the Grav install under $GRAV_DATA"
USER_DIR="$(find "$GRAV_DATA" -maxdepth 4 -type d -path '*/user/pages' -print -quit 2>/dev/null || true)"
[[ -n "$USER_DIR" ]] || die "no Grav install found.
  Start it first and give it a moment to unpack:
      docker compose up -d news && sleep 30
  then re-run this script."

USER_DIR="$(dirname "$USER_DIR")"       # .../user
log "found: $USER_DIR"

# ---- hostname for custom_base_url ------------------------------------------
SITE_HOSTNAME="schoolhub.local"
if [[ -f "$REPO_ROOT/.env" ]]; then
    # shellcheck disable=SC1091
    env_host="$(grep -E '^SITE_HOSTNAME=' "$REPO_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d "\"' " || true)"
    [[ -n "$env_host" ]] && SITE_HOSTNAME="$env_host"
fi
log "site hostname: $SITE_HOSTNAME"

# ---- copy pages ------------------------------------------------------------
copy_tree() {
    local src="$1" dest="$2" label="$3"
    [[ -d "$src" ]] || return 0
    log "installing $label into $dest"
    mkdir -p "$dest"
    ( cd "$src" && find . -type f -print0 ) | while IFS= read -r -d '' rel; do
        local target="$dest/${rel#./}"
        if [[ -e "$target" && $FORCE -eq 0 ]]; then
            printf '    skip (exists)  %s\n' "${rel#./}"
            continue
        fi
        mkdir -p "$(dirname "$target")"
        cp "$src/${rel#./}" "$target"
        printf '    wrote          %s\n' "${rel#./}"
    done
}

copy_tree "$SEED_DIR/pages"  "$USER_DIR/pages"  "sample posts"
copy_tree "$SEED_DIR/config" "$USER_DIR/config" "site config"

# ---- point Grav at the right public URL ------------------------------------
SYSTEM_YAML="$USER_DIR/config/system.yaml"
if [[ -f "$SYSTEM_YAML" ]]; then
    log "setting custom_base_url to http://$SITE_HOSTNAME/news"
    if grep -qE '^custom_base_url:' "$SYSTEM_YAML"; then
        sed -i.bak -E "s#^custom_base_url:.*#custom_base_url: 'http://$SITE_HOSTNAME/news'#" "$SYSTEM_YAML"
        rm -f "$SYSTEM_YAML.bak"
    else
        printf "\ncustom_base_url: 'http://%s/news'\n" "$SITE_HOSTNAME" >> "$SYSTEM_YAML"
    fi
fi

# ---- ownership -------------------------------------------------------------
# The linuxserver.io images run Grav as PUID:PGID. If this script ran as root
# (or a different user), hand the files over so Grav can edit them.
PUID="${PUID:-1000}"; PGID="${PGID:-1000}"
if [[ -f "$REPO_ROOT/.env" ]]; then
    PUID="$(grep -E '^PUID=' "$REPO_ROOT/.env" | tail -n1 | cut -d= -f2- || echo "$PUID")"
    PGID="$(grep -E '^PGID=' "$REPO_ROOT/.env" | tail -n1 | cut -d= -f2- || echo "$PGID")"
fi
if [[ "$(id -u)" == "0" ]]; then
    log "chowning seeded files to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$USER_DIR/pages" "$USER_DIR/config" 2>/dev/null || \
        warn "chown failed — if Grav can't edit the pages, fix ownership manually"
fi

log "done. Now run:  docker compose restart news"
log "then open:      http://$SITE_HOSTNAME/news/"
