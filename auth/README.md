# /auth — Authelia (shared login)

```
configuration.yml     Authelia config. No secrets in it — those come from .env.
users_database.yml     the accounts. One placeholder admin; CHANGE ITS PASSWORD.
data/                  sqlite session + regulation db (gitignored, created on first run)
```

The Nginx side lives in `proxy/`:

- `proxy/conf.d/locations/60-auth.conf` — the portal at `/authelia` and the internal
  `auth_request` endpoint.
- `proxy/snippets/authelia-authrequest.conf` — **the snippet that gates a route.**
- `proxy/conf.d/locations/70-private.conf` — a working gated route to copy.

## First run checklist

1. `openssl rand -hex 32` three times; put the values in `.env` as
   `AUTHELIA_SESSION_SECRET`, `AUTHELIA_STORAGE_ENCRYPTION_KEY`,
   `AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET`.
   The stack refuses to start without them (`:?` in `docker-compose.yml`).
2. Replace the admin password hash in `users_database.yml` (command below).
3. `docker compose up -d auth proxy` and visit `http://schoolhub.local/private/`.
   Logged out you should be bounced to the portal; after logging in, bounced back.

## Add a user

```bash
docker compose run --rm --no-deps --entrypoint authelia auth \
  crypto hash generate bcrypt --password 'their-password'
```

Paste the `$2b$...` output into a new block in `users_database.yml`:

```yaml
  jdoe:
    disabled: false
    displayname: 'Jane Doe'
    password: '$2b$12$...'
    email: 'jdoe@schoolhub.local'
    groups: ['teachers']
```

Authelia re-reads the file within a minute. `docker compose restart auth` forces it.

## Gate a route

One line inside the `location` block in `proxy/conf.d/locations/<route>.conf`:

```nginx
include /etc/nginx/snippets/authelia-authrequest.conf;
```

Then `docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload`.

To restrict to a group, add a rule **above** the catch-all in `configuration.yml`:

```yaml
    - domain: 'schoolhub.local'
      resources: ['^/news/admin.*$']
      policy: 'one_factor'
      subject: ['group:teachers']
```

## Things worth knowing

**Plain HTTP.** The session cookie can't be `secure` without HTTPS, so anyone sniffing the
school LAN can lift a session. Fine for keeping students out of teacher pages; not fine for
anything genuinely sensitive. When that changes, the answer is HTTPS with a locally-trusted
CA, not a different auth design.

**One hostname, one cookie.** Authelia normally expects `auth.example.com` + `app.example.com`.
We have no DNS control on a school network, so it's mounted at the `/authelia` *path* on the
same host (`server.address: 'tcp://:9091/authelia'`). The cookie domain, the `authelia_url`,
and the access-control `domain` must therefore all be the same string — `schoolhub.local`.
If you rename the project, change all three, plus `PI_HOSTNAME` in `.env`.

**Students reaching the Pi by IP** (e.g. `http://192.168.1.50/private/`) will fail the login
loop, because the cookie is scoped to `schoolhub.local`. That's expected. Use the hostname.

**Secrets via files instead of .env.** If you'd rather not have secrets in `.env`, Authelia
accepts `AUTHELIA_SESSION_SECRET_FILE` etc. pointing at a mounted file; swap the env keys in
`docker-compose.yml` and mount the files.
