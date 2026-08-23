# /services/ebooks — Calibre-web

Route: `/ebooks` · Image: `lscr.io/linuxserver/calibre-web` · Compose service: `ebooks`

```
download-content.sh    fetches epubs from Project Gutenberg into import/
starter-books.tsv      the curated starter set (73 public-domain titles)
import-to-calibre.sh   runs `calibredb add` inside the container: import/ -> library/
config/                Calibre-web's own settings db          (gitignored)
library/               the Calibre library it serves          (gitignored)
import/                staging area for downloaded epubs      (gitignored)
```

## First run

```bash
sudo chown -R 1000:1000 services/ebooks/{config,library,import}   # PUID/PGID from .env
docker compose up -d ebooks
./services/ebooks/download-content.sh          # ~73 books, 40-60 MB, a few minutes
./services/ebooks/import-to-calibre.sh         # this is what CREATES the library
```

Then open `http://schoolhub.local/ebooks`:

1. Log in with Calibre-web's defaults, **`admin` / `admin123`**, and change the password
   immediately (Admin → Users). This is a separate account from Authelia's.
2. Admin → Edit Database Configuration → set the location to `/books`.

**Do the import before pointing Calibre-web at `/books`.** Calibre-web can only *open* an
existing Calibre library; the Database Configuration page has no "create new database" option,
and pointing it at an empty folder just fails validation. `calibredb add` (what the import
script runs) is what creates `metadata.db` in the first place.

## calibredb comes from a mod, and the mod is downloaded at runtime

`DOCKER_MODS=linuxserver/mods:universal-calibre` is fetched **when the container starts**, not
baked into the image. Two consequences:

* Do the first import while the machine still has internet. On a Pi that has already been
  sealed off from the network, the mod can't be fetched and `calibredb` won't exist.
* If the fetch fails you'll see `OFFLINE: linuxserver/mods:universal-calibre not found in
  modcache, skipping` in `docker compose logs ebooks`, and `import-to-calibre.sh` will stop
  with a clear message rather than half-importing.

Fallback if you can't use the mod: run calibre's CLI from a one-off container instead —

```bash
docker run --rm -v "$PWD/services/ebooks/library:/books" -v "$PWD/services/ebooks/import:/import" \
  lscr.io/linuxserver/calibre:latest \
  /usr/bin/calibredb add --recurse --with-library /books /import
```

## Expanding the library

Nothing else in the system changes when you add books — Calibre-web serves whatever is in the
library.

**A few specific titles:** find each on gutenberg.org, take the number out of the URL
(`gutenberg.org/ebooks/1342` → `1342`), add a line to `starter-books.tsv`:

```
1342	literature	Austen, Jane	Pride and Prejudice
```

then re-run `download-content.sh` and `import-to-calibre.sh`. Books you already have are
skipped on both steps.

**A whole subject at once:** query the catalog instead of hand-picking IDs.

```bash
./services/ebooks/download-content.sh --topic science --limit 100
./services/ebooks/download-content.sh --topic history --limit 100
./services/ebooks/import-to-calibre.sh
```

**Other sources.** Standard Ebooks (better typography, same public-domain texts) and OpenStax
(openly licensed textbooks) are both good additions. Neither has a bulk API that is polite to
script against — Standard Ebooks gates bulk downloads behind its Patrons Circle — so the
practical route is to download what you want manually, drop the files into `import/`, and run
`import-to-calibre.sh`. It imports any format Calibre understands, not just epub.

## Content policy note

Everything the script fetches is public domain, and that's deliberate: this platform is meant to
be handed to other schools, so a copyright problem would sink it. The curated list was checked
title by title — Gutenberg's catalogue does contain adult material, so if you expand by
`--topic` or by raw ID, skim what lands in `import/` before importing.

## Rate limits

Project Gutenberg asks automated clients not to hammer the site. The script sleeps between
downloads, identifies itself in the User-Agent, and skips what it already has. For large pulls
use a mirror:

```bash
GUTENBERG_MIRROR=https://gutenberg.pglaf.org ./services/ebooks/download-content.sh --topic science --limit 300
```
