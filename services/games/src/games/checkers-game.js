'use strict';

/**
 * Checkers (American / English draughts) — hand-written rules engine.
 *
 * This is the only real game logic in the whole platform. Chess gets chess.js;
 * checkers has no equivalent library worth depending on, so the rules live
 * here. They are written to be read, not to be fast — a Pi validating one move
 * every few seconds has cycles to spare.
 *
 * THE RULES IMPLEMENTED (standard American / English draughts):
 *
 *   Board       8x8, play on the dark squares only. 12 pieces each.
 *   Sides       BLACK starts on rows 0-2 (top) and its men move DOWN (+1 row).
 *               RED starts on rows 5-7 (bottom) and its men move UP (-1 row).
 *               Black moves first, as is standard.
 *   Men         move one square diagonally forward; capture by jumping one
 *               square diagonally forward over an adjacent enemy piece into
 *               the empty square beyond. Men do NOT capture backwards — that
 *               is international draughts, not this variant.
 *   Kings       made by reaching the far back row. Move and capture one square
 *               diagonally in ANY direction. Not "flying kings" (that's
 *               international draughts too).
 *   Mandatory   if any capture is available to the side to move, ONLY captures
 *   captures    are legal. Which capture is up to the player (no "must take
 *               the longest chain" rule).
 *   Multi-jump  after a jump, if the SAME piece can jump again it must, and
 *               the turn does not pass until the chain is finished.
 *   Kinging     ends the turn immediately, even mid-chain. A man that reaches
 *               the back row by jumping stops there and becomes a king; it
 *               does not continue jumping as a king in the same turn.
 *   Loss        a player with no pieces, or with no legal move, loses.
 *   Draw        40 moves (80 plies) by both players with no capture and no
 *               new king.
 *
 * Coordinates: row 0 is the TOP of the board as rendered, column 0 is the
 * LEFT. Square ids are the strings "row-col" ("0-1", "7-6"), which is what
 * crosses the wire to the browser.
 */

const SIZE = 8;

const BLACK = 'b';
const RED = 'r';

// Which way a man of each colour advances, and the row that kings it.
const FORWARD = { [BLACK]: 1, [RED]: -1 };
const KING_ROW = { [BLACK]: SIZE - 1, [RED]: 0 };

const DRAW_PLY_LIMIT = 80; // 40 moves each with no capture and no promotion

const inside = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const idOf = (r, c) => `${r}-${c}`;
const parseId = (id) => {
    const [r, c] = String(id).split('-').map(Number);
    return { r, c };
};
const isDark = (r, c) => (r + c) % 2 === 1;
const opponent = (color) => (color === BLACK ? RED : BLACK);

/** Starting position: three rows of men each, on the dark squares only. */
function initialBoard() {
    const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (!isDark(r, c)) continue;
            if (r <= 2) board[r][c] = { color: BLACK, king: false };
            else if (r >= 5) board[r][c] = { color: RED, king: false };
        }
    }
    return board;
}

