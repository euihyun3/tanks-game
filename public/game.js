// ===== canvas setup: low-res offscreen world, chunky 2x blit to visible canvas =====
const canvas = document.getElementById('game');
const vctx = canvas.getContext('2d');
canvas.style.imageRendering = 'pixelated'; // defensive; style.css also sets this
const statusEl = document.getElementById('status');
const helpEl = document.querySelector('.help');

let W = 1000, H = 600;   // world size (server units == visible canvas px)
const SCALE = 2;         // world px per low-res px
let LW = W / SCALE, LH = H / SCALE;

const off = document.createElement('canvas');
const ctx = off.getContext('2d');           // low-res world buffer
const tCan = document.createElement('canvas');
const tctx = tCan.getContext('2d');         // pre-rendered terrain buffer

let terrain = null;
let latestState = null;
let serverMode = null;   // authoritative mode from the server's welcome
let roomCode = null;     // room code assigned by the server's welcome

function sizeBuffers() {
  LW = Math.round(W / SCALE);
  LH = Math.round(H / SCALE);
  off.width = LW;
  off.height = LH;
  tCan.width = LW;
  tCan.height = LH;
  // resizing a canvas resets its context state, so re-assert the pixel look
  ctx.imageSmoothingEnabled = false;
  tctx.imageSmoothingEnabled = false;
  if (terrain) renderTerrain();
}
sizeBuffers();

// physics constants mirrored from the server for the aim-preview arc
const GRAVITY = 260;
const TANK_RADIUS = 11;
const BARREL_LEN = TANK_RADIUS + 14;
const MIN_POWER = 220;
const MAX_POWER = 620;
const MG_POWER = 520; // mg has no charge; flies at fixed power
const MOVE_BUDGET = 150; // classic: world px of driving allowed per turn

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// HTTP and WebSocket share one port now (works locally and on cloud hosts)
const WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

const WEAPONS = ['basic', 'tnt', 'scatter', 'flame', 'mg'];
const WEAPON_LABELS = { basic: 'BASIC', tnt: 'TNT', scatter: 'SCATTER', flame: 'FLAME', mg: 'MG' };
const CRATE_COLORS = { tnt: '#d4552a', scatter: '#4a8fd4', flame: '#ff9631', mg: '#e8d84a' };

// ===== local players (1 or 2 on this device, each with its own websocket) =====
const locals = [];
function makeLocal(slot, name, color) {
  return {
    slot, name, color,
    id: null,
    ws: null,
    input: { left: false, right: false, up: false, down: false, space: false },
    ammoTotal: null,     // for pickup sound detection
    sndCharging: false,  // whether we started a charge sound
  };
}

function getPlayer(local) {
  if (!latestState || local.id === null) return null;
  return latestState.players.find((p) => p.id === local.id) || null;
}

function localTag(id) {
  if (locals.length === 2) {
    if (locals[0].id === id) return ' (P1)';
    if (locals[1].id === id) return ' (P2)';
  } else if (locals[0] && locals[0].id === id) {
    return ' (you)';
  }
  return '';
}

function modeTag() {
  return serverMode ? '[' + serverMode.toUpperCase() + '] ' : '';
}

function isClassic() {
  return serverMode !== 'chaos';
}

// Which classic turn phase applies to this player, or null when phases don't
// apply to them (chaos, someone else's turn, round over). Solo practice keeps
// the old "do whatever you like" behaviour, reported as 'aim'.
function classicPhase(id) {
  if (!latestState || !isClassic() || latestState.winner) return null;
  if (latestState.playerCount < 2) return 'aim';
  if (latestState.currentTurn !== id) return null;
  const ph = latestState.turnPhase;
  return ph === 'move' || ph === 'firing' ? ph : 'aim';
}

// keys this local player uses, for phase hints (differs in 2-on-1-device mode)
function keysFor(local) {
  if (locals.length === 2 && local.slot === 0) {
    return { lr: 'A/D', ud: 'W/S', fire: 'F' };
  }
  return { lr: '←/→', ud: '↑/↓', fire: 'SPACE' };
}

function phaseHint(local, ph) {
  if (ph === 'firing') return 'SHELL IN FLIGHT';
  const k = keysFor(local);
  if (ph === 'move') return 'MOVE — ' + k.lr + ' DRIVE, ' + k.fire + ' WHEN DONE';
  return 'AIM — ' + k.ud + ' ANGLE, ' + k.lr + ' POWER, ' + k.fire + ' FIRE';
}

// ===== join screen =====
const overlayEl = document.getElementById('join-overlay');
const joinForm = document.getElementById('join-panel');
const name1Input = document.getElementById('join-name');
const name2Input = document.getElementById('join-name2');
const p2Extra = document.getElementById('p2-extra');

let chosenMode = 'classic';
let localCount = 1;
const selectedColors = ['#7a8b3f', '#5d7a8c'];

const PALETTE = [
  ['#7a8b3f', 'Olive'], ['#5d7a8c', 'Field gray'], ['#b0803f', 'Desert tan'],
  ['#7d5a5a', 'Maroon'], ['#46606e', 'Navy'], ['#55613a', 'Dark olive'],
];

