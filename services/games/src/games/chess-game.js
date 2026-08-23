'use strict';

/**
 * Chess — a thin adapter over chess.js.
 *
 * Deliberately thin: chess.js already knows castling, en passant, promotion,
 * threefold repetition, insufficient material and the fifty-move rule. Every
 * one of those is a bug waiting to happen if hand-rolled, which is exactly why
 * PROJECT_PLAN.md says not to. All this file does is present the same shape of
 * state() / legalMovesMap() / move() that the checkers engine does, so the room
 * and socket layers never care which game they're running.
 */

const { Chess } = require('chess.js');

const WHITE = 'w';
const BLACK = 'b';

// Unicode is enough for a board UI and needs no image assets — which matters
// on a platform whose whole point is working with no internet.
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

class ChessGame {
    constructor() {
        this.reset();
    }

    reset() {
        this.chess = new Chess();
        this.lastMove = null;
    }

    static get type() { return 'chess'; }
    get type() { return 'chess'; }

    get seats() {
        return [
            { id: WHITE, label: 'White', hint: 'moves first, plays from the bottom' },
            { id: BLACK, label: 'Black', hint: 'plays from the top' },
        ];
    }

    get turn() {
        return this.chess.turn();
    }

    /** { "e2": ["e3", "e4"], ... } */
    legalMovesMap() {
        const map = {};
        if (this.chess.isGameOver()) return map;
        for (const move of this.chess.moves({ verbose: true })) {
            const list = (map[move.from] ||= []);
            // A promotion shows up four times (q/r/b/n) with the same to-square.
            if (!list.includes(move.to)) list.push(move.to);
        }
        return map;
    }

    /**
     * Squares where the mover has to pick a promotion piece, as "from:to"
     * strings. The browser uses this to know when to show the piece chooser
     * instead of guessing from the piece type and rank itself.
     */
    promotionMoves() {
        if (this.chess.isGameOver()) return [];
        return [
            ...new Set(
                this.chess
                    .moves({ verbose: true })
                    .filter((m) => m.promotion)
                    .map((m) => `${m.from}:${m.to}`),
            ),
        ];
    }

    /** Never throws: the arguments come off a websocket. */
    move({ from, to, promotion }) {
        if (this.chess.isGameOver()) return { ok: false, error: 'The game is already over.' };
        try {
            const played = this.chess.move({ from, to, promotion: promotion || 'q' });
            this.lastMove = { from: played.from, to: played.to };
            return { ok: true };
        } catch (err) {
            // chess.js 1.x throws on an illegal move rather than returning null.
            return { ok: false, error: 'That is not a legal move.' };
        }
    }

    state() {
        // chess.js gives rank 8 first, which is already the order we draw in.
        const cells = [];
        this.chess.board().forEach((rankRow, row) => {
            rankRow.forEach((square, col) => {
                const file = 'abcdefgh'[col];
                const rank = 8 - row;
                cells.push({
                    id: `${file}${rank}`,
                    row,
                    col,
                    dark: (row + col) % 2 === 1,
                    playable: true,
                    piece: square
                        ? { kind: PIECE_NAMES[square.type], type: square.type, color: square.color }
                        : null,
                });
            });
        });

        return {
            type: 'chess',
            cells,
            turn: this.chess.turn(),
            legalMoves: this.legalMovesMap(),
            promotionMoves: this.promotionMoves(),
            lastMove: this.lastMove,
            mustContinueFrom: null,
            check: this.chess.inCheck(),
            history: this.chess.history().slice(-12),
            fen: this.chess.fen(),
            over: this.chess.isGameOver(),
            winner: this.winner(),
            statusText: this.statusText(),
        };
    }

    winner() {
        if (!this.chess.isCheckmate()) return null;
        // The side to move is the one that got mated.
        return this.chess.turn() === WHITE ? BLACK : WHITE;
    }

    statusText() {
        const mover = this.chess.turn() === WHITE ? 'White' : 'Black';
        const other = this.chess.turn() === WHITE ? 'Black' : 'White';

        if (this.chess.isCheckmate()) return `${other} wins by checkmate`;
        if (this.chess.isStalemate()) return 'Draw — stalemate';
        if (this.chess.isInsufficientMaterial()) return 'Draw — not enough pieces to mate';
        if (this.chess.isThreefoldRepetition()) return 'Draw — threefold repetition';
        if (this.chess.isDraw()) return 'Draw — fifty-move rule';
        if (this.chess.inCheck()) return `${mover} to move — in check`;
        return `${mover} to move`;
    }
}

module.exports = { ChessGame };
