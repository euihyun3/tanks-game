#!/usr/bin/env python3
"""Multiplayer artillery tanks with destructible terrain, room-based.

One stdlib-only socket server on a single port (PORT env var, default 8080)
serves both the static game page over HTTP and the realtime game state over
a hand-rolled WebSocket upgrade. Games are isolated in rooms keyed by a
4-letter code.
"""
import base64
import hashlib
import json
import math
import os
import random
import re
import socket
import struct
import threading
import time
from urllib.parse import unquote

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PORT = int(os.environ.get('PORT', 8080))
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')

WIDTH, HEIGHT = 1000, 600
TICK = 1 / 30

GRAVITY = 260
MOVE_SPEED = 160
ANGLE_SPEED = 90
MIN_POWER = 220
MAX_POWER = 620
DEFAULT_POWER = max(MIN_POWER, min(MAX_POWER, 400.0))  # classic: persists per player
POWER_RATE = 260          # classic aim phase: power units per second from left/right
CHARGE_RATE = (MAX_POWER - MIN_POWER) / 1.1  # chaos only
MOVE_BUDGET = 150.0       # classic: world px a tank may drive per turn
FIRE_COOLDOWN = 0.4
TANK_RADIUS = 11
EXPLOSION_RADIUS = 46
MAX_DAMAGE = 45
RESET_DELAY = 3.0

MG_POWER = 520
BURST_SIZE = 8
BURST_INTERVAL = 0.08
CHAOS_MG_INTERVAL = 0.15

# per-weapon explosion radius / max damage
WEAPONS = {
    'basic':   {'radius': EXPLOSION_RADIUS, 'damage': MAX_DAMAGE},
    'tnt':     {'radius': 80, 'damage': 75},
    'scatter': {'radius': 20, 'damage': 14},
    'flame':   {'radius': 15, 'damage': 10},
    'mg':      {'radius': 8,  'damage': 6},
}
CHAOS_COOLDOWNS = {'basic': 1.2, 'tnt': 3.0, 'scatter': 2.0, 'flame': 2.5, 'mg': CHAOS_MG_INTERVAL}
AMMO_WEAPONS = ('tnt', 'scatter', 'flame', 'mg')
STARTING_AMMO = {'tnt': 1, 'scatter': 1, 'flame': 1, 'mg': 30}

CRATE_INTERVAL = 7.0
MAX_CRATES = 5
CRATE_PICKUP_DIST = 20
FIRE_TTL = 4.0
FIRE_RADIUS = 28
FIRE_DPS = 8.0

COLORS = ['#7a8b3f', '#5d7a8c', '#b0803f', '#7d5a5a']  # olive, field gray, desert tan, maroon

ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'  # no I/O to avoid confusion
CONTENT_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
}

# ONE lock guards the rooms dict and all room state.
state_lock = threading.Lock()
rooms = {}  # code -> room dict


def new_room_code():
    """Random unique 4-letter room code. Caller must hold state_lock."""
    while True:
        code = ''.join(random.choice(ROOM_ALPHABET) for _ in range(4))
        if code not in rooms:
            return code


def make_room(code, mode_req=None):
    mode = mode_req if mode_req in ('classic', 'chaos') else 'classic'
    return {
        'code': code,
        'players': {},        # conn -> player dict
        'terrain': generate_terrain(),
        'terrain_changed': True,
        'projectiles': [],
        'crates': [],         # [{'x', 'y', 'kind'}]
        'fires': [],          # [{'x', 'y', 'ttl'}]
        'next_id': 1,
        'winner': None,
        'reset_at': None,
        'current_turn': None,  # player id whose turn it is
        # classic: 'move' (drive on a budget) -> 'aim' (angle/power) -> 'firing' (shot resolving)
        # chaos: always 'aim'; the client ignores the phase there
        'turn_phase': 'aim' if mode == 'chaos' else 'move',
        'mode': mode,
        'last_crate_spawn': time.monotonic(),
    }


