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

## If kiwix-serve doesn't expand the glob

The compose command passes `/data/*.zim`. Recent kiwix-serve builds expand that themselves (the
image has no shell to do it for them). If your build doesn't and the container complains it
can't find `/data/*.zim`, list the files explicitly in `docker-compose.yml`:

```yaml
    command: ["--port=8080", "--urlRootLocation=/library",
              "/data/wikipedia_en_all_nopic_2026-06.zim"]
```
