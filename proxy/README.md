# /proxy — Nginx reverse proxy

The single entry point. Port 80 is the only port published by the whole stack.

```
nginx.conf                     main config — worker/gzip/resolver/websocket map
conf.d/default.conf            the one server block; includes locations/*.conf
conf.d/locations/00-homepage.conf   "/"        -> homepage container
conf.d/locations/10-library.conf    "/library" -> kiwix-serve
conf.d/locations/20-ebooks.conf     "/ebooks"  -> Calibre-web
conf.d/locations/30-news.conf       "/news"    -> Grav
conf.d/locations/40-games.conf      "/games"   -> games (websocket-aware)
conf.d/locations/50-forum.conf      "/forum"   -> placeholder page (Phase 4)
conf.d/locations/60-auth.conf       "/authelia" portal + internal authz endpoint
conf.d/locations/70-private.conf    "/private" demo route behind login
snippets/proxy-headers.conf         standard proxy headers
snippets/websocket.conf             Upgrade/Connection + long timeouts
snippets/authelia-authrequest.conf  one include = route requires login
```

## Adding a route

Create `conf.d/locations/80-yourthing.conf`:

```nginx
location /yourthing/ {
    set $yourthing_upstream http://yourthing:8080;
    proxy_pass $yourthing_upstream;
    include /etc/nginx/snippets/proxy-headers.conf;
    # include /etc/nginx/snippets/websocket.conf;              # if websockets
    # include /etc/nginx/snippets/authelia-authrequest.conf;   # if login required
}
```

Then `docker compose restart proxy`. No other file changes.

## Two things that will bite you

**Upstreams are variables on purpose.** `set $x http://svc:port;` + `proxy_pass $x;`
defers DNS to request time. With a literal `proxy_pass http://svc:port;` nginx resolves at
startup and *refuses to start* if that container isn't up — one unbuilt service would take the
entire site down.

The trade-off: when the upstream is a variable, nginx no longer rewrites the matched location
prefix out of the path. Passing a variable with no URI (`proxy_pass $x;`) forwards the original
path unchanged; that's what most routes here want. To strip a prefix, use
`rewrite ^/prefix/(.*)$ /$1 break;` before `proxy_pass` (see `30-news.conf`) — do **not** write
`proxy_pass $x/;`, which would send a literal `/` for every request.

**Check your config before restarting:**

```bash
docker compose exec proxy nginx -t && docker compose exec proxy nginx -s reload
```