function wireSwatchRow(rowEl, idx) {
  const swatches = Array.from(rowEl.querySelectorAll('.swatch'));
  const custom = rowEl.querySelector('input[type=color]');
  for (const sw of swatches) {
    sw.addEventListener('click', () => {
      selectedColors[idx] = sw.dataset.color;
      custom.value = sw.dataset.color;
      custom.classList.remove('selected');
      swatches.forEach((s) => s.classList.toggle('selected', s === sw));
    });
  }
  custom.addEventListener('input', () => {
    selectedColors[idx] = custom.value;
    swatches.forEach((s) => s.classList.remove('selected'));
    custom.classList.add('selected');
  });
}
wireSwatchRow(document.getElementById('swatch-row1'), 0);

// second swatch row is generated dynamically
(function buildSwatchRow2() {
  const row = document.getElementById('swatch-row2');
  for (const pair of PALETTE) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (pair[0] === selectedColors[1] ? ' selected' : '');
    btn.dataset.color = pair[0];
    btn.style.background = pair[0];
    btn.title = pair[1];
    row.appendChild(btn);
  }
  const label = document.createElement('span');
  label.className = 'swatch-label';
  label.textContent = 'custom';
  row.appendChild(label);
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'custom-color';
  custom.value = selectedColors[1];
  custom.title = 'Custom color';
  row.appendChild(custom);
  wireSwatchRow(row, 1);
})();

// mode picker
const modeBtns = {
  classic: document.getElementById('mode-classic'),
  chaos: document.getElementById('mode-chaos'),
};
for (const m of ['classic', 'chaos']) {
  modeBtns[m].addEventListener('click', () => {
    chosenMode = m;
    modeBtns.classic.classList.toggle('selected', m === 'classic');
    modeBtns.chaos.classList.toggle('selected', m === 'chaos');
  });
}

// room picker: create a fresh room or join by code
const roomNewBtn = document.getElementById('room-new');
const roomJoinBtn = document.getElementById('room-join');
const roomCodeInput = document.getElementById('room-code');
let roomChoice = 'new';

function setRoomChoice(choice) {
  roomChoice = choice;
  roomNewBtn.classList.toggle('selected', choice === 'new');
  roomJoinBtn.classList.toggle('selected', choice === 'join');
  roomCodeInput.style.display = choice === 'join' ? '' : 'none';
  if (choice === 'join') roomCodeInput.focus();
}
roomNewBtn.addEventListener('click', () => setRoomChoice('new'));
roomJoinBtn.addEventListener('click', () => setRoomChoice('join'));

// ?room=ABCD in the URL preselects join-with-code (shareable invite links)
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  roomCodeInput.value = urlRoom.toUpperCase().slice(0, 8);
  setRoomChoice('join');
}

// players-on-this-device picker
const pcBtns = Array.from(document.querySelectorAll('#pc-row .opt-btn'));
for (const btn of pcBtns) {
  btn.addEventListener('click', () => {
    localCount = parseInt(btn.dataset.pc, 10);
    pcBtns.forEach((b) => b.classList.toggle('selected', b === btn));
    p2Extra.style.display = localCount === 2 ? 'flex' : 'none';
  });
}

function setHelpText() {
  const classic = (serverMode || chosenMode) !== 'chaos';
  const sep = ' &nbsp;|&nbsp; ';
  if (locals.length === 2) {
    helpEl.innerHTML = classic
      ? '<b>P1:</b> move <b>A/D</b>, <b>F</b> done &middot; aim <b>W/S</b> angle, <b>A/D</b> power, <b>F</b> fire &middot; <b>Q</b> wpn' + sep +
        '<b>P2:</b> move <b>&larr;/&rarr;</b>, <b>Space</b> done &middot; aim <b>&uarr;/&darr;</b> angle, <b>&larr;/&rarr;</b> power, <b>Space</b> fire &middot; <b>M</b> wpn'
      : '<b>P1:</b> W/A/S/D move+aim, <b>F</b> fire, <b>Q</b> weapon' + sep +
        '<b>P2:</b> Arrow keys move+aim, <b>Space</b> fire, <b>M</b> weapon';
  } else {
    helpEl.innerHTML = classic
      ? 'MOVE: <b>&larr;/&rarr;</b> drive, <b>Space</b> done' + sep +
        'AIM: <b>&uarr;/&darr;</b> angle, <b>&larr;/&rarr;</b> power, <b>Space</b> fire' + sep +
        'WASD too' + sep +
        'Weapon: <b>1-5</b> or <b>Q</b>'
      : 'Move: <b>A/D</b> or <b>&larr;/&rarr;</b>' + sep +
        'Aim: <b>W/S</b> or <b>&uarr;/&darr;</b>' + sep +
        'Fire: hold <b>Space</b>, release to shoot' + sep +
        'Weapon: <b>1-5</b> or <b>Q</b> to cycle';
  }
}

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (locals.length) return;
  if (window.SFX) SFX.init(); // unlock audio on this user gesture
  const n1 = name1Input.value.trim().slice(0, 12);
  locals.push(makeLocal(0, n1, selectedColors[0]));
  if (localCount === 2) {
    const n2 = name2Input.value.trim().slice(0, 12);
    locals.push(makeLocal(1, n2, selectedColors[1]));
  }
  buildKeymaps();
  setHelpText();
  overlayEl.style.display = 'none';
  statusEl.textContent = 'Connecting...';
  // P1 connects first; P2 (if any) joins P1's room once the welcome names it
  const requested = roomChoice === 'join' ? roomCodeInput.value.trim().toUpperCase() : '';
  connect(locals[0], requested);
});

