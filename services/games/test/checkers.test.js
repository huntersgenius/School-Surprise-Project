'use strict';

/**
 * Tests for the hand-written checkers rules — the one piece of game logic in
 * this platform that isn't a well-tested library. Run with:  npm test
 *
 * Each test builds a tiny position rather than playing a whole game, so a
 * failure points straight at the rule that broke.
 */

const test = require('node:test');
const assert = require('node:assert');

const { CheckersGame, _internals } = require('../src/games/checkers-game');
const { BLACK, RED } = _internals;

/** Replace the board with an explicit position. Keys are "row-col". */
function setPosition(game, pieces, turn = BLACK) {
    game.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (const [id, spec] of Object.entries(pieces)) {
        const [r, c] = id.split('-').map(Number);
        game.board[r][c] = { color: spec[0], king: spec.includes('K') };
    }
    game.turn = turn;
    game.mustContinueFrom = null;
    game.result = null;
    game.quietPlies = 0;
    return game;
}

test('opening position has 12 pieces a side on dark squares only', () => {
    const game = new CheckersGame();
    assert.strictEqual(game.countPieces(BLACK), 12);
    assert.strictEqual(game.countPieces(RED), 12);

    for (const cell of game.state().cells) {
        if (cell.piece) assert.ok(cell.dark, `piece on a light square at ${cell.id}`);
    }
});

test('black moves first and has exactly seven opening moves', () => {
    const game = new CheckersGame();
    assert.strictEqual(game.turn, BLACK);

    const moves = game.legalMovesMap();
    const total = Object.values(moves).reduce((n, list) => n + list.length, 0);
    assert.strictEqual(total, 7, 'standard draughts opening has 7 legal moves');
});

test('men move forward only; kings move both ways', () => {
    const game = setPosition(new CheckersGame(), { '4-3': 'b' }, BLACK);
    // A black man at row 4 advances DOWN the board (rows increase).
    assert.deepStrictEqual(game.legalMovesMap()['4-3'].sort(), ['5-2', '5-4']);

    const kinged = setPosition(new CheckersGame(), { '4-3': 'bK' }, BLACK);
    assert.deepStrictEqual(kinged.legalMovesMap()['4-3'].sort(), ['3-2', '3-4', '5-2', '5-4']);
});

test('a capture is compulsory when one is available', () => {
    // Black at 2-3 can jump the red man at 3-4 landing on 4-5. It also has a
    // quiet move to 3-2, and a second black man at 6-1 has quiet moves — none
    // of those may be played while a capture exists.
    const game = setPosition(new CheckersGame(), { '2-3': 'b', '3-4': 'r', '6-1': 'b' }, BLACK);

    const moves = game.legalMovesMap();
    assert.deepStrictEqual(Object.keys(moves), ['2-3'], 'only the capturing piece may move');
    assert.deepStrictEqual(moves['2-3'], ['4-5']);

    const refused = game.move({ from: '6-1', to: '5-0' });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.error, /capture is available/i);
});

test('a multi-jump keeps the turn until the chain is finished', () => {
    // Black at 0-1 jumps 1-2 to 2-3, from where it can jump 3-4 to 4-5.
    const game = setPosition(new CheckersGame(), { '0-1': 'b', '1-2': 'r', '3-4': 'r' }, BLACK);

    const first = game.move({ from: '0-1', to: '2-3' });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(game.turn, BLACK, 'turn does not pass mid-chain');
    assert.strictEqual(game.mustContinueFrom.r, 2);
    assert.strictEqual(game.mustContinueFrom.c, 3);

    // Only the chaining piece may move, and only by jumping.
    assert.deepStrictEqual(Object.keys(game.legalMovesMap()), ['2-3']);

    const second = game.move({ from: '2-3', to: '4-5' });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(game.turn, RED, 'turn passes once the chain ends');
    assert.strictEqual(game.mustContinueFrom, null);
    assert.strictEqual(game.countPieces(RED), 0);
});

test('reaching the back row makes a king and ends the turn mid-chain', () => {
    // Black man at 5-2 jumps the red man at 6-3 and lands on 7-4 — the back
    // row. Even though another jump would be available from there as a king,
    // kinging ends the turn (standard American rule).
    const game = setPosition(
        new CheckersGame(),
        { '5-2': 'b', '6-3': 'r', '6-5': 'r', '4-4': 'r' },
        BLACK,
    );

    const res = game.move({ from: '5-2', to: '7-4' });
    assert.strictEqual(res.ok, true);

    const piece = game.board[7][4];
    assert.ok(piece.king, 'piece was crowned');
    assert.strictEqual(game.mustContinueFrom, null, 'no chain continues after kinging');
    assert.strictEqual(game.turn, RED, 'turn passed');
});

test('a man is crowned on a plain move to the back row', () => {
    const game = setPosition(new CheckersGame(), { '6-1': 'b', '0-7': 'r' }, BLACK);
    assert.strictEqual(game.move({ from: '6-1', to: '7-0' }).ok, true);
    assert.ok(game.board[7][0].king);
});

test('running out of pieces loses', () => {
    const game = setPosition(new CheckersGame(), { '2-3': 'b', '3-4': 'r' }, BLACK);
    game.move({ from: '2-3', to: '4-5' });

    assert.ok(game.result, 'game ended');
    assert.strictEqual(game.result.winner, BLACK);
    assert.match(game.state().statusText, /black wins/i);
    assert.strictEqual(game.state().over, true);
});

test('being unable to move loses, even with pieces left', () => {
    // Red man at 0-1 is on its own back row: it can only move upward, and
    // there is no row above. No legal move => red loses.
    const game = setPosition(new CheckersGame(), { '0-1': 'r', '5-0': 'b' }, RED);
    game.evaluateEnd();

    assert.ok(game.result);
    assert.strictEqual(game.result.winner, BLACK);
    assert.match(game.result.reason, /no legal moves/);
});

test('illegal input is refused, not crashed on', () => {
    const game = new CheckersGame();
    for (const bad of [
        { from: 'nonsense', to: '4-5' },
        { from: '99-99', to: '0-0' },
        { from: null, to: undefined },
        { from: '5-0', to: '5-0' },
    ]) {
        const res = game.move(bad);
        assert.strictEqual(res.ok, false, `refused ${JSON.stringify(bad)}`);
        assert.ok(typeof res.error === 'string' && res.error.length > 0);
    }
    // The board is untouched by any of that.
    assert.strictEqual(game.countPieces(BLACK), 12);
    assert.strictEqual(game.countPieces(RED), 12);
});

test('state() gives the browser 64 cells, a turn and a legal-move map', () => {
    const state = new CheckersGame().state();
    assert.strictEqual(state.cells.length, 64);
    assert.strictEqual(state.type, 'checkers');
    assert.strictEqual(state.turn, BLACK);
    assert.ok(Object.keys(state.legalMoves).length > 0);
    assert.strictEqual(state.over, false);
    // No token or internal timer leaks into what goes over the wire.
    assert.strictEqual(JSON.stringify(state).includes('graceTimer'), false);
});
