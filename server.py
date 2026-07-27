#!/usr/bin/env python3
"""Multiplayer artillery tanks with destructible terrain, room-based.

One stdlib-only socket server on a single port (PORT env var, default 8080)
serves both the static game page over HTTP and the realtime game state over
a hand-rolled WebSocket upgrade. Games are isolated in rooms keyed by a
4-letter code.

A room may also hold up to three computer opponents ("bots"), requested with the
join message's optional "bots" field. They are ordinary players driven by a
server-side brain, and they never keep a room alive on their own.
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

# --- bot (computer opponent) tuning knobs ---
BOT_CAP = 3                    # hard cap on bots living in one room
BOT_MAX_PER_JOIN = 2           # protocol: the join message's "bots" field is clamped to 0..2
BOT_THINK = (0.35, 0.8)        # classic: seconds of "thinking" before acting in a phase
BOT_PHASE_TIMEOUT = 3.5        # classic: force the phase along after this long (anti-stall)
BOT_MOVE_CHANCE = 0.65         # classic: chance of a plain reposition when no crate is reachable
BOT_REPOSITION = (25.0, 80.0)  # classic: px of the move budget spent repositioning
# Aim error comes in two parts: a per-target ranging miscalibration that persists
# until the bot switches target (this is what walking shots in corrects for) and a
# small fresh wobble on every shot (so it is never perfectly repeatable). Turn all
# four of these down to make bots deadlier, up to make them easier.
BOT_RANGE_ERR_ANGLE = 5.0      # deg of persistent per-target miscalibration
BOT_RANGE_ERR_POWER = 0.09     # fractional persistent per-target miscalibration
BOT_ANGLE_JITTER = 0.8         # deg of fresh random error on each shot
BOT_POWER_JITTER = 0.012       # fractional fresh random error on each shot
BOT_CORRECTION = 0.4           # how much of the last miss to walk back on the next shot
BOT_BIAS_DECAY = 0.6           # leak on the old correction (keeps it from wandering off)
BOT_MAX_STEP = 90.0            # px cap on a single correction step
BOT_MAX_BIAS = 220.0           # px cap on the accumulated walk-in correction
BOT_TNT_RANGE = 300.0          # only consider TNT when the target is at least this far
BOT_SPECIAL_CHANCE = 0.35      # chance of using a special when it fits
BOT_CHAOS_FIRE = (2.0, 3.0)    # chaos: seconds between shots
BOT_CHAOS_DRIVE = (0.25, 0.8)  # chaos: length of a driving burst
BOT_CHAOS_DRIVE_GAP = (1.5, 4.0)   # chaos: pause between driving bursts
BOT_SIM_MAX_STEPS = 220        # integration steps allowed for one simulated shot
BOT_SOLVE_STEP_BUDGET = 3500   # integration steps allowed for one whole firing solution
BOT_SOLVE_ANGLES = (22.0, 35.0, 48.0, 61.0, 74.0)   # coarse search, mirrored when aiming left
BOT_SOLVE_POWER_FRACTIONS = (0.0, 0.34, 0.67, 1.0)  # coarse search, of the power range

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
        if not has_human(room):
            # joining a room with no humans in it: joiner is effectively the host and
            # picks the mode. Any bots left over from the previous game are cleared
            # out (such a room is about to be swept anyway).
            for conn in [c for c, p in room['players'].items() if p['bot']]:
                room['players'].pop(conn, None)
            room['current_turn'] = None
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
        'bot': False,         # bots are ordinary players with a server-side brain
        'ai': None,           # bot controller state (see new_ai)
    }


def has_human(room):
    """A room lives only while a human is in it; bots must never keep one alive."""
    return any(not p['bot'] for p in room['players'].values())


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
        if p['bot']:
            bot_release(p)       # drop any keys the brain was holding
            p['prev_space'] = False
            p['ai'] = new_ai()   # forget aim corrections, timers and tracked shots
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


def projectile_origin(room, p, angle_deg):
    """Muzzle position for a shot from p at angle_deg (shared by live fire and bot sims)."""
    rad = math.radians(angle_deg)
    barrel_len = TANK_RADIUS + 14
    return (p['x'] + barrel_len * math.cos(rad),
            terrain_height_at(room, p['x']) - TANK_RADIUS - barrel_len * math.sin(rad))


def step_projectile(proj, dt):
    """Advance one projectile one step. The single source of truth for shot physics."""
    proj['vy'] += GRAVITY * dt
    proj['x'] += proj['vx'] * dt
    proj['y'] += proj['vy'] * dt


def fire_projectile(room, p, angle_deg, power, kind):
    rad = math.radians(angle_deg)
    origin_x, origin_y = projectile_origin(room, p, angle_deg)
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


# --- computer-controlled opponents ---------------------------------------------
#
# A bot is an ordinary entry in room['players'] (so it spawns, drives, takes
# damage, wins and resets like anybody else) driven by a server-side brain that
# writes the *same* input dict a real client would send. It never mutates game
# state directly: driving still spends move_left, firing still goes through the
# phase machine / cooldowns / ammo in tick().


class BotConn:
    """Stand-in for a WebSocket connection so a bot can be a key in room['players'].

    broadcast() calls send_text() on every player's conn; for a bot the state
    goes nowhere (there is no socket) and it can never raise, so the
    dead-connection sweep in broadcast() can never evict it.
    """

    __slots__ = ('bot_id',)

    def __init__(self, bot_id):
        self.bot_id = bot_id

    def send_text(self, text):
        return  # no socket: bot state is never serialized out

    def __repr__(self):
        return f'<BotConn bot {self.bot_id}>'


def new_ai():
    """Fresh brain state. Every timer here counts down in ticks, never wall clock."""
    return {
        'phase': None,          # classic turn phase this plan belongs to
        't': 0.0,               # seconds spent in the current phase
        'think': 0.0,           # seconds left of the "thinking" pause
        'planned': False,       # move phase: destination chosen?
        'goal_x': None,         # move phase: where we're driving to (None = stay put)
        'aimed': False,         # aim phase: angle/power already set from a solution?
        'aim_x': None,          # x the current solution was aimed at
        'bias': 0.0,            # px of walk-in correction carried into the next solve
        'bias_target': None,    # which target the bias was learned against
        'err_target': None,     # target the ranging miscalibration was drawn for
        'err_angle': 0.0,       # persistent aim error, deg
        'err_power': 0.0,       # persistent aim error, fraction of power
        'shot_aim_x': None,     # aim point of the shot in flight
        'shot_target': None,    # target id of the shot in flight
        'last_err': None,       # signed px error of the last observed impact
        'watch': None,          # our projectile, tracked until it disappears
        'watch_pos': None,      # its last seen position == impact point
        'pending_watch': 0,     # ticks left to latch onto a just-fired projectile
        'fire_wait': random.uniform(*BOT_CHAOS_FIRE),   # chaos: seconds until next shot
        'charge_hold': None,    # chaos: seconds left to hold space while charging
        'charge_want': None,    # chaos: power we are charging towards
        'driving': False,       # chaos: mid driving burst?
        'drive_dir': 0,
        'drive_t': 0.0,
    }


def parse_bot_request(raw):
    """Read the join message's optional "bots" field. Junk/missing -> 0, clamped to 0..2."""
    if raw is None or isinstance(raw, bool):
        return 0
    try:
        n = int(raw)
    except (TypeError, ValueError, OverflowError):
        try:
            n = int(str(raw).strip())
        except (TypeError, ValueError):
            return 0
    return max(0, min(BOT_MAX_PER_JOIN, n))