function connect(local, room) {
  const sock = new WebSocket(WS_URL);
  local.ws = sock;

  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'join', name: local.name, color: local.color, mode: chosenMode, room: room || '' }));
    if (local.slot === 0) statusEl.textContent = 'Connected. Waiting for another player...';
  };
  sock.onclose = () => {
    if (local.slot === 0) statusEl.textContent = 'Disconnected from server.';
  };

  sock.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'welcome') {
      local.id = msg.id;
      local.color = msg.color;
      if (local.slot === 0) {
        roomCode = msg.room || null;
        if (locals[1] && !locals[1].ws) connect(locals[1], roomCode);
        serverMode = msg.mode || 'classic';
        setHelpText(); // the server is authoritative about the mode
        if (msg.width && (msg.width !== W || msg.height !== H)) {
          W = msg.width;
          H = msg.height;
          sizeBuffers();
        } else {
          W = msg.width || W;
          H = msg.height || H;
        }
        statusEl.textContent = modeTag() + 'Waiting for another player to join...';
      }
      return;
    }
    if (local.slot !== 0) return; // primary connection drives shared world state
    if (msg.type === 'terrain') {
      terrain = msg.terrain;
      renderTerrain();
    } else if (msg.type === 'state') {
      playStateSounds(msg);
      trackExplosions(msg.projectiles);
      latestState = msg;
      recordTrail(msg.projectiles);
      updateStatus(msg);
    }
  };
}

// ===== sounds: compare consecutive states to trigger effects =====
const snd = { projByKind: {}, turn: null, winner: null, fires: 0, lastMg: 0 };
function playStateSounds(msg) {
  if (!window.SFX) return;
  const byKind = {};
  for (const p of msg.projectiles) {
    const k = p.kind || 'basic';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  let addedMg = 0, addedOther = 0, removedOther = 0;
  const kinds = new Set(Object.keys(byKind).concat(Object.keys(snd.projByKind)));
  for (const k of kinds) {
    const d = (byKind[k] || 0) - (snd.projByKind[k] || 0);
    if (k === 'mg') {
      if (d > 0) addedMg = d;
    } else if (d > 0) {
      addedOther += d;
    } else {
      removedOther += -d;
    }
  }
  const now = performance.now();
  if (addedMg > 0 && SFX.mg && now - snd.lastMg >= 100) {
    SFX.mg();
    snd.lastMg = now;
  }
  if (addedOther > 2 && SFX.scatter) SFX.scatter();
  else if (addedOther > 0) SFX.fire();
  if (removedOther > 0) SFX.explosion(); // mg tracers vanish constantly; only boom for real shells

  const nFires = (msg.fires || []).length;
  if (nFires > 0 && snd.fires === 0 && SFX.flame) SFX.flame();

  // pickup: a LOCAL player's ammo total increased
  for (const local of locals) {
    const p = msg.players.find((pl) => pl.id === local.id);
    if (p && p.ammo) {
      const total = (p.ammo.tnt || 0) + (p.ammo.scatter || 0) + (p.ammo.flame || 0) + (p.ammo.mg || 0);
      if (local.ammoTotal !== null && total > local.ammoTotal && SFX.pickup) SFX.pickup();
      local.ammoTotal = total;
    }
  }

  if (msg.winner && !snd.winner) SFX.win();
  if (serverMode !== 'chaos' && !msg.winner && msg.playerCount >= 2) {
    const isLocalTurn = locals.some((l) => l.id === msg.currentTurn);
    if (isLocalTurn && snd.turn !== msg.currentTurn) SFX.turn();
  }
  snd.projByKind = byKind;
  snd.turn = msg.currentTurn;
  snd.winner = msg.winner;
  snd.fires = nFires;
}

function playerName(id) {
  const p = latestState && latestState.players.find((pl) => pl.id === id);
  return p && p.name ? p.name : 'Player ' + id;
}

function updateStatus(msg) {
  const tag = modeTag();
  if (msg.playerCount < 2) {
    statusEl.textContent = tag + 'Waiting for players — room code: ' + (roomCode || '...');
    statusEl.className = '';
    return;
  }
  if (msg.winner) {
    statusEl.textContent = '';
    return;
  }
  if (serverMode === 'chaos') {
    statusEl.textContent = tag + 'Free-for-all — fire at will!';
    statusEl.className = '';
    return;
  }
  // classic: phase drives the headline
  const ph = msg.turnPhase === 'move' || msg.turnPhase === 'firing' ? msg.turnPhase : 'aim';
  const mine = locals.find((l) => l.id === msg.currentTurn) || null;
  if (ph === 'firing') {
    statusEl.textContent = 'SHELL IN FLIGHT...';
    statusEl.className = '';
  } else if (mine) {
    const who = locals.length === 2
      ? playerName(msg.currentTurn) + localTag(msg.currentTurn)
      : 'YOUR TURN';
    statusEl.textContent = '🎯 ' + who + ': ' + phaseHint(mine, ph);
    statusEl.className = 'my-turn';
  } else {
    statusEl.textContent =
      playerName(msg.currentTurn) + "'s turn — " + (ph === 'move' ? 'driving' : 'aiming') + '...';
    statusEl.className = '';
  }
}

// ===== tracer trail: record shell positions, fade them out over time =====
const TRAIL_LIFE = 4000; // ms
let trail = [];

function recordTrail(projectiles) {
  const now = performance.now();
  for (const p of projectiles) {
    trail.push({ x: p.x, y: p.y, born: now });
  }
  trail = trail.filter((t) => now - t.born < TRAIL_LIFE);
}

// ===== explosion particles (client-side, spawned where projectiles vanish) =====
let prevProjs = null;
const particles = [];

function trackExplosions(projs) {
  const prev = prevProjs;
  prevProjs = projs.map((p) => ({ x: p.x, y: p.y, kind: p.kind }));
  if (!prev || projs.length >= prev.length) {
    if (!prev) return;
  }
  const used = new Array(projs.length).fill(false);
  for (const op of prev) {
    let best = -1;
    let bd = 90 * 90; // max match distance (world px, squared)
    for (let i = 0; i < projs.length; i++) {
      if (used[i] || projs[i].kind !== op.kind) continue;
      const dx = projs[i].x - op.x;
      const dy = projs[i].y - op.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) used[best] = true;
    else spawnExplosion(op.x, op.y, op.kind);
  }
}

function spawnExplosion(wx, wy, kind) {
  const now = performance.now();
  const big = kind === 'tnt';
  const count = kind === 'mg' ? 3 : big ? 18 : 10;
  const colors = ['#ffdd33', '#ff8822', '#cc4422', '#9a9a9a'];
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (big ? 30 : 20) + Math.random() * (big ? 70 : 45); // low-res px/s
    particles.push({
      x: wx / SCALE,
      y: wy / SCALE,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 15,
      size: kind === 'mg' ? 1 : 1 + Math.floor(Math.random() * 2),
      color: colors[Math.floor(Math.random() * colors.length)],
      born: now,
      ttl: 400 + Math.random() * 200,
    });
  }
}

