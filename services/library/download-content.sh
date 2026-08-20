#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SchoolHub — library content downloader (Kiwix ZIM files)
#
# Resolves the CURRENT latest build of each ZIM from the live Kiwix catalog at
# run time. Nothing dated is hardcoded, so this script does not go stale.
#
# THIS DOWNLOADS TENS OF GIGABYTES. Run it deliberately, on a connection you
# don't mind saturating overnight, with the destination on the SSD.
#
#   ./download-content.sh --list                 # show names + sizes, fetch nothing
#   ./download-content.sh wikipedia              # ~49 GB as of the last check
#   ./download-content.sh khan                   # SEE THE WARNING BELOW
#   ./download-content.sh all                    # both (default)
#   ./download-content.sh --dest /srv/zim all    # somewhere other than ./data
#   ./download-content.sh --yes khan             # skip the "that file is huge" prompt
#
# SIZE WARNING (checked against the live catalog, run --list to re-check):
#   wikipedia_en_all_nopic   ~49 GB   fine for a 256GB+ SSD
#   khanacademy_en_all      ~168 GB   this is the WITH-VIDEO build — the only
#                                     English Khan Academy ZIM Kiwix currently
#                                     publishes. There is no "nopic"/text-only
#                                     variant. Budget the disk for it or skip
#                                     Khan Academy for now.
# Anything over SIZE_WARN_GB (default 60) asks for confirmation first.
#
# Downloads resume: re-run the same command after an interruption and it picks
# up where it left off. Each file is checksum-verified against the .sha256 the
# Kiwix mirror publishes next to it.
#
# After it finishes:  docker compose restart library
# kiwix-serve picks up any .zim in this folder — no config change needed.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${LIBRARY_DATA_DIR:-$SCRIPT_DIR/data}"

# Override to use a closer/faster mirror, e.g.
#   KIWIX_MIRROR=https://mirror.download.kiwix.org/zim ./download-content.sh
KIWIX_MIRROR="${KIWIX_MIRROR:-https://download.kiwix.org/zim}"

DRY_RUN=0
LIST_ONLY=0
ASSUME_YES=0
SIZE_WARN_GB="${SIZE_WARN_GB:-60}"
TARGETS=()

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

require_tools() {
    command -v curl >/dev/null 2>&1 || die "curl is required (apt install curl)"
    command -v sha256sum >/dev/null 2>&1 || warn "sha256sum not found — checksum verification will be skipped"
}

# Fetch a directory index from the mirror. Kiwix serves plain autoindex HTML,
# so grepping filenames out of it is stable and needs no XML/JSON parsing.
fetch_index() {
    local url="$1"
    curl -fsSL --retry 3 --retry-delay 2 --max-time 60 "$url" 2>/dev/null || true
}

# latest_from <catalog-subdir> <regex> -> prints the newest matching filename
#
# "Newest" = highest version-sorted name. Kiwix filenames end in _YYYY-MM, so
# version sort gives correct chronological order (2024-09 < 2024-11 < 2025-02).
latest_from() {
    local subdir="$1" regex="$2"
    fetch_index "$KIWIX_MIRROR/$subdir/" \
        | grep -oE "$regex" \
        | sort -uV \
        | tail -n 1
}

# resolve <label> <subdirs...> -- <regexes...>
#
# Tries each catalog subdirectory against each filename pattern, in order, and
# returns the first hit as "<subdir>/<filename>". Kiwix has reorganised its
# catalog layout before (and renamed khanacademy -> khan-academy), so each
# lookup gets several plausible locations rather than one brittle path.
resolve() {
    local label="$1"; shift
    local -a subdirs=() regexes=()
    local mode="subdirs"
    for arg in "$@"; do
        if [[ "$arg" == "--" ]]; then mode="regexes"; continue; fi
        if [[ "$mode" == "subdirs" ]]; then subdirs+=("$arg"); else regexes+=("$arg"); fi
    done

    local subdir regex found
    for regex in "${regexes[@]}"; do
        for subdir in "${subdirs[@]}"; do
            found="$(latest_from "$subdir" "$regex")"
            if [[ -n "$found" ]]; then
                printf '%s/%s\n' "$subdir" "$found"
                return 0
            fi
        done
    done

    warn "could not resolve a current $label ZIM from $KIWIX_MIRROR"
    warn "  browse $KIWIX_MIRROR/ yourself and pass the filename to download_one()"
    return 1
}