def add_bots(room, count):
    """Add up to `count` bots, silently ignoring anything past BOT_CAP for the room.

    Caller must hold state_lock. Returns the bots added.
    """
    existing = sum(1 for p in room['players'].values() if p['bot'])
    added = []
    for _ in range(max(0, min(count, BOT_CAP - existing))):
        pid = room['next_id']
        room['next_id'] += 1
        player = make_player(room, pid)
        player['bot'] = True
        player['ai'] = new_ai()
        player['name'] = f'Bot {pid}'
        room['players'][BotConn(pid)] = player
        added.append(player)
    if added:
        room['terrain_changed'] = True
        if room['current_turn'] is None:
            room['current_turn'] = min(p['id'] for p in room['players'].values())
            begin_turn(room)
    return added


def bot_release(p):
    """Let go of every key. A bot with no plan holds nothing."""
    inp = p['input']
    inp['left'] = inp['right'] = inp['up'] = inp['down'] = inp['space'] = False


def bot_press_space(p):
    """One-tick space pulse; returns True when the press will read as a fresh edge.

    tick() copies input['space'] into prev_space every tick, so a held key can
    never retrigger. If space is still down from the previous tick we release it
    here and press on the next one.
    """
    if p['prev_space'] or p['input']['space']:
        p['input']['space'] = False
        return False
    p['input']['space'] = True
    return True


