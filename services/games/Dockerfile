# ---------------------------------------------------------------------------
# SchoolHub games service.
#
# Built on the Pi rather than cross-compiled: node:22-alpine publishes an
# arm64 manifest, so `docker compose build games` on the Pi Just Works and
# there is no buildx/qemu step to get wrong.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci uses the lockfile exactly — the same dependency tree on your laptop
# and on the Pi.
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public

# node:alpine ships an unprivileged "node" user; nothing here needs root.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://localhost:3000/healthz || exit 1

CMD ["node", "src/server.js"]
