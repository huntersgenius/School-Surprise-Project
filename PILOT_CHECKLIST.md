# SchoolHub — Pilot Readiness Checklist

The document to follow when standing this up on the actual Raspberry Pi. Everything below was
either verified on a real running stack (x86_64) or is explicitly marked as untested.

**Read once before starting.** Two things will bite you if you skip them: the admin password is
a public placeholder, and `PUID` must not be 0.

---

## 1. What is verified, and on what

Verified means: brought up in Docker, driven through the real Nginx proxy, and checked by
request or in a browser. It does **not** mean tested on ARM64 — nothing here has run on a Pi
yet.

| Service | Status | What was actually proven |
|---|---|---|
| **Proxy** (nginx 1.27) | ✅ verified | Every route walked. `nginx -t` clean. Three config bugs found and fixed while doing it. |
| **Homepage** | ✅ verified | Serves at `/`, tiles link to the right routes, CSS/assets load. |
| **Library** (kiwix-serve) | ✅ verified with real content | 2.1GB `wikipedia_en_top_nopic_2026-06.zim` downloaded, SHA-256 verified, served through the proxy: catalog lists "Best of Wikipedia", the *Photosynthesis* article renders (422KB, 26 mentions of chlorophyll), full-text search returns real hits. |
| **Ebooks** (Calibre-web) | ✅ verified end to end | All 73 starter titles downloaded, imported with `calibredb` (real titles/authors/covers extracted), library browsable in the UI, book download returns a valid epub (487KB), in-browser reader opens. |
| **News** (Grav 1.7.53) | ✅ verified | Three seeded posts render, links carry the `/news` prefix, admin panel reachable. |
| **Auth** (Authelia 4.38) | ✅ verified | Full chain: gated route → http→https redirect → portal → login → session cookie → content served. |
| **Games** (custom) | ✅ verified | Chess and checkers played in two real browser tabs: live sync both ways, mandatory captures enforced, illegal moves refused, disconnect → warning → seat held → forfeit. 17/17 unit tests pass. |
| **Forum** (Lemmy) | ⛔ not started | Placeholder route only. Out of scope for the pilot. |
| **`deploy.sh`** | ⚠️ written, never run | It changes hostname, firewall and packages — it can only be run on the Pi. Read it before running. |
| **ARM64** | ⚠️ unverified | Every image *claims* an arm64 manifest; none has been pulled on real ARM hardware. First thing to check on the Pi. |

### Known gaps carried into the pilot

* **Full 49GB Wikipedia not downloaded.** The sandbox had 27GB free, so the 2.1GB
  "top articles" build was used to prove the pipeline instead. Same builder, same format, same
  code path — only the corpus size differs. Download the full one on the Pi (§4).
* **Khan Academy not downloaded.** The only English build Kiwix publishes is 168GB, with video.
  Deliberately deferred.
* **Games are open to anyone on the LAN.** No login required. One-line change if you want it
  (`services/games/README.md`).
* **In-progress games are lost if the hub restarts.** Accepted trade-off, documented.
* **Self-signed certificate** on gated routes — see §6.

---

## 2. Before you touch the Pi

On your dev machine, with the repo cloned:

```bash
git checkout claude/offline-school-platform-6geboc
cp .env.example .env
```

Edit `.env`:

- [ ] `AUTHELIA_SESSION_SECRET` — `openssl rand -hex 32`
- [ ] `AUTHELIA_STORAGE_ENCRYPTION_KEY` — a *different* `openssl rand -hex 32`
- [ ] `AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET` — a third one
- [ ] `PUID` / `PGID` — **must not be 0** (Grav's php-fpm dies as root)
- [ ] `TZ` — the school's timezone
- [ ] `ADMIN_SSH_SOURCE` — your laptop's LAN IP or subnet
- [ ] `PI_HOSTNAME` / `SITE_HOSTNAME` — keep in sync (`schoolhub` / `schoolhub.local`)

Then replace the admin password hash — the one in the repo is public:

```bash
docker compose run --rm --no-deps --entrypoint authelia auth \
  crypto hash generate bcrypt --password 'the-real-password'
# paste the $2b$... output over the placeholder in auth/users_database.yml
```

- [ ] Commit and push those changes, or plan to copy `.env` and `users_database.yml` to the Pi
      by hand (they are gitignored / contain the hash).

---

## 3. On the Pi — first deployment

Assumes Raspberry Pi OS Lite 64-bit on a USB SSD, SSH working, Pi on the school network.

```bash
ssh pi@<pi-ip>

# get the repo
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/huntersgenius/School-Surprise-Project.git /opt/schoolhub
cd /opt/schoolhub
git checkout claude/offline-school-platform-6geboc

# copy your .env and auth/users_database.yml across from the dev machine, then:
./deploy.sh --check-images
```

`deploy.sh` will: sanity-check the machine → install Docker + Compose → install avahi and set
the hostname → configure UFW (80, 443, SSH from your address) → chown the data dirs → generate
the Authelia secrets if `.env` is missing → build the games image → bring the stack up.

`--check-images` adds an ARM64 manifest check before it starts. **Read its output** — that is
the first real test of the ARM64 assumption.

Useful variants:

```bash
./deploy.sh --skip-firewall        # if school IT manages the firewall
./deploy.sh --no-start             # set everything up, start it yourself
./deploy.sh --admin-ssh 192.168.1.50   # restrict SSH to one machine
```

### Immediately after it finishes

- [ ] `docker compose ps` — all seven services up. `library` restart-looping is **expected**
      until a ZIM exists.
- [ ] `docker compose logs proxy | tail` — no `[emerg]`.
- [ ] `curl -I http://localhost/` → 200.
- [ ] `sudo ufw status verbose` → 80 and 443 open, SSH restricted to your address, default deny.
- [ ] `docker stats --no-stream` — see §7 for what to expect.

---

## 4. Content, on the Pi

Do this **while the Pi still has internet**. Run the big one inside `tmux` so an SSH drop
doesn't kill it.

```bash
# check current sizes first — they change month to month
./services/library/download-content.sh --list

tmux new -s zim
./services/library/download-content.sh wikipedia        # ~49GB, hours
# detach with ctrl-b d, reattach with: tmux attach -t zim
docker compose restart library
```

- [ ] Confirm free space **before** starting: the script refuses if the disk is too small, which
      is the behaviour you want, but check with `df -h` anyway.
- [ ] Interrupted? Just re-run the same command — it resumes and only renames `.part` → `.zim`
      after the published SHA-256 matches.
- [ ] Smaller alternative if the SSD is tight: `--variant top` (~2GB, most-read articles) or
      `--variant simple` (~1GB, Simple English). Both are real Wikipedia.
- [ ] Khan Academy is `--yes khan` and is **168GB with video**. Decide deliberately.

```bash
# ebooks — minutes, use the mirror (gutenberg.org itself 504s a lot)
GUTENBERG_MIRROR=https://gutenberg.pglaf.org ./services/ebooks/download-content.sh
./services/ebooks/import-to-calibre.sh          # pulls a ~1.2GB calibre image once
```

- [ ] In Calibre-web (`http://schoolhub.local/ebooks`): log in `admin` / `admin123`, **change
      the password**, then Admin → Edit Database Configuration → `/books`.

```bash
# news — Grav forces admin creation before it serves anything
docker compose up -d news && sleep 30
docker compose exec -u abc news sh -c \
  'cd /app/www/public && php bin/plugin login new-user \
     -u newsadmin -p "a-real-password" -e news@schoolhub.local \
     -l en -P b --admin-type admin -N "School Office" -s enabled'
./services/news/seed-content.sh
docker compose restart news
```

---

## 5. Checks that can only be done on real hardware

These are the ones nobody could do in a container on x86.

### ARM64

- [ ] Every image pulled without `no matching manifest for linux/arm64`.
- [ ] `docker compose build games` succeeded on the Pi (node:22-alpine is multi-arch; the build
      is deliberately done on the Pi rather than cross-compiled).
- [ ] If any image has no arm64 build, the substitutes to consider are in
      `PROJECT_PLAN.md`'s tech table.

### Network identity

- [ ] `hostname` returns `schoolhub`.
- [ ] `systemctl status avahi-daemon` is active.
- [ ] From a **laptop on the same network**: `ping schoolhub.local` resolves.
- [ ] From an **Android phone**: open `http://schoolhub.local/`. Some Android versions don't do
      mDNS — if it fails, that is expected, and the fallback is the IP address. Note which
      devices work; it changes what you tell students.
- [ ] Set a **DHCP reservation** on the school router for the Pi's MAC (deploy.sh prints it).
      Without it the IP fallback breaks after a reboot.

### The firewall actually holding

- [ ] From a machine that is *not* your admin device: `ssh pi@schoolhub.local` should be
      refused, `http://schoolhub.local/` should work.
- [ ] `sudo ufw status numbered` matches what you expect.
- [ ] Note: Docker writes its own iptables rules, so a service with a published port bypasses
      UFW. Only the proxy publishes ports here — keep it that way.

### Certificate behaviour on real devices

Open content is plain http and shows no warning. Only gated routes (`/private/`, and anything
you gate later) go to https with a self-signed certificate.

- [ ] On a laptop browser: `http://schoolhub.local/private/` → redirects to https → certificate
      warning → "Advanced / Proceed" → Authelia login → after login, the staff page.
- [ ] On a phone browser: same. **Check this specifically** — mobile browsers are more
      aggressive about self-signed certs, and iOS Safari in particular may refuse without
      installing the certificate.
- [ ] If the warning is unacceptable for staff, install `proxy/certs/public.crt` as a trusted
      root on those devices (or on the school's managed image).
- [ ] Confirm students never hit https by accident: browse the library, ebooks, news and games
      on a phone and check the URL bar stays on http.

### Resource headroom under real load

- [ ] `docker stats --no-stream` at idle, then with the library being searched.
- [ ] `vcgencmd measure_temp` under load — a Pi 4 in a cupboard with no airflow throttles.
- [ ] `free -h` while kiwix serves the full 49GB ZIM. Its memory use grows with the search
      index, and this is the single biggest unknown on a 4GB Pi.
- [ ] Simulate a class: 15-20 devices hitting library + games at once (Phase 4 of the plan has
      the load-test brief if you want to be systematic).

---

## 6. The security posture, stated plainly

So you can decide if it's acceptable before students are on it.

* **Open content is unauthenticated and unencrypted.** Anyone on the school LAN can read the
  library, ebooks, news and play games. That is the design.
* **Gated routes use a self-signed certificate.** Traffic is encrypted, but the certificate
  isn't trusted by default, so a determined attacker on the wire could MITM a staff member who
  clicks through the warning. Installing the cert as a trusted root fixes that.
* **The Authelia admin password in the repo is public.** Change it (§2). If you skip one thing
  in this document, don't let it be this one.
* **Calibre-web ships with `admin`/`admin123`** and Grav has its own separate admin account.
  Neither is Authelia. Three separate passwords to set.
* **Student names in games are self-declared** and not verified.

---

## 7. Expected footprint (measured on x86; ARM will differ somewhat)

Idle, all seven services running with the 2.1GB ZIM loaded:

| Service | Memory |
|---|---|
| proxy | ~7 MB |
| homepage | ~5 MB |
| library (kiwix) | ~78 MB |
| ebooks (Calibre-web) | ~189 MB |
| news (Grav) | ~78 MB |
| auth (Authelia) | ~25 MB |
| games | ~21 MB |
| **total** | **~400 MB** |

On a 4GB Pi that leaves plenty of headroom — but kiwix's memory grows with ZIM size, and the
full Wikipedia is 23× larger than what was measured. Watch it (§5).

Disk: images ~2.3GB, plus content — 49GB Wikipedia, ~90MB ebooks, ~32MB news. Budget **80GB
minimum**, 128GB+ comfortable.

---

## 8. Explicitly out of scope for this pilot

Not missing — deliberately excluded. Don't let scope creep in before the pilot runs.

* **The forum (Lemmy).** Not started. The Lemmy ↔ Authelia integration is an open design
  question, not a coding task, and it needs a decision first.
* **Khan Academy ZIM.** 168GB with video; no text-only build exists.
* **HTTPS for open content** / a locally-trusted CA rollout.
* **Login for games.**
* **Games surviving a restart** (would need a database).
* **Any new feature.** The recipe for adding one after the pilot is at the end of
  `PROJECT_PLAN.md`.

---

## 9. If something breaks

`README.md` has a troubleshooting table built from failures that actually happened —
Grav 502s, the IPv6 bind, the `/news` prefix, kiwix restart loops, nginx duplicate directives,
the login redirect loop. Check there first.

Per-service detail lives in `services/*/README.md` and `auth/README.md`.