human_size() {
    local bytes="$1"
    if [[ -z "$bytes" || "$bytes" == "0" ]]; then echo "unknown size"; return; fi
    awk -v b="$bytes" 'BEGIN {
        split("B KB MB GB TB", u, " ");
        i = 1; while (b >= 1024 && i < 5) { b /= 1024; i++ }
        printf "%.1f %s", b, u[i]
    }'
}

remote_size() {
    curl -fsIL --max-time 30 "$1" 2>/dev/null \
        | tr -d '\r' \
        | awk 'tolower($1) == "content-length:" { size = $2 } END { print size + 0 }'
}

# Guard against absent-mindedly starting a 168GB download on a Pi. Returns
# non-zero (skip) rather than failing the whole run.
confirm_large() {
    local filename="$1" size="$2"
    local threshold=$(( SIZE_WARN_GB * 1024 * 1024 * 1024 ))

    (( size > threshold )) || return 0
    (( ASSUME_YES )) && return 0

    warn "$filename is $(human_size "$size") — larger than the ${SIZE_WARN_GB}GB warning threshold."
    if [[ ! -t 0 ]]; then
        warn "  not running interactively, so skipping it."
        warn "  re-run with --yes (or raise SIZE_WARN_GB) if you really want it."
        return 1
    fi

    local answer
    read -r -p "  Download it anyway? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] && return 0

    log "  skipped $filename"
    return 1
}

check_disk_space() {
    local needed_bytes="$1"
    [[ "$needed_bytes" -gt 0 ]] || return 0
    local avail_kb
    avail_kb="$(df -Pk "$DEST_DIR" | awk 'NR == 2 { print $4 }')"
    local avail_bytes=$(( avail_kb * 1024 ))
    if (( avail_bytes < needed_bytes )); then
        warn "only $(human_size "$avail_bytes") free at $DEST_DIR, need $(human_size "$needed_bytes")"
        warn "free some space or re-run with --dest pointing at a bigger disk"
        return 1
    fi
    log "disk space ok: $(human_size "$avail_bytes") free, need $(human_size "$needed_bytes")"
}

# download_one <catalog-path>   e.g. wikipedia/wikipedia_en_all_nopic_2025-01.zim
#
# Downloads to "<name>.part" and only renames to "<name>.zim" after the
# checksum passes. That's what makes an interrupted 40GB download safe to
# resume — a half-file never looks like a finished one to kiwix-serve or to a
# later run of this script.
download_one() {
    local rel_path="$1"
    local filename="${rel_path##*/}"
    local url="$KIWIX_MIRROR/$rel_path"
    local target="$DEST_DIR/$filename"
    local part="$target.part"

    if [[ -f "$target" ]]; then
        log "already present, skipping: $filename"
        return 0
    fi

    local size; size="$(remote_size "$url")"
    log "$filename  ($(human_size "$size"))"
    log "  from $url"
    log "  to   $target"

    if (( DRY_RUN )); then
        log "  [dry run] not downloading"
        return 0
    fi

    confirm_large "$filename" "$size" || return 0
    check_disk_space "$size" || return 1

    [[ -f "$part" ]] && log "  resuming a previous partial download"
    log "  downloading — this can take hours; Ctrl-C is safe, re-run to resume"
    if command -v wget >/dev/null 2>&1; then
        wget --continue --progress=bar:force:noscroll --tries=10 --timeout=60 \
             -O "$part" "$url"
    else
        curl -fL --retry 10 --retry-delay 5 --continue-at - -o "$part" "$url"
    fi

    verify_checksum "$url" "$part" || return 1
    mv -f "$part" "$target"
    log "  saved $filename"
}