function drawParticlesLow(now) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    const t = (now - pt.born) / pt.ttl;
    if (t >= 1) {
      particles.splice(i, 1);
      continue;
    }
    const sec = (now - pt.born) / 1000;
    ctx.globalAlpha = 1 - t;
    ctx.fillStyle = pt.color;
    ctx.fillRect(Math.round(pt.x + pt.vx * sec), Math.round(pt.y + pt.vy * sec), pt.size, pt.size);
  }
  ctx.globalAlpha = 1;
}

// ===== input =====
let keymaps = [];
let cycleKeys = {};

function buildKeymaps() {
  if (locals.length === 2) {
    keymaps = [
      { a: 'left', d: 'right', w: 'up', s: 'down', f: 'space' },
      { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', ' ': 'space' },
    ];
    cycleKeys = { q: 0, m: 1 };
  } else {
    keymaps = [{
      a: 'left', ArrowLeft: 'left',
      d: 'right', ArrowRight: 'right',
      w: 'up', ArrowUp: 'up',
      s: 'down', ArrowDown: 'down',
      ' ': 'space',
    }];
    cycleKeys = { q: 0 };
  }
}

function send(local) {
  if (local.ws && local.ws.readyState === WebSocket.OPEN) {
    local.ws.send(JSON.stringify(local.input));
  }
}

function sendWeapon(local, weapon) {
  if (local.ws && local.ws.readyState === WebSocket.OPEN) {
    local.ws.send(JSON.stringify({ type: 'weapon', weapon }));
  }
}

function cycleWeapon(local) {
  const p = getPlayer(local);
  if (!p) return;
  const idx = Math.max(0, WEAPONS.indexOf(p.weapon));
  for (let i = 1; i <= WEAPONS.length; i++) {
    const w = WEAPONS[(idx + i) % WEAPONS.length];
    if (w === 'basic' || (p.ammo && p.ammo[w] > 0)) {
      sendWeapon(local, w);
      return;
    }
  }
}

// whether the server will act on this local player's input right now
// (solo play, chaos, or their own turn while it still accepts input)
function canAct(local) {
  if (!latestState) return true;
  if (serverMode === 'chaos') return true;
  if (latestState.playerCount < 2) return true;
  if (latestState.currentTurn !== local.id) return false;
  const ph = latestState.turnPhase;
  return ph !== 'firing';
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  if (window.SFX) SFX.init();
  if (!locals.length) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // weapon selection keys
  if (locals.length === 1 && k >= '1' && k <= '5') {
    e.preventDefault();
    if (!e.repeat) sendWeapon(locals[0], WEAPONS[Number(k) - 1]);
    return;
  }
  if (k in cycleKeys) {
    e.preventDefault();
    if (!e.repeat) cycleWeapon(locals[cycleKeys[k]]);
    return;
  }

  for (let i = 0; i < locals.length; i++) {
    const action = keymaps[i][k];
    if (!action) continue;
    e.preventDefault();
    const local = locals[i];
    if (!local.input[action]) {
      local.input[action] = true;
      send(local);
      // charging only exists in chaos now; classic fires on the Space press
      if (action === 'space' && window.SFX && serverMode === 'chaos' && canAct(local)) {
        const p = getPlayer(local);
        if (!p || p.weapon !== 'mg') { // mg has no charge
          SFX.charge();
          local.sndCharging = true;
        }
      }
    }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  if (!locals.length) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (let i = 0; i < locals.length; i++) {
    const action = keymaps[i][k];
    if (!action) continue;
    e.preventDefault();
    const local = locals[i];
    local.input[action] = false;
    send(local);
    if (action === 'space' && local.sndCharging) {
      if (window.SFX) SFX.chargeStop();
      local.sndCharging = false;
    }
  }
});

// ===== rendering helpers =====
function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// terrain: quantized, banded, blocky — pre-rendered to tCan whenever terrain changes
const DIRT_TONES = ['#6b4a2f', '#5c3f27', '#4d3520'];
function renderTerrain() {
  if (!terrain) return;
  tctx.clearRect(0, 0, LW, LH);
  for (let lx = 0; lx < LW; lx++) {
    const wx = Math.min(terrain.length - 1, lx * SCALE);
    let ly = Math.round(terrain[wx] / SCALE);
    ly = Math.max(0, Math.floor(ly / 2) * 2); // quantize to 4-visible-px steps
    // chunky grass topline (2 low-res px = 4 visible px)
    tctx.fillStyle = '#57944a';
    tctx.fillRect(lx, ly, 1, 1);
    tctx.fillStyle = '#3f7d3f';
    tctx.fillRect(lx, ly + 1, 1, 1);
    // dirt banding below
    let y = ly + 2;
    while (y < LH) {
      const bandIdx = Math.floor(y / 6);
      const next = Math.min(LH, (bandIdx + 1) * 6);
      tctx.fillStyle = DIRT_TONES[bandIdx % DIRT_TONES.length];
      tctx.fillRect(lx, y, 1, next - y);
      y = next;
    }
  }
}

// ===== hull tilt: read the ground slope under the tank from the terrain array =====
const TILT_MAX = (35 * Math.PI) / 180;        // cliffs must not flip the tank over
const TILT_SPAN = 16;                         // world px each side: where the track ends sit
const TILT_STEP = (5 * Math.PI) / 180;        // quantized: chunky and jitter-free
const TILT_EASE = 0.25;                       // smoothing per frame
const tilts = new Map();                      // player id -> smoothed tilt (radians)

function groundAt(wx) {
  const i = Math.max(0, Math.min(terrain.length - 1, Math.round(wx)));
  return terrain[i];
}

// canvas y grows downward, so higher terrain value on the right == nose-down-right,
// which is exactly the sign ctx.rotate() wants.
function targetTilt(p) {
  if (!terrain || !terrain.length) return 0;
  const a = Math.atan2(groundAt(p.x + TILT_SPAN) - groundAt(p.x - TILT_SPAN), TILT_SPAN * 2);
  return Math.max(-TILT_MAX, Math.min(TILT_MAX, a));
}

function tankTilt(p) {
  const target = targetTilt(p);
  const prev = tilts.get(p.id);
  const next = prev === undefined ? target : prev + (target - prev) * TILT_EASE;
  tilts.set(p.id, next);
  return Math.round(next / TILT_STEP) * TILT_STEP;
}

// second bar above the tank: charge in chaos, move budget / power in classic
function tankBar(p) {
  if (!isClassic()) {
    if (!p.charging) return null;
    return { pct: clamp01((p.power - MIN_POWER) / (MAX_POWER - MIN_POWER)), color: '#ffdd33' };
  }
  const ph = classicPhase(p.id);
  if (ph === 'move') {
    const left = typeof p.moveLeft === 'number' ? p.moveLeft : MOVE_BUDGET;
    return { pct: clamp01(left / MOVE_BUDGET), color: '#5ad24a' };
  }
  if (ph === 'aim') {
    return { pct: clamp01((p.power - MIN_POWER) / (MAX_POWER - MIN_POWER)), color: '#ffdd33' };
  }
  return null;
}

// The tilted part of the tank is drawn into a tiny sprite buffer first, then
// blitted through ctx.rotate with smoothing off. Rotating fillRects directly
// antialiases every edge into mush; rotating a bitmap resamples it
// nearest-neighbour, which keeps the hard 8-bit pixel edges we want.
const sprCan = document.createElement('canvas');
sprCan.width = 24;
sprCan.height = 24;
const sctx = sprCan.getContext('2d');
sctx.imageSmoothingEnabled = false;
const SPR_C = 12; // sprite-space coords of the tank centre

// hull + tracks + turret, unrotated, centred at (SPR_C, SPR_C)
function paintHullSprite(body, dark, light) {
  sctx.clearRect(0, 0, 24, 24);
  sctx.setTransform(1, 0, 0, 1, SPR_C, SPR_C);

  // tracks
  sctx.fillStyle = '#2b2b22';
  sctx.fillRect(-8, 2, 16, 4);
  sctx.fillStyle = '#555555';
  for (let i = -7; i <= 5; i += 3) {
    sctx.fillRect(i, 3, 2, 1);
  }

  // hull
  sctx.fillStyle = body;
  sctx.fillRect(-7, -1, 14, 3);
  sctx.fillStyle = light;
  sctx.fillRect(-7, -1, 14, 1);

  // turret
  sctx.fillStyle = light;
  sctx.fillRect(-3, -4, 6, 3);
  sctx.fillStyle = dark;
  sctx.fillRect(-1, -5, 2, 1); // hatch

  sctx.setTransform(1, 0, 0, 1, 0, 0);
}

// rect-only 8-bit tank sprite (low-res coords), hull tilted onto the ground slope
const PIVOT_DY = -3; // turret/barrel pivot, in unrotated sprite space
function drawTankLow(p) {
  const x = Math.round(p.x / SCALE);
  const y = Math.round(p.y / SCALE);
  const body = p.alive ? p.color : '#4a4a4a';
  const dark = p.alive ? shade(p.color, 0.55) : '#2e2e2e';
  const light = p.alive ? shade(p.color, 1.25) : '#5a5a5a';
  const tilt = tankTilt(p);
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);

  // Barrel: drawn at the ABSOLUTE world angle — p.angle must read the same on
  // every slope — but its pivot rides along with the tilted turret.
  const rad = (p.angle * Math.PI) / 180;
  const px = x - PIVOT_DY * sin;
  const py = y + PIVOT_DY * cos;
  ctx.fillStyle = dark;
  for (let i = 3; i <= 12; i++) {
    const bx = Math.round(px + i * Math.cos(rad));
    const by = Math.round(py - i * Math.sin(rad));
    ctx.fillRect(bx - 1, by - 1, 2, 2);
  }

  // hull + tracks + turret body: these follow the slope
  paintHullSprite(body, dark, light);
  ctx.save();
  ctx.imageSmoothingEnabled = false; // chunky nearest-neighbour rotation
  ctx.translate(x, y);
  if (tilt) ctx.rotate(tilt);
  ctx.drawImage(sprCan, -SPR_C, -SPR_C);
  ctx.restore();

  if (!p.alive) return;

  // hp bar — always level, never tilted
  ctx.fillStyle = '#000000';
  ctx.fillRect(x - 7, y - 14, 14, 3);
  ctx.fillStyle = p.hp > 40 ? '#4caf50' : '#e53935';
  ctx.fillRect(x - 7, y - 14, Math.max(0, Math.round(14 * (p.hp / 100))), 3);

  // move / power / charge bar — also level
  const bar = tankBar(p);
  if (bar) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(x - 7, y - 10, 14, 3);
    ctx.fillStyle = bar.color;
    ctx.fillRect(x - 7, y - 10, Math.max(0, Math.round(14 * bar.pct)), 3);
  }
}