def simulate_shot(room, p, angle_deg, power, max_steps=BOT_SIM_MAX_STEPS):
    """Fly a candidate shot offline against the live terrain.

    Uses the same integrator and terrain test as tick(), so a solution that
    clips a hill in front of the tank shows up as an impact right there.
    Returns (impact_x, impact_y, steps_used).
    """
    rad = math.radians(angle_deg)
    ox, oy = projectile_origin(room, p, angle_deg)
    proj = {'x': ox, 'y': oy, 'vx': power * math.cos(rad), 'vy': -power * math.sin(rad)}
    steps = 0
    while steps < max_steps:
        step_projectile(proj, TICK)
        steps += 1
        if proj['x'] < 0 or proj['x'] > WIDTH or proj['y'] > HEIGHT:
            break
        if proj['y'] >= terrain_height_at(room, proj['x']):
            break
    return proj['x'], proj['y'], steps


def bot_solve(room, p, aim_x, aim_y):
    """Search (angle, power) by simulation for the shot landing nearest the aim point.

    Coarse grid, then a small refinement around the best hit. The total number of
    integration steps is hard-capped by BOT_SOLVE_STEP_BUDGET so one solve can
    never stall the 30Hz loop. Returns (angle, power, miss_px).
    """
    toward_right = aim_x >= p['x']
    span = MAX_POWER - MIN_POWER
    state = {'budget': BOT_SOLVE_STEP_BUDGET, 'best': None}

    def try_shot(angle, power):
        if state['budget'] < 20:
            return
        angle = max(1.0, min(179.0, angle))
        power = max(MIN_POWER, min(MAX_POWER, power))
        ix, iy, steps = simulate_shot(room, p, angle, power,
                                      min(BOT_SIM_MAX_STEPS, state['budget']))
        state['budget'] -= steps
        miss = math.hypot(ix - aim_x, iy - aim_y)
        # never drop it on our own head when the target is somewhere else
        if abs(ix - p['x']) < TANK_RADIUS + EXPLOSION_RADIUS and abs(aim_x - p['x']) > 120:
            miss += 600.0
        best = state['best']
        if best is None or miss < best[2]:
            state['best'] = (angle, power, miss)

    for base in BOT_SOLVE_ANGLES:
        angle = base if toward_right else 180.0 - base
        for frac in BOT_SOLVE_POWER_FRACTIONS:
            try_shot(angle, MIN_POWER + span * frac)
    best = state['best']
    if best is not None:
        ba, bp = best[0], best[1]
        for da in (-6.5, 0.0, 6.5):
            for dp in (-span * 0.16, 0.0, span * 0.16):
                if da == 0.0 and dp == 0.0:
                    continue
                try_shot(ba + da, bp + dp)
    best = state['best']
    if best is None:   # budget starved: fall back to a plausible lob
        return ((45.0 if toward_right else 135.0), MIN_POWER + span * 0.5, float('inf'))
    return best


def bot_pick_target(room, p):
    """Nearest living opponent, ties going to the lowest HP. Free-for-all: bots included."""
    best, best_key = None, None
    for q in room['players'].values():
        if q is p or not q['alive']:
            continue
        key = (round(abs(q['x'] - p['x'])), q['hp'], q['id'])
        if best_key is None or key < best_key:
            best, best_key = q, key
    return best


