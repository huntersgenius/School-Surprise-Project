# /services/library — kiwix-serve

Route: `/library` · Image: `ghcr.io/kiwix/kiwix-serve` · Compose service: `library`

```
download-content.sh    resolves + downloads the latest ZIM files from the Kiwix catalog
data/                  the ZIM files themselves (gitignored — tens of GB)
```

There is no code here and no per-file configuration. kiwix-serve serves **every `.zim` in
`data/`** — full-text search, article rendering, images, all built in. Adding content is: put a
file in `data/`, `docker compose restart library`.

## Getting the content

```bash
./services/library/download-content.sh --list        # what's current, and how big
./services/library/download-content.sh wikipedia     # the one you actually want first
docker compose restart library
```

Interrupted downloads resume — re-run the same command. Files land as `<name>.zim.part` and are
only renamed to `.zim` after the published SHA-256 matches, so kiwix never sees a half file.

## Sizes (checked against the live catalog, re-check with `--list`)

| ZIM | Size | Notes |
|---|---|---|
| `wikipedia_en_all_nopic` | **~49 GB** | Full article text, no images. The one to have. |
| `khanacademy_en_all` | **~168 GB** | ⚠️ Includes all the videos. See below. |

**About Khan Academy:** Kiwix currently publishes exactly one English Khan Academy ZIM and it is
the full build with video, at ~168 GB. There is no text-only or "nopic" variant. That is a real
budget decision, not a download you start absent-mindedly — the script refuses anything over
`SIZE_WARN_GB` (default 60) unless you confirm interactively or pass `--yes`. On a 256 GB SSD
you can have Wikipedia *or* Khan Academy comfortably, not both plus room to grow. Worth checking
`--list` again before you buy the drive, in case a smaller build has since been published.

## Expected startup behaviour

With an empty `data/` folder the library container has nothing to serve and will exit and
restart in a loop. That is normal before the first download — every other service is unaffected
because each one runs in its own container and the proxy resolves upstreams lazily.

## Adding other ZIMs

Kiwix publishes Wiktionary, Wikibooks, Stack Exchange, TED, Gutenberg, PhET simulations and
plenty more. Browse `https://download.kiwix.org/zim/`, drop the file into `data/`, restart the
container. To automate a new one, copy `get_wikipedia()` in `download-content.sh`, point it at
the right catalog sub-directory and filename pattern, and add it to the `case` in `main()`.

## How the "drop a file in and restart" trick works

kiwix-serve does **not** expand `/data/*.zim` itself — passed as a plain argument it treats the
glob as a literal filename, prints its usage and exits, and the container restart-loops even
when ZIM files are sitting right there. (Confirmed against `ghcr.io/kiwix/kiwix-serve:latest`.)

So the compose file runs it through a shell, which does the expansion:

```yaml
    entrypoint: ["/bin/sh", "-c"]
    command: ["exec kiwix-serve --port=8080 --urlRootLocation=/library /data/*.zim"]
```

Don't "simplify" that back to a bare argument list.

## Smaller real Wikipedia builds

If the full 49GB doesn't fit — or you want to prove the whole path before committing to an
overnight download — there are two other genuine English "nopic" builds:

```bash
./download-content.sh --variant top wikipedia      # ~2 GB, the most-read articles
./download-content.sh --variant simple wikipedia   # ~1 GB, Simple English Wikipedia
./download-content.sh --variant all wikipedia      # ~49 GB, everything (default)
```

Same format, same code path, same search — only the corpus differs. The `top` build is what
this route was verified against: catalog listing, the *Photosynthesis* article rendering at
422KB through the proxy, and full-text search returning real hits.

You can also drop any `.zim` in `data/` and restart; kiwix serves whatever is there, and
multiple ZIMs appear as separate books in the catalog.
