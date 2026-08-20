#!/usr/bin/env bash
# ===========================================================================
#
#   >>>  THIS SCRIPT RUNS **ON THE RASPBERRY PI**.  <<<
#
#   Not on your laptop, not in WSL, not in a container. It installs system
#   packages, changes the hostname and turns on a firewall. Running it on
#   your development machine would be a bad afternoon.
#
#   Get it there and run it like this:
#
#       ssh pi@<the-pi-s-ip>
#       curl -fsSL https://raw.githubusercontent.com/huntersgenius/School-Surprise-Project/main/deploy.sh -o deploy.sh
#       chmod +x deploy.sh
#       ./deploy.sh
#
#   ...or, if you've already copied the repo across, just run it from inside
#   the repo. It is safe to re-run: every step checks before it acts.
#
# ---------------------------------------------------------------------------
#
#   WHAT IT DOES
#     1. sanity-checks that this really is a Linux box you meant to change
#     2. installs Docker + the Compose plugin (via get.docker.com)
#     3. installs avahi-daemon and sets the hostname, so the Pi answers to
#        schoolhub.local without touching the school's DNS
#     4. configures UFW: inbound port 80 for everyone, SSH from your machine
#        only, everything else denied
#     5. clones (or updates) this repo into INSTALL_DIR
#     6. creates .env from .env.example and generates the Authelia secrets
#     7. builds the games image and brings the stack up
#
#   WHAT IT DELIBERATELY DOES NOT DO
#     * change the Pi's IP address. Doing that over SSH drops your own
#       session mid-script. Set a DHCP reservation on the router instead —
#       the script prints the MAC address you need for it.
#     * download any content. The ZIM and ebook downloads are separate,
#       deliberate steps you run afterwards (they're huge).
#
#   OPTIONS
#     --skip-docker     don't touch Docker (already installed and working)
#     --skip-firewall   don't touch UFW (school IT manages it, or you're
#                       still setting up and don't want to lock yourself out)
#     --check-images    verify every image has an arm64 build, then continue
#     --no-start        set everything up but don't bring the stack up
#     --admin-ssh CIDR  where SSH may come from (default: from .env, else
#                       the address you are connected from right now)
#
# ===========================================================================

set -euo pipefail

SKIP_DOCKER=0
SKIP_FIREWALL=0
CHECK_IMAGES=0
NO_START=0
ADMIN_SSH_SOURCE=""

# Defaults; .env overrides them if it exists.
PI_HOSTNAME="schoolhub"
REPO_URL="https://github.com/huntersgenius/School-Surprise-Project.git"
REPO_BRANCH="main"
INSTALL_DIR="/opt/schoolhub"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m### %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# sudo unless we're already root.
SUDO=""
[[ "$(id -u)" -ne 0 ]] && SUDO="sudo"

usage() {
    awk 'NR > 1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-docker)   SKIP_DOCKER=1; shift ;;
        --skip-firewall) SKIP_FIREWALL=1; shift ;;
        --check-images)  CHECK_IMAGES=1; shift ;;
        --no-start)      NO_START=1; shift ;;
        --admin-ssh)     ADMIN_SSH_SOURCE="$2"; shift 2 ;;
        -h|--help)       usage 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

# If this script is sitting in a checkout that already has a .env, its values
# win over the defaults above — the hostname and firewall steps below need them
# before step 6 gets around to creating one.
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
ADMIN_SSH_OVERRIDE="$ADMIN_SSH_SOURCE"   # whatever --admin-ssh set, if anything
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
    log "loaded settings from $SCRIPT_DIR/.env"
fi
# A command-line flag beats the file.
[[ -n "$ADMIN_SSH_OVERRIDE" ]] && ADMIN_SSH_SOURCE="$ADMIN_SSH_OVERRIDE"
ADMIN_SSH_SOURCE="${ADMIN_SSH_SOURCE:-}"