def get_or_create_room(code_raw, mode_req):
    """Find or create the room for a join message. Caller must hold state_lock."""
    code = ''
    if code_raw is not None:
        code = str(code_raw).strip().upper()[:8]
    if code and code in rooms:
        room = rooms[code]
        if not room['players']:
            # joining an empty room: joiner is effectively the host, picks the mode
            room['mode'] = mode_req if mode_req in ('classic', 'chaos') else 'classic'
            room['turn_phase'] = 'aim' if room['mode'] == 'chaos' else 'move'
        return room
    if not code:
        code = new_room_code()
    room = make_room(code, mode_req)
    rooms[code] = room
    return room


def generate_terrain():
    heights = [0.0] * (WIDTH + 1)
    heights[0] = HEIGHT * 0.6 + (random.random() - 0.5) * 100
    heights[WIDTH] = HEIGHT * 0.6 + (random.random() - 0.5) * 100

    def displace(l, r, disp):
        if r - l < 2:
            return
        mid = (l + r) // 2
        heights[mid] = (heights[l] + heights[r]) / 2 + (random.random() - 0.5) * disp
        displace(l, mid, disp * 0.55)
        displace(mid, r, disp * 0.55)

    displace(0, WIDTH, 220)
    for i in range(WIDTH + 1):
        heights[i] = max(HEIGHT * 0.25, min(HEIGHT - 20, heights[i]))
    return heights


def terrain_height_at(room, x):
    x = max(0, min(WIDTH, round(x)))
    return room['terrain'][x]


def spawn_position(room, taken=None):
    taken = taken if taken is not None else [p['x'] for p in room['players'].values()]
    for _ in range(40):
        x = WIDTH * (0.1 + 0.8 * random.random())
        if all(abs(x - t) >= 140 for t in taken):
            return x
    return WIDTH * (0.1 + 0.8 * random.random())


def make_player(room, pid):
    idx = len(room['players'])
    return {
        'id': pid,
        'name': f'Player {pid}',
        'color': COLORS[idx % len(COLORS)],
        'x': spawn_position(room),
        'angle': 45.0,
        'power': DEFAULT_POWER,   # classic: persists across turns
        'move_left': MOVE_BUDGET,  # classic: driving budget left this turn (chaos ignores it)
        'charging': False,
        'charge_start': 0.0,
        'cooldown': 0.0,
        'hp': 100,
        'alive': True,
        'input': {'left': False, 'right': False, 'up': False, 'down': False, 'space': False},
        'prev_space': False,
        'weapon': 'basic',
        'ammo': dict(STARTING_AMMO),
        'wcd': {},            # chaos per-weapon cooldowns: weapon -> seconds remaining
        'pending_burst': 0,   # classic mg burst bullets left to fire
        'burst_timer': 0.0,
    }


def reset_round(room):
    room['terrain'] = generate_terrain()
    room['terrain_changed'] = True
    room['projectiles'].clear()
    room['crates'].clear()
    room['fires'].clear()
    room['last_crate_spawn'] = time.monotonic()
    room['winner'] = None
    room['reset_at'] = None
    for p in room['players'].values():
        p['x'] = spawn_position(room)
        p['angle'] = 45.0
        p['power'] = DEFAULT_POWER
        p['move_left'] = MOVE_BUDGET
        p['charging'] = False
        p['cooldown'] = 0.0
        p['hp'] = 100
        p['alive'] = True
        p['weapon'] = 'basic'
        p['ammo'] = dict(STARTING_AMMO)
        p['wcd'] = {}
        p['pending_burst'] = 0
        p['burst_timer'] = 0.0
    ids = sorted(p['id'] for p in room['players'].values())
    room['current_turn'] = ids[0] if ids else None
    begin_turn(room)


