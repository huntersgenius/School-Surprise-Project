# /services/news — Grav CMS

Route: `/news` · Image: `lscr.io/linuxserver/grav` · Compose service: `news`

```
seed/pages/       three sample posts, copied into the live site by seed-content.sh
seed/config/      site title + custom_base_url
seed-content.sh   installs the seed into the running Grav install (idempotent)
data/             the live Grav install — pages, config, cache (gitignored)
```

Grav is flat-file: posts are markdown files on disk, there is no database to back up or
migrate. Copying `data/user/pages` somewhere safe *is* the backup.

## First run

```bash
docker compose up -d news
sleep 30                              # Grav unpacks itself on first start

# Grav redirects EVERY page to /news/admin until an admin account exists.
docker compose exec -u abc news sh -c \
  'cd /app/www/public && php bin/plugin login new-user \
     -u newsadmin -p "choose-a-password" -e news@schoolhub.local \
     -l en -P b --admin-type admin -N "School Office" -s enabled'

./services/news/seed-content.sh
docker compose restart news
```

Then open `http://schoolhub.local/news/`.

## Why the image is pinned to 1.7.x

`docker-compose.yml` pins `lscr.io/linuxserver/grav:1.7.53-ls252` rather than `:latest`.
The current `:latest` (Grav 2.0.21 on PHP 8.5) serves a working 404 page for **every** route,
including its own shipped demo pages — Grav boots, the admin panel answers, and the page tree
is empty. 1.7.53 on PHP 8.3 behaves correctly. Re-test before moving the pin.

## If the container won't start on an IPv6-less host

The image's nginx config binds `[::]:80`. On a host with IPv6 disabled in the kernel this is
fatal (`socket() [::]:80 failed (97: Address family not supported by protocol)`) and the
container restart-loops. The config lives in the mounted volume, so fix it in place:

```bash
sed -i -E 's|^(\s*)(listen \[::\].*)|\1# \2|' services/news/data/nginx/site-confs/default.conf
docker compose restart news
```

A stock Raspberry Pi OS has IPv6 enabled, so this is only for hosts where it's been turned off.

## Writing posts

**In the browser:** `http://schoolhub.local/news/admin` — the first visit asks you to create an
admin account. Grav's admin plugin is a normal WYSIWYG-ish editor; a teacher does not need
training for it.

**On disk:** a post is a folder with an `item.md` inside:

```
data/.../user/pages/01.home/04.sports-day/item.md
```

```markdown
---
title: 'Sports day moved to Friday'
date: '14-06-2026 09:00'
taxonomy:
    category: announcements
---

Short summary shown in the listing.

===

The rest of the post, after the summary delimiter.
```

The `NN.` number prefix controls ordering; the listing itself sorts by date, newest first.

## The base-URL gotcha (this one cost real debugging time)

Grav is told its public address by `custom_base_url` in
`data/.../user/config/system.yaml`, which `seed-content.sh` sets from `SITE_HOSTNAME` in
`.env`. **Once it knows that base path, Grav expects to receive it in the request URI and
strips it itself.**

So the nginx route must pass `/news/...` through **unchanged**. An earlier version of
`30-news.conf` rewrote `/news/foo` to `/foo` before proxying, which produced the most
misleading failure in this whole build: every generated link looked perfect (`/news/home/...`),
Grav's own 404 page rendered with the right site title, and every single page 404'd — because
the route Grav received no longer matched anything it had.

If you ever see "links look right but everything 404s", check for a rewrite in front of Grav.

Consequence of the same setting: reaching the news site by raw IP produces links pointing at
`schoolhub.local`. Use the hostname. If you rename the project, re-run `seed-content.sh` (it
rewrites the key in place) and restart the container.

## Admin panel and shared login (Phase 2 follow-up)

Grav's admin has its own account system, separate from Authelia. Once the shared login is in
real use, gate the admin path so teachers use one account:

1. Uncomment the `/news/admin` block in `proxy/conf.d/locations/30-news.conf`.
2. Optionally add a group restriction in `auth/configuration.yml` (`subject: ['group:teachers']`).
3. `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`

Grav will still ask for its own login behind that — Authelia gates the *route*, it doesn't sign
you into Grav. That's a known limitation of forward-auth in front of an app with its own users,
and it's the same shape of problem as Lemmy in Phase 4.
