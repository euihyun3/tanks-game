const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');

let myId = null;
let myColor = null;
let terrain = null;
let latestState = null;
let W = 1000, H = 600;

// physics constants mirrored from the server for the aim-preview arc
const GRAVITY = 260;
const TANK_RADIUS = 16;
const BARREL_LEN = TANK_RADIUS + 14;
const MIN_POWER = 220;
const MAX_POWER = 620;

const WS_PORT = 8081;
let ws = null;

// --- join screen ---
const overlayEl = document.getElementById('join-overlay');
const joinForm = document.getElementById('join-panel');
const nameInput = document.getElementById('join-name');
const customColorInput = document.getElementById('join-custom');
const swatches = Array.from(document.querySelectorAll('.swatch'));
let selectedColor = '#7a8b3f';

for (const swatch of swatches) {
  swatch.addEventListener('click', () => {
    selectedColor = swatch.dataset.color;
    customColorInput.value = selectedColor;
    customColorInput.classList.remove('selected');
    swatches.forEach((s) => s.classList.toggle('selected', s === swatch));
  });
}
customColorInput.addEventListener('input', () => {
  selectedColor = customColorInput.value;
  swatches.forEach((s) => s.classList.remove('selected'));
  customColorInput.classList.add('selected');
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (ws) return;
  if (window.SFX) SFX.init(); // unlock audio on this user gesture
  const name = nameInput.value.trim().slice(0, 12);
  overlayEl.style.display = 'none';
  statusEl.textContent = 'Connecting...';
  connect(name, selectedColor);
});

function connect(name, color) {
  ws = new WebSocket(`ws://${location.hostname}:${WS_PORT}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', name, color }));
    statusEl.textContent = 'Connected. Waiting for another player...';
  };
  ws.onclose = () => {
    statusEl.textContent = 'Disconnected from server.';
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'welcome') {
      myId = msg.id;
      myColor = msg.color;
      W = msg.width;
      H = msg.height;
    } else if (msg.type === 'terrain') {
      terrain = msg.terrain;
    } else if (msg.type === 'state') {
      playStateSounds(msg);
      latestState = msg;
      recordTrail(msg.projectiles);
      updateStatus(msg);
    }
  };
}

// compare consecutive states to trigger sound effects
let sndPrev = { proj: 0, turn: null, winner: null };
function playStateSounds(msg) {
  if (!window.SFX) return;
  if (msg.projectiles.length > sndPrev.proj) SFX.fire();
  if (msg.projectiles.length < sndPrev.proj) SFX.explosion();
  if (msg.winner && !sndPrev.winner) SFX.win();
  if (!msg.winner && msg.playerCount >= 2 &&
      msg.currentTurn === myId && sndPrev.turn !== myId) {
    SFX.turn();
  }
  sndPrev = { proj: msg.projectiles.length, turn: msg.currentTurn, winner: msg.winner };
}

function playerName(id) {
  const p = latestState && latestState.players.find((pl) => pl.id === id);
  return p && p.name ? p.name : `Player ${id}`;
}

function updateStatus(msg) {
  if (msg.playerCount < 2) {
    statusEl.textContent = 'Waiting for another player to join...';
    statusEl.className = '';
  } else if (msg.winner) {
    statusEl.textContent = '';
  } else if (msg.turnPhase === 'firing') {
    statusEl.textContent = 'Shell in flight...';
    statusEl.className = '';
  } else if (msg.currentTurn === myId) {
    statusEl.textContent = '🎯 YOUR TURN — move, aim, fire!';
    statusEl.className = 'my-turn';
  } else {
    statusEl.textContent = `${playerName(msg.currentTurn)}'s turn...`;
    statusEl.className = '';
  }
}

// --- tracer trail: record shell positions, fade them out over time ---
const TRAIL_LIFE = 4000; // ms
let trail = [];

function recordTrail(projectiles) {
  const now = performance.now();
  for (const p of projectiles) {
    trail.push({ x: p.x, y: p.y, born: now });
  }
  trail = trail.filter((t) => now - t.born < TRAIL_LIFE);
}

const input = { left: false, right: false, up: false, down: false, space: false };
function send() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(input));
}

const KEYMAP = {
  ArrowLeft: 'left', a: 'left', A: 'left',
  ArrowRight: 'right', d: 'right', D: 'right',
  ArrowUp: 'up', w: 'up', W: 'up',
  ArrowDown: 'down', s: 'down', S: 'down',
  ' ': 'space',
};

// whether this client is allowed to act right now (solo play or own turn)
function canAct() {
  return !latestState || latestState.playerCount < 2 ||
    (latestState.currentTurn === myId && latestState.turnPhase === 'aim');
}

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  if (window.SFX) SFX.init();
  const key = KEYMAP[e.key];
  if (!key) return;
  e.preventDefault();
  if (!input[key]) {
    input[key] = true;
    send();
    if (key === 'space' && window.SFX && canAct()) SFX.charge();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  const key = KEYMAP[e.key];
  if (!key) return;
  e.preventDefault();
  input[key] = false;
  send();
  if (key === 'space' && window.SFX) SFX.chargeStop();
});

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

