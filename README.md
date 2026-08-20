# SchoolHub

An offline, self-hosted platform for a school: Wikipedia and Khan Academy, a public-domain
ebook library, live chess and checkers, and a news board — all running on one Raspberry Pi
plugged into the school's network, with **zero internet dependency for students**.

The full architecture and reasoning live in [PROJECT_PLAN.md](PROJECT_PLAN.md). Read that first
if you're picking this up cold.

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
Nothing here has been run yet — no images built, no content downloaded.

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

Also worth setting now: `PUID`/`PGID` (run `id -u; id -g`), `TZ`, and `HTTP_PORT=8080` if
something already owns port 80 on your machine.

### 3. Change the admin password

`auth/users_database.yml` ships with a bcrypt hash of `changeme123`, which is public — it's in
this repo. Replace it:

```bash
docker compose run --rm --no-deps --entrypoint authelia auth \
  crypto hash generate bcrypt --password 'your-real-password'
```

Paste the `$2b$...` output over the placeholder hash.

### 4. Bring the stack up

```bash
docker compose up -d          # builds the games image, pulls the other five
docker compose ps
```

Expected right now: **everything healthy except `library`, which restart-loops.** That's
correct — kiwix-serve has no ZIM file to serve yet. Every other service is unaffected.

Check the routes:

```bash
curl -I http://localhost/            # homepage
curl -I http://localhost/games/      # games — works immediately
curl -I http://localhost/ebooks      # Calibre-web (empty library)
curl -I http://localhost/news/       # Grav (unseeded)
curl -I http://localhost/private/    # 302 to the Authelia login — proves auth works
```

### 5. Seed the news site (one minute)

```bash
docker compose up -d news
sleep 30                                  # Grav unpacks itself on first start
./services/news/seed-content.sh
docker compose restart news
```

### 6. Download the ebooks (a few minutes, ~50 MB)

```bash
./services/ebooks/download-content.sh          # 73 curated public-domain titles
./services/ebooks/import-to-calibre.sh         # imports them into Calibre-web
```

Then open `http://localhost/ebooks`, enter `/books` when it asks for the library location, and
log in with Calibre-web's own default (`admin` / `admin123`) — change that immediately.

### 7. Download the library (hours, tens of GB)

**Check the sizes first.** They're bigger than the plan assumed:

```bash
./services/library/download-content.sh --list
```

As of the last check: Wikipedia (no pictures) is **49 GB**; the only English Khan Academy ZIM
Kiwix publishes is the with-video build at **168 GB**. Then:

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

## Adding a new feature later

Four steps, none of which touch anything that already works: new folder under `/services`, one
block in `docker-compose.yml`, one file in `proxy/conf.d/locations/`, one tile in
`homepage/index.html` — plus one `include` line if it needs login. The worked example is at the
end of `PROJECT_PLAN.md`.