# ---------------------------------------------------------------------------
step "1/7  Checking this is the right machine"
# ---------------------------------------------------------------------------

[[ "$(uname -s)" == "Linux" ]] || die "this script is for the Pi's Linux, not $(uname -s)."

ARCH="$(uname -m)"
log "architecture: $ARCH"
if [[ "$ARCH" != "aarch64" && "$ARCH" != "arm64" ]]; then
    warn "this doesn't look like 64-bit Raspberry Pi OS (expected aarch64, got $ARCH)."
    warn "The stack needs the 64-bit OS — several images no longer ship 32-bit ARM."
    read -r -p "  Continue anyway? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || exit 1
fi

if [[ -r /proc/device-tree/model ]]; then
    log "board: $(tr -d '\0' < /proc/device-tree/model)"
fi

if [[ -f /.dockerenv ]] || grep -qa 'docker\|lxc' /proc/1/cgroup 2>/dev/null; then
    die "this looks like a container, not the Pi itself. Run it on the Pi."
fi

command -v apt-get >/dev/null 2>&1 || die "apt-get not found — this expects Raspberry Pi OS / Debian."

log "free disk on /: $(df -Ph / | awk 'NR==2 {print $4}')"
log "RAM: $(free -h | awk '/^Mem:/ {print $2}')"

# ---------------------------------------------------------------------------
step "2/7  Docker + Compose"
# ---------------------------------------------------------------------------

if (( SKIP_DOCKER )); then
    log "skipped (--skip-docker)"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "already installed: $(docker --version), $(docker compose version | head -n1)"
else
    log "installing Docker via get.docker.com (this takes a few minutes on a Pi)"
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    $SUDO sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh

    # get.docker.com ships the compose plugin; belt and braces for older images.
    if ! docker compose version >/dev/null 2>&1; then
        log "installing the compose plugin separately"
        $SUDO apt-get update -qq
        $SUDO apt-get install -y docker-compose-plugin
    fi

    if [[ "$(id -u)" -ne 0 ]]; then
        log "adding $USER to the docker group"
        $SUDO usermod -aG docker "$USER"
        warn "log out and back in (or run 'newgrp docker') for that to take effect."
        warn "This script will keep using sudo for docker until you do."
    fi

    $SUDO systemctl enable --now docker
fi

# Use sudo for docker if the group change hasn't taken effect in this session.
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
fi

# ---------------------------------------------------------------------------
step "3/7  Hostname + avahi (so the Pi answers to schoolhub.local)"
# ---------------------------------------------------------------------------

if ! dpkg -s avahi-daemon >/dev/null 2>&1; then
    log "installing avahi-daemon"
    $SUDO apt-get update -qq
    $SUDO apt-get install -y avahi-daemon
else
    log "avahi-daemon already installed"
fi

CURRENT_HOSTNAME="$(hostname)"
if [[ "$CURRENT_HOSTNAME" != "$PI_HOSTNAME" ]]; then
    log "setting hostname: $CURRENT_HOSTNAME -> $PI_HOSTNAME"
    $SUDO hostnamectl set-hostname "$PI_HOSTNAME"
    # /etc/hosts must agree or sudo gets slow and noisy.
    if grep -qE "^127\.0\.1\.1" /etc/hosts; then
        $SUDO sed -i -E "s/^(127\.0\.1\.1\s+).*/\1$PI_HOSTNAME/" /etc/hosts
    else
        echo "127.0.1.1	$PI_HOSTNAME" | $SUDO tee -a /etc/hosts >/dev/null
    fi
else
    log "hostname already $PI_HOSTNAME"
fi

$SUDO systemctl enable --now avahi-daemon
log "the Pi should now answer to: $PI_HOSTNAME.local"