def bot_aim_point(room, p, target):
    """Where to aim at `target`, shifted by whatever the last miss taught us."""
    ai = p['ai']
    bias = ai['bias'] if ai['bias_target'] == target['id'] else 0.0
    ax = max(5.0, min(float(WIDTH - 5), target['x'] + bias))
    return ax, terrain_height_at(room, ax) - TANK_RADIUS


def bot_note_impact(p, impact_x):
    """Walk the next shot in: correct for where the last one actually landed.

    A leaky integrator, not a plain sum: it converges on a real ranging error in
    two or three shots but cannot random-walk off the map chasing the per-shot
    wobble (an undamped version measurably gets *worse* the longer it shoots).
    """
    ai = p['ai']
    aim_x, tid = ai['shot_aim_x'], ai['shot_target']
    ai['shot_aim_x'] = None
    ai['shot_target'] = None
    if aim_x is None or tid is None:
        return
    err = impact_x - aim_x            # + == landed past/right of where we aimed
    if ai['bias_target'] != tid:
        ai['bias'] = 0.0
        ai['bias_target'] = tid
    step = max(-BOT_MAX_STEP, min(BOT_MAX_STEP, -err * BOT_CORRECTION))
    ai['bias'] = max(-BOT_MAX_BIAS, min(BOT_MAX_BIAS, ai['bias'] * BOT_BIAS_DECAY + step))
    ai['last_err'] = err


def bot_track_shot(room, p):
    """Follow our shot to its impact so bot_note_impact can learn from it."""
    ai = p['ai']
    if ai['pending_watch'] > 0:
        mine = [pr for pr in room['projectiles'] if pr['owner'] == p['id']]
        if mine:
            ai['watch'] = mine[-1]
            ai['watch_pos'] = (mine[-1]['x'], mine[-1]['y'])
            ai['pending_watch'] = 0
        else:
            ai['pending_watch'] -= 1
            if ai['pending_watch'] == 0:   # the shot never went out
                ai['shot_aim_x'] = None
                ai['shot_target'] = None
    watch = ai['watch']
    if watch is None:
        return
    if any(pr is watch for pr in room['projectiles']):
        ai['watch_pos'] = (watch['x'], watch['y'])
        return
    pos = ai['watch_pos']
    ai['watch'] = None
    ai['watch_pos'] = None
    if pos is not None:
        bot_note_impact(p, pos[0])


def bot_choose_weapon(p, dist):
    """Mostly the basic shell; a special only when it has the ammo and clearly fits."""
    if (p['ammo'].get('tnt', 0) > 0 and dist > BOT_TNT_RANGE
            and random.random() < BOT_SPECIAL_CHANCE):
        return 'tnt'
    return 'basic'


def bot_set_aim(room, p, target, weapon=None):
    """Solve, add human-sized error, and set the bot's weapon/angle/power."""
    ai = p['ai']
    if ai['err_target'] != target['id']:
        # new target: the bot is freshly miscalibrated against it and has to range in
        ai['err_target'] = target['id']
        ai['err_angle'] = random.uniform(-BOT_RANGE_ERR_ANGLE, BOT_RANGE_ERR_ANGLE)
        ai['err_power'] = random.uniform(-BOT_RANGE_ERR_POWER, BOT_RANGE_ERR_POWER)
    ax, ay = bot_aim_point(room, p, target)
    if weapon is None:
        weapon = bot_choose_weapon(p, abs(target['x'] - p['x']))
    if weapon != 'basic' and p['ammo'].get(weapon, 0) <= 0:
        weapon = 'basic'
    p['weapon'] = weapon
    angle, power, _miss = bot_solve(room, p, ax, ay)
    angle += ai['err_angle'] + random.uniform(-BOT_ANGLE_JITTER, BOT_ANGLE_JITTER)
    power *= 1.0 + ai['err_power'] + random.uniform(-BOT_POWER_JITTER, BOT_POWER_JITTER)
    p['angle'] = max(0.0, min(180.0, angle))
    p['power'] = max(MIN_POWER, min(MAX_POWER, power))
    ai['aim_x'] = ax
    ai['aimed'] = True
    return ax


