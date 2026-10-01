# SpoolBase Self-Hosted

SpoolBase Lite as a self-hosted app: filament inventory, printer fleet
and spare parts, with a small Node.js + SQLite backend that also serves the
frontend. Run it on your own machine - no subscription, no third party, your
data stays on your hardware.

Orders, customers, quotes and the P&L dashboard are **not** part of the Lite
version. If you just want simple offline spool tracking with zero setup, use
**SpoolBase Core** (`../SPOOLBASE.html`); for the managed version see the
main [README](../README.md).

## Requirements

- Node.js 18+ and npm
- A machine that can stay on (a Raspberry Pi, a home server, a small VPS —
  anything that can run Node.js continuously)

## Setup

```bash
cd self-hosted
npm install
SINGLE_USER=1 node server.js     # single-user, no API key
# open http://127.0.0.1:3001/
```

The backend serves `frontend.html` itself on `GET /` (same origin as the
API, no reverse proxy needed). No other file of the folder is served.

**npm 12 note:** npm 12 blocks install scripts, so `better-sqlite3` is not
compiled and the server fails to start. Run
`npm install-scripts approve better-sqlite3` and then
`npm rebuild better-sqlite3`, or use npm <= 10.

### Single-user mode (`SINGLE_USER=1`)

For personal use. No API key is required: every request is attributed to
the admin user (created automatically if missing, no key printed) and the
frontend does not ask for a key. If `HOST` is not `127.0.0.1`/`localhost`
the server prints a warning: **anyone on the network can then read and write
your data.** Keep the default `HOST=127.0.0.1` unless you trust your network.

### Multi-user mode (default, `SINGLE_USER` unset)

On first run, since there are no users yet, the server creates an admin
account and prints its API key **once**:

```
========================================================
 Nessun utente trovato: creato il primo utente admin.
 Username: admin
 API key:  <a long random hex string>
========================================================
```

**Copy that API key now.** Open `http://127.0.0.1:3001/` and paste it when
the frontend asks for it.

## Configuration (environment variables)

All optional — sensible defaults are used if unset.

| Variable | Default | Purpose |
|---|---|---|
| `SINGLE_USER` | unset | Set to `1` to disable API keys (single-user mode, see above) |
| `PORT` | `3001` | Port the backend listens on |
| `HOST` | `127.0.0.1` | Bind address — keep on `127.0.0.1` and put a reverse proxy (nginx, Caddy, Cloudflare Tunnel) in front if exposing to the internet |
| `DB_PATH` | `./spoolbase.db` | SQLite database file location |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Base URL used to build activation/reset links — set this to your real public URL if exposing the app externally |
| `BOOTSTRAP_ADMIN_ID` | `admin` | Username for the auto-created first admin |
| `BOOTSTRAP_ADMIN_NAME` | `Admin` | Display name for the auto-created first admin |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | unset | Optional: get a Telegram notification on new signup requests |
| `DASHBOARD_CALENDAR_URL` | unset | Optional: POST new orders to an external calendar webhook you control |
| `PRINTER_IP_BLOCKLIST` | unset | Optional comma-separated list of your own LAN IPs (router, NAS, etc.) to exclude from the printer-IP field, e.g. `192.168.0.1,192.168.0.10` |

## Adding more users (multi-user mode only)

New users self-register at the frontend's sign-up form, which creates a
pending request. As an admin (logged in with the admin API key or the
password you set via `/api/auth/set-password`), approve it from the admin
panel — this generates a fresh API key/activation link for that person.
Every user's data is isolated; nobody can see another user's spools
or printers.

## Security notes

- The backend binds to `127.0.0.1` by default — it is **not** reachable
  from your LAN or the internet until you put something in front of it
  (reverse proxy, tunnel). Add authentication at that layer too if exposing
  it publicly (e.g. Cloudflare Access) — the app's own login is a second
  layer, not a substitute for network-level protection on servers you
  actually expose.
- API keys and session tokens are the only secrets this app has — there is
  no separate master password. Treat a leaked API key as a leaked account:
  revoke it via the admin panel and issue a new one.
- `PRINTER_IP_BLOCKLIST` and printer IPs are restricted to private LAN
  ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) as a basic SSRF
  guard — printers should never need a public IP here.
