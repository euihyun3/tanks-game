# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

8-bit multiplayer artillery tanks (Worms/Scorched Earth style): destructible
terrain, room-based matches with 4-letter join codes, two game modes (classic
turn-based / chaos free-for-all), five weapons with ammo crate pickups,
1-or-2-players-per-device, and up to 3 server-driven bot opponents per room.
Python stdlib server (zero dependencies), vanilla HTML5 canvas + JS client, a
single port serves both HTTP and a hand-rolled WebSocket.

## Running it

```bash
python3 server.py             # serves http://localhost:8080 (PORT env var overrides)
```

There is no build step, package manager, test suite, or linter in this repo —
`requirements.txt` is intentionally empty ("stdlib only — nothing to
install"). Verify a change by running the server and driving it through a
browser (or two browser tabs / windows to exercise multiplayer).

Deploys to Render via `render.yaml` (`pip install -r requirements.txt` then
`python server.py`); the free tier sleeps after ~15 min idle.

## Architecture

### Everything server-authoritative, one file

`server.py` is the entire backend: game simulation, bot AI, room/session
management, and a minimal WebSocket implementation, all stdlib-only (socket,
threading, hashlib/base64 for the WS handshake, struct for frames). There is
no framework. The client (`public/`) is a thin renderer + input forwarder —
it never simulates gameplay itself except for a client-side aim-preview arc
(mirrored physics constants, used only for the dotted trajectory dots) and
purely cosmetic explosion particles/tank tilt.

- **One global lock.** `state_lock` (a single `threading.Lock`) guards
  `rooms` and all room state. Every read or mutation of a room — from a
  client's WS thread or from the game loop — happens under it. Any new
  server-side state must go through this lock too.
- **Game loop.** A single background thread (`game_loop`) ticks every room at
  30Hz (`TICK = 1/30`): `game_step()` takes the lock, drops any room with no
  human in it, then calls `tick(room)` (physics/turns/bots) and
  `broadcast(room)` (push state to every connection) for the rest. Per-client
  WS threads only mutate `player['input']`/`weapon` — they never touch
  physics directly.
- **Connections as socket threads.** `run_server()` accepts on a raw
  `socket.socket` and spawns one daemon thread per client
  (`handle_connection`). That thread does the raw HTTP-vs-WebSocket sniff
  (looks for an `Upgrade: websocket` header), either serves a static file
  from `public/` or performs the WS handshake and hands off to
  `handle_ws_client`, which loops reading frames (`decode_frame`) until a
  `join` message arrives, then forwards every subsequent frame into
  `player['input']`.

### Rooms

A room (`rooms: code -> room dict`, see `make_room`) owns its own terrain,
player set, projectiles, crates, fires, and turn state. `get_or_create_room`
either joins an existing code or mints a fresh 4-letter one
(`new_room_code`, alphabet excludes I/O). **A room lives only while it has a
human** (`has_human`) — bots never keep one alive; `leave_room` deletes it
once the last human quits, and `game_step` sweeps any bot-only room as a
defensive backstop. Joining an already-bot-populated-but-humanless room
clears the bots and lets the new joiner re-pick the mode (see
`get_or_create_room`).

### Two modes, one tick loop

`room['mode']` is `'classic'` or `'chaos'`, chosen at room creation and fixed
for the room's lifetime (`tick()` branches on it throughout):

- **Classic**: strict turn order, phase machine per active player —
  `move` (drive on a `MOVE_BUDGET` px allowance) → `aim` (angle/power held
  keys) → `firing` (shot resolves, no input). `advance_turn` walks player ids
  in a ring. Power persists per player across turns; the move budget resets
  each turn (`begin_turn`).
- **Chaos**: no turns or phases — everyone drives, aims, and fires
  simultaneously. Firing is hold-to-charge (`CHARGE_RATE`) and per-weapon
  cooldowns (`CHAOS_COOLDOWNS`) gate each shot instead of a global cooldown.

Both modes share the same projectile physics (`step_projectile`,
`fire_projectile`), terrain deformation (`explode`), weapon table
(`WEAPONS`), and win/reset flow (last tank standing → `RESET_DELAY` → `reset_round`
regenerates terrain and respawns everyone).

### Terrain

A 1D heightmap: `terrain[x]` for `x` in `0..WIDTH` (midpoint-displacement
fractal, `generate_terrain`). Tanks and projectiles read/write it through
`terrain_height_at`. `explode()` is the single place terrain gets carved —
projectile impacts, not player actions directly, deform it and flag
`room['terrain_changed']` so `broadcast` knows to push a fresh `terrain`
message (sent separately from the high-frequency `state` message since it's
comparatively large and rarely changes).

### Weapons, ammo, crates, fire

`WEAPONS` is the source of truth for per-shot `radius`/`damage`. `basic` is
unlimited; the other four (`AMMO_WEAPONS`) draw from `player['ammo']`,
auto-reverting to `basic` when a weapon runs dry (`consume_ammo`). Crates
spawn periodically near a living tank (`CRATE_INTERVAL`) and top up ammo on
proximity pickup. `flame` shells leave burning terrain cells (`room['fires']`)
that tick down and damage any tank standing in them — independent of the
turn/phase system in classic mode.

### Bots

A bot is **not a special code path** — it's an ordinary entry in
`room['players']` keyed by a `BotConn` stand-in (implements `send_text` as a
no-op so `broadcast`'s dead-connection sweep can never evict it) whose input
dict is written by a server-side brain (`bot_control`, called once per tick
per bot, before human input is consumed) instead of a socket. From there it
goes through the exact same phase/cooldown/ammo/movement code every human
player does.

- `bot_classic` / `bot_chaos` hold per-mode behavior (drive, pick a target,
  aim, fire) driven by an AI state blob from `new_ai()`.
- Aim solving (`bot_solve`) forward-simulates candidate (angle, power) pairs
  against the live terrain with the same integrator `tick()` uses
  (`simulate_shot`/`step_projectile`), coarse-grid then refines around the
  best hit, under a hard step budget (`BOT_SOLVE_STEP_BUDGET`) so a solve can
  never stall the 30Hz loop.
  - Bots are deliberately imperfect and adaptive: a persistent per-target
    miscalibration (`err_angle`/`err_power`, redrawn on target switch) plus
    fresh per-shot jitter, corrected over subsequent shots by a leaky
    walk-in bias (`bot_note_impact`/`bot_track_shot`) that "learns" the miss
    without ever fully converging or random-walking away. The `BOT_*` tuning
    constants near the top of `server.py` are the knob set for difficulty.
- `join_room`'s `bots` field (clamped `0..BOT_MAX_PER_JOIN`, room-wide cap
  `BOT_CAP`) is the only entry point for adding bots.

### Wire protocol (WebSocket, JSON text frames)

Client → server:
- `{"type": "join", "room", "mode", "name", "color", "bots"}` — first message
  on every connection; server replies `welcome` (assigns id/color/room) then
  an initial `terrain`.
- `{"type": "weapon", "weapon}` — switch weapon (rejected if out of ammo).
- `{"left"/"right"/"up"/"down"/"space": bool}` — held-key state, sent on every
  change (see `game.js`'s `send()`); the server does not distinguish edges
  itself except for `space` (`prev_space` tracks the down→up/up→down edge for
  fire/charge semantics).

Server → client, every tick from `broadcast()`:
- `state` — full snapshot (players, projectiles, crates, fires, turn/phase,
  winner). Sent every tick to every connection.
- `terrain` — full heightmap array, sent only when `terrain_changed` is set
  (i.e., right after something deforms it), not every tick.

If you change either message's shape, update both `server.py` (`join_room`,
`broadcast`) and the corresponding client-side parsing in `game.js`
(`sock.onmessage`) together — there's no schema shared between them.

### Client (`public/`)

- `game.js` — everything: join-screen wiring, WebSocket session management
  for 1 or 2 local players (`locals[]`, each with its own socket; P1's
  connection is authoritative for shared world state, see `isLive`/
  `sessionId` for how a quit invalidates in-flight callbacks from a stale
  socket), input → key handling, and the render loop (`requestAnimationFrame`
  `draw()`). No modules, no bundler — plain `<script>` tags in `index.html`.
- Rendering is deliberately low-res-then-upscaled for the chunky 8-bit look:
  gameplay draws into an offscreen low-res canvas (`off`/`ctx`, `SCALE = 2`
  world px per low-res px) that's blitted to the visible canvas with
  `imageSmoothingEnabled = false`; a separate hi-res pass (`drawHiRes`) draws
  text/HUD directly on the visible canvas afterward so labels stay crisp.
  Terrain is pre-rendered to its own offscreen buffer (`tCan`/`tctx`,
  `renderTerrain`) and only redrawn when a new `terrain` message arrives.
- `sounds.js` — `window.SFX`, synthesized chiptune effects via raw Web Audio
  (square/triangle oscillators + a noise buffer), no audio files. Must be
  unlocked by `SFX.init()` from a user gesture before anything plays.
- Physics constants (`GRAVITY`, `MIN_POWER`/`MAX_POWER`, `TANK_RADIUS`, move
  budget, etc.) are duplicated in `game.js` to drive the client-only aim
  preview arc. Keep these in sync with `server.py` by hand — the server
  never sends them.

## Conventions worth preserving

- No dependencies beyond the stdlib on the server. Think hard before adding
  one; `requirements.txt` being empty is a stated design choice, not an
  oversight.
- All shared game state changes happen under `state_lock`; never mutate a
  `room` dict outside it.
- Keep server and client physics/weapon constants numerically identical when
  changing one — the server is authoritative for gameplay, but the client's
  copies drive the aim-preview arc and will visibly diverge if they drift.
- A bot must stay indistinguishable from a human at the `tick()` level: give
  it a brain that only ever writes `player['input']` (and `weapon`/`angle`/
  `power` the same fields a human player's fields would end up at), never a
  bot-only shortcut through the physics/phase/ammo code.
