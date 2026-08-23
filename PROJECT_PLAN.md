# SchoolHub — Offline School Platform — Execution Plan

> **Naming:** the project name is `SchoolHub` and the Pi answers to `schoolhub.local`.
> Both come from one place — `PROJECT_NAME` / `SITE_HOSTNAME` in `.env` — plus a handful of
> literal strings in `auth/configuration.yml` and `homepage/index.html`. To rename the whole
> project: `grep -rIl -i schoolhub . --exclude-dir=.git | xargs sed -i 's/SchoolHub/YourName/g; s/schoolhub/yourname/g'`
> then update `.env`.
> **This file lives in the repo root. Every phase prompt below tells Claude Code to read it first** — this is what lets a fresh terminal session, days later, pick up exactly where you left off with full context.

## What this is

An offline, self-hosted platform for a school: a Wikipedia + Khan Academy library, a public-domain ebook collection, real-time mind games (chess, checkers), a news board, and — once the base is proven — a Reddit-style student forum. Everything runs on a Raspberry Pi 4 plugged directly into the school's router, with zero internet dependency for students. It's built to later be handed to other schools as a flashable, self-installing image.

The architecture is deliberately boring: almost every feature is an existing, battle-tested open-source tool running in its own Docker container, wired together by one Nginx reverse proxy. The only piece of real custom software in the entire plan is the games backend. This keeps the system easy to extend — every new idea you have later follows the exact same four-step pattern (new folder, new compose entry, new Nginx route, new homepage tile), so "flexible for new features" isn't a hope, it's a structural property of how this is built.

## Tech stack decisions, in detail

| Layer | Tool | Reasoning |
|---|---|---|
| OS | Raspberry Pi OS Lite, 64-bit | Headless, no desktop environment — every spare MB of RAM goes to serving, not rendering a GUI nobody uses. 64-bit is required because current Docker images increasingly drop 32-bit ARM support. |
| Boot drive | USB SSD, not SD card | A server does constant small reads/writes — search index lookups, logs, session files. SD cards degrade and fail under that access pattern within months; SSDs don't. Migrating later is painful, so start correctly. |
| Containers | Docker + Docker Compose | Every feature is isolated — a bug or crash in one container can't take down another. Adding a new feature is additive (new service block), never a modification of something that already works. |
| Local network name | Static IP (DHCP reservation) + Avahi (mDNS) | Gives you `schoolhub.local` without needing write access to the school router's DNS settings, which IT almost certainly won't grant you. Static IP means the Pi rebooting never silently breaks the reverse proxy's assumptions. |
| Firewall | UFW — allow port 80 + SSH from one known device only | You're plugging directly into a school's network. Every other port Docker might expose internally should never be reachable from the wider LAN. |
| Traffic routing | Nginx reverse proxy | One public entry point on port 80. Every feature becomes one new `location` block — students never see or need to know a port number. |
| Study library | kiwix-serve, serving ZIM files | A ZIM file is an entire website frozen into one file. kiwix-serve is a complete, pre-built, read-only web server for these files — full-text search, page rendering, all included. Zero backend code required. |
| Study content files | `wikipedia_en_all_nopic` + a Khan Academy ZIM | Kiwix ships Wikipedia in three tiers: "mini" (intro paragraph + infobox only — too shallow for real homework), "nopic" (full article text, no images, ~25-45GB), "maxi" (full text + images, 100GB+). Nopic is the right trade-off: real research depth, without a download that eats your whole month. |
| Ebooks | Calibre-web, content from Project Gutenberg / Standard Ebooks / OpenStax | Calibre-web is a complete open-source library manager and in-browser reader — no backend code needed. Content sources are chosen specifically because they're public-domain or openly licensed, which matters a lot once you're distributing this to other schools — a copyright problem here would sink the whole project's credibility. |
| News | Grav CMS | Flat-file CMS — no database to manage, lightweight enough for a Pi, simple enough for a teacher to post to without training. |
| Shared login | Authelia, sitting in front of Nginx as forward-auth | Rather than building your own login system (real backend work, real security risk if done wrong), Authelia is a purpose-built, pre-built SSO layer. Every feature added *after* this point inherits shared login for free — you gate a new route behind it in one config line, no new code. |
| Games | Custom Node.js + Socket.io backend | The one place in this entire stack that is genuinely bespoke software. Nothing pre-built handles "two specific students' live moves synced in real time" — this has to be written. |
| Forum (Phase 4) | Lemmy | An actual, complete, open-source Reddit clone — accounts, posts, comments, voting, moderation, communities, its own database, all included. You configure and deploy it, you don't build a forum from scratch. |
| Dev environment | WSL2 + Ubuntu 24.04 + Docker Desktop (WSL2 backend) | Closest match to the Pi's actual Linux environment, so what works in development is far more likely to work unchanged on the Pi. Keep the repo inside WSL's own filesystem (`~/projects/...`), not `/mnt/c/...` — Docker is noticeably slower crossing that boundary. |