// One preview dot: bright core inside a dark 1px outline, so it stays readable
// over both the light-blue sky and the brown dirt. 4x4 low-res = 8x8 visible px.
function drawPreviewDot(wx, wy) {
  const lx = Math.round(wx / SCALE);
  const ly = Math.round(wy / SCALE);
  ctx.fillStyle = '#14100a';
  ctx.fillRect(lx - 1, ly - 1, 4, 4);
  ctx.fillStyle = '#fff45c';
  ctx.fillRect(lx, ly, 2, 2);
}

// dotted preview arc, chunky low-res dots — plotted only up to the APEX
function drawAimPreview(p, power) {
  if (!terrain || !terrain.length) return;
  const rad = (p.angle * Math.PI) / 180;
  let x = p.x + BARREL_LEN * Math.cos(rad);
  let y = p.y - BARREL_LEN * Math.sin(rad);
  const vx = power * Math.cos(rad);
  let vy = -power * Math.sin(rad);
  const dt = 0.045;

  for (let i = 0; i < 120; i++) {
    const rising = vy <= 0; // y grows downward, so negative vy == climbing
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;
    if (x < 0 || x > W || y > H) break;             // left the map
    const tx = Math.max(0, Math.min(terrain.length - 1, Math.round(x)));
    if (y >= terrain[tx]) break;                    // hit dirt before the apex
    const apex = rising && vy >= 0;                 // stopped climbing: this is the top
    if (i % 2 === 0 || apex) drawPreviewDot(x, y);
    if (apex) break;                                // never plot the descending half
  }
}

