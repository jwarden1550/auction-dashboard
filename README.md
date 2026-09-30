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

**PIPELINE** — what is live and what is queued, for one seller account
(`AUCTION_ACCOUNT`, default slabpacks@arenaclub.com). Two views:

*In auction* is `auction.STATUS = 'active'` — lots taking bids now, with hours
left, current bid, bid count, reserve and the closing-soon count.

*Waiting* is items sitting `in_marketplace` with no live auction. An item leaves
`in_marketplace` the moment its lot goes active, so the two views cannot
double-count (measured: zero overlap).

Both show SECTION — the collection the card sits in on the account, Shoebox or
Auctions, read from `public.collections`. Verified against the account UI:
Auctions 3,079 / Shoebox 701, whose live lots are 55 + 93 = 148.

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

`GET /api/pipeline?view=active|waiting` takes the same filters and answers the
same shape. It runs its SQL through Metabase's native-query endpoint rather than
a saved question, so the SQL lives in this repo. Two things that cost an hour to
learn, both commented in the file: `INSERT` and `COLLECTION` are reserved words
in Snowflake and must be quoted, and an ad-hoc native query is capped at 2,000
rows regardless of any requested constraint — the loader pages with
LIMIT/OFFSET to get past it.