def bot_move_goal(room, p):
    """Destination x for the move phase, inside the remaining budget. None = stay put."""
    budget = max(0.0, p['move_left'] - 4.0)
    if budget < 8.0:
        return None
    reachable = [c for c in room['crates'] if abs(c['x'] - p['x']) <= budget]
    if reachable:
        return min(reachable, key=lambda c: abs(c['x'] - p['x']))['x']
    if random.random() > BOT_MOVE_CHANCE:
        return None
    step = min(budget, random.uniform(*BOT_REPOSITION))
    goal = p['x'] + random.choice((-1.0, 1.0)) * step
    if goal < TANK_RADIUS + 20 or goal > WIDTH - TANK_RADIUS - 20:
        goal = p['x'] - (goal - p['x'])   # bounce off the map edge
    return max(float(TANK_RADIUS), min(float(WIDTH - TANK_RADIUS), goal))


def bot_classic(room, p):
    """Phase-aware turn: think, maybe drive, then aim and fire."""
    ai = p['ai']
    inp = p['input']
    if p['id'] != room['current_turn']:
        bot_release(p)
        ai['phase'] = None
        return

    phase = room['turn_phase']
    if phase != ai['phase']:      # new phase -> new plan
        ai['phase'] = phase
        ai['t'] = 0.0
        ai['think'] = random.uniform(*BOT_THINK)
        ai['planned'] = False
        ai['goal_x'] = None
        ai['aimed'] = False
    ai['t'] += TICK

    if phase == 'firing':
        bot_release(p)
        return

    # anti-stall: after this long in a phase, act no matter what
    forced = ai['t'] >= BOT_PHASE_TIMEOUT
    if ai['think'] > 0 and not forced:
        ai['think'] -= TICK
        bot_release(p)
        return

    if phase == 'move':
        if not ai['planned']:
            ai['planned'] = True
            ai['goal_x'] = bot_move_goal(room, p)
        goal = ai['goal_x']
        if (goal is not None and not forced and p['move_left'] > 1.0
                and abs(goal - p['x']) > 4.0):
            inp['up'] = inp['down'] = inp['space'] = False
            inp['left'] = goal < p['x']
            inp['right'] = goal > p['x']
            return
        bot_release(p)
        bot_press_space(p)        # done driving -> aim phase
        return

    # aim phase
    bot_release(p)
    target = bot_pick_target(room, p)
    if target is None:
        bot_press_space(p)        # nothing to shoot: fire anyway so the turn moves on
        return
    if not ai['aimed']:
        if p['cooldown'] > 0:
            return                # wait out the cooldown before burning a solve
        bot_set_aim(room, p, target)
    if bot_press_space(p):
        ai['shot_aim_x'] = ai['aim_x']
        ai['shot_target'] = target['id']
        ai['pending_watch'] = 4


