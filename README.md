# TikTok LIVE Gift-Only Chat Reader

Shows only users whose gift is `coins >= Minimum Coins`, together with their latest chat message.
Data source: **Euler Stream** (WebSocket `wss://ws.eulerstream.com`, gift catalog & user API), used the same way as in the reference ZIP (`server.mjs`). No fake APIs.

## Structure
```
gifts.mjs         Gift image resolver (StreamToEarn, from the reference ZIP)
server.mjs        Express + Socket.IO + Euler WebSocket client
public/           index.html, app.js, styles.css
start.bat         Windows launcher (localhost:3000)
Procfile, railway.json, package.json
```
Dependencies: `express`, `socket.io`, `ws` (Node.js 18+).

## Localhost (Windows)
Double-click `start.bat` → dependencies install automatically → open http://localhost:3000.

## Manual
```
npm install
npm start
```
Open http://localhost:3000 (change the port: `PORT=4000 npm start`).

## Railway
1. Push this folder to GitHub (without `node_modules`).
2. Railway → New Project → Deploy from GitHub repo.
3. The start command is picked up automatically (`Procfile` / `railway.json`: `node server.mjs`). The server listens on `0.0.0.0:$PORT`.
4. Settings → Networking → Generate Domain.
5. Health check: `/health`.

### Environment variable
| Var | Required | Description |
|---|---|---|
| `PORT` | set automatically by Railway | default 3000 |
| `MAX_SESSIONS` | no | max concurrent connections (default 50) |

The Euler Key is **not** stored in the environment/server; it is entered from the UI.

## Usage
1. Enter your **Euler Key** (from eulerstream.com) and the **TikTok LIVE Username**, then set **Minimum Coins**.
2. Click **CONNECT** (the LIVE must be running).
3. **SAVE** saves manually; **Auto Save** saves on every change. Data is restored the next time you open the page.

> The Euler Key is stored only in your browser's `localStorage` (never on the server/disk). The server keeps it in memory only while the connection is active. Don't use Auto Save on a shared computer.

## Behavior
- **Combo = 1 card.** A 4x Rose combo shows as `4× Rose • 4 Coins` on a single card that gets updated (not 4 cards). The server sends the cumulative total per `comboId`.
- The filter uses total coins (`coins per gift × quantity`); a new card appears once the combo total ≥ Minimum Coins.
- **Effect tiers** (total coins per card): 10, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000 — each with its own username/border/glow color
  (blue, gold, fire, pink, emerald, royal purple, neon, inferno, rainbow, prism, legend, mythic), plus shine, sparkle, a spinning rainbow ring, crown, particles, banner, and a screen flash for 2000.
- **Anti-lag:** only `transform/opacity` are animated, continuous animation runs only on the 8 newest cards, particles share a single canvas (max 420, loop stops when empty), and `prefers-reduced-motion` is respected.
- **COPY** copies the chat text. **DELETE** removes the card and ignores the user (an ongoing combo won't reappear). **RESET ALL** removes all cards.
- Max 300 cards, events deduplicated via msgId, errors shown as toasts, auto-reconnect.

## Extra UI features
- **Live coin counter** — the total coins count up/down with an animation.
- **Session timer** — connection duration (HH:MM:SS); stops on disconnect, resets on a new manual CONNECT, and continues across automatic reconnects.
- **Sort / filter toolbar** — sort by *Newest* / *Oldest* / *Top coins*, and filter by gift (the dropdown fills automatically from incoming gifts).
- **Sound toggle** — a "cha-ching" effect (synthesized with WebAudio, no audio files) on every incoming gift; 🔊/🔇 button in the toolbar, choice is remembered. High tiers get an extra bell.
- **Pin** — a PIN button on every card; all cards of that user move to a dock above the list (they don't scroll away or get evicted by the 300-card limit), and new gifts from a pinned user go straight to the dock.
- **"New" highlight** — new or updated cards glow briefly in their tier color.
- **Entrance animation** — new cards grow from small with a bounce, the gift icon and avatar pop in right after; the bigger the gift tier, the stronger the entrance.
