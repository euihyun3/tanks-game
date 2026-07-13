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
  if (terrain) renderTerrain();
}
sizeBuffers();

// physics constants mirrored from the server for the aim-preview arc
const GRAVITY = 260;
const TANK_RADIUS = 16;
const BARREL_LEN = TANK_RADIUS + 14;
const MIN_POWER = 220;
const MAX_POWER = 620;
const MG_POWER = 520; // mg has no charge; flies at fixed power

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
  if (locals.length === 2) {
    helpEl.innerHTML =
      '<b>P1:</b> W/A/S/D move+aim, <b>F</b> fire, <b>Q</b> weapon &nbsp;|&nbsp; ' +
      '<b>P2:</b> Arrow keys move+aim, <b>Space</b> fire, <b>M</b> weapon';
  } else {
    helpEl.innerHTML =
      'Move: <b>A/D</b> or <b>&larr;/&rarr;</b> &nbsp;|&nbsp; ' +
      'Aim: <b>W/S</b> or <b>&uarr;/&darr;</b> &nbsp;|&nbsp; ' +
      'Fire: hold <b>Space</b>, release to shoot &nbsp;|&nbsp; ' +
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
  } else if (msg.winner) {
    statusEl.textContent = '';
  } else if (serverMode === 'chaos') {
    statusEl.textContent = tag + 'Free-for-all — fire at will!';
    statusEl.className = '';
  } else if (msg.turnPhase === 'firing') {
    statusEl.textContent = 'Shell in flight...';
    statusEl.className = '';
  } else if (localTag(msg.currentTurn)) {
    const who = locals.length === 2
      ? playerName(msg.currentTurn) + localTag(msg.currentTurn) + ' — move, aim, fire!'
      : 'YOUR TURN — move, aim, fire!';
    statusEl.textContent = '🎯 ' + who;
    statusEl.className = 'my-turn';
  } else {
    statusEl.textContent = playerName(msg.currentTurn) + "'s turn...";
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

// whether this local player may act right now (solo play, chaos, or own turn)
function canAct(local) {
  if (!latestState) return true;
  if (serverMode === 'chaos') return true;
  if (latestState.playerCount < 2) return true;
  return latestState.currentTurn === local.id && latestState.turnPhase === 'aim';
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
      if (action === 'space' && window.SFX && canAct(local)) {
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

// rect-only 8-bit tank sprite (low-res coords)
function drawTankLow(p) {
  const x = Math.round(p.x / SCALE);
  const y = Math.round(p.y / SCALE);
  const body = p.alive ? p.color : '#4a4a4a';
  const dark = p.alive ? shade(p.color, 0.55) : '#2e2e2e';
  const light = p.alive ? shade(p.color, 1.25) : '#5a5a5a';

  // barrel: thick pixel line at the aim angle (behind the turret)
  const rad = (p.angle * Math.PI) / 180;
  ctx.fillStyle = dark;
  for (let i = 4; i <= 15; i++) {
    const bx = Math.round(x + i * Math.cos(rad));
    const by = Math.round(y - 4 - i * Math.sin(rad));
    ctx.fillRect(bx - 1, by - 1, 2, 2);
  }

  // tracks
  ctx.fillStyle = '#2b2b22';
  ctx.fillRect(x - 12, y + 3, 24, 6);
  ctx.fillStyle = '#555555';
  for (let i = -10; i <= 8; i += 4) {
    ctx.fillRect(x + i, y + 5, 2, 2);
  }

  // hull
  ctx.fillStyle = body;
  ctx.fillRect(x - 10, y - 2, 20, 5);
  ctx.fillStyle = light;
  ctx.fillRect(x - 10, y - 2, 20, 1);

  // turret
  ctx.fillStyle = light;
  ctx.fillRect(x - 4, y - 7, 8, 5);
  ctx.fillStyle = dark;
  ctx.fillRect(x - 1, y - 8, 3, 1); // hatch

  if (!p.alive) return;

  // hp bar
  ctx.fillStyle = '#000000';
  ctx.fillRect(x - 10, y - 22, 20, 3);
  ctx.fillStyle = p.hp > 40 ? '#4caf50' : '#e53935';
  ctx.fillRect(x - 10, y - 22, Math.max(0, Math.round(20 * (p.hp / 100))), 3);

  // charge bar
  if (p.charging) {
    const pct = Math.min(1, (p.power - MIN_POWER) / (MAX_POWER - MIN_POWER));
    ctx.fillStyle = '#000000';
    ctx.fillRect(x - 10, y - 17, 20, 3);
    ctx.fillStyle = '#ffdd33';
    ctx.fillRect(x - 10, y - 17, Math.round(20 * pct), 3);
  }
}

// dotted preview arc, chunky low-res dots
function drawAimPreview(p, power) {
  if (!terrain) return;
  const rad = (p.angle * Math.PI) / 180;
  let x = p.x + BARREL_LEN * Math.cos(rad);
  let y = p.y - BARREL_LEN * Math.sin(rad);
  let vx = power * Math.cos(rad);
  let vy = -power * Math.sin(rad);
  const dt = 0.045;

  ctx.fillStyle = 'rgba(255, 221, 51, 0.85)';
  for (let i = 0; i < 70; i++) {
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;
    if (x < 0 || x > W || y > H) break;
    const tx = Math.max(0, Math.min(W, Math.round(x)));
    if (y >= terrain[tx]) break;
    if (i % 2 === 0) {
      ctx.fillRect(Math.round(x / SCALE), Math.round(y / SCALE), 1, 1);
    }
  }
}

function drawAimPreviews() {
  for (const local of locals) {
    const p = getPlayer(local);
    if (!p || !p.alive) continue;
    if (p.charging) {
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
function drawHud() {
  const lineH = 14;
  const pad = 8;
  const panelW = 132;
  for (const local of locals) {
    const p = getPlayer(local);
    if (!p) continue;
    const panelH = pad * 2 + lineH * (WEAPONS.length + 1);
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
    vctx.textAlign = 'center';
  }
}

function drawHiRes() {
  vctx.textAlign = 'center';
  if (latestState) {
    // name labels + death markers
    for (const p of latestState.players) {
      const tag = localTag(p.id);
      vctx.font = 'bold 13px "Courier New", monospace';
      vctx.fillStyle = tag ? '#ffdd33' : '#f5f0dc';
      const label = ((p.name || 'Player ' + p.id) + tag).toUpperCase();
      vctx.fillText(label, p.x, p.y - 52);
      if (!p.alive) {
        vctx.font = '16px system-ui, sans-serif';
        vctx.fillText('💥', p.x, p.y - 18);
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