def begin_turn(room):
    """Open the current player's turn: classic starts in 'move' with a fresh budget."""
    if room['mode'] == 'chaos':
        room['turn_phase'] = 'aim'
        return
    room['turn_phase'] = 'move'
    for p in room['players'].values():
        if p['id'] == room['current_turn']:
            p['move_left'] = MOVE_BUDGET


def advance_turn(room):
    alive = sorted(p['id'] for p in room['players'].values() if p['alive'])
    if not alive:
        room['current_turn'] = None
        begin_turn(room)
        return
    later = [i for i in alive if room['current_turn'] is not None and i > room['current_turn']]
    room['current_turn'] = later[0] if later else alive[0]
    begin_turn(room)


def explode(room, x, y, radius=EXPLOSION_RADIUS, max_damage=MAX_DAMAGE):
    terrain = room['terrain']
    lo = max(0, math.floor(x - radius))
    hi = min(WIDTH, math.ceil(x + radius))
    for px in range(lo, hi + 1):
        dx = px - x
        falloff = 1 - abs(dx) / radius
        if falloff <= 0:
            continue
        terrain[px] = min(HEIGHT - 20, terrain[px] + falloff * radius * 0.9)
    room['terrain_changed'] = True

    for p in room['players'].values():
        if not p['alive']:
            continue
        tank_y = terrain_height_at(room, p['x']) - TANK_RADIUS
        dist = math.hypot(p['x'] - x, tank_y - y)
        if dist < radius:
            dmg = max_damage * (1 - dist / radius)
            p['hp'] -= dmg
            if p['hp'] <= 0:
                p['hp'] = 0
                p['alive'] = False


def consume_ammo(p, weapon):
    """Spend 1 ammo; auto-switch to basic when the weapon runs dry."""
    if weapon == 'basic':
        return
    p['ammo'][weapon] = max(0, p['ammo'][weapon] - 1)
    if p['ammo'][weapon] <= 0 and p['weapon'] == weapon:
        p['weapon'] = 'basic'


def fire_projectile(room, p, angle_deg, power, kind):
    rad = math.radians(angle_deg)
    barrel_len = TANK_RADIUS + 14
    origin_x = p['x'] + barrel_len * math.cos(rad)
    origin_y = terrain_height_at(room, p['x']) - TANK_RADIUS - barrel_len * math.sin(rad)
    room['projectiles'].append({
        'x': origin_x,
        'y': origin_y,
        'vx': power * math.cos(rad),
        'vy': -power * math.sin(rad),
        'owner': p['id'],
        'kind': kind,
    })


def fire_weapon(room, p):
    """Spawn the shot(s) for p's current weapon at its angle/power. Returns the weapon."""
    weapon = p['weapon']
    if weapon != 'basic' and p['ammo'].get(weapon, 0) <= 0:
        p['weapon'] = 'basic'
        weapon = 'basic'
    if weapon == 'scatter':
        for _ in range(6):
            ang = p['angle'] + random.uniform(-8, 8)
            pw = p['power'] * random.uniform(0.9, 1.1)
            fire_projectile(room, p, ang, pw, 'scatter')
    else:
        fire_projectile(room, p, p['angle'], p['power'], weapon)
    consume_ammo(p, weapon)
    return weapon


def fire_charged(room, p):
    """Chaos only: release a charged shot with the current weapon (all but mg)."""
    weapon = fire_weapon(room, p)
    p['charging'] = False
    p['power'] = MIN_POWER
    p['wcd'][weapon] = CHAOS_COOLDOWNS[weapon]


def fire_aimed(room, p):
    """Classic only: fire immediately at the held angle/power, then wait the shot out.

    Power is NOT reset - it persists as the player's setting for later turns.
    """
    fire_weapon(room, p)
    p['charging'] = False
    p['cooldown'] = FIRE_COOLDOWN
    room['turn_phase'] = 'firing'


