# Game server + standalone HTML client

A small top-down game: explore a set of connected rooms, find a sword to
deal with three dragons, collect three colored keys to unlock their gates,
dodge a bat that steals whatever you're carrying, and bring a chalice home
to win. It also has one hidden secret that isn't documented here on
purpose — it's meant to be found by playing, not by reading this file.

The server is authoritative and runs the whole simulation (positions, AI,
win/lose state, the hidden stuff) at 20 updates/second over a WebSocket.
The HTML file is a thin renderer: open it, point it at your deployed
server, and play.

## What's in this folder

- `server.js` — Node/Express/`ws` game server (one isolated world per connection)
- `public/game.html` — the game client (also served automatically at the
  server's root URL)
- `package.json`, `railway.json` — deployment config
- `game.html` (in the outputs folder alongside this one) — the same client
  file, provided separately so it's easy to just hand someone a single file

## Deploy the server to Railway

1. Push this folder to a GitHub repo (or use the Railway CLI: `railway init`
   then `railway up` from inside this folder).
2. In Railway, create a new project from that repo (or from the CLI upload).
   Railway detects Node via Nixpacks, runs `npm install`, then
   `node server.js` (see `railway.json`).
3. Railway sets `PORT` automatically — the server already reads
   `process.env.PORT`, so no config is needed there.
4. Once deployed, open the generated `*.up.railway.app` URL in a browser —
   the server serves the game directly, so you can play right there.

## Using the standalone HTML download

You don't have to rely on visiting the Railway URL. Take `game.html` and
just double-click it to open it in a browser — no server needed to view
it, only to play:

1. On the boot screen, paste your Railway address as a **WebSocket** URL:
   `wss://your-app-name.up.railway.app` (use `wss://`, not `https://`).
2. Click **Connect**. Once the world loads, controls are:
   - **Move:** Arrow keys or WASD
   - **Pick up / put down:** Space bar (only one thing at a time)
   - **Restart the world:** R

If someone opens the file straight from the server (visiting the Railway
URL), it fills in and connects to that same server automatically.

## Notes on the design

- Each WebSocket connection gets its own private world.
- Dragons are permanently dealt with once touched while carrying the
  sword; touching one empty-handed resets the whole world.
- A key only needs to reach its gate once (carried there, or dropped and
  left behind) — after that, the gate stays open for the rest of that
  world.
- The in-game map is generated automatically from the room graph using a
  small force-directed layout, so it isn't hand-drawn.
- There is more to this than the visible rooms and gates. If you're
  looking at this file to find it: don't — it's intentionally left out of
  the docs. Play instead.

## Local testing

```
npm install
node server.js
# visit http://localhost:3000
```
