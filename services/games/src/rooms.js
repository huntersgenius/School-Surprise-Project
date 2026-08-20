'use strict';

/**
 * Rooms / lobby.
 *
 * KNOWN LIMITATION, deliberately accepted for now: every room lives in this
 * process's memory. Restarting the container ends every game in progress.
 * Two students mid-match will see "connection lost" and have to start again.
 * That is a real cost, not a non-issue — it is accepted because the
 * alternative (a database) is a whole extra service to run and back up on a
 * Pi, for games that last ten minutes. If games ever need to survive a
 * restart, this file is the only one that has to change: give it a store
 * interface and put Redis or SQLite behind it.
 */

const crypto = require('crypto');
const { createGame, isValidGameType, gameLabel } = require('./games');

// No I, O, 0 or 1 — a room code gets read aloud across a classroom.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const MAX_NAME_LENGTH = 24;

function randomCode() {
    let code = '';
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    return code;
}

function cleanName(name, fallback) {
    // Strip anything that isn't a letter, number, space or simple punctuation
    // — these names are rendered in the other player's browser — and only THEN
    // truncate, so removing junk doesn't cost a real name its last characters.
    const safe = String(name || '')
        .replace(/[^\p{L}\p{N} '._-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_NAME_LENGTH);
    return safe || fallback;
}

class RoomManager {
    /**
     * @param {object} options
     * @param {number} options.disconnectGraceSeconds how long a seat is held for a
     *        player who drops, before the game is awarded to their opponent
     * @param {number} options.roomIdleMinutes how long an inactive room is kept
     * @param {(room: Room, event: object) => void} options.onRoomChanged called
     *        whenever a room's state changes for reasons other than a move
     */
    constructor({ disconnectGraceSeconds = 90, roomIdleMinutes = 30, onRoomChanged = () => {} } = {}) {
        this.rooms = new Map();          // code -> room
        this.socketIndex = new Map();    // socket.id -> {code, seat}
        this.disconnectGraceMs = disconnectGraceSeconds * 1000;
        this.roomIdleMs = roomIdleMinutes * 60 * 1000;
        this.onRoomChanged = onRoomChanged;

        this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
        this.sweepTimer.unref?.();
    }

    stop() {
        clearInterval(this.sweepTimer);
        for (const room of this.rooms.values()) {
            for (const seat of Object.values(room.players)) {
                if (seat.graceTimer) clearTimeout(seat.graceTimer);
            }
        }
        this.rooms.clear();
    }

    // ---- lookups ---------------------------------------------------------

    get(code) {
        return this.rooms.get(String(code || '').trim().toUpperCase());
    }

    findBySocket(socketId) {
        const entry = this.socketIndex.get(socketId);
        if (!entry) return null;
        const room = this.rooms.get(entry.code);
        if (!room) {
            this.socketIndex.delete(socketId);
            return null;
        }
        return { room, seat: entry.seat };
    }

    // ---- creating and joining --------------------------------------------

    createRoom({ gameType, playerName, socketId }) {
        if (!isValidGameType(gameType)) {
            return { ok: false, error: 'Unknown game type.' };
        }

        let code = randomCode();
        let attempts = 0;
        while (this.rooms.has(code)) {
            code = randomCode();
            if (++attempts > 50) return { ok: false, error: 'The server is full of games — try again.' };
        }

        const game = createGame(gameType);
        const seats = game.seats;

        const room = {
            code,
            gameType,
            gameLabel: gameLabel(gameType),
            game,
            seats,
            players: {},                 // seatId -> player
            status: 'waiting',           // waiting | playing | finished
            result: null,                // {winner, reason} — reason is human-readable
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
        };

        // The host takes the first seat, which is the one that moves first.
        const host = this.seatPlayer(room, seats[0].id, playerName || 'Player 1', socketId);
        this.rooms.set(code, room);

        return { ok: true, room, player: host };
    }

    joinRoom({ code, playerName, socketId }) {
        const room = this.get(code);
        if (!room) return { ok: false, error: 'No game with that code. Check the letters and try again.' };

        const freeSeat = room.seats.find((s) => !room.players[s.id]);
        if (!freeSeat) return { ok: false, error: 'That game already has two players.' };

        const player = this.seatPlayer(room, freeSeat.id, playerName || 'Player 2', socketId);
        room.status = 'playing';
        room.lastActivityAt = Date.now();

        return { ok: true, room, player };
    }

    /**
     * Re-attach a player to their seat after a refresh or a dropped
     * connection. The token is what proves they owned the seat — nothing else
     * survives a page reload.
     */
    rejoin({ code, token, socketId }) {
        const room = this.get(code);
        if (!room) return { ok: false, error: 'That game has finished or expired.' };

        const seatId = Object.keys(room.players).find((id) => room.players[id].token === token);
        if (!seatId) return { ok: false, error: 'That seat is no longer yours.' };

        const player = room.players[seatId];
        if (player.graceTimer) {
            clearTimeout(player.graceTimer);
            player.graceTimer = null;
        }
        if (player.socketId) this.socketIndex.delete(player.socketId);

        player.socketId = socketId;
        player.connected = true;
        player.disconnectedAt = null;
        this.socketIndex.set(socketId, { code: room.code, seat: seatId });
        room.lastActivityAt = Date.now();

        return { ok: true, room, player };
    }

    seatPlayer(room, seatId, name, socketId) {
        const player = {
            seat: seatId,
            name: cleanName(name, seatId === room.seats[0].id ? 'Player 1' : 'Player 2'),
            token: crypto.randomBytes(16).toString('hex'),
            socketId,
            connected: true,
            disconnectedAt: null,
            graceTimer: null,
        };
        room.players[seatId] = player;
        if (socketId) this.socketIndex.set(socketId, { code: room.code, seat: seatId });
        return player;
    }

    // ---- play ------------------------------------------------------------

    playMove({ socketId, from, to, promotion }) {
        const found = this.findBySocket(socketId);
        if (!found) return { ok: false, error: 'You are not in a game.' };

        const { room, seat } = found;
        if (room.status === 'finished') return { ok: false, error: 'The game is over.' };
        if (room.status !== 'playing') return { ok: false, error: 'Waiting for another player to join.' };
        if (room.game.turn !== seat) return { ok: false, error: "It isn't your turn." };

        const result = room.game.move({ from, to, promotion });
        if (!result.ok) return { ...result, room };

        room.lastActivityAt = Date.now();

        const state = room.game.state();
        if (state.over) {
            room.status = 'finished';
            room.result = { winner: state.winner, reason: state.statusText };
        }

        return { ok: true, room };
    }

    /** Both players have to want it, so this just flips a flag until they agree. */
    requestRematch({ socketId }) {
        const found = this.findBySocket(socketId);
        if (!found) return { ok: false, error: 'You are not in a game.' };

        const { room, seat } = found;
        if (room.status !== 'finished') return { ok: false, error: 'The game is still going.' };

        room.players[seat].wantsRematch = true;
        room.lastActivityAt = Date.now();

        const everyone = Object.values(room.players);
        const allAgree = everyone.length === room.seats.length && everyone.every((p) => p.wantsRematch);

        if (allAgree) {
            room.game.reset();
            room.status = 'playing';
            room.result = null;
            // Swap seats so the same player doesn't always move first.
            this.swapSeats(room);
            for (const player of Object.values(room.players)) player.wantsRematch = false;
            return { ok: true, room, started: true };
        }

        return { ok: true, room, started: false };
    }

    swapSeats(room) {
        const [a, b] = room.seats.map((s) => s.id);
        const playerA = room.players[a];
        const playerB = room.players[b];
        if (!playerA || !playerB) return;

        room.players[a] = playerB;
        room.players[b] = playerA;
        playerA.seat = b;
        playerB.seat = a;

        for (const player of [playerA, playerB]) {
            if (player.socketId) this.socketIndex.set(player.socketId, { code: room.code, seat: player.seat });
        }
    }

    /** Deliberately leaving — different from dropping off the network. */
    leave({ socketId }) {
        const found = this.findBySocket(socketId);
        if (!found) return null;

        const { room, seat } = found;
        const player = room.players[seat];
        if (player?.graceTimer) clearTimeout(player.graceTimer);

        delete room.players[seat];
        this.socketIndex.delete(socketId);
        room.lastActivityAt = Date.now();

        if (room.status === 'playing') {
            room.status = 'finished';
            const otherSeat = room.seats.map((s) => s.id).find((id) => id !== seat);
            room.result = { winner: otherSeat, reason: `${player?.name || 'Your opponent'} left the game` };
        }
        if (Object.keys(room.players).length === 0) {
            this.rooms.delete(room.code);
            return { room, seat, roomClosed: true };
        }
        return { room, seat, roomClosed: false };
    }

    /**
     * A socket dropped. The seat is HELD, not freed: a phone that switches
     * from WiFi to mobile data, or a laptop lid closing for a moment, should
     * not lose the game. The opponent is told immediately (a silent freeze is
     * the thing to avoid), and only after the grace period does the game end.
     */
    handleDisconnect({ socketId }) {
        const found = this.findBySocket(socketId);
        if (!found) return null;

        const { room, seat } = found;
        const player = room.players[seat];
        this.socketIndex.delete(socketId);
        if (!player) return null;

        player.connected = false;
        player.disconnectedAt = Date.now();
        player.socketId = null;
        room.lastActivityAt = Date.now();

        if (player.graceTimer) clearTimeout(player.graceTimer);
        player.graceTimer = setTimeout(() => {
            player.graceTimer = null;
            if (player.connected) return;             // they came back in time

            const stillThere = this.rooms.get(room.code);
            if (!stillThere) return;

            delete room.players[seat];

            if (room.status === 'playing') {
                room.status = 'finished';
                const otherSeat = room.seats.map((s) => s.id).find((id) => id !== seat);
                room.result = {
                    winner: room.players[otherSeat] ? otherSeat : null,
                    reason: `${player.name} did not come back`,
                };
            }

            if (Object.keys(room.players).length === 0) {
                this.rooms.delete(room.code);
                return;
            }
            this.onRoomChanged(room, { type: 'opponent-forfeited', seat, name: player.name });
        }, this.disconnectGraceMs);
        player.graceTimer.unref?.();

        return { room, seat, player, graceMs: this.disconnectGraceMs };
    }

    /** Drop rooms nobody is connected to any more. */
    sweep() {
        const now = Date.now();
        for (const [code, room] of this.rooms) {
            const players = Object.values(room.players);
            const anyoneConnected = players.some((p) => p.connected);
            const idleFor = now - room.lastActivityAt;

            if (players.length === 0) {
                this.rooms.delete(code);
                continue;
            }
            if (!anyoneConnected && idleFor > this.roomIdleMs) {
                for (const player of players) {
                    if (player.graceTimer) clearTimeout(player.graceTimer);
                    if (player.socketId) this.socketIndex.delete(player.socketId);
                }
                this.rooms.delete(code);
            }
        }
    }

    // ---- serialisation ---------------------------------------------------

    /** What every client in the room may see. Tokens never go in here. */
    publicRoom(room) {
        return {
            code: room.code,
            gameType: room.gameType,
            gameLabel: room.gameLabel,
            status: room.status,
            result: room.result,
            seats: room.seats,
            players: room.seats.map((seat) => {
                const player = room.players[seat.id];
                return {
                    seat: seat.id,
                    label: seat.label,
                    hint: seat.hint,
                    name: player ? player.name : null,
                    connected: player ? player.connected : false,
                    wantsRematch: Boolean(player?.wantsRematch),
                };
            }),
        };
    }

    stats() {
        return {
            rooms: this.rooms.size,
            players: this.socketIndex.size,
        };
    }
}

module.exports = { RoomManager, randomCode, cleanName };
