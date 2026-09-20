# Stock Tracker

Barcode inventory, rentals and PAT tracking for an events / power / lighting / sound hire company.

## Run it (Docker)

```bash
docker compose up -d --build
```

Open `http://<server>` (port 80, so no port number is needed). The database (SQLite) is the file **`data/inventory.db`** in this project folder, next to `docker-compose.yml`, so it survives rebuilds and is easy to find. (`data/` is git-ignored, so it is never committed.)

Settings are in `docker-compose.yml`:

| Variable | Purpose |
|---|---|
| `COMPANY_NAME` | Name on exported PDFs and in the sidebar (default `FaderUp`) |
| `LOGO_PATH` | Optional. Logo for the PDF header; default is the bundled `server/assets/FaderUp-Logo-white.png`. It sits directly on the dark blue header, so it should be **white with a transparent background**. To change it, replace that file and rebuild |
| `TZ` | Time zone (matters for PAT "due" dates), default `Europe/London` |
| `BARCODE_DIGITS` | Barcode width, default `5` (`00001`). Numeric codes shorter than this are padded with leading zeros; `0` turns padding off |
| `AUTH_USER` / `AUTH_PASS` | Optional. Set both to require a login (basic auth). **Do this if the server is reachable from the internet, and put it behind HTTPS.** |

**Backups:** the *Backup* button (bottom of the sidebar) downloads a copy of the database. To restore, stop the container (`docker compose down`) and put the file at `data/inventory.db`. If you copy the file by hand instead, stop the app first (or copy `inventory.db-wal` and `inventory.db-shm` with it, which the app keeps beside it while running).

The first `docker compose up` also runs a tiny one-off `data-perms` helper that creates `data/` and makes it writable by the app's unprivileged user (uid 1000); it exits straight away, which is normal.

**Moving from the old Docker volume:** earlier versions kept the database in a Docker volume called `inventory-data`. To bring that data across, run this once from the project folder before starting the new version:

```bash
docker compose down
mkdir -p data
docker run --rm -v inventory-data:/from -v "$(pwd)/data":/to alpine sh -c "cp -a /from/. /to/ && chown -R 1000:1000 /to"
docker compose up -d --build
```

(On Windows PowerShell use `${PWD}\data` instead of `$(pwd)/data`.) The old volume is left untouched; remove it later with `docker volume rm inventory-data` once you have checked everything is there.

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

Rules: an item must be scanned OUT onto a rental or picked from the rental's **Add items** list (an unknown barcode can be added straight from the scan bar). Items that are lost, disassembled, in repair, **sold**, PAT-failed, or already out on another rental are blocked from going out.

## Barcodes

Barcodes are zero-padded numbers like `00001`, shared by items and containers (a code can only belong to one thing). Because spreadsheets and hand-typing drop leading zeros (`12` instead of `00012`), any all-digit code shorter than 5 digits is padded back automatically. That applies to typing, scanning, bulk add and CSV import, so `12` and `00012` are the same barcode.

## Features

- **Items:** category → type (Power: cable/adapter/splitter/distro; Lighting: cable/light/unit; Sound: cable/audio), male & female connector for cables/adapters/splitters, length, description
- **Distros:** a Power type with one input connector and a list of outputs (e.g. 6 × 16A Cee, 2 × 13A). Shown as IN → OUT chips, printed as `In: … / Out: …` on the hire PDFs (identical distros combine on the client copy), and importable from CSV via `input_connector` and `outputs` (`6x 16A Cee (blue); 2x 13A (BS1363)`)
- **Inventory:** search across every field, sort by any column, filters, CSV export
- **Bulk add:** scan or paste barcodes, generate a numbered range (e.g. 00101–00150), or import a CSV
- **Rentals:** create, scan items in and out (or click **Add items** on a rental to search/filter the in-stock list, tick the ones you want and add them in one go), complete/reopen, and export two PDFs (upright A4) from the rental page. They are made to be told apart at a glance: the internal copy has a charcoal header, an amber **INTERNAL COPY** badge and a "staff use only" line, the client copy has a blue header and a green **CLIENT COPY** badge, and every page footer repeats the label. Add `?orientation=landscape` to a PDF link for the wide layout:
  - **Internal PDF**: every item with its barcode, PAT date (N/A when it has none or needs none) and a return tick-box. Sorted by type, then male end, female end, length and description, so identical kit sits together rather than in barcode order
  - **Client PDF**: no barcodes, PAT dates or notes. Identical items are combined into one line with a quantity (4 × 10m 16A lead shows as "4"). Items only combine if type, description, both ends and length all match
- **Containers:** own barcode, scan items in, scan the container to send its contents out
- **Case labels:** *Print label* on a container page makes a 4″ × 6″ label in the style of the old hand-made ones: FaderUp logo and date across the top, Client | Event | Box No., a Contents box (filled from what is in the case, counted like `8 X 16A to 13A 4 way`, and editable), and a Code 128 barcode of the case's barcode so it can be scanned like any other. If everything from the case is out on one rental, client, event and date are pre-filled from it. *Open to print* shows the PDF (print it at actual size / 100% on the label printer); *Download PDF* saves it. The logo is `server/assets/FaderUp-Logo-black.png` (black on white; replace the file or set `LABEL_LOGO_PATH` to change it)
- **Markers & comments:** mark items Lost / Disassembled / Repair with a note, leave comments, full activity history
- **Sold:** *Mark as sold* on an item page (add a note for who / how much). The item stays on the inventory register (filter by status *Sold*) but is inert: it can't be scanned in or out in any mode, added to a rental, stored in a container or PAT tested, and it drops out of the PAT counts. *Undo sale* on its page restores it; scanning never does.
- **PAT testing:** per-item interval (default 12 months), overdue / due-soon / failed / never-tested views, record by scan or by button
- **Dashboard:** stock by type and state, PAT status, active rentals, items needing attention, recent activity

## Development

Needs Node 22.13+ (uses the built-in `node:sqlite`, so there are no native modules).

```bash
npm install
npm start          # http://localhost:3000, data in ./data
```
