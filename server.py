#!/usr/bin/env python3
"""Local-network multiplayer artillery tanks with destructible terrain.

Serves the game page over plain HTTP and runs a hand-rolled WebSocket
server (stdlib only, no pip installs needed) for realtime game state.
"""
import base64
import hashlib
import http.server
import json
import math
import os
import random
import re
import socket
import socketserver
import struct
import threading
import time

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HTTP_PORT = 8080
WS_PORT = 8081

WIDTH, HEIGHT = 1000, 600
TICK = 1 / 30

GRAVITY = 260
MOVE_SPEED = 160
ANGLE_SPEED = 90
MIN_POWER = 220
MAX_POWER = 620
CHARGE_RATE = (MAX_POWER - MIN_POWER) / 1.1
FIRE_COOLDOWN = 0.4
TANK_RADIUS = 16
EXPLOSION_RADIUS = 46
MAX_DAMAGE = 45
RESET_DELAY = 3.0

COLORS = ['#7a8b3f', '#5d7a8c', '#b0803f', '#7d5a5a']  # olive, field gray, desert tan, maroon

state_lock = threading.Lock()
players = {}          # conn -> player dict
terrain = []
terrain_changed = True
projectiles = []
next_id = 1
winner = None
reset_at = None
current_turn = None   # player id whose turn it is
turn_phase = 'aim'    # 'aim' while waiting for the shot, 'firing' while shell in flight


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


def terrain_height_at(x):
    x = max(0, min(WIDTH, round(x)))
    return terrain[x]


def spawn_position(taken=None):
    taken = taken if taken is not None else [p['x'] for p in players.values()]
    for _ in range(40):
        x = WIDTH * (0.1 + 0.8 * random.random())
        if all(abs(x - t) >= 140 for t in taken):
            return x
    return WIDTH * (0.1 + 0.8 * random.random())


def make_player(pid):
    idx = len(players)
    return {
        'id': pid,
        'name': f'Player {pid}',
        'color': COLORS[idx % len(COLORS)],
        'x': spawn_position(),
        'angle': 45.0,
        'power': MIN_POWER,
        'charging': False,
        'charge_start': 0.0,
        'cooldown': 0.0,
        'hp': 100,
        'alive': True,
        'input': {'left': False, 'right': False, 'up': False, 'down': False, 'space': False},
        'prev_space': False,
    }


def reset_round():
    global terrain, terrain_changed, winner, reset_at, current_turn, turn_phase
    terrain = generate_terrain()
    terrain_changed = True
    projectiles.clear()
    winner = None
    reset_at = None
    for p in players.values():
        p['x'] = spawn_position()
        p['angle'] = 45.0
        p['power'] = MIN_POWER
        p['charging'] = False
        p['cooldown'] = 0.0
        p['hp'] = 100
        p['alive'] = True
    ids = sorted(p['id'] for p in players.values())
    current_turn = ids[0] if ids else None
    turn_phase = 'aim'


def advance_turn():
    global current_turn, turn_phase
    alive = sorted(p['id'] for p in players.values() if p['alive'])
    turn_phase = 'aim'
    if not alive:
        current_turn = None
        return
    later = [i for i in alive if current_turn is not None and i > current_turn]
    current_turn = later[0] if later else alive[0]


def explode(x, y):
    global terrain_changed
    lo = max(0, math.floor(x - EXPLOSION_RADIUS))
    hi = min(WIDTH, math.ceil(x + EXPLOSION_RADIUS))
    for px in range(lo, hi + 1):
        dx = px - x
        falloff = 1 - abs(dx) / EXPLOSION_RADIUS
        if falloff <= 0:
            continue
        terrain[px] = min(HEIGHT - 20, terrain[px] + falloff * EXPLOSION_RADIUS * 0.9)
    terrain_changed = True

    for p in players.values():
        if not p['alive']:
            continue
        tank_y = terrain_height_at(p['x']) - TANK_RADIUS
        dist = math.hypot(p['x'] - x, tank_y - y)
        if dist < EXPLOSION_RADIUS:
            dmg = MAX_DAMAGE * (1 - dist / EXPLOSION_RADIUS)
            p['hp'] -= dmg
            if p['hp'] <= 0:
                p['hp'] = 0
                p['alive'] = False


