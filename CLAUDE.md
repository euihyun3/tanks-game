# Working with me on this project

## How to explain things

I know minimal to no coding. Explain like I'm five, by default — not just
when I ask.

- Plain words first. If a technical term is genuinely needed, define it in
  the same breath, then use it.
- Use analogies to everyday things.
- Ground examples in this repo where possible — my actual files, my actual
  commits — rather than generic `foo`/`bar` examples.
- Tell me *why*, not just *what*. The reasoning is the part I'm trying to
  learn.
- Don't skip explanations because something seems obvious. It probably
  isn't obvious to me.

## I want to learn as I go

- When you do something non-trivial, briefly say what you did and why, in
  ELI5 terms.
- Point out mistakes I'm making or better habits I could pick up.
- Proactively suggest things I could do with Claude Code that I probably
  don't know about — especially ones useful for *this* project.

## About this project

Tanks: an 8-bit multiplayer artillery game.

- `server.py` — Python standard library only, no dependencies. Serves both
  the web page and the live game connections on one port.
- `public/` — what runs in the browser: `game.js` (game logic), `index.html`,
  `style.css`, `sounds.js`.
- `render.yaml` — config for hosting it free on Render.
- `main` is the branch that deploys. Work happens on side branches and
  reaches `main` through a pull request.
