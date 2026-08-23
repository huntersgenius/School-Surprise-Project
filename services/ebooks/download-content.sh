#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SchoolHub — ebook content downloader (Project Gutenberg)
#
# Everything fetched here is public domain, which matters: this platform is
# meant to be handed to other schools, and a copyright problem would sink it.
#
#   ./download-content.sh                        # the curated starter set (~73 books)
#   ./download-content.sh --list                 # show what that set is, fetch nothing
#   ./download-content.sh --topic science --limit 100
#   ./download-content.sh --topic history --limit 100
#   ./download-content.sh --dest /srv/import     # somewhere other than ./import
#
# The whole starter set is roughly 40-60 MB — nothing like the ZIM downloads.
#
# TO EXPAND THE LIBRARY LATER (no other part of the system changes):
#   a) add lines to starter-books.tsv — one Gutenberg ID per line; or
#   b) use --topic to pull the most popular N books for a subject from the
#      Gutendex catalog API (gutendex.com, a read-only index of Gutenberg).
# Either way, re-run this script and then import-to-calibre.sh.
#
# POLITENESS: Project Gutenberg asks automated clients not to hammer the site.
# This script sleeps between downloads (RATE_LIMIT_SECONDS, default 2), sends
# an identifying User-Agent, and skips files it already has. Please leave those
# in place. If you're fetching hundreds of books, prefer a mirror:
#   GUTENBERG_MIRROR=https://gutenberg.pglaf.org ./download-content.sh
#
# After it finishes:  ./import-to-calibre.sh
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${EBOOKS_IMPORT_DIR:-$SCRIPT_DIR/import}"
BOOK_LIST="$SCRIPT_DIR/starter-books.tsv"

GUTENBERG_MIRROR="${GUTENBERG_MIRROR:-https://www.gutenberg.org}"
GUTENDEX_API="${GUTENDEX_API:-https://gutendex.com/books/}"
RATE_LIMIT_SECONDS="${RATE_LIMIT_SECONDS:-2}"
USER_AGENT="SchoolHub-offline-school-library/1.0 (self-hosted school library; contact your admin)"

DRY_RUN=0
TOPIC=""
LIMIT=100

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Turn "Austen, Jane" + "Pride and Prejudice" into a tidy, shell-safe filename.
# Calibre reads real metadata from inside the epub, so this is cosmetic.
safe_name() {
    printf '%s' "$1" \
        | tr -d '\r' \
        | tr '/:*?"<>|' '-' \
        | sed -e 's/[[:space:]]\+/ /g' -e 's/^ //' -e 's/ $//' \
        | cut -c1-120
}

# fetch_book <id> <author> <title>
fetch_book() {
    local id="$1" author="$2" title="$3"
    local name; name="$(safe_name "$author - $title")"
    local target="$DEST_DIR/$name.epub"

    if [[ -f "$target" ]]; then
        printf '    have  %s\n' "$name"
        return 0
    fi

    if (( DRY_RUN )); then
        printf '    would fetch  [%s] %s\n' "$id" "$name"
        return 0
    fi

    # Primary URL is the mirror-friendly cache path; the /ebooks/ form is the
    # canonical redirecting one and works when a mirror lacks the cache tree.
    local urls=(
        "$GUTENBERG_MIRROR/cache/epub/$id/pg$id.epub"
        "$GUTENBERG_MIRROR/ebooks/$id.epub3.images"
        "$GUTENBERG_MIRROR/ebooks/$id.epub.noimages"
    )

    local url
    for url in "${urls[@]}"; do
        if curl -fsSL --max-time 180 --retry 2 --retry-delay 3 \
                -A "$USER_AGENT" -o "$target.part" "$url" 2>/dev/null; then
            # An epub is a zip: "PK" magic. A mirror serving an HTML error page
            # with a 200 would otherwise land in the library as a broken book.
            if [[ "$(head -c 2 "$target.part")" == "PK" ]]; then
                mv -f "$target.part" "$target"
                printf '    ok    %s\n' "$name"
                sleep "$RATE_LIMIT_SECONDS"
                return 0
            fi
        fi
        rm -f "$target.part"
    done

    warn "    FAILED [$id] $name — no epub available at $GUTENBERG_MIRROR"
    sleep "$RATE_LIMIT_SECONDS"
    return 1
}