def tick(room):
    dt = TICK
    chaos = (room['mode'] == 'chaos')
    players = room['players']
    projectiles = room['projectiles']
    crates = room['crates']
    fires = room['fires']

    for p in players.values():
        # cooldowns tick down regardless of turn
        if p['cooldown'] > 0:
            p['cooldown'] -= dt
        for w in list(p['wcd']):
            p['wcd'][w] -= dt
            if p['wcd'][w] <= 0:
                del p['wcd'][w]

        if not p['alive']:
            continue
        inp = p['input']

        if chaos:
            # chaos: everyone acts at once, drives freely, charges and fires on release
            if inp['left']:
                p['x'] -= MOVE_SPEED * dt
            if inp['right']:
                p['x'] += MOVE_SPEED * dt
            p['x'] = max(TANK_RADIUS, min(WIDTH - TANK_RADIUS, p['x']))

            if inp['up']:
                p['angle'] = min(180, p['angle'] + ANGLE_SPEED * dt)
            if inp['down']:
                p['angle'] = max(0, p['angle'] - ANGLE_SPEED * dt)

            if p['weapon'] == 'mg':
                p['charging'] = False
                # hold to spray: one bullet per cooldown interval
                if inp['space'] and p['wcd'].get('mg', 0) <= 0 and p['ammo']['mg'] > 0:
                    fire_projectile(room, p, p['angle'], MG_POWER, 'mg')
                    consume_ammo(p, 'mg')
                    p['wcd']['mg'] = CHAOS_COOLDOWNS['mg']
            else:
                can_start = p['wcd'].get(p['weapon'], 0) <= 0
                if inp['space'] and (p['charging'] or can_start):
                    if not p['charging']:
                        p['charging'] = True
                        p['charge_start'] = time.monotonic()
                        p['power'] = MIN_POWER
                    else:
                        elapsed = time.monotonic() - p['charge_start']
                        p['power'] = min(MAX_POWER, MIN_POWER + elapsed * CHARGE_RATE)
                elif not inp['space'] and p['prev_space'] and p['charging']:
                    fire_charged(room, p)
            p['prev_space'] = inp['space']
            continue

        # classic: only the active player acts, through the move -> aim -> firing phases
        p['charging'] = False  # no charging in classic
        if p['id'] != room['current_turn']:
            p['prev_space'] = inp['space']
            continue
        phase = room['turn_phase']
        space_edge = inp['space'] and not p['prev_space']
        p['prev_space'] = inp['space']  # every tick, so a held space can't retrigger

        if phase == 'move':
            dx = 0.0
            if inp['left']:
                dx -= MOVE_SPEED * dt
            if inp['right']:
                dx += MOVE_SPEED * dt
            if dx and p['move_left'] > 0:
                if abs(dx) > p['move_left']:
                    dx = math.copysign(p['move_left'], dx)
                before = p['x']
                p['x'] = max(TANK_RADIUS, min(WIDTH - TANK_RADIUS, p['x'] + dx))
                # only charge for distance actually travelled (the edge clamp is free)
                p['move_left'] = max(0.0, p['move_left'] - abs(p['x'] - before))
            if space_edge:
                room['turn_phase'] = 'aim'
        elif phase == 'aim':
            if inp['up']:
                p['angle'] = min(180, p['angle'] + ANGLE_SPEED * dt)
            if inp['down']:
                p['angle'] = max(0, p['angle'] - ANGLE_SPEED * dt)
            if inp['right']:
                p['power'] = min(MAX_POWER, p['power'] + POWER_RATE * dt)
            if inp['left']:
                p['power'] = max(MIN_POWER, p['power'] - POWER_RATE * dt)
            if space_edge:
                if p['weapon'] == 'mg':
                    # server-timed burst, fired off over the next few ticks
                    if (p['cooldown'] <= 0 and p['pending_burst'] == 0
                            and p['ammo']['mg'] > 0):
                        p['pending_burst'] = BURST_SIZE
                        p['burst_timer'] = 0.0
                        p['cooldown'] = FIRE_COOLDOWN
                        room['turn_phase'] = 'firing'
                elif p['cooldown'] <= 0:
                    fire_aimed(room, p)
        # 'firing': no player input acts

    # classic mg bursts keep firing during the 'firing' phase
    for p in players.values():
        if p['pending_burst'] <= 0:
            continue
        if not p['alive']:
            p['pending_burst'] = 0
            continue
        p['burst_timer'] -= dt
        while p['pending_burst'] > 0 and p['burst_timer'] <= 0:
            if p['ammo']['mg'] <= 0:
                p['pending_burst'] = 0
                break
            fire_projectile(room, p, p['angle'], MG_POWER, 'mg')
            consume_ammo(p, 'mg')
            p['pending_burst'] -= 1
            p['burst_timer'] += BURST_INTERVAL

    for proj in projectiles[:]:
        proj['vy'] += GRAVITY * dt
        proj['x'] += proj['vx'] * dt
        proj['y'] += proj['vy'] * dt

        hit = False
        if proj['x'] < 0 or proj['x'] > WIDTH or proj['y'] > HEIGHT:
            hit = True
        elif proj['y'] >= terrain_height_at(room, proj['x']):
            hit = True
        else:
            for p in players.values():
                if not p['alive']:
                    continue
                tank_y = terrain_height_at(room, p['x']) - TANK_RADIUS
                if math.hypot(proj['x'] - p['x'], proj['y'] - tank_y) < TANK_RADIUS:
                    hit = True
                    break

        if hit:
            kind = proj.get('kind', 'basic')
            spec = WEAPONS.get(kind, WEAPONS['basic'])
            ix = max(0, min(WIDTH, proj['x']))
            iy = min(HEIGHT, proj['y'])
            explode(room, ix, iy, spec['radius'], spec['damage'])
            if kind == 'flame':
                for _ in range(10):
                    fx = max(0, min(WIDTH, ix + random.uniform(-40, 40)))
                    fires.append({'x': fx, 'y': terrain_height_at(room, fx), 'ttl': FIRE_TTL})
            projectiles.remove(proj)

    # fire cells: ride the (deforming) terrain, expire; burn any tank near a fire
    for f in fires[:]:
        f['ttl'] -= dt
        if f['ttl'] <= 0:
            fires.remove(f)
            continue
        f['y'] = terrain_height_at(room, f['x'])
    if fires:
        for p in players.values():
            if not p['alive']:
                continue
            tank_y = terrain_height_at(room, p['x']) - TANK_RADIUS
            if any(math.hypot(p['x'] - f['x'], tank_y - f['y']) < FIRE_RADIUS for f in fires):
                p['hp'] -= FIRE_DPS * dt
                if p['hp'] <= 0:
                    p['hp'] = 0
                    p['alive'] = False

    # ammo crates: periodic spawn, glue to terrain, pickup by proximity
    now = time.monotonic()
    if now - room['last_crate_spawn'] >= CRATE_INTERVAL:
        room['last_crate_spawn'] = now
        if len(crates) < MAX_CRATES:
            # drop near a random living tank so it stays reachable on one move budget
            standing = [p for p in players.values() if p['alive']]
            if standing:
                anchor = random.choice(standing)
                cx = max(60.0, min(float(WIDTH - 60),
                                   anchor['x'] + random.uniform(-250, 250)))
            else:
                cx = random.uniform(60, WIDTH - 60)
            crates.append({'x': cx, 'y': terrain_height_at(room, cx),
                           'kind': random.choice(['tnt', 'scatter', 'flame', 'mg'])})
    for c in crates[:]:
        c['y'] = terrain_height_at(room, c['x'])
        for p in players.values():
            if p['alive'] and abs(p['x'] - c['x']) < CRATE_PICKUP_DIST:
                c_kind = c['kind']
                p['ammo'][c_kind] += 25 if c_kind == 'mg' else 2
                crates.remove(c)
                break

    if (not chaos and room['turn_phase'] == 'firing' and not projectiles
            and not any(p['pending_burst'] > 0 for p in players.values())):
        advance_turn(room)

    # the active player can die on their own turn (fire damage) — hand the turn
    # on, or the room stalls waiting for input from a wreck
    if not chaos and room['turn_phase'] in ('move', 'aim'):
        active = next((p for p in players.values() if p['id'] == room['current_turn']), None)
        if (active is None or not active['alive']) and any(p['alive'] for p in players.values()):
            advance_turn(room)

    if room['winner'] is None and room['reset_at'] is None and len(players) >= 2:
        alive = [p for p in players.values() if p['alive']]
        if len(alive) == 1:
            room['winner'] = alive[0]['id']
            room['reset_at'] = time.monotonic() + RESET_DELAY
        elif len(alive) == 0:
            room['winner'] = 'draw'
            room['reset_at'] = time.monotonic() + RESET_DELAY

    if room['reset_at'] is not None and time.monotonic() >= room['reset_at']:
        reset_round(room)