# The router needs this to pin the address. Changing the IP from here would
# kill this SSH session, so it's your job on the router's admin page.
PRIMARY_IF="$(ip route show default | awk '/default/ {print $5; exit}')"
if [[ -n "${PRIMARY_IF:-}" ]]; then
    log "network interface : $PRIMARY_IF"
    log "current IP        : $(ip -4 addr show "$PRIMARY_IF" | awk '/inet /{print $2; exit}')"
    log "MAC address       : $(cat "/sys/class/net/$PRIMARY_IF/address" 2>/dev/null || echo '?')"
    log "-> set a DHCP reservation for that MAC on the school router, so this"
    log "   address never changes. (Not done here: changing it over SSH would"
    log "   drop this session mid-script.)"
fi

# ---------------------------------------------------------------------------
step "4/7  Firewall (UFW): port 80 open, SSH restricted, everything else denied"
# ---------------------------------------------------------------------------

if (( SKIP_FIREWALL )); then
    log "skipped (--skip-firewall)"
else
    if ! command -v ufw >/dev/null 2>&1; then
        log "installing ufw"
        $SUDO apt-get install -y ufw
    fi

    # Where may SSH come from? Flag, then .env, then whoever is connected now.
    if [[ -z "$ADMIN_SSH_SOURCE" && -n "${SSH_CLIENT:-}" ]]; then
        ADMIN_SSH_SOURCE="$(awk '{print $1}' <<<"$SSH_CLIENT")"
        log "no --admin-ssh given; using the address you're connected from: $ADMIN_SSH_SOURCE"
    fi

    $SUDO ufw --force default deny incoming
    $SUDO ufw --force default allow outgoing
    $SUDO ufw allow 80/tcp comment 'SchoolHub'

    if [[ -n "$ADMIN_SSH_SOURCE" && "$ADMIN_SSH_SOURCE" != "any" ]]; then
        log "allowing SSH from $ADMIN_SSH_SOURCE only"
        $SUDO ufw allow from "$ADMIN_SSH_SOURCE" to any port 22 proto tcp comment 'admin ssh'
    else
        warn "allowing SSH from ANY address — narrow this later with:"
        warn "    sudo ufw delete allow 22/tcp && sudo ufw allow from <your-ip> to any port 22 proto tcp"
        $SUDO ufw allow 22/tcp comment 'ssh (unrestricted)'
    fi

    # mDNS, so the .local name resolves for students.
    $SUDO ufw allow 5353/udp comment 'mDNS (avahi)'

    $SUDO ufw --force enable
    $SUDO ufw status verbose | sed 's/^/    /'

    warn "Docker publishes ports by writing its own iptables rules, which UFW"
    warn "does not manage. Only the proxy publishes a port here (80), so that's"
    warn "fine — but if you ever add 'ports:' to another service, it will be"
    warn "reachable on the LAN even though UFW appears to deny it."
fi

# ---------------------------------------------------------------------------
step "5/7  The repo"
# ---------------------------------------------------------------------------

command -v git >/dev/null 2>&1 || { log "installing git"; $SUDO apt-get install -y git; }

# If we're already inside a checkout, use it. Otherwise clone to INSTALL_DIR.
if [[ -f "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/docker-compose.yml" ]]; then
    INSTALL_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
    log "running from an existing checkout: $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only || warn "could not fast-forward — continuing with what's on disk"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
    log "updating existing checkout at $INSTALL_DIR"
    $SUDO git -C "$INSTALL_DIR" pull --ff-only
else
    log "cloning $REPO_URL ($REPO_BRANCH) into $INSTALL_DIR"
    $SUDO mkdir -p "$(dirname "$INSTALL_DIR")"
    $SUDO git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
    $SUDO chown -R "$(id -un):$(id -gn)" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ---------------------------------------------------------------------------
step "6/7  Configuration (.env)"
# ---------------------------------------------------------------------------

