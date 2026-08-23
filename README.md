# SchoolHub

An offline, self-hosted platform for a school: Wikipedia and Khan Academy, a public-domain
ebook library, live chess and checkers, and a news board — all running on one Raspberry Pi
plugged into the school's network, with **zero internet dependency for students**.

The full architecture and reasoning live in [PROJECT_PLAN.md](PROJECT_PLAN.md). Read that first
if you're picking this up cold.

**Standing it up on the actual Pi? Follow [PILOT_CHECKLIST.md](PILOT_CHECKLIST.md)** — it has
the verified/not-verified status of every service, the exact deploy commands, and the checks
that can only be done on real hardware.

```
/proxy              Nginx reverse proxy — the single entry point on port 80
/homepage           the static front door students land on
/auth               Authelia — shared login (forward-auth)
/services/library   kiwix-serve  → /library   (Wikipedia, Khan Academy)
/services/ebooks    Calibre-web  → /ebooks
/services/news      Grav CMS     → /news
/services/games     custom Node + Socket.io → /games   (the only bespoke code here)
/services/forum     Lemmy — Phase 4, placeholder only
docker-compose.yml  one service block per feature, one shared network
deploy.sh           Pi-side setup — RUNS ON THE PI, not on your laptop
```

---

## Running it locally, step by step

Everything below runs on your dev machine (WSL2 + Docker Desktop, or any Linux with Docker).
This sequence has been run end to end — the commands and their expected output are what
actually happened, not what should happen in theory.

### 1. Get the branch

```bash
git clone https://github.com/huntersgenius/School-Surprise-Project.git
cd School-Surprise-Project
git checkout claude/offline-school-platform-6geboc
```

### 2. Fill in `.env`

```bash
cp .env.example .env
```

Then edit `.env`. The three Authelia secrets are the only values that **must** change — the
stack refuses to start without them:

```bash
# generate a fresh value for each of the three, separately
openssl rand -hex 32
```

Put them in `AUTHELIA_SESSION_SECRET`, `AUTHELIA_STORAGE_ENCRYPTION_KEY` and
`AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET`.

Also worth setting now: `TZ`, and `HTTP_PORT=8080` if something already owns port 80.

**`PUID`/`PGID` must not be 0.** They're what the Calibre-web and Grav containers run as.
Grav's php-fpm refuses to run as root and dies with `please specify user and group other than
root`, which surfaces as a 502 on `/news` with no obvious cause. Use `id -u; id -g`, or leave
them at 1000 if you're root.

Then make the bind-mounted data directories writable by that user, or Grav and Calibre-web
can't create their own files:

```bash
sudo chown -R "${PUID:-1000}:${PGID:-1000}" services/news/data services/ebooks/{config,library,import}
```

### 2b. A word about HTTPS

Open content — homepage, library, ebooks, news, games — is served over plain **HTTP on port
80**, exactly as planned. Students never see a certificate warning.

Routes behind login are different. Authelia 4.38+ refuses to start with an `http://` portal URL
(checked against 4.38.19 and 4.39.20; there is no localhost exception), and its session cookie
is therefore `Secure`, so a gated route on http would loop through the login page forever. The
stack handles this by also listening on **443 with a self-signed certificate**, generated
automatically on first `up` by the one-shot `certs` service, and gated routes redirect
themselves to https. The only person who meets the certificate warning is a staff member
opening a staff page; accept it once, or install `proxy/certs/public.crt` as trusted on the
machines that need it.

If you'd rather not have TLS in the stack at all, see "Open decisions" at the bottom.

### 3. Change the admin password

`auth/users_database.yml` ships with a bcrypt hash of `changeme123`, which is public — it's in
this repo. Replace it:

```bash
docker compose run --rm --no-deps --entrypoint authelia auth \
  crypto hash generate bcrypt --password 'your-real-password'
```

Paste the `$2b$...` output over the placeholder hash.

### 3b. Point your machine at the hostname

Authelia's session cookie is scoped to `schoolhub.local`, so log-in only works when you reach
the site by that name — not by `localhost` or an IP. On the Pi, avahi provides the name. On a
dev machine, add it yourself:

```bash
echo "127.0.0.1 schoolhub.local" | sudo tee -a /etc/hosts
```

### 4. Bring the stack up

```bash
docker compose up -d          # builds games, pulls the rest, generates the TLS cert
docker compose ps
```

Expected: **everything healthy except `library`, which restart-loops.** That's correct —
kiwix-serve has no ZIM file to serve yet, so it exits. Every other service is unaffected,
because each runs in its own container and the proxy resolves upstreams lazily.

Check the routes (verified working exactly like this):

```bash
curl -I http://schoolhub.local/            # homepage        200
curl -I http://schoolhub.local/games/      # games           200, works immediately
curl -I http://schoolhub.local/ebooks      # Calibre-web     302 -> /ebooks/admin/dbconfig
curl -I http://schoolhub.local/news/       # Grav            200 once seeded
curl -I http://schoolhub.local/private/    # gated route     301 -> https
curl -Ik https://schoolhub.local/private/  # logged out      302 -> /authelia/?rd=...
```

That last pair is the whole auth chain: http redirects to https, https bounces you to the
Authelia portal, and after logging in you land back on the page.

### 5. Seed the news site (two minutes)

```bash
docker compose up -d news
sleep 30                                  # Grav unpacks itself on first start
```

Grav forces you to create its admin account before it will serve any page — every route
redirects to `/news/admin` until you do. Do it from the command line:

```bash
docker compose exec -u abc news sh -c \
  'cd /app/www/public && php bin/plugin login new-user \
     -u newsadmin -p "choose-a-password" -e news@schoolhub.local \
     -l en -P b --admin-type admin -N "School Office" -s enabled'
```

