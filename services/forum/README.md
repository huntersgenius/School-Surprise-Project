# /services/forum — Lemmy (Phase 4, not built yet)

Placeholder folder so the repo structure matches PROJECT_PLAN.md.

Right now `/forum` serves a static "coming soon" page from the homepage container — see
`proxy/conf.d/locations/50-forum.conf`, which has the real `proxy_pass` block ready to swap in.

## What Phase 4 involves

1. Merge Lemmy's official compose setup (lemmy, lemmy-ui, postgres, pictrs) into the root
   `docker-compose.yml` rather than running it as a separate stack.
2. Configure it as a single, **non-federated** school instance.
3. Replace the placeholder in `50-forum.conf` with a real proxy route (websocket-aware).
4. Enable the Forum tile in `homepage/index.html` — delete `tile--soon` and the badge, make it
   an `<a href="/forum/">` like its neighbours.

## The open integration question

Lemmy manages its own accounts internally; it is not a forward-auth-gated app like the other
services. Putting Authelia in front of it does not give students one shared account — they'd log
into Authelia and then log into Lemmy again. PROJECT_PLAN.md flags this as the trickiest
integration point in the project and asks for the approach to be agreed **before** any
integration code is written. Don't skip that.

The same limitation already shows up in miniature with Grav's admin panel (see
`services/news/README.md`), which is a useful, low-stakes place to see the problem first.
