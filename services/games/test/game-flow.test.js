'use strict';

/**
 * End-to-end test of the actual socket protocol: two clients, a real server,
 * a real websocket. This is the automated version of "open two browser tabs
 * and play a game", including the disconnect path, which is the one thing
 * that's tedious to test by hand and easy to get wrong.
 *
 * Run with:  npm test
 */

const test = require('node:test');
const assert = require('node:assert');

// Configure the server BEFORE requiring it: it reads env at import and starts
// listening. Port 0 = "any free port", and a 1s grace period keeps the
// disconnect test fast.
process.env.PORT = '0';
process.env.BASE_PATH = '';
process.env.DISCONNECT_GRACE_SECONDS = '1';
process.env.ROOM_IDLE_MINUTES = '1';

const { server, io: ioServer, roomManager } = require('../src/server');
const ioClient = require('socket.io-client');

const listening = new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
});

let baseUrl;

function connect() {
    const socket = ioClient(baseUrl, { path: '/socket.io', transports: ['websocket'] });
    return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
    });
}

/** Promise wrapper around an emit with an acknowledgement. */
function emit(socket, event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/** Resolve with the next matching event, or reject after `ms`. */
function next(socket, event, { match = () => true, ms = 4000 } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.off(event, handler);
            reject(new Error(`timed out waiting for "${event}"`));
        }, ms);
        function handler(payload) {
            if (!match(payload)) return;
            clearTimeout(timer);
            socket.off(event, handler);
            resolve(payload);
        }
        socket.on(event, handler);
    });
}

test.before(async () => {
    await listening;
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    ioServer.close();
    roomManager.stop();
    server.close();
});

test('two players can create, join and play a chess game live', async (t) => {
    const alice = await connect();
    const bob = await connect();
    t.after(() => { alice.close(); bob.close(); });

    const created = await emit(alice, 'room:create', { gameType: 'chess', name: 'Alice' });
    assert.strictEqual(created.ok, true);
    assert.match(created.room.code, /^[A-Z0-9]{4}$/);
    assert.strictEqual(created.you.seat, 'w', 'host takes the side that moves first');
    assert.strictEqual(created.room.status, 'waiting');

    // Alice is told as soon as Bob joins.
    const aliceSeesJoin = next(alice, 'room:sync', { match: (p) => p.room.status === 'playing' });

    const joined = await emit(bob, 'room:join', { code: created.room.code, name: 'Bob' });
    assert.strictEqual(joined.ok, true);
    assert.strictEqual(joined.you.seat, 'b');
    assert.strictEqual(joined.room.status, 'playing');

    const sync = await aliceSeesJoin;
    assert.deepStrictEqual(
        sync.room.players.map((p) => p.name),
        ['Alice', 'Bob'],
    );

    // A move by Alice reaches Bob's board.
    const bobSeesMove = next(bob, 'room:sync', { match: (p) => p.game.turn === 'b' });
    const moved = await emit(alice, 'game:move', { from: 'e2', to: 'e4' });
    assert.strictEqual(moved.ok, true);

    const afterMove = await bobSeesMove;
    assert.deepStrictEqual(afterMove.game.lastMove, { from: 'e2', to: 'e4' });
    assert.ok(afterMove.game.fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3'), 'board advanced');
    assert.ok(afterMove.game.legalMoves.e7, "black's pawn can now move");

    // Out-of-turn and illegal moves are refused with a readable reason.
    const outOfTurn = await emit(alice, 'game:move', { from: 'd2', to: 'd4' });
    assert.strictEqual(outOfTurn.ok, false);
    assert.match(outOfTurn.error, /your turn/i);

    const illegal = await emit(bob, 'game:move', { from: 'e7', to: 'e4' });
    assert.strictEqual(illegal.ok, false);
    assert.match(illegal.error, /legal move/i);

    // And the game is still perfectly playable afterwards.
    const back = await emit(bob, 'game:move', { from: 'e7', to: 'e5' });
    assert.strictEqual(back.ok, true);
});

test('checkers plays over the wire too, mandatory captures and all', async (t) => {
    const p1 = await connect();
    const p2 = await connect();
    t.after(() => { p1.close(); p2.close(); });

    const created = await emit(p1, 'room:create', { gameType: 'checkers', name: 'Black player' });
    assert.strictEqual(created.you.seat, 'b');
    assert.strictEqual(created.game.type, 'checkers');
    assert.strictEqual(created.game.cells.length, 64);

    await emit(p2, 'room:join', { code: created.room.code, name: 'Red player' });

    const p2SeesMove = next(p2, 'room:sync', { match: (p) => p.game.turn === 'r' });
    const moved = await emit(p1, 'game:move', { from: '2-1', to: '3-0' });
    assert.strictEqual(moved.ok, true);

    const state = (await p2SeesMove).game;
    assert.strictEqual(state.turn, 'r');
    assert.deepStrictEqual(state.lastMove, { from: '2-1', to: '3-0' });
    assert.strictEqual(state.counts.b, 12, 'nothing captured yet');
});

test('joining with a bad code fails cleanly, and a full room refuses a third player', async (t) => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    t.after(() => { a.close(); b.close(); c.close(); });

    const nonsense = await emit(a, 'room:join', { code: 'ZZZZ', name: 'Nobody' });
    assert.strictEqual(nonsense.ok, false);
    assert.match(nonsense.error, /no game with that code/i);

    const created = await emit(a, 'room:create', { gameType: 'chess', name: 'A' });
    await emit(b, 'room:join', { code: created.room.code, name: 'B' });

    const third = await emit(c, 'room:join', { code: created.room.code, name: 'C' });
    assert.strictEqual(third.ok, false);
    assert.match(third.error, /already has two players/i);
});