if [[ ! -f .env ]]; then
    log "creating .env from .env.example"
    cp .env.example .env

    log "generating Authelia secrets with openssl"
    for key in AUTHELIA_SESSION_SECRET AUTHELIA_STORAGE_ENCRYPTION_KEY \
               AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET; do
        secret="$(openssl rand -hex 32)"
        sed -i -E "s|^$key=.*|$key=$secret|" .env
    done

    sed -i -E "s|^PUID=.*|PUID=$(id -u)|; s|^PGID=.*|PGID=$(id -g)|" .env
    sed -i -E "s|^TZ=.*|TZ=$(cat /etc/timezone 2>/dev/null || echo UTC)|" .env
    [[ -n "$ADMIN_SSH_SOURCE" ]] && sed -i -E "s|^ADMIN_SSH_SOURCE=.*|ADMIN_SSH_SOURCE=$ADMIN_SSH_SOURCE|" .env

    log ".env written with fresh secrets"
else
    log ".env already exists — leaving it alone"
fi

# Load it so the rest of this script uses the real values.
set -a
# shellcheck disable=SC1091
source ./.env
set +a

warn "STILL YOURS TO DO: the admin password in auth/users_database.yml is the"
warn "public placeholder from the repo. Change it before students are on the"
warn "network — the command is in auth/README.md."

if (( CHECK_IMAGES )); then
    step "     Checking every image has an arm64 build"
    for image in nginx:1.27-alpine authelia/authelia:4.38 ghcr.io/kiwix/kiwix-serve:latest \
                 lscr.io/linuxserver/calibre-web:latest lscr.io/linuxserver/grav:latest \
                 node:22-alpine; do
        if $DOCKER manifest inspect "$image" 2>/dev/null | grep -q 'arm64'; then
            printf '    \033[1;32mok\033[0m    %s\n' "$image"
        else
            printf '    \033[1;33m??\033[0m    %s (no arm64 in the manifest, or the check failed)\n' "$image"
        fi
    done
fi

# ---------------------------------------------------------------------------
step "7/7  Building and starting the stack"
# ---------------------------------------------------------------------------

if (( NO_START )); then
    log "skipped (--no-start). Start it yourself with: docker compose up -d"
else
    log "building the games image (a few minutes on a Pi — it compiles nothing, but npm is npm)"
    $DOCKER compose build games

    log "pulling the rest"
    $DOCKER compose pull --ignore-buildable || warn "some images failed to pull — see above"

    log "starting"
    $DOCKER compose up -d

    sleep 5
    $DOCKER compose ps
fi

# ---------------------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m')Done.$(printf '\033[0m')

WHAT WORKS RIGHT NOW
  http://$PI_HOSTNAME.local/          the hub
  http://$PI_HOSTNAME.local/news/     news (needs seeding, below)
  http://$PI_HOSTNAME.local/ebooks    ebooks (needs content, below)
  http://$PI_HOSTNAME.local/games/    chess and checkers — works immediately
  http://$PI_HOSTNAME.local/library   ONLY once a ZIM file exists (below)

WHAT'S LEFT, IN ORDER

  1. Change the admin password
       see auth/README.md — the placeholder hash is public

  2. Seed the news site
       docker compose up -d news && sleep 30
       ./services/news/seed-content.sh
       docker compose restart news

  3. Ebooks (small, minutes)
       ./services/ebooks/download-content.sh
       ./services/ebooks/import-to-calibre.sh
       then set the library path to /books in the Calibre-web UI

  4. The library (huge, hours — run it in tmux or screen so an SSH drop
     doesn't kill it)
       ./services/library/download-content.sh --list      # check sizes first
       tmux new -s zim
       ./services/library/download-content.sh wikipedia
       docker compose restart library

  5. From a phone or laptop on the same network, open
       http://$PI_HOSTNAME.local/
     If the name doesn't resolve, use the Pi's IP address and check that
     avahi-daemon is running. Some Android versions don't do mDNS — a DHCP
     reservation plus the IP is the fallback.

  6. Watch resource use while it settles:
       docker compose ps
       docker stats --no-stream
       docker compose logs -f --tail=50

EOF