def broadcast(room):
    players = room['players']
    state = {
        'type': 'state',
        'room': room['code'],
        'winner': room['winner'],
        'playerCount': len(players),
        'mode': room['mode'],
        'currentTurn': None if room['mode'] == 'chaos' else room['current_turn'],
        'turnPhase': room['turn_phase'],
        'players': [{
            'id': p['id'],
            'name': p['name'],
            'color': p['color'],
            'x': p['x'],
            'y': terrain_height_at(room, p['x']) - TANK_RADIUS,
            'angle': p['angle'],
            'hp': p['hp'],
            'alive': p['alive'],
            'charging': p['charging'],
            'power': p['power'],
            'moveLeft': p['move_left'],
            'weapon': p['weapon'],
            'ammo': p['ammo'],
        } for p in players.values()],
        'projectiles': [{'x': proj['x'], 'y': proj['y'], 'kind': proj.get('kind', 'basic')}
                        for proj in room['projectiles']],
        'crates': [{'x': c['x'], 'y': c['y'], 'kind': c['kind']} for c in room['crates']],
        'fires': [{'x': f['x'], 'y': f['y'], 'ttl': f['ttl']} for f in room['fires']],
    }
    msg = json.dumps(state)

    terrain_msg = None
    if room['terrain_changed']:
        terrain_msg = json.dumps({'type': 'terrain', 'terrain': room['terrain']})
        room['terrain_changed'] = False

    dead = []
    for conn, p in players.items():
        try:
            if terrain_msg:
                conn.send_text(terrain_msg)
            conn.send_text(msg)
        except OSError:
            dead.append(conn)
    for conn in dead:
        players.pop(conn, None)


