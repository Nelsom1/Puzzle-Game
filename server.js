// server.js
// A small top-down world with dragons, keys, castles, a bridge, a bat, and
// a chalice you must carry home -- plus one hidden secret.
//
// Architecture: every WebSocket connection gets its own isolated, single-
// player world. The server is authoritative: it owns positions, AI, and
// win/lose state, and streams snapshots to the client at 20Hz. The client
// is a dumb renderer.

const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_W = 800;
const ROOM_H = 500;
const TICK_MS = 50; // 20Hz
const TOUCH_DIST = 34;
const PLAYER_SPEED = 6.5;
const DRAGON_SPEED = 1.6;

// ---------------------------------------------------------------------------
// World graph. Each room has up to four exits (N/E/S/W). An exit may carry a
// `lock` -- a key type that must be (or have been) present in `gateRoom` for
// the passage to open. Once unlocked, a passage stays open permanently.
// ---------------------------------------------------------------------------
const ROOMS = {
  r0: { name: 'Forest Clearing', exits: { E: 'r1', N: 'r4' } },
  r1: { name: 'Winding Path', exits: { W: 'r0', E: 'r2', S: 'r5' } },
  r2: { name: 'Yellow Gate Approach', exits: { W: 'r1', N: { to: 'r14', lock: 'yellowKey', gateRoom: 'r2' } } },
  r4: { name: 'Northern Woods', exits: { S: 'r0', E: 'r6', N: 'r7' } },
  r5: { name: 'River Bank', exits: { N: 'r1', E: 'r9', W: { to: 'r8', lock: 'bridge', gateRoom: 'r5' } } },
  r6: { name: 'Dead End Grove', exits: { W: 'r4', S: 'r9', E: { to: 'r_egg', lock: 'dot', gateRoom: 'r6', hidden: true } } },
  r7: { name: "Yellow Dragon's Lair", exits: { S: 'r4', E: 'r10' } },
  r8: { name: 'Marsh', exits: { E: { to: 'r5', lock: 'bridge', gateRoom: 'r5' }, S: 'r11' } },
  r9: { name: 'Crossroads', exits: { W: 'r5', N: 'r6', E: 'r12' } },
  r10: { name: "Green Dragon's Woods", exits: { W: 'r7', S: 'r12' } },
  r11: { name: 'Copper Gate Approach', exits: { N: 'r8', E: { to: 'r15', lock: 'whiteKey', gateRoom: 'r11' }, S: 'r12' } },
  r12: { name: 'Central Plain', exits: { W: 'r9', N: 'r10', S: 'r11', E: 'r13' } },
  r13: { name: "Black Dragon's Pass", exits: { W: 'r12', N: { to: 'r16', lock: 'blackKey', gateRoom: 'r13' } } },
  r14: { name: 'Yellow Castle - Great Hall', exits: { S: 'r2' } },
  r15: { name: 'Copper Castle - Great Hall', exits: { W: 'r11' } },
  r16: { name: 'Black Castle - Great Hall', exits: { S: 'r13' } },
  r_egg: { name: 'Hidden Chamber', exits: { W: 'r6' } },
};

// Resolve exits into a normalized { to, lock, gateRoom } shape.
for (const room of Object.values(ROOMS)) {
  for (const dir of Object.keys(room.exits)) {
    const e = room.exits[dir];
    room.exits[dir] = typeof e === 'string' ? { to: e, lock: null, gateRoom: null } : e;
  }
}

const ITEM_START = {
  sword: { room: 'r4', x: 220, y: 160 },
  bridge: { room: 'r1', x: 620, y: 360 },
  yellowKey: { room: 'r6', x: 400, y: 250 },
  whiteKey: { room: 'r10', x: 240, y: 150 },
  blackKey: { room: 'r9', x: 400, y: 250 },
  chalice: { room: 'r16', x: 400, y: 360 },
  dot: { room: 'r12', x: 68, y: 68 },
};

const DRAGON_START = {
  yellow: { room: 'r7', x: 400, y: 250 },
  green: { room: 'r10', x: 560, y: 350 },
  black1: { room: 'r13', x: 400, y: 150 },
  black2: { room: 'r16', x: 400, y: 150 },
};

