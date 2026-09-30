# Arena Auctions

A standalone dashboard for sold auction lots. Same look and the same
open-column API contract as Buying Inventory, but auctions only.

## What it shows

**LOTS** — every lot the Metabase question returns, filtered server-side
against the whole book rather than the page on screen. Player, set, sport,
grade, sold date, estimated value, cost, sold price, sold-vs-EV, margin,
bids, status and PO, with the slab image and a link back to the auction in
admin. Click a header to sort; the pager walks 100 at a time.

**BREAKDOWN** — the same filtered book grouped by sport, grade, status, tag,
set or PO, with cost, sold, profit, margin, average sold and bids per group
and a TOTAL row that ties back to the KPI tiles.

**EXPORT CSV** — the filtered book, every column, not just the page.

## Deploy

    vercel --scope arena-club
    vercel --prod --scope arena-club

Then set three environment variables on the project and redeploy:

    METABASE_HOST       https://arena-club.metabaseapp.com
    METABASE_API_KEY    an API key with read access
    AUCTION_QUESTION    the saved question id (defaults to 39238, Card Auction)

Without those, `/api/auction` answers `{ ok: false, error: ... }` and the
dashboard shows the reason in a red banner instead of a table.

## Working on it locally

There is no build step — it is one `index.html` and one serverless function.

    npx serve -l 4321 .

A static server has no serverless runtime and no Metabase key, so on
localhost the page reads the deployed Buying Inventory endpoint instead,
which sends `Access-Control-Allow-Origin: *`. That switch is one line at the
top of the script: anything not on localhost uses its own `/api/auction`.

## The API

`GET /api/auction` takes any column name as a filter, so it keeps working
when the question changes shape.

    ?PLAYER_NAME=Kobe,Mbappe        any-of, matches part of the value
    ?min_SOLD_PRICE=50&max_SOLD_PRICE=500
    ?from_SOLD_AT=2026-01-01&to_SOLD_AT=2026-09-30
    ?sort=SOLD_PRICE&dir=desc&limit=100&offset=0
    ?facet=SET_NAME&fq=chrome        matching values for a filter box

It answers with `columns`, `facets`, `matched`, `totals` for the current
filter, `totals_all` for the whole book, and the page of `rows`.