function drawAimPreviews() {
  for (const local of locals) {
    const p = getPlayer(local);
    if (!p || !p.alive) continue;
    if (isClassic()) {
      // no charging in classic: the preview is simply up for the whole aim phase
      if (classicPhase(p.id) === 'aim') {
        drawAimPreview(p, p.weapon === 'mg' ? MG_POWER : p.power);
      }
    } else if (p.charging) {
      drawAimPreview(p, p.power);
    } else if (p.weapon === 'mg' && local.input.space && canAct(local)) {
      drawAimPreview(p, MG_POWER);
    }
  }
}

function drawTrailLow(now) {
  for (const t of trail) {
    const age = (now - t.born) / TRAIL_LIFE;
    if (age >= 1) continue;
    ctx.fillStyle = 'rgba(60, 60, 60, ' + (0.7 * (1 - age)).toFixed(3) + ')';
    ctx.fillRect(Math.round(t.x / SCALE), Math.round(t.y / SCALE), 1, 1);
  }
}

function drawCratesLow() {
  for (const c of latestState.crates || []) {
    const x = Math.round(c.x / SCALE);
    const y = Math.round(c.y / SCALE);
    ctx.fillStyle = '#2f2213';
    ctx.fillRect(x - 2, y - 2, 5, 5); // 10 visible px
    ctx.fillStyle = CRATE_COLORS[c.kind] || '#c9a55a';
    ctx.fillRect(x - 1, y - 1, 3, 3);
  }
}

