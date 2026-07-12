# SPOOLBASE

[#spoolbase](#spoolbase)

A free, standalone filament inventory tracker for 3D printing hobbyists — no
installation, no server, no account. Track your spools and log consumption
after every print, right from your browser.

## Why it exists

[#why-it-exists](#why-it-exists)

Keeping tabs on filament brands, materials, colors and how much is actually
left on each spool gets messy fast once you're juggling more than a couple
of rolls. SPOOLBASE Core is a lightweight, single-file answer: open the
`.html` file in any browser and you're tracking spools in under a minute —
no signup, no backend, no dependency on anyone else's server.

## Key features

[#key-features](#key-features)

- **📦 Spool inventory** — add, edit, and delete spools: brand, material,
  color, diameter, total and remaining weight, optional price per kg.
- **📉 Usage log** — record grams used after every print, with a full,
  per-spool history.
- **🚦 Automatic status** — new / opened / low stock / depleted, computed
  from remaining weight.
- **💰 Estimated stock value** — based on optional price-per-kg per spool.
- **🎯 A sensible material list for hobbyists** — PLA, PLA+, PETG, ABS, ASA,
  TPU, PC, Nylon (PA), Other. No industrial-catalogue clutter.
- **💾 Versioned JSON backup/restore**, with a reminder if you haven't
  exported one in over a week.
- **🌓 Light/dark theme.**

## Usage

[#usage](#usage)

No installation needed: just open `SPOOLBASE.html` in a browser. Data is
saved to your browser's `localStorage` (per browser/device) — export a JSON
backup regularly from the header so you don't lose anything.

When used as a Claude.ai artifact, data is instead saved to your Claude
account through the built-in storage API, with the exact same file working
in both modes without any changes.

## Tech stack

[#tech-stack](#tech-stack)

Vanilla JavaScript, HTML, CSS. No external libraries, no bundler, no build
step, no CDN dependencies: a single file to open and use.

## Want more?

[#want-more](#want-more)

SPOOLBASE Core covers spool tracking. For a full printer-fleet management
system — real-time printer monitoring, multi-user accounts with isolated
data, managed automatic backups, and more — check out **SpoolBase Hosted**,
a fully managed version with nothing to install.

---

## Changelog

[#changelog](#changelog)

### v2.0 — Core release

[#v20-core-release](#v20-core-release)

**Focused the app on one job done well**

- Narrowed the scope to spool inventory and usage tracking — the part of
  the original app people actually used every day.
- Printer fleet, customers, orders, quotes, and P&L have moved to
  **SpoolBase Hosted**, a separate managed product.

**New: hybrid storage**

- Works standalone with `localStorage`, or as a Claude.ai artifact through
  Claude's built-in storage — the same file adapts automatically, no
  configuration needed.

**New: visual design**

- Redesigned interface with a signature circular gauge per spool, light/dark
  theme, fully responsive down to mobile.

**License change**

- Switched to MIT to match the standalone, no-server nature of this tool.

### v1.1 (previous scope)

[#v11-previous-scope](#v11-previous-scope)

Full order pipeline, customer profiles, print cost calculator, and P&L
dashboard — this broader feature set now lives in SpoolBase Hosted.

### v1.0

[#v10](#v10)

First stable version: filament inventory, printer fleet, spare parts,
customers, print cost calculator with printable quotes, and a P&L dashboard
based on a simple flat sales log.

## License

MIT — see [`LICENSE`](./LICENSE).
