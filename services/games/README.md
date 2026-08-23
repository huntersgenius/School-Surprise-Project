# /services/games — chess & checkers (the custom service)

Route: `/games` · Built from source · Compose service: `games`

This is the only bespoke software in the platform. Everything else is configuration of an
existing tool; nothing pre-built does "two students' moves synced live", so this had to be
written.

```
src/server.js              Express + Socket.io wiring, static hosting, health check
src/socket-handlers.js     the whole websocket protocol, documented at the top of the file
src/rooms.js               lobby, room codes, seats, disconnect grace, idle sweeping
src/games/chess-game.js    thin adapter over chess.js
src/games/checkers-game.js hand-written draughts rules  <- the only real game logic here
src/games/index.js         game registry — add a third game by adding one line
public/                    the browser app (lobby + board), no build step, no CDN
test/                      unit tests for checkers, end-to-end tests for the socket flow
```

## Running it

In the stack: `docker compose up -d games` then open `http://schoolhub.local/games/`.

Standalone, for development:

```bash
cd services/games
npm install
npm start                      # http://localhost:3000/games/
npm test                       # 17 tests, ~2s, no docker needed
```

`npm test` covers the things that are tedious to check by hand: mandatory captures, multi-jump
chains, kinging mid-chain, and the full two-client socket flow including a mid-game disconnect
and a seat being reclaimed after a refresh.

## How a game works

1. A player picks chess or checkers and creates a room → the server returns a **4-character
   code** (no I, O, 0 or 1, because these get read aloud across a classroom).
2. The second player enters the code and is seated. The game starts.
3. Every change broadcasts one `room:sync` with the **entire** room and board state. There is no
   incremental diffing: a board is tiny, and resending everything removes a whole class of
   desync bugs.
4. The server is the only authority on legality. The browser only ever displays what it's given
   and asks for moves; a tampered client can't make an illegal move.

The full event list is documented at the top of `src/socket-handlers.js`.

## Disconnects

A dropped connection does not end the game immediately — phones switch networks and laptops
sleep.

* The opponent is told **at once** (`opponent-disconnected`), so nobody stares at a frozen board
  wondering whose turn it is.
* The seat is held for `GAMES_DISCONNECT_GRACE_SECONDS` (default 90).
* Reconnecting or refreshing within that window reclaims the seat — the browser keeps a seat
  token in `sessionStorage` and replays it with `room:rejoin`.
* If nobody comes back, the game is awarded to the player still there.

## Known limitations

**Games are held in memory only.** Restarting the container ends every game in progress; the
players see "connection lost" and have to start again. This is accepted deliberately for now —
the alternative is another service to run and back up on a Pi, for games that last ten minutes.
`src/rooms.js` is the only file that would change if that stops being acceptable.

**No spectators, no clocks, no ratings, no draw offers.** Chess resignation isn't implemented
either — leaving the room ends the game in the opponent's favour, which is close enough for a
lunchtime game.

**No login.** Anyone on the school network can play, and names are self-declared (sanitised
server-side, but not verified). See the open question below.

## Open decision for you: should games require login?

Authelia already exists, so gating this route is one line in
`proxy/conf.d/locations/40-games.conf`:

```nginx
include /etc/nginx/snippets/authelia-authrequest.conf;
```

* **Leave it open** (current): zero friction, students play instantly, no account admin. Names
  are whatever anyone types, so "who was rude in a game" isn't answerable.
* **Require login**: real names attached to real accounts, which matters if games become a
  behaviour-management problem. Costs you an account per student to create and maintain.

Worth deciding after the pilot rather than now — it's a one-line change either way.

## Why the board UI isn't chessboard.js

chessboard.js needs jQuery plus a folder of piece images fetched at runtime. The entire premise
of this platform is that it works with no internet, so every asset has to be local, and a board
is an 8x8 grid of divs. `public/board.js` renders both games from Unicode glyphs and CSS
circles: no dependencies, nothing to download, and the checkers board is visibly a sibling of
the chess board rather than a different app. The socket.io browser client is served by the
service itself at `/games/socket.io/socket.io.js` — also not a CDN.