def game_loop():
    next_tick = time.monotonic()
    while True:
        with state_lock:
            for code in list(rooms):
                room = rooms[code]
                if not room['players']:
                    # defensive sweep; normally deleted when the last player leaves
                    del rooms[code]
                    continue
                tick(room)
                broadcast(room)
        next_tick += TICK
        delay = next_tick - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_tick = time.monotonic()


# --- minimal WebSocket implementation (stdlib only) ---

class BufferedSocket:
    """Socket wrapper that replays bytes read past the HTTP head first."""

    def __init__(self, sock, initial=b''):
        self.sock = sock
        self.buf = initial

    def recv(self, n):
        if self.buf:
            chunk, self.buf = self.buf[:n], self.buf[n:]
            return chunk
        return self.sock.recv(n)

    def sendall(self, data):
        self.sock.sendall(data)

    def close(self):
        self.sock.close()


def recv_exact(sock, n):
    buf = b''
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def encode_frame(payload: bytes) -> bytes:
    header = bytearray([0x81])  # FIN + text frame opcode
    length = len(payload)
    if length <= 125:
        header.append(length)
    elif length <= 0xFFFF:
        header.append(126)
        header += struct.pack('>H', length)
    else:
        header.append(127)
        header += struct.pack('>Q', length)
    return bytes(header) + payload