def tick():
    global winner, reset_at, turn_phase
    dt = TICK

    for p in players.values():
        if not p['alive']:
            continue
        # solo player gets free practice; otherwise only the active player acts
        my_turn = len(players) < 2 or (p['id'] == current_turn and turn_phase == 'aim')
        if not my_turn:
            p['charging'] = False
            p['prev_space'] = p['input']['space']
            continue
        inp = p['input']

        if inp['left']:
            p['x'] -= MOVE_SPEED * dt
        if inp['right']:
            p['x'] += MOVE_SPEED * dt
        p['x'] = max(TANK_RADIUS, min(WIDTH - TANK_RADIUS, p['x']))

        if inp['up']:
            p['angle'] = min(180, p['angle'] + ANGLE_SPEED * dt)
        if inp['down']:
            p['angle'] = max(0, p['angle'] - ANGLE_SPEED * dt)

        if p['cooldown'] > 0:
            p['cooldown'] -= dt

        if inp['space'] and p['cooldown'] <= 0:
            if not p['charging']:
                p['charging'] = True
                p['charge_start'] = time.monotonic()
                p['power'] = MIN_POWER
            else:
                elapsed = time.monotonic() - p['charge_start']
                p['power'] = min(MAX_POWER, MIN_POWER + elapsed * CHARGE_RATE)
        elif not inp['space'] and p['prev_space'] and p['charging']:
            rad = math.radians(p['angle'])
            barrel_len = TANK_RADIUS + 14
            origin_x = p['x'] + barrel_len * math.cos(rad)
            origin_y = terrain_height_at(p['x']) - TANK_RADIUS - barrel_len * math.sin(rad)
            projectiles.append({
                'x': origin_x,
                'y': origin_y,
                'vx': p['power'] * math.cos(rad),
                'vy': -p['power'] * math.sin(rad),
                'owner': p['id'],
            })
            p['charging'] = False
            p['power'] = MIN_POWER
            p['cooldown'] = FIRE_COOLDOWN
            if len(players) >= 2:
                turn_phase = 'firing'
        p['prev_space'] = inp['space']

    for proj in projectiles[:]:
        proj['vy'] += GRAVITY * dt
        proj['x'] += proj['vx'] * dt
        proj['y'] += proj['vy'] * dt

        hit = False
        if proj['x'] < 0 or proj['x'] > WIDTH or proj['y'] > HEIGHT:
            hit = True
        elif proj['y'] >= terrain_height_at(proj['x']):
            hit = True
        else:
            for p in players.values():
                if not p['alive']:
                    continue
                tank_y = terrain_height_at(p['x']) - TANK_RADIUS
                if math.hypot(proj['x'] - p['x'], proj['y'] - tank_y) < TANK_RADIUS:
                    hit = True
                    break

        if hit:
            explode(max(0, min(WIDTH, proj['x'])), min(HEIGHT, proj['y']))
            projectiles.remove(proj)

    if turn_phase == 'firing' and not projectiles:
        advance_turn()

    if winner is None and reset_at is None and len(players) >= 2:
        alive = [p for p in players.values() if p['alive']]
        if len(alive) == 1:
            winner = alive[0]['id']
            reset_at = time.monotonic() + RESET_DELAY
        elif len(alive) == 0:
            winner = 'draw'
            reset_at = time.monotonic() + RESET_DELAY

    if reset_at is not None and time.monotonic() >= reset_at:
        reset_round()


def broadcast():
    global terrain_changed
    state = {
        'type': 'state',
        'winner': winner,
        'playerCount': len(players),
        'currentTurn': current_turn,
        'turnPhase': turn_phase,
        'players': [{
            'id': p['id'],
            'name': p['name'],
            'color': p['color'],
            'x': p['x'],
            'y': terrain_height_at(p['x']) - TANK_RADIUS,
            'angle': p['angle'],
            'hp': p['hp'],
            'alive': p['alive'],
            'charging': p['charging'],
            'power': p['power'],
        } for p in players.values()],
        'projectiles': [{'x': proj['x'], 'y': proj['y']} for proj in projectiles],
    }
    msg = json.dumps(state)

    terrain_msg = None
    if terrain_changed:
        terrain_msg = json.dumps({'type': 'terrain', 'terrain': terrain})
        terrain_changed = False

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
            tick()
            broadcast()
        next_tick += TICK
        delay = next_tick - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            next_tick = time.monotonic()


# --- minimal WebSocket implementation (stdlib only) ---

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


def do_handshake(sock) -> bool:
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = sock.recv(2048)
        if not chunk:
            return False
        data += chunk
    headers = data.decode('utf-8', errors='ignore')
    key = None
    for line in headers.split('\r\n'):
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


def handle_client(sock, addr):
    global next_id
    if not do_handshake(sock):
        sock.close()
        return

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
        pid = next_id
        next_id += 1
        player = make_player(pid)
        name = str(join_msg.get('name', '') or '').strip()[:12]
        player['name'] = name if name else f'Player {pid}'
        color = join_msg.get('color')
        if isinstance(color, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', color):
            player['color'] = color
        players[conn] = player
        global terrain_changed, current_turn
        terrain_changed = True
        if current_turn is None:
            current_turn = pid
        welcome = json.dumps({'type': 'welcome', 'id': pid, 'color': player['color'],
                               'width': WIDTH, 'height': HEIGHT})
        terrain_msg = json.dumps({'type': 'terrain', 'terrain': terrain})
    try:
        conn.send_text(welcome)
        conn.send_text(terrain_msg)
    except OSError:
        with state_lock:
            players.pop(conn, None)
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
                with state_lock:
                    for k in ('left', 'right', 'up', 'down', 'space'):
                        if k in data:
                            player['input'][k] = bool(data[k])
    except OSError:
        pass
    finally:
        with state_lock:
            players.pop(conn, None)
            if player['id'] == current_turn and turn_phase == 'aim':
                advance_turn()
        try:
            sock.close()
        except OSError:
            pass


def ws_server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('0.0.0.0', WS_PORT))
    srv.listen(8)
    while True:
        sock, addr = srv.accept()
        threading.Thread(target=handle_client, args=(sock, addr), daemon=True).start()


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass


def http_server():
    public_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')
    handler = lambda *a, **kw: QuietHandler(*a, directory=public_dir, **kw)
    with socketserver.ThreadingTCPServer(('0.0.0.0', HTTP_PORT), handler) as httpd:
        httpd.allow_reuse_address = True
        httpd.serve_forever()


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
    terrain = generate_terrain()

    threading.Thread(target=game_loop, daemon=True).start()
    threading.Thread(target=ws_server, daemon=True).start()

    print("Tanks server running:")
    print(f"  http://localhost:{HTTP_PORT}")
    for ip in local_ips():
        print(f"  http://{ip}:{HTTP_PORT}  (for others on your network)")

    http_server()
