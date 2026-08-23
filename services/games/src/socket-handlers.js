'use strict';

/**
 * The websocket protocol, in one place.
 *
 * Client -> server (all use acknowledgement callbacks, so the browser always
 * learns why something was refused):
 *
 *   room:create  {gameType, name}          -> {ok, room, you} | {ok:false, error}
 *   room:join    {code, name}              -> {ok, room, you} | {ok:false, error}
 *   room:rejoin  {code, token}             -> {ok, room, you} | {ok:false, error}
 *   game:move    {from, to, promotion}     -> {ok} | {ok:false, error}
 *   game:rematch {}                        -> {ok, started}
 *   room:leave   {}                        -> {ok}
 *
 * Server -> client (broadcast to everyone in the room):
 *
 *   room:sync    {room, game}              the whole truth after any change
 *   room:notice  {type, text}              transient message ("X disconnected")
 */

const { GAME_TYPES } = require('./games');

function registerSocketHandlers(io, roomManager, log = console) {
    // Push the full state to a room. There is no incremental diffing on
    // purpose: a board is small, and "resend everything" removes a whole class
    // of desync bugs that are miserable to debug from a classroom.
    const sync = (room) => {
        if (!room) return;
        io.to(room.code).emit('room:sync', {
            room: roomManager.publicRoom(room),
            game: room.game.state(),
        });
    };

    const notice = (room, type, text) => {
        if (!room) return;
        io.to(room.code).emit('room:notice', { type, text });
    };

    // Called by the room manager when a grace period expires with nobody back.
    roomManager.onRoomChanged = (room, event) => {
        if (event?.type === 'opponent-forfeited') {
            notice(room, 'opponent-forfeited', `${event.name} did not come back. You win.`);
        }
        sync(room);
    };

    io.on('connection', (socket) => {
        log.info?.(`socket connected: ${socket.id}`);

        const ackOk = (cb, payload) => typeof cb === 'function' && cb({ ok: true, ...payload });
        const ackErr = (cb, error) => typeof cb === 'function' && cb({ ok: false, error });

        const you = (room, player) => ({
            seat: player.seat,
            name: player.name,
            token: player.token,
        });

        socket.on('room:create', (payload = {}, cb) => {
            const gameType = String(payload.gameType || '');
            if (!GAME_TYPES.includes(gameType)) return ackErr(cb, 'Pick a game first.');

            const result = roomManager.createRoom({
                gameType,
                playerName: payload.name,
                socketId: socket.id,
            });
            if (!result.ok) return ackErr(cb, result.error);

            socket.join(result.room.code);
            ackOk(cb, {
                room: roomManager.publicRoom(result.room),
                game: result.room.game.state(),
                you: you(result.room, result.player),
            });
            sync(result.room);
        });

        socket.on('room:join', (payload = {}, cb) => {
            const result = roomManager.joinRoom({
                code: payload.code,
                playerName: payload.name,
                socketId: socket.id,
            });
            if (!result.ok) return ackErr(cb, result.error);

            socket.join(result.room.code);
            ackOk(cb, {
                room: roomManager.publicRoom(result.room),
                game: result.room.game.state(),
                you: you(result.room, result.player),
            });
            notice(result.room, 'joined', `${result.player.name} joined. Game on.`);
            sync(result.room);
        });

        socket.on('room:rejoin', (payload = {}, cb) => {
            const result = roomManager.rejoin({
                code: payload.code,
                token: payload.token,
                socketId: socket.id,
            });
            if (!result.ok) return ackErr(cb, result.error);

            socket.join(result.room.code);
            ackOk(cb, {
                room: roomManager.publicRoom(result.room),
                game: result.room.game.state(),
                you: you(result.room, result.player),
            });
            notice(result.room, 'reconnected', `${result.player.name} is back.`);
            sync(result.room);
        });

        socket.on('game:move', (payload = {}, cb) => {
            const result = roomManager.playMove({
                socketId: socket.id,
                from: payload.from,
                to: payload.to,
                promotion: payload.promotion,
            });
            if (!result.ok) {
                // Still resync: a refused move usually means this client's
                // board drifted, and the fix is to show it the truth.
                if (result.room) sync(result.room);
                return ackErr(cb, result.error);
            }
            ackOk(cb, {});
            sync(result.room);
        });

        socket.on('game:rematch', (payload = {}, cb) => {
            const result = roomManager.requestRematch({ socketId: socket.id });
            if (!result.ok) return ackErr(cb, result.error);

            ackOk(cb, { started: result.started });
            notice(
                result.room,
                'rematch',
                result.started ? 'Rematch! Colours swapped.' : 'Rematch offered — waiting for your opponent.',
            );
            sync(result.room);
        });

        socket.on('room:leave', (payload = {}, cb) => {
            const left = roomManager.leave({ socketId: socket.id });
            ackOk(cb, {});
            if (!left) return;

            socket.leave(left.room.code);
            if (!left.roomClosed) {
                notice(left.room, 'opponent-left', 'Your opponent left the game.');
                sync(left.room);
            }
        });

        socket.on('disconnect', (reason) => {
            log.info?.(`socket disconnected: ${socket.id} (${reason})`);

            const dropped = roomManager.handleDisconnect({ socketId: socket.id });
            if (!dropped) return;

            const seconds = Math.round(dropped.graceMs / 1000);
            notice(
                dropped.room,
                'opponent-disconnected',
                `${dropped.player.name} lost connection. Holding their place for ${seconds}s.`,
            );
            sync(dropped.room);
        });
    });
}

module.exports = { registerSocketHandlers };