def decode_frame(sock):
    header = recv_exact(sock, 2)
    if not header:
        return None, None
    b1, b2 = header
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        ext = recv_exact(sock, 2)
        if ext is None:
            return None, None
        length = struct.unpack('>H', ext)[0]
    elif length == 127:
        ext = recv_exact(sock, 8)
        if ext is None:
            return None, None
        length = struct.unpack('>Q', ext)[0]
    mask_key = recv_exact(sock, 4) if masked else None
    payload = recv_exact(sock, length) if length else b''
    if payload is None:
        return None, None
    if masked and mask_key:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return opcode, payload


class WSConnection:
    def __init__(self, sock):
        self.sock = sock
        self.send_lock = threading.Lock()

    def send_text(self, text: str):
        data = encode_frame(text.encode('utf-8'))
        with self.send_lock:
            self.sock.sendall(data)


def do_handshake(sock, header_text) -> bool:
    """Complete the WS handshake using the already-read HTTP request head."""
    key = None
    for line in header_text.split('\r\n'):
        if line.lower().startswith('sec-websocket-key'):
            key = line.split(':', 1)[1].strip()
            break
    if not key:
        return False
    accept = base64.b64encode(hashlib.sha1((key + WS_MAGIC).encode()).digest()).decode()
    response = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    sock.sendall(response.encode())
    return True


