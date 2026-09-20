# Stock Tracker

Barcode inventory, rentals and PAT tracking for an events / power / lighting / sound hire company.

## Run it (Docker)

```bash
docker compose up -d --build
```

Open `http://<server>:3000`. Data lives in the `inventory-data` Docker volume (SQLite), so it survives rebuilds.

Settings are in `docker-compose.yml`:

| Variable | Purpose |
|---|---|
| `COMPANY_NAME` | Name on exported PDFs and in the sidebar (default `FaderUp`) |
| `LOGO_PATH` | Optional. Logo for the PDF header; default is the bundled `server/assets/FaderUp-Logo-white.png`. It sits directly on the dark blue header, so it should be **white with a transparent background**. To change it, replace that file and rebuild |
| `TZ` | Time zone (matters for PAT "due" dates), default `Europe/London` |
| `BARCODE_DIGITS` | Barcode width, default `5` (`00001`). Numeric codes shorter than this are padded with leading zeros; `0` turns padding off |
| `AUTH_USER` / `AUTH_PASS` | Optional. Set both to require a login (basic auth). **Do this if the server is reachable from the internet, and put it behind HTTPS.** |

**Backups:** the *Backup* button (bottom of the sidebar) downloads a copy of the database. To restore, stop the container and copy the file to `/data/inventory.db` in the volume.

If you swap the named volume for a bind mount (`./data:/data`), make the folder writable by uid 1000 (`chown 1000:1000 data`), because the container runs as the unprivileged `node` user.

## Scanning

A USB / Bluetooth barcode scanner works like a keyboard: it types the code and presses Enter. The app listens for that on **every page**, so nothing needs to be focused. (Typing into a form field is left alone.) Use the mode buttons in the bar at the top, or press **Esc** to go back to Lookup:

| Mode | What a scan does |
|---|---|
| **Lookup** | Opens the item / container |
| **Scan OUT** | Adds the item to the selected rental. Opening a rental page selects this mode for you. Scanning a *container* adds everything inside it |
| **Return** | Returns the item to active inventory. Works on any page, no rental needed. Also restores Lost / Disassembled items |
| **Store** | Puts the item in the selected container (opening a container page selects this). Scanning a container barcode switches the target container |
| **PAT test** | Records a pass or fail (chosen in the bar) for today |

Each outcome has its own sound (open **Sound** in the bar to hear them all): out, return, store, found, PAT pass, PAT fail, lookup, duplicate/warn, blocked, unknown barcode, and "out but PAT needs attention".

Rules: an item must be scanned OUT onto a rental (an unknown barcode can be added straight from the scan bar). Items that are lost, disassembled, in repair, PAT-failed, or already out on another rental are blocked from going out.

## Barcodes

Barcodes are zero-padded numbers like `00001`, shared by items and containers (a code can only belong to one thing). Because spreadsheets and hand-typing drop leading zeros (`12` instead of `00012`), any all-digit code shorter than 5 digits is padded back automatically. That applies to typing, scanning, bulk add and CSV import, so `12` and `00012` are the same barcode.

## Features

- **Items:** category → type (Power: cable/adapter/splitter; Lighting: cable/light/unit; Sound: cable/audio), male & female connector for cables/adapters/splitters, length, description
- **Inventory:** search across every field, sort by any column, filters, CSV export
- **Bulk add:** scan or paste barcodes, generate a numbered range (e.g. 00101–00150), or import a CSV
- **Rentals:** create, scan items in and out, complete/reopen, and export two PDFs from the rental page:
  - **Internal PDF**: every item with its barcode, PAT date and a return tick-box. Sorted by type, then male end, female end, length and description, so identical kit sits together rather than in barcode order
  - **Client PDF**: no barcodes, PAT dates or notes. Identical items are combined into one line with a quantity (4 × 10m 16A lead shows as "4"). Items only combine if type, description, both ends and length all match
- **Containers:** own barcode, scan items in, scan the container to send its contents out
- **Markers & comments:** mark items Lost / Disassembled / Repair with a note, leave comments, full activity history
- **PAT testing:** per-item interval (default 12 months), overdue / due-soon / failed / never-tested views, record by scan or by button
- **Dashboard:** stock by type and state, PAT status, active rentals, items needing attention, recent activity

## Development

Needs Node 22.13+ (uses the built-in `node:sqlite`, so there are no native modules).

```bash
npm install
npm start          # http://localhost:3000, data in ./data
```
