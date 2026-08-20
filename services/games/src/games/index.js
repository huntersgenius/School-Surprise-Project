'use strict';

/**
 * The game registry. Adding a third game (draughts variants, gomoku, reversi)
 * means writing one class with the same four members the two below have —
 * seats, legalMovesMap(), move(), state() — and adding it here. Nothing in the
 * room, socket or browser layers needs to change.
 */

const { ChessGame } = require('./chess-game');
const { CheckersGame } = require('./checkers-game');

const GAMES = {
    chess: { label: 'Chess', Game: ChessGame },
    checkers: { label: 'Checkers', Game: CheckersGame },
};

const GAME_TYPES = Object.keys(GAMES);

function isValidGameType(type) {
    return Object.prototype.hasOwnProperty.call(GAMES, type);
}

function createGame(type) {
    if (!isValidGameType(type)) throw new Error(`unknown game type: ${type}`);
    return new GAMES[type].Game();
}

function gameLabel(type) {
    return isValidGameType(type) ? GAMES[type].label : type;
}

module.exports = { GAMES, GAME_TYPES, isValidGameType, createGame, gameLabel };