/** The diagonal directions a given piece may travel. */
function directions(piece) {
    if (piece.king) return [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const dr = FORWARD[piece.color];
    return [[dr, -1], [dr, 1]];
}

/**
 * Every simple (non-capturing) move and every jump available to the piece on
 * (r, c). Returns them separately because captures are mandatory: the caller
 * decides which list is legal, not this function.
 */
function movesForPiece(board, r, c) {
    const piece = board[r][c];
    const simple = [];
    const jumps = [];
    if (!piece) return { simple, jumps };

    for (const [dr, dc] of directions(piece)) {
        const r1 = r + dr;
        const c1 = c + dc;
        if (!inside(r1, c1)) continue;

        if (!board[r1][c1]) {
            simple.push({ from: { r, c }, to: { r: r1, c: c1 }, captured: null });
            continue;
        }

        // Occupied by an enemy: can we land on the empty square beyond it?
        if (board[r1][c1].color === piece.color) continue;
        const r2 = r + 2 * dr;
        const c2 = c + 2 * dc;
        if (inside(r2, c2) && !board[r2][c2]) {
            jumps.push({ from: { r, c }, to: { r: r2, c: c2 }, captured: { r: r1, c: c1 } });
        }
    }
    return { simple, jumps };
}

/**
 * The legal moves for `color`, applying the mandatory-capture rule.
 *
 * `mustContinueFrom` is set mid-chain: only the piece that just jumped may
 * move, and only by jumping again.
 */
function legalMoves(board, color, mustContinueFrom = null) {
    if (mustContinueFrom) {
        const { r, c } = mustContinueFrom;
        const piece = board[r][c];
        if (!piece || piece.color !== color) return [];
        return movesForPiece(board, r, c).jumps;
    }

    const allJumps = [];
    const allSimple = [];
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            const piece = board[r][c];
            if (!piece || piece.color !== color) continue;
            const { simple, jumps } = movesForPiece(board, r, c);
            allJumps.push(...jumps);
            allSimple.push(...simple);
        }
    }
    // Captures are compulsory: if any exist, the simple moves aren't legal.
    return allJumps.length > 0 ? allJumps : allSimple;
}

class CheckersGame {
    constructor() {
        this.reset();
    }

    reset() {
        this.board = initialBoard();
        this.turn = BLACK;              // black moves first
        this.mustContinueFrom = null;   // {r, c} while a multi-jump is unfinished
        this.lastMove = null;           // {from, to} as square ids, for highlighting
        this.history = [];              // human-readable move list
        this.quietPlies = 0;            // plies since the last capture or promotion
        this.result = null;             // {winner, reason} once the game ends
    }

    static get type() { return 'checkers'; }
    get type() { return 'checkers'; }

    /** Seat definitions the lobby uses. Black moves first, so it's seated first. */
    get seats() {
        return [
            { id: BLACK, label: 'Black', hint: 'moves first, plays from the top' },
            { id: RED, label: 'Red', hint: 'plays from the bottom' },
        ];
    }

    /** { "5-2": ["4-1", "4-3"], ... } — everything the UI needs to offer moves. */
    legalMovesMap() {
        const map = {};
        if (this.result) return map;
        for (const move of legalMoves(this.board, this.turn, this.mustContinueFrom)) {
            const from = idOf(move.from.r, move.from.c);
            (map[from] ||= []).push(idOf(move.to.r, move.to.c));
        }
        return map;
    }

    /**
     * Play a move. `from`/`to` are square ids ("5-2"). Returns
     * {ok: true} or {ok: false, error} — it never throws on bad input, because
     * the input comes straight off a websocket.
     */
    move({ from, to }) {
        if (this.result) return { ok: false, error: 'The game is already over.' };

        const a = parseId(from);
        const b = parseId(to);
        if (!inside(a.r, a.c) || !inside(b.r, b.c)) {
            return { ok: false, error: 'Off the board.' };
        }

        const candidates = legalMoves(this.board, this.turn, this.mustContinueFrom);
        const chosen = candidates.find(
            (m) => m.from.r === a.r && m.from.c === a.c && m.to.r === b.r && m.to.c === b.c,
        );

        if (!chosen) {
            // Distinguish the two cases players actually hit, so the UI can say
            // something more useful than "illegal move".
            const anyCapture = candidates.some((m) => m.captured);
            if (this.mustContinueFrom) {
                return { ok: false, error: 'You must finish the jump with the same piece.' };
            }
            if (anyCapture) {
                return { ok: false, error: 'A capture is available, so you have to take it.' };
            }
            return { ok: false, error: 'That is not a legal move.' };
        }

        this.applyMove(chosen);
        return { ok: true };
    }

