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
./services/news/seed-content.sh
docker compose restart news
```

Then open `http://schoolhub.local/news/`.

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

## The base-URL gotcha

The proxy strips `/news` before Grav sees the request, so Grav has to be *told* what its public
address is — that's `custom_base_url` in `data/.../user/config/system.yaml`, which
`seed-content.sh` sets from `SITE_HOSTNAME` in `.env`.

Consequence: reaching the news site by raw IP (`http://192.168.1.50/news/`) produces links
pointing at `schoolhub.local`. Use the hostname. If you rename the project, re-run
`seed-content.sh` (it rewrites the key in place) and restart the container.

## Admin panel and shared login (Phase 2 follow-up)

Grav's admin has its own account system, separate from Authelia. Once the shared login is in
real use, gate the admin path so teachers use one account:

1. Uncomment the `/news/admin` block in `proxy/conf.d/locations/30-news.conf`.
2. Optionally add a group restriction in `auth/configuration.yml` (`subject: ['group:teachers']`).
3. `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`

Grav will still ask for its own login behind that — Authelia gates the *route*, it doesn't sign
you into Grav. That's a known limitation of forward-auth in front of an app with its own users,
and it's the same shape of problem as Lemmy in Phase 4.