def bot_chaos(room, p):
    """No phases in chaos: drive in bursts, re-solve and charge a shot every few seconds."""
    ai = p['ai']
    inp = p['input']
    inp['up'] = inp['down'] = False

    ai['drive_t'] -= TICK
    if ai['drive_t'] <= 0:
        if ai['driving']:
            ai['driving'] = False
            ai['drive_dir'] = 0
            ai['drive_t'] = random.uniform(*BOT_CHAOS_DRIVE_GAP)
        else:
            ai['driving'] = True
            ai['drive_dir'] = random.choice((-1, 1))
            ai['drive_t'] = random.uniform(*BOT_CHAOS_DRIVE)
    if ai['driving']:
        if p['x'] <= TANK_RADIUS + 6 and ai['drive_dir'] < 0:
            ai['drive_dir'] = 1
        elif p['x'] >= WIDTH - TANK_RADIUS - 6 and ai['drive_dir'] > 0:
            ai['drive_dir'] = -1
    # stand still while a shot is charging, or the barrel walks away from the solution
    rolling = ai['driving'] and ai['charge_hold'] is None
    inp['left'] = rolling and ai['drive_dir'] < 0
    inp['right'] = rolling and ai['drive_dir'] > 0

    target = bot_pick_target(room, p)
    if target is None:
        inp['space'] = False
        ai['charge_hold'] = None
        return

    if ai['charge_hold'] is not None:
        # holding space: the server ramps power up from MIN_POWER. Release once we
        # have held long enough for the power we want (or it has already got there).
        ai['charge_hold'] -= TICK
        want = ai['charge_want'] or MAX_POWER
        if ai['charge_hold'] <= 0 or p['power'] >= want - 1.0:
            inp['space'] = False          # release -> tick() fires the charged shot
            ai['charge_hold'] = None
            ai['charge_want'] = None
            ai['fire_wait'] = random.uniform(*BOT_CHAOS_FIRE)
            ai['shot_aim_x'] = ai['aim_x']
            ai['shot_target'] = target['id']
            ai['pending_watch'] = 4
        else:
            inp['space'] = True
        return

    inp['space'] = False
    ai['fire_wait'] -= TICK
    if ai['fire_wait'] > 0:
        return
    # pick the weapon before solving: if it is still cooling down, wait a moment
    # rather than burning a firing solution every single tick
    weapon = bot_choose_weapon(p, abs(target['x'] - p['x']))
    if p['wcd'].get(weapon, 0) > 0:
        ai['fire_wait'] = 0.2
        return
    bot_set_aim(room, p, target, weapon)
    want = max(MIN_POWER + 8.0, p['power'])
    ai['charge_want'] = want
    ai['charge_hold'] = min(1.25, max(TICK, (want - MIN_POWER) / CHARGE_RATE))
    inp['space'] = True


def bot_control(room, p):
    """One tick of a bot's brain, run just before tick() consumes player input."""
    ai = p['ai']
    if ai is None:
        ai = p['ai'] = new_ai()
    bot_track_shot(room, p)
    if not p['alive']:
        bot_release(p)            # dead bots do nothing at all
        ai['phase'] = None
        ai['charge_hold'] = None
        ai['charge_want'] = None
        return
    if room['mode'] == 'chaos':
        bot_chaos(room, p)
    else:
        bot_classic(room, p)


def tick(room):
    dt = TICK
    chaos = (room['mode'] == 'chaos')
    players = room['players']
    projectiles = room['projectiles']
    crates = room['crates']
    fires = room['fires']

    # bots write their input first, so it is consumed by the same code paths as a
    # real client's input in the very same tick
    for p in list(players.values()):
        if p['bot']:
            bot_control(room, p)

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
        step_projectile(proj, dt)

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
            'bot': bool(p['bot']),
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
            if not p['bot']:   # a bot has no socket, so it can never be a dead conn
                dead.append(conn)
    for conn in dead:
        players.pop(conn, None)


def game_step():
    """One iteration of the game loop: drop humanless rooms, then tick + broadcast."""
    with state_lock:
        for code in list(rooms):
            room = rooms[code]
            if not has_human(room):
                # bots must never keep a room alive; normally deleted when the
                # last human leaves, this is the defensive sweep
                del rooms[code]
                continue
            tick(room)
            broadcast(room)


def game_loop():
    next_tick = time.monotonic()
    while True:
        game_step()
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
    add_bots(room, parse_bot_request(join_msg.get('bots')))
    welcome = json.dumps({'type': 'welcome', 'id': pid, 'color': player['color'],
                          'width': WIDTH, 'height': HEIGHT,
                          'mode': room['mode'], 'room': room['code']})
    terrain_msg = json.dumps({'type': 'terrain', 'terrain': room['terrain']})
    return room, player, welcome, terrain_msg


def leave_room(conn, room, player):
    """Remove a player from its room; delete the room once no humans are left.

    Bots are members of room['players'], so emptiness is the wrong test: a
    bot-only room would tick forever. Caller must hold state_lock.
    """
    room['players'].pop(conn, None)
    if player['id'] == room['current_turn'] and room['turn_phase'] in ('move', 'aim'):
        advance_turn(room)
    if not has_human(room):
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