# verify_checksum <url> <local-file>
verify_checksum() {
    local url="$1" path="$2"
    command -v sha256sum >/dev/null 2>&1 || return 0

    log "  verifying checksum (a few minutes for a large ZIM)"
    local sums; sums="$(curl -fsSL --max-time 60 "$url.sha256" 2>/dev/null || true)"
    if [[ -z "$sums" ]]; then
        warn "  no .sha256 published for ${url##*/} — skipping verification"
        return 0
    fi

    # The published file is "<hash>  <name>"; the name won't match our .part
    # file, so compare hashes directly instead of feeding it to sha256sum -c.
    local expected actual
    expected="$(awk '{ print $1 }' <<<"$sums" | head -n 1)"
    actual="$(sha256sum "$path" | awk '{ print $1 }')"

    if [[ "$expected" == "$actual" ]]; then
        log "  checksum ok"
        return 0
    fi

    warn "  CHECKSUM MISMATCH for ${url##*/}"
    warn "    expected $expected"
    warn "    got      $actual"
    warn "  the partial file was kept at $path — delete it to start over"
    return 1
}

# ---------------------------------------------------------------------------
# the two content sets
# ---------------------------------------------------------------------------

# Wikipedia: "nopic" = full article text, no images (~25-45GB).
# "mini" is too shallow for homework, "maxi" is 100GB+. See PROJECT_PLAN.md.
get_wikipedia() {
    log "resolving latest wikipedia_en_all_nopic from the Kiwix catalog"
    local rel
    rel="$(resolve "Wikipedia" \
              wikipedia \
              -- \
              'wikipedia_en_all_nopic_[0-9]{4}-[0-9]{2}\.zim')" || return 1
    log "latest is ${rel##*/}"
    download_one "$rel"
}

# Khan Academy: catalog location and spelling have both changed historically
# (other/ vs khan-academy/, khanacademy_ vs khan-academy_), so try each.
# Preference order: the plain full build, then any dated variant.
get_khan() {
    log "resolving latest Khan Academy ZIM from the Kiwix catalog"
    local rel
    rel="$(resolve "Khan Academy" \
              khan-academy khanacademy other \
              -- \
              'khan-academy_en_all_[0-9]{4}-[0-9]{2}\.zim' \
              'khanacademy_en_all_[0-9]{4}-[0-9]{2}\.zim' \
              'khan-academy_en_[a-z0-9-]*_[0-9]{4}-[0-9]{2}\.zim' \
              'khanacademy_en_[a-z0-9-]*_[0-9]{4}-[0-9]{2}\.zim')" || return 1
    log "latest is ${rel##*/}"
    download_one "$rel"
}

# To add another ZIM (Gutenberg, Stack Exchange, TED, Wiktionary...), copy one
# of the two functions above, point it at the right catalog subdir and pattern,
# and add it to the case statement in main(). Nothing else in the stack changes:
# kiwix-serve serves whatever .zim files exist in this folder.

# ---------------------------------------------------------------------------

# Prints the comment block at the top of this file as the help text, so the
# docs and the --help output can never drift apart.
usage() {
    awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dest)     DEST_DIR="$2"; shift 2 ;;
            --dry-run)  DRY_RUN=1; shift ;;
            -y|--yes)   ASSUME_YES=1; shift ;;
            --list)     LIST_ONLY=1; DRY_RUN=1; shift ;;
            -h|--help)  usage 0 ;;
            wikipedia|wiki)      TARGETS+=("wikipedia"); shift ;;
            khan|khanacademy)    TARGETS+=("khan"); shift ;;
            all)                 TARGETS+=("wikipedia" "khan"); shift ;;
            *) die "unknown argument: $1 (try --help)" ;;
        esac
    done

    [[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=("wikipedia" "khan")

    require_tools
    mkdir -p "$DEST_DIR"
    DEST_DIR="$(cd -- "$DEST_DIR" && pwd)"
    log "destination: $DEST_DIR"
    (( LIST_ONLY )) && log "list mode: resolving names only, nothing will be downloaded"

    local failed=0
    for target in "${TARGETS[@]}"; do
        case "$target" in
            wikipedia) get_wikipedia || failed=1 ;;
            khan)      get_khan      || failed=1 ;;
        esac
    done

    if (( failed )); then
        warn "one or more downloads did not complete — re-run to resume"
        exit 1
    fi

    if (( DRY_RUN )); then
        log "done (nothing downloaded — dry run)"
    else
        log "done. Now run:  docker compose restart library"
    fi
}

main "$@"