    /** Mutates the board for a move already known to be legal. */
    applyMove(move) {
        const piece = this.board[move.from.r][move.from.c];

        this.board[move.from.r][move.from.c] = null;
        this.board[move.to.r][move.to.c] = piece;

        let captured = false;
        if (move.captured) {
            this.board[move.captured.r][move.captured.c] = null;
            captured = true;
        }

        // Kinging. Note this happens BEFORE the multi-jump check on purpose:
        // reaching the back row ends the turn even if another jump is on offer.
        let promoted = false;
        if (!piece.king && move.to.r === KING_ROW[piece.color]) {
            piece.king = true;
            promoted = true;
        }

        this.history.push(this.notate(move, { captured, promoted }));
        this.lastMove = { from: idOf(move.from.r, move.from.c), to: idOf(move.to.r, move.to.c) };
        this.quietPlies = captured || promoted ? 0 : this.quietPlies + 1;

        // Chain jumps: same piece, must jump again, turn does not pass.
        const canJumpAgain =
            captured &&
            !promoted &&
            movesForPiece(this.board, move.to.r, move.to.c).jumps.length > 0;

        if (canJumpAgain) {
            this.mustContinueFrom = { r: move.to.r, c: move.to.c };
        } else {
            this.mustContinueFrom = null;
            this.turn = opponent(this.turn);
        }

        this.evaluateEnd();
    }

    /** Sets this.result if the game is over. */
    evaluateEnd() {
        const mine = this.countPieces(this.turn);
        if (mine === 0) {
            this.result = { winner: opponent(this.turn), reason: 'no pieces left' };
            return;
        }
        if (legalMoves(this.board, this.turn, this.mustContinueFrom).length === 0) {
            this.result = { winner: opponent(this.turn), reason: 'no legal moves' };
            return;
        }
        if (this.quietPlies >= DRAW_PLY_LIMIT) {
            this.result = { winner: null, reason: '40 moves with no capture or king' };
        }
    }

    countPieces(color) {
        let n = 0;
        for (const row of this.board) {
            for (const piece of row) if (piece && piece.color === color) n++;
        }
        return n;
    }

    /** "b: 5-2 x 3-4 (K)" — enough for a move list, not standard notation. */
    notate(move, { captured, promoted }) {
        const piece = this.board[move.to.r][move.to.c];
        const sep = captured ? ' x ' : '-';
        return `${piece.color}: ${idOf(move.from.r, move.from.c)}${sep}${idOf(move.to.r, move.to.c)}${promoted ? ' (K)' : ''}`;
    }

    /** The whole picture the browser needs, in one object. */
    state() {
        const cells = [];
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                const piece = this.board[r][c];
                cells.push({
                    id: idOf(r, c),
                    row: r,
                    col: c,
                    dark: isDark(r, c),
                    playable: isDark(r, c),
                    piece: piece ? { kind: piece.king ? 'king' : 'man', color: piece.color } : null,
                });
            }
        }

        return {
            type: 'checkers',
            cells,
            turn: this.turn,
            legalMoves: this.legalMovesMap(),
            lastMove: this.lastMove,
            mustContinueFrom: this.mustContinueFrom
                ? idOf(this.mustContinueFrom.r, this.mustContinueFrom.c)
                : null,
            history: this.history.slice(-12),
            counts: { [BLACK]: this.countPieces(BLACK), [RED]: this.countPieces(RED) },
            over: Boolean(this.result),
            winner: this.result ? this.result.winner : null,
            statusText: this.statusText(),
        };
    }

    statusText() {
        if (this.result) {
            if (!this.result.winner) return `Draw — ${this.result.reason}`;
            const name = this.result.winner === BLACK ? 'Black' : 'Red';
            return `${name} wins — ${this.result.reason}`;
        }
        const name = this.turn === BLACK ? 'Black' : 'Red';
        if (this.mustContinueFrom) return `${name} must continue jumping`;
        return `${name} to move`;
    }
}

module.exports = {
    CheckersGame,
    // exported for the tests
    _internals: { initialBoard, movesForPiece, legalMoves, idOf, parseId, BLACK, RED, SIZE },
};
