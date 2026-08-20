/* ---------------------------------------------------------------------------
 * SchoolHub games — browser app.
 *
 * The server is the only authority: this file never decides whether a move is
 * legal, it just shows what the server sent and asks for moves. Every update
 * arrives as a full "room:sync" snapshot.
 * ------------------------------------------------------------------------- */

(function () {
    'use strict';

    const config = window.GAMES_CONFIG || { socketPath: '/games/socket.io', games: [] };
    const STORAGE_KEY = 'schoolhub.games.session';

    const el = (id) => document.getElementById(id);
    const ui = {
        connection: el('connection'),
        lobby: el('screen-lobby'),
        game: el('screen-game'),
        name: el('input-name'),
        code: el('input-code'),
        create: el('btn-create'),
        join: el('btn-join'),
        lobbyError: el('lobby-error'),
        roomCode: el('room-code'),
        copyCode: el('btn-copy-code'),
        rematch: el('btn-rematch'),
        leave: el('btn-leave'),
        status: el('status'),
        notice: el('notice'),
        board: el('board'),
        players: el('players'),
        history: el('history'),
        promotion: el('promotion'),
        tagline: el('tagline'),
    };

    /** Everything the client knows. `me` survives a page reload; the rest doesn't. */
    const app = {
        me: loadSession(),      // {code, token, name, seat} or null
        room: null,
        game: null,
        selected: null,
        targets: [],
        noticeTimer: null,
    };

    // ---- session persistence ------------------------------------------------
    // A refresh, a phone locking, or a flaky WiFi drop shouldn't cost you your
    // seat: the token in sessionStorage is what lets the server give it back.

    function loadSession() {
        try {
            return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
        } catch (err) {
            return null;
        }
    }

    function saveSession(me) {
        app.me = me;
        if (me) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(me));
        else sessionStorage.removeItem(STORAGE_KEY);
    }

    // ---- socket -------------------------------------------------------------

    const socket = io({
        path: config.socketPath,
        transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => {
        setConnection('online', 'connected');
        // Reclaim a seat after a reconnect or a refresh.
        if (app.me && app.me.code && app.me.token) {
            socket.emit('room:rejoin', { code: app.me.code, token: app.me.token }, (res) => {
                if (res && res.ok) {
                    enterGame(res);
                } else {
                    saveSession(null);
                    showLobby();
                }
            });
        }
    });

    socket.on('disconnect', () => setConnection('offline', 'reconnecting…'));
    socket.io.on('reconnect_attempt', () => setConnection('connecting', 'reconnecting…'));

    socket.on('room:sync', (payload) => {
        app.room = payload.room;
        app.game = payload.game;
        // A move by either player invalidates whatever was selected.
        app.selected = null;
        app.targets = [];
        renderGame();
    });

    socket.on('room:notice', (payload) => showNotice(payload.text, payload.type));

    function setConnection(state, label) {
        ui.connection.className = `conn conn--${state}`;
        ui.connection.querySelector('.conn__label').textContent = label;
    }

    // ---- lobby --------------------------------------------------------------

    function selectedGameType() {
        const checked = document.querySelector('input[name="gameType"]:checked');
        return checked ? checked.value : 'chess';
    }

    function lobbyError(message) {
        ui.lobbyError.textContent = message;
        ui.lobbyError.hidden = !message;
    }

    ui.create.addEventListener('click', () => {
        lobbyError('');
        ui.create.disabled = true;
        socket.emit(
            'room:create',
            { gameType: selectedGameType(), name: ui.name.value },
            (res) => {
                ui.create.disabled = false;
                if (!res || !res.ok) return lobbyError((res && res.error) || 'Could not create the room.');
                enterGame(res);
            },
        );
    });

    ui.join.addEventListener('click', () => {
        const code = (ui.code.value || '').trim().toUpperCase();
        lobbyError('');
        if (code.length < 4) return lobbyError('Enter the four-letter room code.');

        ui.join.disabled = true;
        socket.emit('room:join', { code, name: ui.name.value }, (res) => {
            ui.join.disabled = false;
            if (!res || !res.ok) return lobbyError((res && res.error) || 'Could not join that room.');
            enterGame(res);
        });
    });

    ui.code.addEventListener('input', () => {
        ui.code.value = ui.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    ui.code.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') ui.join.click();
    });

    ui.name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') ui.create.click();
    });

    // ---- entering / leaving a game -----------------------------------------

    function enterGame(res) {
        app.room = res.room;
        app.game = res.game;
        saveSession({
            code: res.room.code,
            token: res.you.token,
            name: res.you.name,
            seat: res.you.seat,
        });
        showGame();
        renderGame();
    }

    ui.leave.addEventListener('click', () => {
        socket.emit('room:leave', {}, () => {});
        saveSession(null);
        app.room = null;
        app.game = null;
        showLobby();
    });

    ui.rematch.addEventListener('click', () => {
        socket.emit('game:rematch', {}, (res) => {
            if (res && !res.ok) showNotice(res.error, 'error');
        });
    });

    ui.copyCode.addEventListener('click', async () => {
        const code = app.room ? app.room.code : '';
        if (!code) return;
        try {
            await navigator.clipboard.writeText(code);
            showNotice(`Copied ${code} — give it to your opponent.`, 'info');
        } catch (err) {
            // clipboard access needs https on some browsers; the code is on
            // screen anyway, so this is a nicety, not a failure.
            showNotice(`Room code: ${code}`, 'info');
        }
    });

    function showLobby() {
        ui.lobby.hidden = false;
        ui.game.hidden = true;
        lobbyError('');
    }

    function showGame() {
        ui.lobby.hidden = true;
        ui.game.hidden = false;
    }

    // ---- rendering ----------------------------------------------------------

    function mySeat() {
        return app.me ? app.me.seat : null;
    }

    function renderGame() {
        if (!app.room || !app.game) return;

        ui.roomCode.textContent = app.room.code;
        ui.tagline.textContent = `${app.room.gameLabel} — room ${app.room.code}`;

        // status line
        if (app.room.status === 'waiting') {
            ui.status.textContent = 'Waiting for someone to join with your room code…';
            ui.status.className = 'status status--waiting';
        } else if (app.room.status === 'finished' && app.room.result) {
            ui.status.textContent = resultText(app.room.result);
            ui.status.className = 'status status--over';
        } else {
            const yours = app.game.turn === mySeat();
            ui.status.textContent = yours ? `Your move — ${app.game.statusText}` : app.game.statusText;
            ui.status.className = `status${yours ? ' status--yours' : ''}`;
        }

        ui.rematch.hidden = app.room.status !== 'finished';
        const me = app.room.players.find((p) => p.seat === mySeat());
        if (me && me.wantsRematch) {
            ui.rematch.textContent = 'Rematch offered…';
            ui.rematch.disabled = true;
        } else {
            ui.rematch.textContent = 'Rematch';
            ui.rematch.disabled = false;
        }

        renderPlayers();
        renderHistory();

        window.SchoolHubBoard.renderBoard(ui.board, app.game, {
            mySeat: mySeat(),
            selected: app.selected,
            targets: app.targets,
            onSelect: onSquareClick,
        });
    }

    function resultText(result) {
        if (!result.winner) return result.reason || 'Game over';
        const winner = app.room.players.find((p) => p.seat === result.winner);
        const who = result.winner === mySeat() ? 'You win' : `${winner && winner.name ? winner.name : 'Your opponent'} wins`;
        return `${who} — ${result.reason}`;
    }

    function renderPlayers() {
        ui.players.replaceChildren(
            ...app.room.players.map((player) => {
                const li = document.createElement('li');
                li.className = 'player';
                if (player.seat === app.game.turn && app.room.status === 'playing') {
                    li.classList.add('player--turn');
                }
                if (player.seat === mySeat()) li.classList.add('player--me');

                const dot = document.createElement('span');
                dot.className = `player__seat player__seat--${player.seat}`;
                li.appendChild(dot);

                const name = document.createElement('span');
                name.className = 'player__name';
                name.textContent = player.name
                    ? player.name + (player.seat === mySeat() ? ' (you)' : '')
                    : 'waiting for a player…';
                li.appendChild(name);

                const status = document.createElement('span');
                status.className = 'player__status';
                if (player.name && !player.connected) {
                    status.textContent = 'disconnected';
                    status.classList.add('is-offline');
                } else {
                    status.textContent = player.label;
                }
                li.appendChild(status);

                return li;
            }),
        );
    }

    function renderHistory() {
        const moves = (app.game.history || []).slice().reverse();
        ui.history.replaceChildren(
            ...moves.map((move) => {
                const li = document.createElement('li');
                li.textContent = move;
                return li;
            }),
        );
    }

    function showNotice(text, type) {
        if (!text) return;
        ui.notice.textContent = text;
        ui.notice.className = `notice notice--${type || 'info'}`;
        ui.notice.hidden = false;
        clearTimeout(app.noticeTimer);
        app.noticeTimer = setTimeout(() => {
            ui.notice.hidden = true;
        }, 6000);
    }

    // ---- moving -------------------------------------------------------------

    function onSquareClick(squareId) {
        if (!app.game || app.room.status !== 'playing') return;
        if (app.game.turn !== mySeat()) return showNotice("It isn't your turn yet.", 'info');

        // Second click: a legal destination -> send the move.
        if (app.selected && app.targets.includes(squareId)) {
            return sendMove(app.selected, squareId);
        }

        // First click (or re-selecting): pick a piece that actually has moves.
        const targets = (app.game.legalMoves || {})[squareId];
        if (targets && targets.length) {
            app.selected = squareId;
            app.targets = targets;
        } else {
            app.selected = null;
            app.targets = [];
        }
        renderGame();
    }

    function sendMove(from, to) {
        const needsPromotion = (app.game.promotionMoves || []).includes(`${from}:${to}`);
        if (needsPromotion) return askPromotion(from, to);
        emitMove(from, to, null);
    }

    function emitMove(from, to, promotion) {
        socket.emit('game:move', { from, to, promotion }, (res) => {
            if (res && !res.ok) showNotice(res.error, 'error');
        });
        app.selected = null;
        app.targets = [];
    }

    function askPromotion(from, to) {
        ui.promotion.hidden = false;
        const choose = (event) => {
            const button = event.target.closest('.promo');
            if (!button) return;
            cleanup();
            emitMove(from, to, button.dataset.piece);
        };
        const cancel = (event) => {
            if (event.target === ui.promotion) {
                cleanup();
                renderGame();
            }
        };
        function cleanup() {
            ui.promotion.hidden = true;
            ui.promotion.removeEventListener('click', choose);
            ui.promotion.removeEventListener('click', cancel);
        }
        ui.promotion.addEventListener('click', choose);
        ui.promotion.addEventListener('click', cancel);
    }

    // ---- boot ---------------------------------------------------------------

    // Remember the player's name between visits — one less thing to type.
    const savedName = localStorage.getItem('schoolhub.games.name');
    if (savedName) ui.name.value = savedName;
    ui.name.addEventListener('change', () => {
        localStorage.setItem('schoolhub.games.name', ui.name.value.trim().slice(0, 24));
    });

    showLobby();
})();