function drawTerrain() {
  if (!terrain) return;
  ctx.fillStyle = '#6b4a2f';
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) {
    ctx.lineTo(x, terrain[x]);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#3f7d3f';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 4) {
    if (x === 0) ctx.moveTo(x, terrain[x]);
    else ctx.lineTo(x, terrain[x]);
  }
  ctx.stroke();
}

function drawTank(p) {
  ctx.save();
  ctx.translate(p.x, p.y);

  const body = p.alive ? p.color : '#4a4a4a';
  const dark = p.alive ? shade(p.color, 0.55) : '#2e2e2e';
  const light = p.alive ? shade(p.color, 1.25) : '#5a5a5a';

  // barrel first so it sits behind the turret
  const rad = (p.angle * Math.PI) / 180;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(30 * Math.cos(rad), -8 - 30 * Math.sin(rad));
  ctx.stroke();
  // muzzle brake
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(24 * Math.cos(rad), -8 - 24 * Math.sin(rad));
  ctx.lineTo(29 * Math.cos(rad), -8 - 29 * Math.sin(rad));
  ctx.stroke();
  ctx.lineCap = 'butt';

  // tracks: dark rounded slab with road wheels
  ctx.fillStyle = '#2b2b22';
  roundRect(-24, 6, 48, 12, 6);
  ctx.fill();
  ctx.fillStyle = '#555';
  for (let i = -1.5; i <= 1.5; i++) {
    ctx.beginPath();
    ctx.arc(i * 12, 12, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // hull: trapezoid sitting on the tracks
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-22, 6);
  ctx.lineTo(-16, -3);
  ctx.lineTo(16, -3);
  ctx.lineTo(22, 6);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // turret dome
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.arc(0, -6, 9, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = dark;
  ctx.stroke();

  // hatch
  ctx.fillStyle = dark;
  ctx.fillRect(-3, -14, 6, 3);

  // allied-style star roundel on the hull
  if (p.alive) {
    drawStar(0, 2, 4.5, '#f5f0dc');
  }

  ctx.restore();

  // labels + bars drawn unrotated above the tank
  ctx.save();
  ctx.translate(p.x, p.y);

  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = p.id === myId ? '#ffdd33' : '#f5f0dc';
  const label = p.name || `Player ${p.id}`;
  ctx.fillText(p.id === myId ? `${label} (you)` : label, 0, -52);

  if (!p.alive) {
    ctx.font = '16px system-ui, sans-serif';
    ctx.fillText('💥', 0, -18);
    ctx.restore();
    return;
  }

  ctx.fillStyle = '#000a';
  ctx.fillRect(-20, -44, 40, 6);
  ctx.fillStyle = p.hp > 40 ? '#4caf50' : '#e53935';
  ctx.fillRect(-20, -44, 40 * (p.hp / 100), 6);

  if (p.charging) {
    const pct = Math.min(1, (p.power - MIN_POWER) / (MAX_POWER - MIN_POWER));
    ctx.fillStyle = '#000a';
    ctx.fillRect(-20, -34, 40, 6);
    ctx.fillStyle = '#ffdd33';
    ctx.fillRect(-20, -34, 40 * pct, 6);
  }

  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStar(cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const outer = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const inner = outer + Math.PI / 5;
    ctx.lineTo(cx + r * Math.cos(outer), cy + r * Math.sin(outer));
    ctx.lineTo(cx + r * 0.45 * Math.cos(inner), cy + r * 0.45 * Math.sin(inner));
  }
  ctx.closePath();
  ctx.fill();
}

// dotted preview arc while charging your own shot
function drawAimPreview(p) {
  if (!terrain) return;
  const rad = (p.angle * Math.PI) / 180;
  let x = p.x + BARREL_LEN * Math.cos(rad);
  let y = p.y - BARREL_LEN * Math.sin(rad);
  let vx = p.power * Math.cos(rad);
  let vy = -p.power * Math.sin(rad);
  const dt = 0.045;

  ctx.fillStyle = 'rgba(255, 221, 51, 0.8)';
  for (let i = 0; i < 70; i++) {
    vy += GRAVITY * dt;
    x += vx * dt;
    y += vy * dt;
    if (x < 0 || x > W || y > H) break;
    const tx = Math.max(0, Math.min(W, Math.round(x)));
    if (y >= terrain[tx]) break;
    if (i % 2 === 0) {
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawTrail() {
  const now = performance.now();
  for (const t of trail) {
    const age = (now - t.born) / TRAIL_LIFE;
    if (age >= 1) continue;
    ctx.fillStyle = `rgba(60, 60, 60, ${0.7 * (1 - age)})`;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function draw() {
  ctx.fillStyle = '#7ec8e3';
  ctx.fillRect(0, 0, W, H);
  drawTerrain();
  drawTrail();

  if (latestState) {
    for (const p of latestState.players) {
      if (p.alive && p.charging && p.id === myId) drawAimPreview(p);
      drawTank(p);
    }

    ctx.fillStyle = '#222';
    for (const proj of latestState.projectiles) {
      ctx.beginPath();
      ctx.arc(proj.x, proj.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (latestState.winner) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, H / 2 - 40, W, 80);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 32px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const text = latestState.winner === 'draw'
        ? 'Draw! New round starting...'
        : `${playerName(latestState.winner)} wins! New round starting...`;
      ctx.fillText(text, W / 2, H / 2 + 12);
    }
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
