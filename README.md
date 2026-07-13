# Tanks

8-bit multiplayer artillery tanks with destructible terrain, rooms, two game
modes (classic turn-based / chaos free-for-all), five weapons with ammo crate
pickups, and 1-or-2-players-per-device support. Python stdlib server (no
dependencies), HTML5 canvas client, HTTP + WebSocket on a single port.

## Run locally

```bash
python3 server.py
```

Open http://localhost:8080 — share your LAN IP (printed at startup) with
players on the same network. Create a room and share the 4-letter code.

## Deploy free on Render

1. Push this folder to a GitHub repo.
2. On https://render.com: New → Web Service → connect the repo.
3. Render reads `render.yaml` automatically (free plan, `python server.py`).
4. Share the `https://<your-app>.onrender.com` URL. Friends join with your
   room code, or send them a direct invite link:
   `https://<your-app>.onrender.com/?room=ABCD`

Note: the free tier sleeps after ~15 min idle; the first visit after that
takes ~1 minute to wake.