# ---------------------------------------------------------------------------
# mode 1 (default): the curated list in starter-books.tsv
# ---------------------------------------------------------------------------
fetch_curated() {
    [[ -f "$BOOK_LIST" ]] || die "book list not found: $BOOK_LIST"

    local total failed=0 count=0
    total="$(grep -cvE '^\s*(#|$)' "$BOOK_LIST" || true)"
    log "curated starter set: $total titles from $BOOK_LIST"

    local id subject author title
    while IFS=$'\t' read -r id subject author title; do
        [[ -z "${id:-}" || "$id" == \#* ]] && continue
        count=$(( count + 1 ))
        printf '[%3d/%3d] %-18s ' "$count" "$total" "$subject"
        fetch_book "$id" "$author" "$title" || failed=$(( failed + 1 ))
    done < "$BOOK_LIST"

    (( failed == 0 )) || warn "$failed title(s) could not be fetched (see above)"
}

# ---------------------------------------------------------------------------
# mode 2: --topic, for expanding the library without hand-picking IDs
# ---------------------------------------------------------------------------
fetch_topic() {
    local topic="$1" limit="$2"

    command -v python3 >/dev/null 2>&1 \
        || die "--topic needs python3 to read the catalog JSON (the curated mode doesn't)"

    log "querying the Gutendex catalog for '$topic' (most popular $limit, English)"

    local page_url="$GUTENDEX_API?languages=en&topic=$topic&sort=popular"
    local fetched=0 tmp; tmp="$(mktemp)"
    trap 'rm -f "$tmp"' RETURN

    while [[ -n "$page_url" && $fetched -lt $limit ]]; do
        curl -fsSL --max-time 60 -A "$USER_AGENT" -o "$tmp" "$page_url" \
            || die "catalog request failed: $page_url"

        # Emit "id<TAB>author<TAB>title" for entries that actually have an epub.
        local lines
        lines="$(python3 - "$tmp" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
for b in data.get("results", []):
    if "application/epub+zip" not in b.get("formats", {}):
        continue
    authors = b.get("authors") or []
    author = authors[0]["name"] if authors else "Anonymous"
    title = (b.get("title") or "").replace("\n", " ").split(":")[0].split(";")[0].strip()
    print(f"{b['id']}\t{author}\t{title}")
print("NEXT\t" + (data.get("next") or ""))
PY
)"

        page_url=""
        local id author title
        while IFS=$'\t' read -r id author title; do
            if [[ "$id" == "NEXT" ]]; then page_url="$author"; continue; fi
            (( fetched >= limit )) && continue
            fetched=$(( fetched + 1 ))
            printf '[%3d/%3d] %-18s ' "$fetched" "$limit" "$topic"
            fetch_book "$id" "$author" "$title" || true
        done <<<"$lines"
    done

    log "topic '$topic': $fetched titles processed"
}

usage() {
    awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dest)     DEST_DIR="$2"; shift 2 ;;
            --topic)    TOPIC="$2"; shift 2 ;;
            --limit)    LIMIT="$2"; shift 2 ;;
            --list|--dry-run) DRY_RUN=1; shift ;;
            -h|--help)  usage 0 ;;
            *) die "unknown argument: $1 (try --help)" ;;
        esac
    done

    command -v curl >/dev/null 2>&1 || die "curl is required (apt install curl)"
    mkdir -p "$DEST_DIR"
    DEST_DIR="$(cd -- "$DEST_DIR" && pwd)"
    log "destination: $DEST_DIR"
    log "source mirror: $GUTENBERG_MIRROR"

    if [[ -n "$TOPIC" ]]; then
        fetch_topic "$TOPIC" "$LIMIT"
    else
        fetch_curated
    fi

    local have; have="$(find "$DEST_DIR" -maxdepth 1 -name '*.epub' | wc -l)"
    log "$have epub file(s) now in $DEST_DIR"
    if (( DRY_RUN )); then
        log "done (nothing downloaded — list mode)"
    else
        log "done. Now run:  ./import-to-calibre.sh"
    fi
}

main "$@"