def join_room(conn, join_msg):
    """Create/find the room for a join message and add the new player to it.

    Caller must hold state_lock. Returns (room, player, welcome_json, terrain_json).
    """
    room = get_or_create_room(join_msg.get('room'), join_msg.get('mode'))
    pid = room['next_id']
    room['next_id'] += 1
    player = make_player(room, pid)
    name = str(join_msg.get('name', '') or '').strip()[:12]
    player['name'] = name if name else f'Player {pid}'
    color = join_msg.get('color')
    if isinstance(color, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        player['color'] = color
    room['players'][conn] = player
    room['terrain_changed'] = True
    if room['current_turn'] is None:
        room['current_turn'] = pid
        begin_turn(room)
    welcome = json.dumps({'type': 'welcome', 'id': pid, 'color': player['color'],
                          'width': WIDTH, 'height': HEIGHT,
                          'mode': room['mode'], 'room': room['code']})
    terrain_msg = json.dumps({'type': 'terrain', 'terrain': room['terrain']})
    return room, player, welcome, terrain_msg


def leave_room(conn, room, player):
    """Remove a player from its room; delete the room when empty.

    Caller must hold state_lock.
    """
    room['players'].pop(conn, None)
    if player['id'] == room['current_turn'] and room['turn_phase'] in ('move', 'aim'):
        advance_turn(room)
    if not room['players']:
        rooms.pop(room['code'], None)


def handle_ws_client(sock):
    """Run the per-client WS loop. `sock` is a BufferedSocket, handshake done."""
    conn = WSConnection(sock)

    # wait for a valid join message before creating the player
    join_msg = None
    try:
        while join_msg is None:
            opcode, payload = decode_frame(sock)
            if opcode is None or opcode == 0x8:  # closed before joining
                try:
                    sock.close()
                except OSError:
                    pass
                return
            if opcode == 0x1:  # text
                try:
                    data = json.loads(payload.decode('utf-8'))
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(data, dict) and data.get('type') == 'join':
                    join_msg = data
    except OSError:
        try:
            sock.close()
        except OSError:
            pass
        return

    with state_lock:
        room, player, welcome, terrain_msg = join_room(conn, join_msg)
    try:
        conn.send_text(welcome)
        conn.send_text(terrain_msg)
    except OSError:
        with state_lock:
            leave_room(conn, room, player)
        sock.close()
        return

    try:
        while True:
            opcode, payload = decode_frame(sock)
            if opcode is None:
                break
            if opcode == 0x8:  # close
                break
            if opcode == 0x1:  # text
                try:
                    data = json.loads(payload.decode('utf-8'))
                except (ValueError, UnicodeDecodeError):
                    continue
                if isinstance(data, dict) and data.get('type') == 'join':
                    continue  # already joined; ignore stray join messages
                if isinstance(data, dict) and data.get('type') == 'weapon':
                    w = data.get('weapon')
                    with state_lock:
                        if w == 'basic' or (w in AMMO_WEAPONS and player['ammo'].get(w, 0) > 0):
                            player['weapon'] = w
                    continue
                with state_lock:
                    for k in ('left', 'right', 'up', 'down', 'space'):
                        if k in data:
                            player['input'][k] = bool(data[k])
    except OSError:
        pass
    finally:
        with state_lock:
            leave_room(conn, room, player)
        try:
            sock.close()
        except OSError:
            pass


# --- single-port HTTP + WebSocket dispatch ---

def resolve_static_path(url_path):
    """Map a request path to a real file path inside PUBLIC_DIR, or None."""
    path = url_path.split('?', 1)[0].split('#', 1)[0]
    path = unquote(path)
    if path == '/':
        path = '/index.html'
    root = os.path.realpath(PUBLIC_DIR)
    full = os.path.realpath(os.path.join(root, path.lstrip('/')))
    if full != root and not full.startswith(root + os.sep):
        return None  # path traversal attempt
    return full


def send_http_response(sock, status, body=b'', content_type='text/plain'):
    head = (
        f"HTTP/1.1 {status}\r\n"
        f"Content-Type: {content_type}\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    )
    sock.sendall(head.encode() + body)


def serve_static(sock, request_line):
    parts = request_line.split()
    if len(parts) < 2:
        send_http_response(sock, '400 Bad Request', b'Bad Request')
        return
    method, target = parts[0], parts[1]
    if method != 'GET':
        send_http_response(sock, '405 Method Not Allowed', b'Method Not Allowed')
        return
    full = resolve_static_path(target)
    if full is None or not os.path.isfile(full):
        send_http_response(sock, '404 Not Found', b'Not Found')
        return
    ext = os.path.splitext(full)[1].lower()
    ctype = CONTENT_TYPES.get(ext, 'application/octet-stream')
    with open(full, 'rb') as fh:
        body = fh.read()
    send_http_response(sock, '200 OK', body, ctype)


def handle_connection(sock, addr):
    try:
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = sock.recv(4096)
            if not chunk:
                return
            head += chunk
            if len(head) > 65536:
                return
        head_bytes, _, leftover = head.partition(b'\r\n\r\n')
        header_text = head_bytes.decode('utf-8', errors='ignore')
        lines = header_text.split('\r\n')
        request_line = lines[0] if lines else ''
        is_ws = any(line.lower().startswith('upgrade:') and 'websocket' in line.lower()
                    for line in lines[1:])

        if is_ws:
            bsock = BufferedSocket(sock, leftover)
            if not do_handshake(bsock, header_text):
                return
            handle_ws_client(bsock)  # closes the socket itself
            return

        serve_static(sock, request_line)
    except OSError:
        pass
    finally:
        try:
            sock.close()
        except OSError:
            pass


def run_server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', PORT))
    srv.listen(16)
    while True:
        sock, addr = srv.accept()
        threading.Thread(target=handle_connection, args=(sock, addr), daemon=True).start()


def local_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ip = info[4][0]
            if ':' not in ip and not ip.startswith('127.'):
                ips.add(ip)
    except socket.gaierror:
        pass
    return sorted(ips)


if __name__ == '__main__':
    threading.Thread(target=game_loop, daemon=True).start()

    print(f"Tanks server running on port {PORT}:")
    print(f"  http://localhost:{PORT}")
    for ip in local_ips():
        print(f"  http://{ip}:{PORT}  (for others on your network)")

    run_server()
