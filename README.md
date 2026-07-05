# SPOOLBASE

A management tool for small 3D printing businesses — filament inventory, printer fleet,
spare parts, customers, quotes, order pipeline and P&L, all in **a single standalone HTML
file**, no server, no external dependencies, no framework.

Built for anyone running a small printer fleet (in my case: 1× Creality K2 Plus, 2× Creality
K1C) who wants to keep stock, costs and earnings under control without installing anything.

## Why it exists

Between filament spools of different brands/materials/colors, maintenance parts, customer
quotes and end-of-month accounting, a spreadsheet gets unmanageable fast. SPOOLBASE is a
lightweight alternative: a single `.html` file that opens in any browser, saves data locally,
and carries all the calculation logic (material cost, waste margin, depreciation, VAT) with
no backend required.

## Key features

- **📦 Filament inventory** — full CRUD, automatic grouping of identical spools, automatic
  status (new / opened / depleted), distinct visual highlighting for low-stock and depleted
  spools, consumption log.
- **🖨 Printer fleet** and **🔧 Maintenance parts** — inventory with minimum thresholds and
  purchase history.
- **👤 Customers** — profile with order history, amount collected, and outstanding credit.
- **🧮 Print cost calculator** — internal cost (with a safety waste margin) vs. customer quote
  (with commercial markup and configurable VAT), multi-spool and multi-printer support,
  printable quote document.
- **📋 Orders** — full status pipeline (*quote generated → sent to customer → accepted →
  printing → post-processing → ready → delivered → paid*), outstanding credit tracked
  separately from actual cash collected, delivery due dates with overdue alerts, a rolling
  7-day upcoming-deliveries summary, and a direct link between an order and the actual
  filament consumed from inventory.
- **💰 P&L dashboard** — revenue only counted on actual payments received, material/parts/
  depreciation costs, monthly margin.
- **⚙️ Settings** — cost parameters, business details for quotes, configurable and
  auto-calculated VAT, light/dark theme.
- **Versioned JSON backup**, with an automatic reminder if you haven't exported one in a while.

## Usage

No installation needed: just open the `.html` file in a browser. Data is saved to
`localStorage` (only on that browser/device) — export a JSON backup regularly from the
Filaments page so you don't lose anything (the app reminds you on its own after a week).

When used as a Claude.ai artifact, data is instead saved to your Claude account through the
built-in storage API, with the exact same file working in both modes without any changes.

## Tech stack

Vanilla JavaScript, HTML, CSS. No external libraries, no bundler, no build step: a single
file to open and use. Charts and calculations are hand-rolled, with no CDN dependencies.



---

## Changelog

### v1.1

**New: full order pipeline**
- Dedicated Orders page with statuses (quote generated → sent → accepted → printing →
  post-processing → ready → delivered → paid) plus a cancelled status.
- Create an order from the print cost calculator, or manually without going through it.
- Edit an order at any time (customer, description, amounts, notes).
- Outstanding credit tracked separately from actual cash collected, both in the P&L
  dashboard and on customer profiles.
- Expected delivery date with automatic overdue/due-today alerts, plus a badge for orders
  stuck too long in the same status.
- "Upcoming deliveries" summary on a rolling 7-day window.

**New: order ↔ inventory link**
- The quote saves the planned materials (spool + grams) onto the order.
- Actually deducting stock from inventory is an explicit, traceable action linked to the
  order in the consumption log, with a warning if the available weight isn't enough or the
  spool no longer exists.

**New: Settings page**
- Cost/quote parameters, business details, configurable VAT rate.
- VAT automatically calculated on orders based on the configured rate.
- Persistent light/dark theme.
- Language selector (English scaffolded in, not translated yet).

**Robustness improvements**
- Distinct visual highlighting between low-stock and fully depleted spools.
- Warning when deleting a spool that's still referenced as planned material on an order.
- Periodic backup reminder (banner shown if no backup has been exported in over 7 days).
- Automatic, backward-compatible migration of data from the old "direct sale" format to the
  new order pipeline.

**Bugfixes**
- Fixed a bug in the delivery-delay calculation (it compared timestamps instead of calendar
  dates).
- Fixed a bug in the delivery summary that completely hid a next-day delivery whenever the
  current day was a Sunday.

### v1.0

First stable version: filament inventory, printer fleet, spare parts, customers, print cost
calculator with printable quotes, P&L dashboard based on a simple flat sales log.