const START_ROOM = 'r0';
const WIN_ROOM = 'r14';

const SECRET_ROOM = 'r_egg';
const SECRET_LINES = ['MOST OF THE YEAR,', 'PROBABLY AROUND 7 MONTHS.'];

// Build the metadata for one room. By default, exits flagged `hidden` are
// left out entirely -- the client shouldn't even know they exist until
// they're discovered. Pass includeHidden=true once a hidden exit should be
// revealed to the client (see the `reveal` message below).
function buildRoomMeta(id, includeHidden = false) {
  const room = ROOMS[id];
  const exits = {};
  for (const [dir, e] of Object.entries(room.exits)) {
    if (e.hidden && !includeHidden) continue;
    exits[dir] = { to: e.to, lock: e.lock };
  }
  return { name: room.name, exits };
}

// Static room metadata sent once to the client at connection time. The
// secret room is left out entirely until it's found.
const ROOM_META = {};
for (const id of Object.keys(ROOMS)) {
  if (id === SECRET_ROOM) continue;
  ROOM_META[id] = buildRoomMeta(id);
}

function freshWorld() {
  const items = {};
  for (const [type, pos] of Object.entries(ITEM_START)) {
    items[type] = { type, room: pos.room, x: pos.x, y: pos.y, carried: false };
  }
  const dragons = {};
  for (const [id, pos] of Object.entries(DRAGON_START)) {
    const color = id.startsWith('yellow') ? 'yellow' : id.startsWith('green') ? 'green' : 'black';
    dragons[id] = {
      id, color, room: pos.room, x: pos.x, y: pos.y,
      alive: true, vx: (Math.random() - 0.5), vy: (Math.random() - 0.5),
    };
  }
  return {
    player: { room: START_ROOM, x: 400, y: 250, carrying: null, facing: 'S' },
    items,
    dragons,
    bat: { room: 'r12', x: 400, y: 250, tx: 400, ty: 250, carrying: null, hopAt: Date.now() + 4000 },
    unlocks: { yellowKey: false, whiteKey: false, blackKey: false, bridge: false, dot: false },
    won: false,
    lost: false,
    lastEvent: null,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

function itemAt(world, room, notCarried = true) {
  return Object.values(world.items).find(it => it.room === room && (!notCarried || !it.carried));
}

function updateUnlocks(world) {
  for (const room of Object.values(ROOMS)) {
    for (const exit of Object.values(room.exits)) {
      if (!exit.lock || world.unlocks[exit.lock]) continue;
      const gateRoom = exit.gateRoom;
      const item = world.items[exit.lock];
      const presentAsGround = item.room === gateRoom && !item.carried;
      const presentInHand = world.player.room === gateRoom && world.player.carrying === exit.lock;
      if (presentAsGround || presentInHand) {
        world.unlocks[exit.lock] = true;
        world.lastEvent = `The ${labelForLock(exit.lock)} unlocks a gate somewhere nearby...`;
      }
    }
  }
}

function labelForLock(lock) {
  return { yellowKey: 'yellow key', whiteKey: 'copper key', blackKey: 'black key', bridge: 'bridge', dot: 'tiny speck' }[lock] || lock;
}

function canPass(world, exit) {
  if (!exit.lock) return true;
  return !!world.unlocks[exit.lock];
}

function applyMovement(world, input) {
  const p = world.player;
  if (world.won || world.lost) return;
  let dx = 0, dy = 0;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  if (dx === 0 && dy === 0) return;
  const len = Math.hypot(dx, dy) || 1;
  dx = (dx / len) * PLAYER_SPEED;
  dy = (dy / len) * PLAYER_SPEED;
  if (Math.abs(dx) > Math.abs(dy)) p.facing = dx > 0 ? 'E' : 'W';
  else if (dy !== 0) p.facing = dy > 0 ? 'S' : 'N';

  let nx = p.x + dx;
  let ny = p.y + dy;
  const room = ROOMS[p.room];

  // Check for exit crossing at the four edges.
  if (ny < 10 && room.exits.N && canPass(world, room.exits.N)) {
    p.room = room.exits.N.to; ny = ROOM_H - 30; nx = clamp(nx, 30, ROOM_W - 30);
    world.player.x = nx; world.player.y = ny; syncCarriedItem(world); return;
  }
  if (ny > ROOM_H - 10 && room.exits.S && canPass(world, room.exits.S)) {
    p.room = room.exits.S.to; ny = 30; nx = clamp(nx, 30, ROOM_W - 30);
    world.player.x = nx; world.player.y = ny; syncCarriedItem(world); return;
  }
  if (nx < 10 && room.exits.W && canPass(world, room.exits.W)) {
    p.room = room.exits.W.to; nx = ROOM_W - 30; ny = clamp(ny, 30, ROOM_H - 30);
    world.player.x = nx; world.player.y = ny; syncCarriedItem(world); return;
  }
  if (nx > ROOM_W - 10 && room.exits.E && canPass(world, room.exits.E)) {
    p.room = room.exits.E.to; nx = 30; ny = clamp(ny, 30, ROOM_H - 30);
    world.player.x = nx; world.player.y = ny; syncCarriedItem(world); return;
  }

  p.x = clamp(nx, 12, ROOM_W - 12);
  p.y = clamp(ny, 12, ROOM_H - 12);
  syncCarriedItem(world);
}

function syncCarriedItem(world) {
  if (world.player.carrying) {
    const it = world.items[world.player.carrying];
    it.room = world.player.room; it.x = world.player.x; it.y = world.player.y;
  }
}

function handleAction(world, action) {
  if (world.won || world.lost) return;
  const p = world.player;
  if (action === 'toggleCarry') {
    if (p.carrying) {
      world.items[p.carrying].carried = false;
      world.lastEvent = `You set down the ${labelFor(p.carrying)}.`;
      p.carrying = null;
    } else {
      const candidates = Object.values(world.items).filter(it => it.room === p.room && !it.carried);
      let nearest = null, nearestDist = Infinity;
      for (const it of candidates) {
        const d = dist(p.x, p.y, it.x, it.y);
        if (d < TOUCH_DIST && d < nearestDist) { nearest = it; nearestDist = d; }
      }
      if (nearest) {
        nearest.carried = true;
        p.carrying = nearest.type;
        world.lastEvent = `You pick up the ${labelFor(nearest.type)}.`;
      }
    }
  }
}

function labelFor(type) {
  return {
    sword: 'sword', bridge: 'bridge', yellowKey: 'yellow key',
    whiteKey: 'copper key', blackKey: 'black key', chalice: 'chalice',
    dot: 'tiny speck',
  }[type] || type;
}

function updateDragons(world) {
  for (const d of Object.values(world.dragons)) {
    if (!d.alive) continue;
    if (Math.random() < 0.03) { d.vx = (Math.random() - 0.5) * 2; d.vy = (Math.random() - 0.5) * 2; }
    let nx = d.x + d.vx * DRAGON_SPEED;
    let ny = d.y + d.vy * DRAGON_SPEED;
    if (nx < 60 || nx > ROOM_W - 60) d.vx *= -1;
    if (ny < 60 || ny > ROOM_H - 60) d.vy *= -1;
    d.x = clamp(nx, 60, ROOM_W - 60);
    d.y = clamp(ny, 60, ROOM_H - 60);

    if (d.room === world.player.room && dist(d.x, d.y, world.player.x, world.player.y) < TOUCH_DIST) {
      if (world.player.carrying === 'sword') {
        d.alive = false;
        world.lastEvent = `You slay the ${d.color} dragon with your sword!`;
      } else {
        world.lost = true;
        world.lastEvent = `The ${d.color} dragon catches you. You have been eaten!`;
      }
    }
  }
}

function updateBat(world) {
  const bat = world.bat;
  const now = Date.now();
  if (now >= bat.hopAt) {
    const roomIds = Object.keys(ROOMS).filter(id => id !== SECRET_ROOM);
    bat.room = roomIds[Math.floor(Math.random() * roomIds.length)];
    bat.x = 60 + Math.random() * (ROOM_W - 120);
    bat.y = 60 + Math.random() * (ROOM_H - 120);
    bat.hopAt = now + 3000 + Math.random() * 4000;

    // Chance to relocate whatever it's carrying.
    if (bat.carrying) {
      const it = world.items[bat.carrying];
      it.room = bat.room; it.x = bat.x; it.y = bat.y; it.carried = false;
      world.lastEvent = `A bat drops the ${labelFor(bat.carrying)} in the ${ROOMS[bat.room].name}!`;
      bat.carrying = null;
    } else {
      // Maybe grab something loose in the new room (not the sword the
      // player is actively holding -- only ground items, and never mid-air
      // from the player's hands, to keep this fair). The chalice is exempt:
      // it's the item that gates the win condition, and losing it to random
      // bat luck could let a player skip the black-key challenge entirely.
      const ground = itemAt(world, bat.room);
      if (ground && ground.type !== 'chalice' && Math.random() < 0.35) {
        ground.carried = true;
        bat.carrying = ground.type;
        world.lastEvent = `A bat snatches the ${labelFor(ground.type)}!`;
      }
    }
  } else {
    // small local jitter
    bat.x = clamp(bat.x + (Math.random() - 0.5) * 6, 40, ROOM_W - 40);
    bat.y = clamp(bat.y + (Math.random() - 0.5) * 6, 40, ROOM_H - 40);
  }
}

function checkWin(world) {
  if (world.won || world.lost) return;
  if (world.player.room === WIN_ROOM && world.player.carrying === 'chalice') {
    world.won = true;
    world.lastEvent = 'You return the chalice to the Yellow Castle. You win!';
  }
}

function snapshot(world) {
  return {
    player: world.player,
    items: Object.fromEntries(
      Object.entries(world.items)
        .filter(([, v]) => v.room === world.player.room)
        .map(([k, v]) => [k, { type: v.type, room: v.room, x: v.x, y: v.y, carried: v.carried }])
    ),
    dragons: Object.fromEntries(Object.entries(world.dragons).map(([k, v]) => [k, { room: v.room, x: v.x, y: v.y, alive: v.alive, color: v.color }])),
    bat: { room: world.bat.room, x: world.bat.x, y: world.bat.y, carrying: world.bat.carrying },
    unlocks: world.unlocks,
    won: world.won,
    lost: world.lost,
    event: world.lastEvent,
    secret: world.player.room === SECRET_ROOM ? { lines: SECRET_LINES } : null,
  };
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket wiring
// ---------------------------------------------------------------------------
const app = express();
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'game.html')));
app.get('/game.html', (req, res) => res.sendFile(path.join(__dirname, 'game.html')));
app.get('/health', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let world = freshWorld();
  let revealed = false;
  const input = { up: false, down: false, left: false, right: false };

  ws.send(JSON.stringify({ type: 'init', rooms: ROOM_META, roomSize: { w: ROOM_W, h: ROOM_H }, startRoom: START_ROOM, winRoom: WIN_ROOM }));

  const timer = setInterval(() => {
    applyMovement(world, input);
    updateUnlocks(world);
    updateDragons(world);
    updateBat(world);
    checkWin(world);

    if (world.unlocks.dot && !revealed) {
      revealed = true;
      ws.send(JSON.stringify({
        type: 'reveal',
        room: SECRET_ROOM,
        meta: buildRoomMeta(SECRET_ROOM),
        patch: { room: 'r6', exits: buildRoomMeta('r6', true).exits },
      }));
    }

    try {
      ws.send(JSON.stringify({ type: 'state', payload: snapshot(world) }));
    } catch (e) { /* socket likely closing */ }
    world.lastEvent = null;
  }, TICK_MS);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'input') {
      input.up = !!msg.keys.up; input.down = !!msg.keys.down;
      input.left = !!msg.keys.left; input.right = !!msg.keys.right;
    } else if (msg.type === 'action') {
      handleAction(world, msg.action);
    } else if (msg.type === 'reset') {
      world = freshWorld();
      revealed = false;
    }
  });

  ws.on('close', () => clearInterval(timer));
});

server.listen(PORT, () => {
  console.log(`Game server listening on port ${PORT}`);
});