test('a mid-game disconnect warns the opponent, holds the seat, then forfeits', async (t) => {
    const alice = await connect();
    const bob = await connect();
    t.after(() => { bob.close(); });

    const created = await emit(alice, 'room:create', { gameType: 'chess', name: 'Alice' });
    await emit(bob, 'room:join', { code: created.room.code, name: 'Bob' });
    await emit(alice, 'game:move', { from: 'e2', to: 'e4' });

    // Bob is told immediately — no silent freeze.
    const warned = next(bob, 'room:notice', { match: (p) => p.type === 'opponent-disconnected' });
    const bobSeesOffline = next(bob, 'room:sync', {
        match: (p) => p.room.players.some((pl) => pl.name === 'Alice' && !pl.connected),
    });

    alice.close();

    const notice = await warned;
    assert.match(notice.text, /Alice lost connection/);
    assert.match(notice.text, /1s/, 'the hold time is stated');
    await bobSeesOffline;

    // The server does not crash, and the game is still there while the seat
    // is held (grace period is 1s in this test).
    const room = roomManager.get(created.room.code);
    assert.ok(room, 'room survives the disconnect');
    assert.strictEqual(room.status, 'playing');

    // ...and once the grace period lapses, Bob wins by forfeit.
    const forfeited = await next(bob, 'room:notice', {
        match: (p) => p.type === 'opponent-forfeited',
        ms: 5000,
    });
    assert.match(forfeited.text, /did not come back/i);

    const finished = roomManager.get(created.room.code);
    assert.strictEqual(finished.status, 'finished');
    assert.strictEqual(finished.result.winner, 'b', 'the player still connected wins');
});

test('a refresh reclaims your seat with the token', async (t) => {
    const alice = await connect();
    const bob = await connect();
    t.after(() => { alice.close(); bob.close(); });

    const created = await emit(alice, 'room:create', { gameType: 'chess', name: 'Alice' });
    await emit(bob, 'room:join', { code: created.room.code, name: 'Bob' });
    await emit(alice, 'game:move', { from: 'd2', to: 'd4' });

    // Simulate the tab being reloaded: same token, brand new socket.
    alice.close();
    const reborn = await connect();
    t.after(() => reborn.close());

    const rejoined = await emit(reborn, 'room:rejoin', {
        code: created.room.code,
        token: created.you.token,
    });
    assert.strictEqual(rejoined.ok, true);
    assert.strictEqual(rejoined.you.seat, 'w', 'same seat as before');
    assert.strictEqual(rejoined.game.turn, 'b', 'the game carried on');
    assert.ok(rejoined.game.fen.includes('3P4'), 'the pawn is still on d4');

    // A wrong token gets nothing.
    const impostor = await connect();
    t.after(() => impostor.close());
    const denied = await emit(impostor, 'room:rejoin', {
        code: created.room.code,
        token: 'not-the-right-token',
    });
    assert.strictEqual(denied.ok, false);
});

test('player names are sanitised before they reach the other browser', async (t) => {
    const a = await connect();
    t.after(() => a.close());

    const created = await emit(a, 'room:create', {
        gameType: 'chess',
        name: '<script>alert(1)</script>Zoë',
    });
    assert.strictEqual(created.ok, true);
    assert.ok(!created.you.name.includes('<'), 'angle brackets stripped');
    assert.ok(created.you.name.includes('Zoë'), 'accented letters kept');
});
