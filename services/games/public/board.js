/* ---------------------------------------------------------------------------
 * Board renderer — shared by chess and checkers.
 *
 * WHY NOT chessboard.js: it needs jQuery plus a folder of piece images fetched
 * at runtime. This platform's entire premise is "works with no internet", and
 * a board is an 8x8 grid of divs. Unicode chess glyphs and CSS circles need no
 * assets at all, render identically on a phone and a school desktop, and let
 * both games share one renderer — which is why the checkers board looks like a
 * sibling of the chess board rather than a bolted-on second app.
 *
 * The whole board is re-rendered on every update. 64 divs is nothing, and it
 * removes any chance of the DOM drifting out of sync with the server.
 * ------------------------------------------------------------------------- */

(function (global) {
    'use strict';

    const CHESS_GLYPHS = {
        king: '♚',
        queen: '♛',
        rook: '♜',
        bishop: '♝',
        knight: '♞',
        pawn: '♟',
    };

    const FILES = 'abcdefgh';

    /**
     * @param {HTMLElement} container
     * @param {object} state        the game state object from the server
     * @param {object} options
     * @param {string|null} options.mySeat      which side the viewer is playing
     * @param {string|null} options.selected    currently selected square id
     * @param {string[]} options.targets        legal destinations for it
     * @param {(id: string) => void} options.onSelect
     */
    function renderBoard(container, state, options = {}) {
        const { mySeat = null, selected = null, targets = [], onSelect = () => {} } = options;

        // Chess is drawn from White's side by default, checkers from Red's
        // (both are the side that starts at the bottom). Flip for the other
        // player so your own pieces are always nearest to you.
        const bottomSeat = state.type === 'chess' ? 'w' : 'r';
        const flipped = Boolean(mySeat) && mySeat !== bottomSeat;

        const cells = state.cells.slice().sort((a, b) =>
            flipped ? b.row - a.row || b.col - a.col : a.row - b.row || a.col - b.col,
        );

        const lastFrom = state.lastMove ? state.lastMove.from : null;
        const lastTo = state.lastMove ? state.lastMove.to : null;
        const targetSet = new Set(targets);
        const movable = new Set(Object.keys(state.legalMoves || {}));
        const yourTurn = mySeat && state.turn === mySeat && !state.over;

        container.className = `board board--${state.type}${flipped ? ' board--flipped' : ''}`;
        container.setAttribute('role', 'grid');
        container.setAttribute('aria-label', `${state.type} board`);

        const frag = document.createDocumentFragment();

        cells.forEach((cell, index) => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `sq ${cell.dark ? 'sq--dark' : 'sq--light'}`;
            el.dataset.square = cell.id;
            el.setAttribute('role', 'gridcell');

            if (cell.id === selected) el.classList.add('is-selected');
            if (cell.id === lastFrom || cell.id === lastTo) el.classList.add('is-last');
            if (targetSet.has(cell.id)) {
                el.classList.add(cell.piece ? 'is-capture' : 'is-target');
            }
            if (yourTurn && movable.has(cell.id)) el.classList.add('is-movable');
            if (state.mustContinueFrom === cell.id) el.classList.add('is-chaining');

            // Checkers is only played on the dark squares; the light ones are
            // scenery and shouldn't look clickable.
            const inert = cell.playable === false || (!yourTurn && !cell.piece);
            if (inert && !targetSet.has(cell.id)) el.tabIndex = -1;

            if (cell.piece) {
                el.appendChild(renderPiece(state.type, cell.piece));
            } else if (targetSet.has(cell.id)) {
                // A real element rather than ::after, so it can coexist with
                // the file/rank labels drawn by the pseudo-elements.
                const dot = document.createElement('span');
                dot.className = 'dot';
                el.appendChild(dot);
            }

            // Edge labels (chess only): file letters along the bottom row,
            // rank numbers up the left-hand column, drawn by CSS.
            if (state.type === 'chess') {
                if (Math.floor(index / 8) === 7) el.dataset.file = FILES[cell.col];
                if (index % 8 === 0) el.dataset.rank = String(8 - cell.row);
            }

            el.setAttribute('aria-label', describeCell(state.type, cell));
            el.addEventListener('click', () => onSelect(cell.id));
            frag.appendChild(el);
        });

        container.replaceChildren(frag);
    }

    function renderPiece(gameType, piece) {
        const el = document.createElement('span');

        if (gameType === 'chess') {
            el.className = `piece piece--chess piece--${piece.color === 'w' ? 'white' : 'black'}`;
            el.textContent = CHESS_GLYPHS[piece.kind] || '?';
            return el;
        }

        el.className = `piece piece--checker piece--${piece.color === 'b' ? 'black' : 'red'}`;
        if (piece.kind === 'king') {
            el.classList.add('piece--king');
            const crown = document.createElement('span');
            crown.className = 'crown';
            crown.textContent = '★'; // ★
            el.appendChild(crown);
        }
        return el;
    }

    function describeCell(gameType, cell) {
        if (!cell.piece) return `${cell.id} empty`;
        if (gameType === 'chess') {
            const colour = cell.piece.color === 'w' ? 'white' : 'black';
            return `${cell.id} ${colour} ${cell.piece.kind}`;
        }
        const colour = cell.piece.color === 'b' ? 'black' : 'red';
        return `${cell.id} ${colour} ${cell.piece.kind}`;
    }

    global.SchoolHubBoard = { renderBoard };
})(window);
