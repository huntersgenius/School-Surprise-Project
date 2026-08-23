'use strict';

/**
 * SchoolHub games service — Express + Socket.io.
 *
 * Served behind the Nginx reverse proxy at BASE_PATH (default /games). The app
 * mounts itself at that path rather than at "/" so the proxy can forward the
 * URL untouched, which keeps the nginx config for this route as close to the
 * plain-HTTP routes as a websocket service can be.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { RoomManager } = require('./rooms');
const { registerSocketHandlers } = require('./socket-handlers');
const { GAME_TYPES, GAMES } = require('./games');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
// Normalise "/games/" or "games" to "/games", and "" or "/" to "".
const BASE_PATH = (() => {
    const raw = (process.env.BASE_PATH ?? '/games').trim();
    if (!raw || raw === '/') return '';
    return `/${raw.replace(/^\/+|\/+$/g, '')}`;
})();
const DISCONNECT_GRACE_SECONDS = Number.parseInt(process.env.DISCONNECT_GRACE_SECONDS || '90', 10);
const ROOM_IDLE_MINUTES = Number.parseInt(process.env.ROOM_IDLE_MINUTES || '30', 10);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const log = {
    info: (...args) => console.log(new Date().toISOString(), ...args),
    error: (...args) => console.error(new Date().toISOString(), ...args),
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

const roomManager = new RoomManager({
    disconnectGraceSeconds: DISCONNECT_GRACE_SECONDS,
    roomIdleMinutes: ROOM_IDLE_MINUTES,
});

// --- routes ---------------------------------------------------------------

// Health check for docker and for the proxy. Answers on both paths so the
// container healthcheck doesn't need to know about BASE_PATH.
const health = (req, res) => res.json({ ok: true, uptime: process.uptime(), ...roomManager.stats() });
app.get('/healthz', health);
if (BASE_PATH) app.get(`${BASE_PATH}/healthz`, health);

// Hands the browser its runtime settings rather than making it guess them
// from window.location — which breaks the moment the route is renamed.
app.get(`${BASE_PATH}/config.js`, (req, res) => {
    const config = {
        basePath: BASE_PATH,
        socketPath: `${BASE_PATH}/socket.io`,
        disconnectGraceSeconds: DISCONNECT_GRACE_SECONDS,
        games: GAME_TYPES.map((type) => ({ type, label: GAMES[type].label })),
    };
    res.type('application/javascript');
    res.set('Cache-Control', 'no-store');
    res.send(`window.GAMES_CONFIG = ${JSON.stringify(config)};`);
});

app.use(
    BASE_PATH || '/',
    express.static(PUBLIC_DIR, {
        index: 'index.html',
        maxAge: '1h',
        etag: true,
    }),
);

// Anything else under the base path is the single-page app.
app.get(`${BASE_PATH}/*`, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// Reaching the container directly (no proxy) still lands somewhere useful.
if (BASE_PATH) {
    app.get('/', (req, res) => res.redirect(`${BASE_PATH}/`));
}

// --- websockets -----------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, {
    path: `${BASE_PATH}/socket.io`,
    // Same-origin only: the page is served by this app, through the proxy.
    cors: { origin: false },
    // The Pi is on a LAN; a dropped phone should reconnect, not be pinged out.
    pingInterval: 20000,
    pingTimeout: 25000,
});

registerSocketHandlers(io, roomManager, log);

// --- lifecycle ------------------------------------------------------------

server.listen(PORT, () => {
    log.info(`games service listening on :${PORT}`);
    log.info(`  base path        ${BASE_PATH || '/'}`);
    log.info(`  socket.io path   ${BASE_PATH}/socket.io`);
    log.info(`  disconnect grace ${DISCONNECT_GRACE_SECONDS}s`);
    log.info(`  idle room sweep  ${ROOM_IDLE_MINUTES}min`);
});

const shutdown = (signal) => {
    log.info(`${signal} received, shutting down`);
    io.close();
    roomManager.stop();
    server.close(() => process.exit(0));
    // Don't hang forever on a websocket that won't close.
    setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A crash in one game must not take the service down for everyone else.
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

module.exports = { app, server, io, roomManager };
