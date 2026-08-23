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
# What it does to the live Grav install:
#   * moves Grav's shipped demo pages aside (Home / Typography) — they are a
#     framework demo, not a school news site, and Grav's own 01.home/default.md
#     would otherwise collide with our blog listing in the same folder
#   * installs services/news/seed/pages/ as the site
#   * sets custom_base_url so links work behind the /news prefix
#
# Safe to re-run: it stops at the marker file once the pages are in place.
# Pass --force to re-seed anyway (your own posts in those folders would be
# overwritten; anything you added elsewhere is untouched).
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SEED_DIR="$REPO_ROOT/services/news/seed"
GRAV_DATA="${NEWS_DATA_DIR:-$REPO_ROOT/services/news/data}"
MARKER=".schoolhub-seeded"
FORCE=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${1:-}" == "--force" ]] && FORCE=1

# ---- find the Grav install -------------------------------------------------
# The linuxserver.io image unpacks Grav somewhere under /config (currently
# /config/www), so locate user/pages rather than hardcoding the path.
log "looking for the Grav install under $GRAV_DATA"
PAGES_DIR="$(find "$GRAV_DATA" -maxdepth 4 -type d -path '*/user/pages' -print -quit 2>/dev/null || true)"
[[ -n "$PAGES_DIR" ]] || die "no Grav install found.
  Start it first and give it a moment to unpack:
      docker compose up -d news && sleep 30
  then re-run this script."

USER_DIR="$(dirname "$PAGES_DIR")"       # .../user
log "found: $USER_DIR"

# ---- hostname for custom_base_url ------------------------------------------
SITE_HOSTNAME="schoolhub.local"
if [[ -f "$REPO_ROOT/.env" ]]; then
    env_host="$(grep -E '^SITE_HOSTNAME=' "$REPO_ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d "\"' " || true)"
    [[ -n "$env_host" ]] && SITE_HOSTNAME="$env_host"
fi
log "site hostname: $SITE_HOSTNAME"

# ---- pages -----------------------------------------------------------------

if [[ -f "$PAGES_DIR/$MARKER" && $FORCE -eq 0 ]]; then
    log "pages already seeded (remove $PAGES_DIR/$MARKER or pass --force to redo)"
else
    # Grav ships a demo skeleton: 01.home/default.md and 02.typography. Both
    # would show up in the school's menu, and default.md sits in the same
    # folder as our blog listing — two templates in one folder, Grav picks one
    # and the news page silently isn't it. Move the whole shipped tree aside.
    shipped_backup="$USER_DIR/pages.grav-default"
    if [[ -f "$PAGES_DIR/01.home/default.md" && ! -d "$shipped_backup" ]]; then
        log "moving Grav's demo pages aside to $(basename "$shipped_backup")/"
        mkdir -p "$shipped_backup"
        # Move the demo content, keep the folder itself in place.
        find "$PAGES_DIR" -mindepth 1 -maxdepth 1 -exec mv {} "$shipped_backup"/ \;
    fi

    log "installing sample posts into $PAGES_DIR"
    ( cd "$SEED_DIR/pages" && find . -type f -print0 ) | while IFS= read -r -d '' rel; do
        rel="${rel#./}"
        target="$PAGES_DIR/$rel"
        if [[ -e "$target" && $FORCE -eq 0 ]]; then
            printf '    skip (exists)  %s\n' "$rel"
            continue
        fi
        mkdir -p "$(dirname "$target")"
        cp "$SEED_DIR/pages/$rel" "$target"
        printf '    wrote          %s\n' "$rel"
    done
    date -u +"seeded %Y-%m-%dT%H:%M:%SZ by seed-content.sh" > "$PAGES_DIR/$MARKER"
fi

# ---- config ----------------------------------------------------------------
# Grav writes its own user/config files on install, so copying ours wholesale
# would either clobber image-specific settings (the theme name differs between
# images) or be skipped entirely. Patch the individual keys we care about.

CONFIG_DIR="$USER_DIR/config"
mkdir -p "$CONFIG_DIR"

# set_top_level_key <file> <key> <quoted-value>
set_top_level_key() {
    local file="$1" key="$2" value="$3"
    [[ -f "$file" ]] || printf -- "---\n" > "$file"
    if grep -qE "^$key:" "$file"; then
        sed -i -E "s|^$key:.*|$key: $value|" "$file"
        printf '    set            %s: %s (in %s)\n' "$key" "$value" "$(basename "$file")"
    else
        printf "\n%s: %s\n" "$key" "$value" >> "$file"
        printf '    added          %s: %s (in %s)\n' "$key" "$value" "$(basename "$file")"
    fi
}

log "configuring the site"
# The proxy strips /news before Grav sees the request, so Grav has to be told
# its public address or every link it generates points at the site root.
set_top_level_key "$CONFIG_DIR/system.yaml" "custom_base_url" "'http://$SITE_HOSTNAME/news'"
set_top_level_key "$CONFIG_DIR/site.yaml" "title" "'School News'"

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
    chown -R "$PUID:$PGID" "$PAGES_DIR" "$CONFIG_DIR" 2>/dev/null || \
        warn "chown failed — if Grav can't edit the pages, fix ownership manually"
fi

log "done. Now run:  docker compose restart news"
log "then open:      http://$SITE_HOSTNAME/news/"
