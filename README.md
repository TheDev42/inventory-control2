# Stock Tracker

Barcode inventory, rentals and PAT tracking for an events / power / lighting / sound hire company.

## Run it (Docker)

```bash
docker compose up -d --build
```

Open `http://<server>` (port 80, so no port number is needed) for the staff app. The customer-facing **hire site** is the same container on **port 90** — `http://<server>:90` — and is the only port meant to be exposed to the internet; see [Public hire site](#public-hire-site-port-90). The database (SQLite) is the file **`data/inventory.db`** in this project folder, next to `docker-compose.yml`, so it survives rebuilds and is easy to find. (`data/` is git-ignored, so it is never committed.)

Settings are in `docker-compose.yml`:

| Variable | Purpose |
|---|---|
| `LOGO_PATH` | Optional. Logo for the PDF header; default is the bundled `server/assets/FaderUp-Logo-white.png`. It sits directly on the dark blue header, so it should be **white with a transparent background**. To change it, replace that file and rebuild |
| `TZ` | Time zone (matters for PAT "due" dates), default `Europe/London` |
| `BARCODE_DIGITS` | Barcode width, default `5` (`00001`). Numeric codes shorter than this are padded with leading zeros; `0` turns padding off |
| `AUTH_USER` / `AUTH_PASS` | Optional. Set both to require a login (basic auth). **Do this if the server is reachable from the internet, and put it behind HTTPS.** |
| `HIRE_PORT` | The public hire site's port inside the container, default `3090` (published as **90**). `0` turns the site off altogether |
| `HIRE_CONTACT_EMAIL` / `HIRE_CONTACT_PHONE` | Optional. Shown in the hire site's footer so customers can get hold of you |
| `HIRE_LOGO_PATH` | Logo shown at the top of the hire site until you upload your own from *Hire site → Pictures & wording*; default is the bundled `server/assets/FaderUp-Logo-black.png`. Set to an empty string for no logo at all until one is uploaded |
| `HIRE_TRUST_PROXY` | Set to `1` if the hire site sits behind a reverse proxy, so its rate limiting sees the real caller rather than the proxy |

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

## Public hire site (port 90)

A second, customer-facing website runs in the same container on **port 90**. It is a separate app from the
one on port 80: separate port, separate pages, no admin routes and no login prompt. **Port 90 is the only
one to expose to the internet** — leave port 80 on your own network (or behind `AUTH_USER` / `AUTH_PASS`
and HTTPS), because it can change and delete everything.

What it serves, and nothing else: your sub-categories, the kinds of item in each, and how many are free.
Barcodes, item ids, costs, owners, PAT records, containers and the activity log are not on it at all —
the only thing from the inventory it exposes is a job's quantities, once it exists as a booking. The only
thing a visitor can write is a booking.

### What a customer does

1. **Browse freely.** The front page lists every sub-category as a square tile, in whatever order you have
   arranged them. Opening one shows the kinds of item in it — grouped under section headings like "16A" /
   "32A" if you have set any, which stay pinned as the page scrolls — with how many are available. Opening
   an item shows its about page: details, connectors, length, how many you own, how many are free, and
   whatever wording you have written for it. A search box in the header and a **Stock list** page (every
   kind of item, flat, for someone who already knows what they want) are there too. None of this asks for
   anything.
2. **Give their details.** The first time they try to put something in a **flight case** (the cart) they
   are asked for the hire dates, the client, the event, their name and their email — once, then it is
   remembered on their device and shown in a strip at the top. Nothing before that point needs it.
3. **Fill a flight case.** Quantities are capped at what is actually free for their dates, and the flight
   case page re-checks that every time it is opened.
4. **Book it.** This is not a request that waits for you to accept — it immediately creates a real, active
   rental under the next **job number** (see below), with the flight case's lines on it as kit requirements
   (see **Kit requirements** above: packing it is just scanning any matching barcodes, not specific ones).
   The confirmation page shows the job number, a PDF hire sheet to download (the same client-PDF layout the
   admin side uses), and asks them to get in touch to confirm the details — there is a ready-made "email us"
   button when `HIRE_CONTACT_EMAIL` is set.

### Availability

With no dates chosen, the numbers are simply what is in stock right now. Once dates are given, an item
counts as free unless it is lost, disassembled, in repair or sold, or it is already on an active rental
whose dates overlap. A rental with no end date — or one whose kit is still out past its end date — blocks
every future window, because there is no telling when that kit is coming back. Because a booking is a real
rental from the moment it is made but names kinds and quantities rather than barcodes, unpacked quantities
on *other* overlapping bookings are subtracted too — so two customers can't both be promised the same
unscanned stock before either of them has actually been packed.

### Your side of it: *Hire site* in the sidebar

- **Pictures & wording** is where you set the look and the arrangement:
  - A **Logo** at the top, shown instead of the site's text name. Any size works — it is scaled to fit,
    not cropped square.
  - Every sub-category tile and every kind of item gets a square picture, a name and an about text.
    Pictures are cropped square from the middle and shrunk in the browser before they are saved, so any
    photo works and the database stays small. They live in the database, so the *Backup* button includes
    them.
  - **Combine items** lists several kinds as one, under a name you give it (e.g. 0.5 m and 1 m IEC leads as
    "Short IEC leads"). Tick the items, type the name, press *Combine*; tick a combined item along with others to
    add them to it. Customers see one item whose free count is the total of its kinds and book a quantity of it;
    on the rental that becomes one kit requirement that any mix of those kinds fills. A combined item has its own
    picture and wording; *Take out* removes one kind from it and *Split up* lists them all separately again.
  - **Reorder** switches the lists into Move up / Move down order, and (for item kinds) lets you type a
    **section** such as "16A" or "32A" that groups it on the public page. Changes save as you make them.
- **Bookings** is the history: dates, client, who booked it, what they asked for, and a link to the rental
  it created. There is nothing to accept or decline — that already happened — this is just the record.

The catalogue is your inventory, so there is no second list to maintain: add stock and it appears. The one
thing to know is that a "kind of item" is a group of identical items — the same grouping the Stock
overview uses (category, type, description, connectors, length) — so editing one of those fields in the
inventory moves an item into a different group, which has its own picture, wording, order and section.

## Scanning

A USB / Bluetooth barcode scanner works like a keyboard: it types the code and presses Enter. The app listens for that on **every page**, so nothing needs to be focused. (Typing into a form field is left alone.) Use the mode buttons in the bar at the top, or press **Esc** to go back to Lookup:

| Mode | What a scan does |
|---|---|
| **Lookup** | Opens the item / container |
| **Scan OUT** | Adds the item to the selected rental. Opening a rental page selects this mode for you. Scanning a *case* puts the case on the rental and adds everything inside it, packed into that case |
| **Return** | Returns the item to active inventory. Works on any page, no rental needed. Also restores Lost / Disassembled items. Scanning a *case* only marks the **case** as back: its items are **not** returned, so every item has to be scanned in individually (the scan tells you how many are still out) |
| **Store** | Puts the item in the selected container (opening a container page selects this). Scanning a container barcode switches the target container. If that case has been added to a rental (and not scanned back yet), the item goes out on that rental too, packed in the case |
| **PAT test** | Records a pass or fail (chosen in the bar) for today |

Each outcome has its own sound (open **Sound** in the bar to hear them all): out, return, store, found, PAT pass, PAT fail, lookup, duplicate/warn, blocked, unknown barcode, and "out but PAT needs attention".

Rules: an item must be scanned OUT onto a rental or picked from the rental's **Add items** list (an unknown barcode can be added straight from the scan bar). Items that are lost, disassembled, in repair, **sold**, PAT-failed, or already out on another rental are blocked from going out.

## Barcodes

Barcodes are zero-padded numbers like `00001`, shared by items and containers (a code can only belong to one thing). Because spreadsheets and hand-typing drop leading zeros (`12` instead of `00012`), any all-digit code shorter than 5 digits is padded back automatically. That applies to typing, scanning, bulk add and CSV import, so `12` and `00012` are the same barcode.

## Features

- **Items:** category → type (Power: cable/adapter/splitter/distro; Lighting: cable/light/unit; Sound: cable/audio), male & female connector for cables/adapters/splitters, length, description, and **owner** (the company, or you personally: *Company* is the default, and *Me (personal)* items get a "Mine" badge). Owner is a field on the add/edit form and in bulk add, and an optional `owner` column (`company` or `me`) in CSV import
- **Categories:** Power, Lighting and Sound (and the types above) are only the starting set. The **Categories** page adds your own categories and sub-categories (types) from the browser, each with a choice of connector boxes: none, male + female end, or input + outputs. One with no items in it can be deleted again
- **Distros:** a Power type with one input connector and a list of outputs (e.g. 6 × 16A Cee, 2 × 13A). Shown as IN → OUT chips, printed as `In: … / Out: …` on the hire PDFs (identical distros combine on the client copy), and importable from CSV via `input_connector` and `outputs` (`6x 16A Cee (blue); 2x 13A (BS1363)`)
- **Inventory:** search across every field, sort by any column, filters (including owner), CSV export (with an `owner` column). Tick items (or use *Select all N matching* to tick everything the current filters show) and *Set owner to…* to change many at once; ticks are kept while you page and filter. The Stock overview can also be limited to your own kit or the company's
- **Bulk add:** scan or paste barcodes, generate a numbered range (e.g. 00101–00150), or import a CSV
- **Rentals:** every rental gets a sequential **job number** (`JOB-0001`, `JOB-0002`, …) the moment it is created, whether that's the admin's own **New rental** form or a booking from the hire site — one shared counter, shown on the Rentals list, the rental page and both PDFs. Create, scan items in and out (or click **Add items** on a rental to search/filter the in-stock list, tick the ones you want and add them in one go), complete/reopen (**completing a rental marks every item that has not been returned as LOST**, with a note on the item; the confirmation tells you how many; a lost item can be found later and restored by scanning it in Return mode), and export two PDFs (upright A4) from the rental page. They are made to be told apart at a glance: the internal copy has a charcoal header, an amber **INTERNAL COPY** badge and a "staff use only" line, the client copy has a blue header and a green **CLIENT COPY** badge, and every page footer repeats the label. Add `?orientation=landscape` to a PDF link for the wide layout:
  - **Internal PDF**: every item with its barcode, PAT date (N/A when it has none or needs none) and a return tick-box. Sorted by type, then male end, female end, length and description, so identical kit sits together rather than in barcode order
  - **Client PDF**: no barcodes, PAT dates or notes. Identical items are combined into one line with a quantity (4 × 10m 16A lead shows as "4"). Items only combine if type, description, both ends and length all match
- **Kit requirements:** on a rental, **Add by quantity** lets you ask for "10 of this kind of item" (the same grouping the Stock overview uses) instead of picking 10 specific barcodes. Packing it is then just scanning any 10 matching items — the requirement's progress bar reads off what is already out on the rental, so there is nothing extra to keep in sync. A booking from the hire site arrives with these already filled in from what the customer asked for
- **Containers:** own barcode, scan items in, scan the container to send its contents out. Two kinds: **permanent cases** (the ones you always use, kept in your inventory) and **temporary boxes** (one-offs for a job: just give it a name and it gets a new barcode, `T0001`, `T0002`…; a number is never handed out twice, even if a box is deleted). Adding a case to a rental, or scanning it OUT, sends everything stored in it out on the rental, packed into it, and anything scanned into it afterwards follows. **Close box** on a temporary box's page finishes it for good: what was in it is written down, it is emptied, and it moves to the *Closed* tab, where its page still shows what was in it and every rental it was on. A closed box can't be scanned, stored into or used on a rental again. *Close finished temporary boxes* closes every one that was used on a rental, is empty and is not on an active rental. Permanent cases and open temporary boxes appear in every case drop-down
- **Organising a shipment:** on a rental, the **Cases** panel lists the cases on it (add a permanent case or a temporary box, or make a new temporary box on the spot). Each line has a *Case* drop-down to pack it into a case; tick several lines and use *Assign to case* to do many at once, filter the lines by case, or choose *Pack into* in the **Add items** picker so new items go straight into a case. *Label* on a case prints its 4″ × 6″ label with the contents (from what is packed into it), client, event and box number ("2 of 3") already filled in from the rental
- **Case labels:** *Print label* on a container page makes a 4″ × 6″ label in the style of the old hand-made ones: FaderUp logo and date across the top, Client | Event | Box No., a Contents box (filled from what is in the case, counted like `8 X 16A to 13A 4 way`, and editable), and a Code 128 barcode of the case's barcode so it can be scanned like any other. If everything from the case is out on one rental, client, event and date are pre-filled from it. *Open to print* shows the PDF (print it at actual size / 100% on the label printer); *Download PDF* saves it. The logo is `server/assets/FaderUp-Logo-black.png` (black on white; replace the file or set `LABEL_LOGO_PATH` to change it)
- **Markers & comments:** mark items Lost / Disassembled / Repair with a note, leave comments, full activity history
- **Sold:** *Mark as sold* on an item page (add a note for who / how much). The item stays on the inventory register (filter by status *Sold*) but is inert: it can't be scanned in or out in any mode, added to a rental, stored in a container or PAT tested, and it drops out of the PAT counts. *Undo sale* on its page restores it; scanning never does.
- **PAT testing:** per-item interval (default 12 months), overdue / due-soon / failed / never-tested views, record by scan or by button. A mistaken test can be removed with **Delete** in the item's PAT history: its last-test and due dates are recalculated from the tests that remain (none left = never tested). Deleting a failed test does not move the item out of Repair; restore it yourself
- **Stock overview:** how many of each kind of item you own and how many are available right now. Items with identical details (category, type, description, connectors, length; capitals don't matter) are grouped into one line, labelled with their most common spelling. Each line shows the total, the available count (in stock) with a small bar, and where the rest are (on rental, repair, lost, disassembled). Click a number to see those items in the inventory. Search, filter by category, or sort by most owned / least available. Sold items are not counted (they are no longer yours)
- **Dashboard:** stock by type and state, PAT status, active rentals, items needing attention, recent activity

## Development

Needs Node 22.13+ (uses the built-in `node:sqlite`, so there are no native modules).

```bash
npm install
npm start          # staff app on http://localhost:3000, hire site on http://localhost:3090, data in ./data
```

Both apps run in the one process and share the database. `HIRE_PORT=0 npm start` leaves the hire site out.