const FIRE_COLORS = ['#ff5522', '#ff8822', '#ffdd33'];
function drawFiresLow() {
  for (const f of latestState.fires || []) {
    const x = Math.round(f.x / SCALE);
    const y = Math.round(f.y / SCALE);
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = FIRE_COLORS[Math.floor(Math.random() * FIRE_COLORS.length)];
      const s = 1 + Math.floor(Math.random() * 2);
      ctx.fillRect(x - 2 + Math.floor(Math.random() * 4), y - 2 - Math.floor(Math.random() * 3), s, s);
    }
  }
}

function drawProjectilesLow() {
  for (const proj of latestState.projectiles) {
    const x = Math.round(proj.x / SCALE);
    const y = Math.round(proj.y / SCALE);
    if (proj.kind === 'tnt') {
      ctx.fillStyle = '#8b3a1e';
      ctx.fillRect(x - 1, y - 1, 3, 3);
    } else if (proj.kind === 'scatter') {
      ctx.fillStyle = '#33302a';
      ctx.fillRect(x, y, 1, 1);
    } else if (proj.kind === 'flame') {
      ctx.fillStyle = '#ff8822';
      ctx.fillRect(x - 1, y - 1, 2, 2);
      ctx.fillStyle = Math.random() < 0.5 ? '#ffdd33' : '#ff5522';
      ctx.fillRect(x - 2 + Math.floor(Math.random() * 3), y - 1 + Math.floor(Math.random() * 3), 1, 1);
    } else if (proj.kind === 'mg') {
      ctx.fillStyle = '#ffee55';
      ctx.fillRect(x, y, 1, 1);
    } else {
      ctx.fillStyle = '#222222';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
}

// ===== hi-res overlay (text pass on the visible canvas) =====
// classic phase row at the bottom of a player's HUD panel: MOVE budget / POWER
function drawPhaseRow(x, baseY, w, p) {
  const ph = classicPhase(p.id);
  vctx.font = 'bold 11px "Courier New", monospace';
  if (ph === null) {
    vctx.fillStyle = '#5a5a5a';
    vctx.fillText('WAIT', x, baseY);
    return;
  }
  if (ph === 'firing') {
    vctx.fillStyle = '#ff9631';
    vctx.fillText('FIRING', x, baseY);
    return;
  }
  const move = ph === 'move';
  const color = move ? '#5ad24a' : '#ffdd33';
  const pct = move
    ? clamp01((typeof p.moveLeft === 'number' ? p.moveLeft : MOVE_BUDGET) / MOVE_BUDGET)
    : clamp01((p.power - MIN_POWER) / (MAX_POWER - MIN_POWER));
  vctx.fillStyle = color;
  vctx.fillText(move ? 'MOVE' : 'PWR', x, baseY);
  const bx = x + 34;
  const bw = Math.max(10, w - 34);
  const by = baseY - 8;
  const bh = 9;
  vctx.fillStyle = '#000000';
  vctx.fillRect(bx, by, bw, bh);
  vctx.strokeStyle = color;
  vctx.lineWidth = 1;
  vctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  vctx.fillStyle = color;
  vctx.fillRect(bx + 2, by + 2, Math.round((bw - 4) * pct), bh - 4);
}

function drawHud() {
  const lineH = 14;
  const pad = 8;
  const panelW = 132;
  const classic = isClassic();
  for (const local of locals) {
    const p = getPlayer(local);
    if (!p) continue;
    const panelH = pad * 2 + lineH * (WEAPONS.length + 1 + (classic ? 1 : 0));
    const x = local.slot === 0 ? 10 : W - 10 - panelW;
    const y = H - 10 - panelH;

    vctx.fillStyle = 'rgba(10, 12, 8, 0.72)';
    vctx.fillRect(x, y, panelW, panelH);
    vctx.strokeStyle = p.color;
    vctx.lineWidth = 2;
    vctx.strokeRect(x + 1, y + 1, panelW - 2, panelH - 2);

    vctx.textAlign = 'left';
    vctx.font = 'bold 11px "Courier New", monospace';
    vctx.fillStyle = p.color;
    const header = (locals.length === 2 ? 'P' + (local.slot + 1) + ' ' : '') + (p.name || 'Player ' + p.id).toUpperCase();
    vctx.fillText(header.slice(0, 15), x + pad, y + pad + 9);

    vctx.font = 'bold 12px "Courier New", monospace';
    for (let i = 0; i < WEAPONS.length; i++) {
      const w = WEAPONS[i];
      const ammo = w === 'basic' ? -1 : (p.ammo ? p.ammo[w] || 0 : 0);
      const current = p.weapon === w;
      const keyTxt = locals.length === 1 ? (i + 1) + ' ' : '';
      const ammoTxt = ammo < 0 ? '' : ' x' + ammo;
      vctx.fillStyle = current ? '#ffdd33' : (ammo === 0 ? '#5a5a5a' : '#e8e4d0');
      vctx.fillText((current ? '>' : ' ') + keyTxt + WEAPON_LABELS[w] + ammoTxt, x + pad, y + pad + 9 + lineH * (i + 1));
    }
    if (classic) {
      drawPhaseRow(x + pad, y + pad + 9 + lineH * (WEAPONS.length + 1), panelW - pad * 2, p);
    }
    vctx.textAlign = 'center';
  }
}

// big, unmissable "whose turn / which phase" banner across the top (classic only)
function drawPhaseBanner() {
  if (!latestState || !isClassic()) return;
  if (latestState.winner || latestState.playerCount < 2) return;
  const p = latestState.players.find((pl) => pl.id === latestState.currentTurn);
  if (!p) return;
  const ph = latestState.turnPhase === 'move' || latestState.turnPhase === 'firing'
    ? latestState.turnPhase : 'aim';
  const mine = locals.find((l) => l.id === latestState.currentTurn) || null;
  let text;
  if (ph === 'firing') {
    text = 'SHELL IN FLIGHT';
  } else if (mine) {
    const who = locals.length === 2 ? 'P' + (mine.slot + 1) + ': ' : 'YOUR TURN: ';
    text = who + phaseHint(mine, ph);
  } else {
    text = ((p.name || 'PLAYER ' + p.id).toUpperCase()) + ' — ' + (ph === 'move' ? 'DRIVING' : 'AIMING');
  }
  vctx.font = 'bold 14px "Courier New", monospace';
  vctx.textAlign = 'center';
  const bw = vctx.measureText(text).width + 24;
  vctx.fillStyle = 'rgba(10, 12, 8, 0.72)';
  vctx.fillRect(Math.round(W / 2 - bw / 2), 6, Math.round(bw), 24);
  vctx.strokeStyle = mine ? '#ffdd33' : '#4a5238';
  vctx.lineWidth = 2;
  vctx.strokeRect(Math.round(W / 2 - bw / 2) + 1, 7, Math.round(bw) - 2, 22);
  vctx.fillStyle = mine ? '#ffdd33' : '#cdd6a3';
  vctx.fillText(text, W / 2, 23);
}

function drawHiRes() {
  vctx.textAlign = 'center';
  if (latestState) {
    // name labels + death markers (level, above the smaller tanks)
    for (const p of latestState.players) {
      const tag = localTag(p.id);
      vctx.font = 'bold 13px "Courier New", monospace';
      vctx.fillStyle = tag ? '#ffdd33' : '#f5f0dc';
      const label = ((p.name || 'Player ' + p.id) + tag).toUpperCase();
      vctx.fillText(label, p.x, p.y - 32);
      if (!p.alive) {
        vctx.font = '16px system-ui, sans-serif';
        vctx.fillText('💥', p.x, p.y - 14);
      }
    }

    // crate letters
    vctx.font = 'bold 9px "Courier New", monospace';
    vctx.fillStyle = '#14100a';
    for (const c of latestState.crates || []) {
      if (!c.kind) continue;
      vctx.fillText(c.kind[0].toUpperCase(), c.x, c.y + 3);
    }

    drawHud();
    drawPhaseBanner();

    if (latestState.winner) {
      vctx.fillStyle = 'rgba(0,0,0,0.6)';
      vctx.fillRect(0, H / 2 - 40, W, 80);
      vctx.fillStyle = '#ffffff';
      vctx.font = 'bold 28px "Courier New", monospace';
      const text = latestState.winner === 'draw'
        ? 'DRAW! NEW ROUND STARTING...'
        : (playerName(latestState.winner) + localTag(latestState.winner)).toUpperCase() + ' WINS! NEW ROUND STARTING...';
      vctx.fillText(text, W / 2, H / 2 + 10);
    }
  }

  // server mode + room badges
  if (serverMode) {
    vctx.font = 'bold 12px "Courier New", monospace';
    vctx.textAlign = 'right';
    vctx.fillStyle = '#20506b';
    vctx.fillText(serverMode.toUpperCase() + ' MODE', W - 10, 18);
    if (roomCode) {
      vctx.fillStyle = '#1a4258';
      vctx.fillText('ROOM ' + roomCode, W - 10, 34);
    }
    vctx.textAlign = 'center';
  }
}

// ===== main loop =====
function draw() {
  const now = performance.now();

  // low-res world pass
  ctx.fillStyle = '#7ec8e3';
  ctx.fillRect(0, 0, LW, LH);
  if (terrain) ctx.drawImage(tCan, 0, 0);
  drawTrailLow(now);
  if (latestState) {
    drawCratesLow();
    drawFiresLow();
    drawAimPreviews();
    // keep the tilt-smoothing cache from growing over a long session
    if (tilts.size > 16) tilts.clear();
    for (const p of latestState.players) drawTankLow(p);
    drawProjectilesLow();
  }
  drawParticlesLow(now);

  // chunky blit
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(off, 0, 0, LW, LH, 0, 0, canvas.width, canvas.height);

  // hi-res text pass
  drawHiRes();

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