**Architecture note (ARM64):** your PC is x86_64, the Pi is ARM64. Every tool above (Nginx, kiwix-serve, Calibre-web, Grav, Authelia, Lemmy's Postgres) publishes official ARM64 builds, so this is a non-issue for anything pre-built. The one exception is the games service's custom Dockerfile — simplest to just build that image directly on the Pi at deploy time rather than cross-compiling from your PC.

## Repo structure

```
/proxy                → Nginx reverse proxy config
/homepage              → your custom front door (static HTML/CSS, the only page students see by default)
/auth                  → Authelia config + user database
/services/library      → kiwix-serve + /data (ZIM files go here, gitignored — too large for git)
/services/ebooks       → Calibre-web + content download scripts
/services/news         → Grav + seed content
/services/games        → custom Node.js/Socket.io backend + frontend
/services/forum        → Lemmy (Phase 4)
docker-compose.yml     → root file, one service block per feature, shared Docker network
PROJECT_PLAN.md         → this file — the persistent source of truth across sessions
```

**The permanent pattern for every future feature idea you have:** new folder under `/services`, one new block in `docker-compose.yml`, one new `location` block in Nginx, one new tile on the homepage, gated behind Authelia if it needs accounts. Every feature after Phase 4 follows this exact recipe — it's documented once, here, and never needs rediscovering.

## How the phases work

Everything is grouped into **4 phases**. Each phase below is one long, detailed instruction block — paste the whole block into Claude Code in one sitting, since the pieces inside a phase depend on each other and are meant to be built together. Don't skip ahead to the next phase until you've actually verified the current one works (the verification steps are included in each phase's instructions) — a broken assumption in Phase 1 gets expensive if it's not caught until Phase 4.

## Your tasks across the whole project

- Install WSL2 + Docker Desktop (one-time, host machine)
- Flash the Pi's SD/SSD, get it on school WiFi or ethernet, confirm SSH access
- Kick off and babysit the large ZIM downloads (25-45GB — expect this to run overnight on typical connections)
- Content-policy calls: exact book sources to include, forum moderation rules once you reach Phase 4 — these are founder decisions, not technical ones
- Run the actual pilot with real students and teachers, and make the scope go/no-go calls as issues surface
- Approve Claude Code's proposed approach at the one genuinely uncertain integration point (Lemmy ↔ Authelia, flagged in Phase 4) before it gets built

---

## Current build state

Phases 1-3 have been built **and run**: the whole stack was brought up with `docker compose up -d`,
every route was exercised through the real proxy, and the bugs that surfaced were fixed. The Pi
itself has not been touched, and the large content downloads have not been run.

| Piece | State |
|---|---|
| Repo scaffold, `.gitignore`, `.env.example` | done |
| Nginx reverse proxy (`/proxy`) | **running** — every route verified; three config bugs found and fixed |
| Homepage (`/homepage`) | **running** — serves at `/`, tiles link correctly |
| Library (kiwix-serve) | **running** — catalog, article rendering and full-text search verified with a test ZIM; the real 49GB download is yours to kick off |
| Ebooks (Calibre-web) | **running** — login and the `/ebooks` prefix verified in a browser; bulk import needs the calibre mod (see its README) |
| News (Grav) | **running** — three seeded posts render, links carry the `/news` prefix |
| Auth (Authelia) | **running** — full chain verified: gated route → portal → login → session → content |
| Games (Node + Socket.io) | **running** — chess and checkers played end to end in two real browsers, including the disconnect/forfeit path |
| Forum (Lemmy) | Phase 4, **not started** — placeholder route only |
| Pi deployment (`deploy.sh`) | written, **not run** — it runs on the Pi, which doesn't exist yet |

---

## Auth — how to use it (Phase 2 reference)

Authelia runs as a forward-auth service behind Nginx. It is *not* a proxy itself: Nginx asks it
"is this request allowed?" before serving a gated route, via `auth_request`.

### Add a user

1. Generate a hash (no local tooling needed — the Authelia image ships the CLI):
   ```bash
   docker compose run --rm --no-deps --entrypoint authelia auth \
     crypto hash generate bcrypt --password 'the-new-password'
   ```
2. Add the block to `auth/users_database.yml`:
   ```yaml
   users:
     jdoe:
       displayname: 'Jane Doe'
       password: '$2b$12$...'     # paste the hash from step 1
       email: 'jdoe@example.invalid'
       groups: ['students']
   ```
3. `docker compose restart auth` — Authelia reloads the file on start.

### Gate a route behind login

Add **two lines** to that route's file in `proxy/conf.d/locations/`, inside the `location`
block — the https redirect must come first, or the `Secure` session cookie never reaches the
route and the user bounces between the page and the login form forever:

```nginx
include /etc/nginx/snippets/require-https.conf;
include /etc/nginx/snippets/authelia-authrequest.conf;
```

then `docker compose exec proxy nginx -s reload` (or `docker compose restart proxy`).
`proxy/conf.d/locations/70-private.conf` is a working example of a gated route.

Restricting a route to a *group* is an Authelia-side change — add a rule above the catch-all in
`auth/configuration.yml`:

```yaml
access_control:
  rules:
    - domain: 'schoolhub.local'
      resources: ['^/news/admin.*$']
      policy: 'one_factor'
      subject: ['group:teachers']
```

### HTTP vs HTTPS — what running it actually forced

The original plan assumed the whole platform could sit on plain HTTP. That holds for every
open service, and it is what students get. It does **not** hold for the login layer:

Authelia 4.38+ refuses to start if `session.cookies[].authelia_url` is `http://`. Verified
against 4.38.19 and 4.39.20 — the validator rejects it for a hostname, for `localhost`, and
for `127.0.0.1` alike. Because the portal must be https, the session cookie is issued
`Secure`, and a gated route served over http would never receive it — the browser would loop
through the login page forever.

So the stack listens on **both**: port 80 for open content (unchanged), port 443 with a
self-signed certificate for anything behind login. The certificate is generated on first
`docker compose up` by the one-shot `certs` service (using the Authelia image's own
`crypto certificate` command — no extra dependency). Gated locations include
`snippets/require-https.conf`, which redirects them to https.

**The residual gap:** the certificate is self-signed, so the first visit to a gated page shows
a browser warning. Students never see it — open content stays on http. Installing
`proxy/certs/public.crt` as a trusted root on staff devices removes it. Treat this login as
"keeps casual students out of the teacher pages", not as a defence against a determined
attacker on the wire.

The alternatives, if the certificate warning is unacceptable: pin Authelia to a pre-4.38
release that still allows http (old auth software), or replace forward-auth with nginx basic
auth (no shared session, no lockout, no logout). Both are downgrades; the self-signed
certificate is the least-bad option.

---

## Adding any future feature (the concrete recipe, using this repo)

Say the feature is "typing practice". End to end:

1. **Folder** — `services/typing/` with whatever the tool needs (a `Dockerfile` if it's custom,
   otherwise just a README noting the image and its volumes).
2. **Compose block** — one new service in `docker-compose.yml`, on the `schoolnet` network,
   `restart: unless-stopped`, no `ports:` (only the proxy publishes a port).
   ```yaml
     typing:
       image: some/typing-image:1.2
       container_name: ${COMPOSE_PROJECT_NAME:-schoolhub}-typing
       restart: unless-stopped
       networks: [schoolnet]
   ```
3. **Nginx route** — one new file, `proxy/conf.d/locations/80-typing.conf`. Nothing else in the
   proxy config is touched; `default.conf` already includes `locations/*.conf`.
   ```nginx
   location /typing/ {
       set $typing_upstream http://typing:8080;
       proxy_pass $typing_upstream;
       include /etc/nginx/snippets/proxy-headers.conf;
       # include /etc/nginx/snippets/websocket.conf;         # if it uses websockets
       # include /etc/nginx/snippets/authelia-authrequest.conf;  # if it needs login
   }
   ```
4. **Homepage tile** — one `<a class="tile">` in `homepage/index.html`, copying an existing tile.
5. **Auth (optional)** — the one `include` line from the Auth section above.

That's the whole pattern. No existing service is modified, so nothing that already works can break.

---

## PHASE 1 — Foundation & Read-Only Content Core

```
Read PROJECT_PLAN.md in full before doing anything — it has the complete
architecture, tech decisions, and reasoning for this project. Everything
below assumes that context.

We're building Phase 1 of SchoolHub: the foundation and every
"read-only" content service — nothing here needs user accounts yet.

1. REPO SCAFFOLD
   - Initialize git.
   - Create the full folder structure exactly as specified in
     PROJECT_PLAN.md's "Repo structure" section.
   - Create a root docker-compose.yml with a shared Docker network
     (e.g. "schoolnet") that every service will join. Leave it structured
     so new service blocks can be appended cleanly as we build them.
   - Create a sensible .gitignore: exclude ZIM files, downloaded ebooks,
     and any generated data/config directories that shouldn't be in git.

2. NGINX REVERSE PROXY (/proxy)
   - Config listening on port 80, serving the homepage at "/" by default.
   - Structure it so adding a new location block (e.g. /library, /ebooks,
     /news) is a small, isolated, obviously-correct addition later.
   - Containerize it and add it to docker-compose.yml.

3. HOMEPAGE (/homepage)
   - A clean, simple static HTML/CSS page (no framework needed) — school
     name/logo placeholder, and tiles/buttons for Library, Ebooks, Games,
     News, Forum. Games and Forum tiles can be visually present but
     disabled/"coming soon" for now since we build those in later phases.
   - Should look reasonable on both a desktop browser and a phone browser,
     since students will access this from whatever device they have.

4. LIBRARY SERVICE (/services/library) — kiwix-serve
   - Add kiwix-serve as a container, using the current official image.
   - Mount a /data volume that kiwix-serve serves everything from — the
     goal is that dropping any ZIM file into this folder and restarting
     the container makes it available, with zero code changes.
   - Write download-content.sh: a script that checks the current Kiwix
     download catalog (library.kiwix.org or download.kiwix.org) and
     fetches the latest dated wikipedia_en_all_nopic ZIM for English into
     /data. Do NOT hardcode a specific dated filename that will go stale —
     have the script resolve the current latest version at run time.
     Also add a second function/section in the same script for fetching a
     Khan Academy ZIM from the same catalog, same approach.
   - Create the script but do not run it — these are 25GB+ downloads I'll
     kick off manually.
   - Add the Nginx /library route pointing at this container.
   - Wire the homepage's Library button to /library.

5. EBOOKS SERVICE (/services/ebooks) — Calibre-web
   - Add Calibre-web as a container with persistent volumes for its
     library database and book files, using the current official/
     community image.
   - Write a content script that pulls a modest starter set (a few
     hundred titles across common school subjects — literature, science,
     history) from Project Gutenberg's bulk catalog or Standard Ebooks,
     respecting their rate limits/mirrors, into a folder Calibre-web can
     bulk-import. Document how to expand this list later — this should
     not require touching any other part of the system.
   - Add the Nginx /ebooks route and wire the homepage button.

6. NEWS SERVICE (/services/news) — Grav
   - Add Grav CMS as a container with persistent content storage.
   - Seed 2-3 sample posts so there's something to see immediately.
   - Add the Nginx /news route and wire the homepage button. Note in a
     comment that Grav's admin panel will need to sit behind Authelia
     once Phase 2 is done — don't build that gating yet.

7. VERIFY (do this before considering Phase 1 done)
   - docker compose up -d, confirm every container is healthy.
   - Curl or browser-check each route: "/", "/library", "/ebooks",
     "/news" all resolve correctly through Nginx.
   - Confirm homepage buttons actually navigate to the right place.
   - Report back: what's running, what ports/routes exist, anything that
     didn't go as planned, and exactly what commands I need to run to
     kick off the ZIM and ebook downloads myself.
```

---

## PHASE 2 — Identity Layer & First Pi Deployment

```
Read PROJECT_PLAN.md in full for context, including what was built in
Phase 1 (check the actual repo state too, don't assume — read the current
docker-compose.yml and folder structure directly).

Phase 2 has two parts: add shared login, then get everything deployed to
the real Raspberry Pi and verify it actually works there.

PART A — SHARED LOGIN (/auth) — Authelia
   - Add Authelia as a container, using a simple file-based user database
     to start (users_database.yml with bcrypt-hashed passwords) — we can
     upgrade to a real database backend later if the platform grows past
     what a flat file comfortably handles.
   - Configure session/cookie settings appropriately for a LAN-only,
     no-real-domain environment (this matters — Authelia's defaults often
     assume a real public domain with HTTPS, and we're on a bare local
     network on plain HTTP for now; flag if this creates a meaningful
     security gap worth knowing about even in a closed school LAN).
   - Wire up Nginx's forward-auth (auth_request) so any location block
     can be gated behind login by adding a couple of lines — but don't
     gate the existing Library/Ebooks/News routes yet. Instead, add ONE
     new test route (a simple protected page) to prove login works
     end-to-end: visiting it redirects to Authelia's login page, and after
     logging in, redirects back to the protected content.
   - Document in PROJECT_PLAN.md, under a new "Auth" section: exactly how
     to add a new user, and exactly how to gate an existing or future
     route behind login. This will get reused constantly.

PART B — FIRST DEPLOYMENT TO THE ACTUAL PI
   Assume: Raspberry Pi 4, Raspberry Pi OS Lite 64-bit already flashed to
   a USB SSD, SSH access available, and it's connected to the school
   network (WiFi or ethernet — ask me which if it matters for any step).

   - Walk through, and execute where possible over SSH: installing Docker
     + Docker Compose on the Pi, installing avahi-daemon so the Pi
     answers to a .local hostname, configuring a static IP or DHCP
     reservation, and setting up UFW to allow only port 80 and SSH from
     my current device.
   - Copy the repo to the Pi (git clone or rsync — your call on which is
     cleaner given what's in .gitignore, since the ZIM/ebook data
     shouldn't need to travel this way if I can download it directly on
     the Pi instead).
   - Before bringing the stack up: check every image used so far (Nginx,
     kiwix-serve, Calibre-web, Grav, Authelia) for an available ARM64
     manifest. Flag clearly if anything doesn't have one and propose an
     alternative image.
   - Bring the stack up on the Pi and verify it's reachable from a
     laptop/phone on the same network via the .local hostname — walk me
     through how I should test this from my own device since you can't
     do that step yourself.
   - Report Pi resource usage (docker stats) so we know how much headroom
     is left on a 4GB Pi 4 before Phases 3 and 4 add more load, and flag
     anything that behaved differently here than it did on WSL2.
```

---

## PHASE 3 — Games (the one custom backend)

```
Read PROJECT_PLAN.md in full, plus the current repo state, for context.

Build the Games service — this is the one part of the whole platform that
is genuinely custom software, not configuration of an existing tool.

1. BACKEND (/services/games)
   - Node.js + Express + Socket.io server.
   - Use chess.js for chess rules/move validation — don't hand-roll chess
     rules. For checkers, note there isn't as strong a standard
     open-source library as chess.js, so a small hand-written rules
     engine is reasonable here (standard rules: mandatory captures,
     kinging on reaching the back row, multi-jump chains) — keep it
     simple and well-commented since it's the one piece of actual game
     logic we're writing ourselves.
   - Room/lobby system: a player can create a room and get a short
     shareable code, a second player can join using that code, and the
     two get matched into a live game. Handle a player disconnecting
     mid-game gracefully (don't crash the server, give the other player
     a clear "opponent disconnected" state rather than a silent freeze).
   - Game state can live in memory for now (no database) — losing
     in-progress games on a server restart is an acceptable trade-off at
     this stage; note this as a known limitation rather than silently
     deciding it doesn't matter.

2. FRONTEND (served as part of this service, or via /homepage — your call
   on the cleanest split)
   - A simple lobby screen (create/join room) and a game screen
     (chessboard.js or similar for the board UI, plus a comparably simple
     board UI for checkers), styled consistently with the existing
     homepage rather than looking like a bolted-on separate app.

3. WIRING
   - Containerize the service and add it to docker-compose.yml.
   - Add the Nginx /games route — this needs WebSocket-aware proxy
     config (Upgrade/Connection headers) since Socket.io requires it;
     call this out explicitly since it's a different config shape than
     the earlier plain HTTP routes.
   - Enable the homepage's Games tile (previously disabled/"coming soon").

4. VERIFY
   - Test a full game end-to-end using two separate browser tabs/windows
     acting as two different players — confirm moves sync live in both
     directions for both chess and checkers.
   - Test the disconnect-handling path deliberately (close one tab
     mid-game) and confirm the server and the other player's client both
     handle it without crashing or hanging.
   - Report back what's running and anything that needs a design call
     from me (e.g. whether games should require login at all, given
     Authelia already exists from Phase 2 — this is a real open decision,
     not something to assume silently).
```

---

## PHASE 4 — Forum, Full Deployment & Validation

```
Read PROJECT_PLAN.md in full, plus the current repo state, for context.

This is the final phase: add the forum, get the complete stack running on
the Pi, and validate it under realistic load.

1. FORUM (/services/forum) — Lemmy
   - Add Lemmy via its official Docker Compose setup (it includes its own
     Postgres database and pictrs image-handling service) — merge this
     cleanly into the existing root docker-compose.yml rather than running
     it as a fully separate stack.
   - Configure it as a single, non-federated school-community instance —
     federation with the wider Lemmy network should be off unless I
     explicitly say otherwise later.
   - BEFORE writing any integration code: research and propose the
     simplest reliable way to connect Lemmy's own account system with
     Authelia's shared login from Phase 2. This is the trickiest
     integration point in the entire project — Lemmy manages its own
     auth internally rather than being a simple forward-auth-gated app
     like the earlier services, so a naive approach may not actually
     give students one real shared account. Present the trade-offs
     (e.g. fully separate Lemmy accounts as a pragmatic near-term
     compromise, vs. a deeper integration) and wait for me to confirm
     the approach before implementing it.
   - Add the Nginx /forum route and enable the homepage's Forum tile.

2. FULL STACK REDEPLOYMENT
   - Redeploy the complete current stack (everything from Phases 1-4) to
     the Pi, following the same process established in Phase 2.
   - Confirm combined resource usage (RAM/CPU/disk) fits comfortably
     within the Pi 4's hardware budget now that every service is running
     together, and flag it clearly if it doesn't.

3. LOAD VALIDATION
   - Simulate roughly 15-20 concurrent connections hitting the Library
     and Games services simultaneously (using a simple load tool — your
     call on which, e.g. a basic scripted loop or a lightweight load
     testing tool) — that's a realistic concurrent-user count for an
     actual school pilot.
   - Report what slows down or breaks first, if anything, and give a
     concrete recommendation (e.g. Nginx worker tuning, container
     resource limits, or a hardware note) rather than just raw numbers.

4. DOCUMENT THE FUTURE-FEATURE PATTERN
   - Add a permanent section to PROJECT_PLAN.md (if not already fully
     clear from what exists) spelling out, concretely and using this
     real repo as the example, exactly what "add a new feature" looks
     like end to end: new /services folder, new compose block, new
     Nginx route, new homepage tile, optional Authelia gating. This is
     what every future idea gets pointed at instead of re-explaining the
     architecture from scratch each time.
```

---

## Adding any future feature (after Phase 4)

Once the four phases are done, every new idea follows this same short instruction, pasted fresh whenever you have a new feature to add:

```
Read PROJECT_PLAN.md. New feature idea: [describe it]. Following the
established pattern (new /services folder, new docker-compose block, new
Nginx route, new homepage tile, gated behind Authelia if it needs
accounts), propose a plan before writing any code. I'll approve it, then
you implement.
```