Then seed the sample posts and the base URL:

```bash
./services/news/seed-content.sh
docker compose restart news
```

### 6. Download the ebooks (a few minutes, ~50 MB)

```bash
./services/ebooks/download-content.sh          # 73 curated public-domain titles
./services/ebooks/import-to-calibre.sh         # imports them into Calibre-web
```

Then open `http://schoolhub.local/ebooks`, log in with Calibre-web's own default
(`admin` / `admin123`, change it immediately), and enter `/books` on the Database
Configuration page.

**Order matters here.** Calibre-web can only *open* an existing Calibre library — it has no
"create new database" button. `import-to-calibre.sh` is what creates it, via `calibredb`, so
run the import before pointing Calibre-web at `/books`.

By default the import runs `calibredb` from a one-off `linuxserver/calibre` container (~1.2GB
pulled once, works reliably). It can also use the `calibredb` that
`DOCKER_MODS=linuxserver/mods:universal-calibre` installs inside the ebooks container, but that
mod is downloaded when the container starts and silently isn't there if the machine was offline
— so the one-off container is the default. See `services/ebooks/README.md`.

If gutenberg.org is slow or returns 504s, use the mirror:
`GUTENBERG_MIRROR=https://gutenberg.pglaf.org ./services/ebooks/download-content.sh`

### 7. Download the library (hours, tens of GB)

**Check the sizes first.** They're bigger than the plan assumed:

```bash
./services/library/download-content.sh --list
```

As of the last check: Wikipedia (no pictures) is **49 GB**; the only English Khan Academy ZIM
Kiwix publishes is the with-video build at **168 GB**. Then:

Smaller real alternatives if the SSD is tight — same format, same code path, real Wikipedia:
`--variant top` (~2GB, most-read articles) or `--variant simple` (~1GB, Simple English).

```bash
# run this in tmux/screen — it takes hours and resumes if interrupted
./services/library/download-content.sh wikipedia
docker compose restart library
```

Anything over 60 GB asks for confirmation before it starts. Downloads land as `.part` files and
are only renamed once the published SHA-256 matches.

### 8. Deploy to the Pi (when you have one)

`./deploy.sh` runs **on the Pi**, over SSH — not from your dev machine. Read the header comment
in it; it installs Docker, sets the hostname, configures avahi and UFW, clones the repo,
generates the secrets and brings the stack up. `./deploy.sh --help` prints the whole thing.

---

## Troubleshooting, from things that actually went wrong

| Symptom | Cause | Fix |
|---|---|---|
| `/news` returns 502, logs say `please specify user and group other than root` | `PUID=0` | set `PUID`/`PGID` to a non-root user (1000) |
| `/news` 502, logs say `socket() [::]:80 failed (97: Address family not supported)` | the host has IPv6 disabled, the Grav image binds `[::]:80` | comment out the `listen [::]…` lines in `services/news/data/nginx/site-confs/default.conf`, restart |
| every `/news` page 404s but links look right | the `/news` prefix is being stripped before Grav | don't rewrite: Grav strips its own `custom_base_url` prefix. See `proxy/conf.d/locations/30-news.conf` |
| `library` restart-loops, log prints kiwix usage | no `.zim` in `services/library/data`, or the glob wasn't shell-expanded | download a ZIM; the compose file already runs kiwix through `/bin/sh -c` so the glob works |
| proxy won't start, `directive is duplicate` / `proxy_busy_buffers_size` | a location sets a directive that the http block or a snippet already set | keep timeouts in `nginx.conf`, don't override one buffer setting alone |
| login redirects forever | reached the site by IP or `localhost` instead of `schoolhub.local`, so the cookie doesn't match | use the hostname |
| `auth` container exits on boot | Authelia rejects an `http://` portal URL | `session.cookies[].authelia_url` must be `https://` |

## Handy commands

```bash
docker compose ps                                   # what's running
docker compose logs -f --tail=50 games              # follow one service
docker compose exec proxy nginx -t                  # check the proxy config
docker compose exec proxy nginx -s reload           # apply a route change
docker compose restart library                      # after adding a ZIM file
cd services/games && npm test                       # 17 tests, no docker needed
docker stats --no-stream                            # resource use
```

## Where things are documented

| Topic | File |
|---|---|
| Architecture, tech choices, phases | `PROJECT_PLAN.md` |
| Adding a user, gating a route behind login | `auth/README.md` |
| Adding an Nginx route | `proxy/README.md` |
| ZIM sizes, adding other Kiwix content | `services/library/README.md` |
| Expanding the ebook library | `services/ebooks/README.md` |
| Writing news posts, the base-URL gotcha | `services/news/README.md` |
| Games protocol, disconnect handling, limitations | `services/games/README.md` |
| Lemmy plan and the auth question | `services/forum/README.md` |

## Open decisions

Two things are deliberately left for you rather than assumed:

**1. TLS.** The stack serves open content on http and gated routes on https with a self-signed
certificate, because Authelia will not run otherwise. The alternatives, if you dislike that:
pin Authelia to a pre-4.38 release that accepts http (older auth software on a school
network), or drop Authelia for now and gate the few staff routes with nginx basic auth (no
shared session, no lockout, no logout). Say which and it's a small change.

**2. Should games require login?** One `include` line in
`proxy/conf.d/locations/40-games.conf` either way. Trade-offs are in
`services/games/README.md`. Worth deciding after the pilot.

## Adding a new feature later

Four steps, none of which touch anything that already works: new folder under `/services`, one
block in `docker-compose.yml`, one file in `proxy/conf.d/locations/`, one tile in
`homepage/index.html` — plus one `include` line if it needs login. The worked example is at the
end of `PROJECT_PLAN.md`.
