/**
 * Buying Inventory — Auction, from a Metabase question.
 *
 * GET /api/auction                       first page
 * GET /api/auction?facet=<col>&fq=kob    matching values for a filter
 *
 * Paging: limit (default 100), offset.
 * Filtering: any returned column can be filtered by passing its name as a
 * query param — /api/auction?sport=baseball&player_name=Kobe%20Bryant — and
 * every filter accepts a comma or newline separated list.
 * Numeric bounds: min_<col> and max_<col>.
 *
 * Env:
 *   AUCTION_QUESTION   the saved question id
 *   METABASE_HOST, METABASE_API_KEY
 *
 * The column mapping is deliberately open: whatever the question returns is
 * what the table shows, so this works before anyone agrees on a schema.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.METABASE_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';
const esc = s => String(s).replace(/'/g, "''");

/* Completed auctions, read from the warehouse.
 *
 * This used to read saved question 39238, which sat a week behind: 13,081
 * lots whose newest sale was 13 October while the warehouse already had
 * completed auctions through the 19th. That question belongs to another
 * collection and is read-only here, so this asks Snowflake the same thing.
 *
 * "Completed" means exactly auction.status = 'completed'. Probed against the
 * account before choosing it: 13,109 completed lots, every one of them
 * carrying a winning bid and an order, running to the day of the probe.
 * The other ended states are deliberately not sales — expired_payment (858,
 * the winner never paid), reserve_not_met (141), cancelled (28),
 * awaiting_payment (3, not yet settled). expired_payment alone carries
 * $28.1M of bids against $1.6M across every completed lot, which is reason
 * enough on its own not to add it to a revenue figure.
 *
 * Lineage per the Arena data dictionary: auction.item_id + item_category
 * (not card_id, retired by the cards→items swap), items for ownership and
 * section, ADMIN.CARDS for attributes, item_cost_accounting for cost.
 */
const SQL = `
WITH cost_by_item AS (
  /* One cost per item: the latest row that actually carries a figure,
     falling back to the latest row when every one is zero. 39238 took the
     latest row outright, which let a later empty row hide the real
     acquisition cost. */
  SELECT ITEM_ID,
         COALESCE(MAX_BY(PURCHASE_COST_CENTS,
                         IFF(COALESCE(PURCHASE_COST_CENTS, 0) <> 0, CREATED_AT, NULL)),
                  MAX_BY(PURCHASE_COST_CENTS, CREATED_AT)) AS purchase_cost_cents,
         MAX_BY(KIND, CREATED_AT)                          AS cost_kind,
         COUNT(*)                                          AS cost_rows
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY ITEM_ID
)
SELECT
    'https://admin.arenaclub.com/auctions/' || a.ID                 AS AUCTION_URL,
    'https://admin.arenaclub.com/cards/' || a.ITEM_ID || '/estimate-value' AS CARD_URL,
    c.FRONT_SLAB_PICTURE_URL,
    c.PLAYER_NAME,
    c.SET_NAME,
    c.SPORT,
    c.OVERALL                                                       AS GRADE,
    c."INSERT"                                                      AS "INSERT",
    c.PARALLEL_NAME,
    c.PARALLEL_TOTAL,
    c.NUMBER                                                        AS "8ac_number",
    i.TAG,
    COALESCE(col.NAME, '(uncollected)')                             AS "COLLECTION",
    i.CATEGORY                                                      AS ITEM_CATEGORY,
    CONVERT_TIMEZONE('America/Los_Angeles', a.END_AT)               AS SOLD_AT,
    c.ESTIMATED_VALUE_CENTS / 100.0                                 AS ESTIMATED_VALUE,
    ci.purchase_cost_cents / 100.0                                  AS PURCHASE_COST,
    a.CURRENT_BID_VALUE_CENTS / 100.0                               AS SOLD_PRICE,
    (a.CURRENT_BID_VALUE_CENTS - c.ESTIMATED_VALUE_CENTS) / 100.0   AS SOLD_VS_EV,
    a.TOTAL_BIDS,
    (a.CURRENT_BID_VALUE_CENTS - COALESCE(ci.purchase_cost_cents,0)) / 100.0 AS MARGIN,
    ci.cost_kind                                                    AS COST_KIND,
    ci.cost_rows                                                    AS COST_ROW_COUNT,
    c.TEAM, c."YEAR" AS "YEAR", c.GRADING_COMPANY,
    c.SET_NUMBER AS CARD_NUMBER, c.NUMBER AS AC_NUMBER,
    c.PARALLEL_NUMBER, c.SLAB_KIND AS SLAB_TYPE,
    c."RARITY" AS "RARITY", c."LANGUAGE" AS "LANGUAGE", c."EDITION" AS "EDITION",
    c.IS_ROOKIE, c.IS_RELIC, c.IS_FULL_ART,
    COALESCE((SELECT MAX(pb.NAME)
                FROM APP_PROD.PUBLIC.PREMIER_AUCTIONS pa
                JOIN APP_PROD.PUBLIC.PREMIER_AUCTION_BLOCKS pb
                  ON pb.ID = pa.BLOCK_ID
                 AND NOT COALESCE(pb._SNOWFLAKE_DELETED, FALSE)
               WHERE pa.AUCTION_ID = a.ID
                 AND pa.APPROVAL_STATUS = 'approved'
                 AND NOT COALESCE(pa._SNOWFLAKE_DELETED, FALSE)),
             'standard')                                            AS PREMIER_BLOCK,
    a.STATUS                                                        AS AUCTION_STATUS
FROM APP_PROD.PUBLIC.AUCTION a
JOIN APP_PROD.PUBLIC.USERS u
  ON u.ID = a.USER_ID
 AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN APP_PROD.PUBLIC.ITEMS i
  ON i.ID = a.ITEM_ID
 AND NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN APP_PROD.PUBLIC.COLLECTIONS col
  ON col.ID = i.COLLECTION_ID
 AND NOT COALESCE(col._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN APP_PROD.ADMIN.CARDS c
  ON c.ID = a.ITEM_ID
 AND NOT COALESCE(c._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN cost_by_item ci ON ci.ITEM_ID = a.ITEM_ID
WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND a.STATUS = 'completed'
/* one row per lot whatever the joins do */
QUALIFY ROW_NUMBER() OVER (PARTITION BY a.ID ORDER BY c.NUMBER NULLS LAST) = 1
/* ends on a row id: LIMIT/OFFSET over an order with ties breaks them
   differently per page, which lands a row on two pages and drops another */
ORDER BY a.END_AT DESC, a.ID`;

const cache = { at: 0, rows: null, cols: null };
let inflight = null;
const TTL_MS = 30 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const terms = v => String(v == null ? '' : v)
  .split(/[,\n\r\t;]+/).map(t => t.trim()).filter(Boolean);
const hasAny = (hay, raw) => {
  const list = terms(raw);
  if (!list.length) return true;
  const h = String(hay == null ? '' : hay).toLowerCase();
  return list.some(t => h.includes(t.toLowerCase()));
};

/** Which column holds what, by name. */
const pick = (cols, re) => cols.find(c => re.test(c));
const COST_RE = /^(purchase_?cost|cost|buy_?price|purchase_?price|acquisition_?cost)$/i;
const SOLD_RE = /^(sold_?price|sale_?price|sold|price_?sold|realized|hammer)$/i;
const QTY_RE  = /^(cards|card_?count|total_?cards|qty|quantity|copies)$/i;
const EV_RE   = /^(estimated_?value|est_?value|ev)$/i;

/** Totals for a set of rows: cards, cost, sold, profit. */
function totals(rows, cols) {
  const cost = pick(cols, COST_RE), sold = pick(cols, SOLD_RE), qty = pick(cols, QTY_RE);
  const ev = pick(cols, EV_RE);
  const n = v => {
    const x = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return isNaN(x) ? 0 : x;
  };
  const has = (r, c) => c && r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== '';

  let cards = 0, costSum = 0, soldSum = 0, soldCount = 0, costOfSold = 0, evOfSold = 0;
  rows.forEach(r => {
    const units = qty ? (n(r[qty]) || 0) : 1;
    cards += units || 1;
    if (has(r, cost)) costSum += n(r[cost]);
    if (has(r, sold) && n(r[sold]) !== 0) {
      soldSum += n(r[sold]);
      soldCount += units || 1;
      if (has(r, cost)) costOfSold += n(r[cost]);
      if (has(r, ev)) evOfSold += n(r[ev]);
    }
  });

  const profit = soldSum - costOfSold;
  return {
    lots: rows.length, cards, cost: costSum, sold: soldSum, sold_count: soldCount,
    cost_of_sold: costOfSold, profit,
    // margin on revenue: (sold - cost of sold) / sold
    margin: soldSum ? (profit / soldSum) * 100 : null,
    // what these lots fetched against what they were estimated at. 100% = sold
    // exactly at estimate; below means the book is selling under its own EV.
    // Only lots that actually sold are counted on either side.
    ev_of_sold: evOfSold,
    sold_to_ev: evOfSold ? (soldSum / evOfSold) * 100 : null,
    cost_col: cost || null, sold_col: sold || null, qty_col: qty || null
  };
}

/** Columns that shouldn't be offered as filters. */
const SKIP = /url$|^id$|_id$/i;

async function load(force) {
  // ?fresh=1 (the REFRESH button) skips the cache; everything else reuses it
  if (!force && cache.rows && Date.now() - cache.at < TTL_MS) return cache;
  // An expired copy is worth more than an error. If the warehouse will not
  // answer, serve what was last read; the "data pulled" stamp shows its age.
  const stale = cache.rows ? cache : null;
  // Two requests arriving at a cold instance would each run the whole walk
  // and wait twice as long for it. They share the one.
  if (!force && inflight) return inflight;

  inflight = (async () => {
    // Metabase caps an ad-hoc native query at 2,000 bare rows and ignores a
    // requested constraint, so walk it with LIMIT/OFFSET and stitch. The
    // query's ORDER BY ends on a row id, which is what makes that safe.
    const PAGE = 2000, MAX_PAGES = 40;
    const base = SQL.replace('{{ACCOUNT}}', esc(ACCOUNT));
    let cols = [], rows = [];

    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const sql = `${base}\nLIMIT ${PAGE} OFFSET ${pageNo * PAGE}`;
      const res = await fetch(`${HOST}/api/dataset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ database: DB, type: 'native', native: { query: sql } })
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || body.error || !body.data) {
        const why = (body && (body.error || body.message)) || `HTTP ${res.status}`;
        throw new Error(String(why).slice(0, 300));
      }
      if (!cols.length) cols = (body.data.cols || []).map(x => x.name);
      const batch = (body.data.rows || []).map(r => {
        const o = {};
        cols.forEach((name, idx) => { o[name] = r[idx]; });
        return o;
      });
      rows = rows.concat(batch);
      if (batch.length < PAGE) break;          // last page
    }

    cache.rows = rows;
    cache.cols = cols;
    cache.at = Date.now();
    return cache;
  })();
  try {
    return await inflight;
  } catch (e) {
    if (stale) return stale;
    throw e;
  } finally { inflight = null; }
}

const looksDate = v => {
  const t = String(v == null ? '' : v).trim();
  if (!t || /^\d+([.,]\d+)?$/.test(t)) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(t) || (/\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}/.test(t) && !isNaN(Date.parse(t)));
};
const asTime = v => {
  const t = Date.parse(String(v == null ? '' : v).trim());
  return isNaN(t) ? null : t;
};

/** Columns holding dates, judged from their values. */
function dateCols(rows, cols) {
  const out = {};
  cols.forEach(c => {
    const sample = rows.slice(0, 200).map(r => r[c]).filter(v => v !== null && v !== '');
    out[c] = sample.length > 0 && sample.every(looksDate);
  });
  return out;
}

/** Is this column numeric across the rows we have? */
function numericCols(rows, cols) {
  const out = {};
  cols.forEach(c => {
    const sample = rows.slice(0, 200).map(r => r[c]).filter(v => v !== null && v !== '');
    out[c] = sample.length > 0 && sample.every(v =>
      typeof v === 'number' || /^-?[$]?[\d,]+(\.\d+)?%?$/.test(String(v).trim()));
  });
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  // s-maxage decides when the edge goes and asks again; stale-while-revalidate
  // decides how long it keeps answering from the copy it has while it does.
  // Long, because the alternative is a reader waiting out the Metabase fetch,
  // and REFRESH is there for anyone who wants it now.
  res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');

  if (!HOST || !KEY) {
    noStore();
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }

  try {
    const q = req.query;
    const fresh = q.fresh === '1' || q.fresh === 'true';
    if (fresh) noStore();
    const c = await load(fresh);
    const cols = c.cols;
    const isDate = dateCols(c.rows, cols);
    const isNum = numericCols(c.rows, cols);
    cols.forEach(x => { if (isDate[x]) isNum[x] = false; });

    // ?facet=player_name&fq=kob → matching values, ranked
    if (q.facet) {
      const key = cols.find(x => x.toLowerCase() === String(q.facet).toLowerCase());
      if (!key) { noStore(); return res.status(200).json({ ok: false, error: 'unknown facet' }); }
      const needle = String(q.fq || '').toLowerCase();
      const seen = new Set();
      c.rows.forEach(r => { const v = r[key]; if (v !== null && v !== '') seen.add(String(v)); });
      const values = [...seen]
        .filter(v => !needle || v.toLowerCase().includes(needle))
        .sort((a, b) => {
          const A = a.toLowerCase(), B = b.toLowerCase();
          if (needle) {
            const rank = x => x.startsWith(needle) ? 0
              : x.split(/[\s\/]+/).some(w => w.startsWith(needle)) ? 1 : 2;
            const d = rank(A) - rank(B); if (d) return d;
          }
          return A.localeCompare(B);
        })
        .slice(0, 300);
      return res.status(200).json({ ok: true, facet: key, total: seen.size, values });
    }

    // any column can be filtered by name, with min_/max_ for numbers
    let rows = c.rows.filter(r => cols.every(col => {
      const v = q[col];
      if (v !== undefined && !hasAny(r[col], v)) return false;
      if (isDate[col]) {
        const from = q['from_' + col], to = q['to_' + col];
        const t = asTime(r[col]);
        if (from !== undefined && from !== '' && (t === null || t < Date.parse(from))) return false;
        // "to" covers the whole of that day
        if (to !== undefined && to !== '' && (t === null || t > Date.parse(to) + 86399999)) return false;
        return true;
      }
      const lo = q['min_' + col], hi = q['max_' + col];
      if (lo !== undefined && num(r[col]) < num(lo)) return false;
      if (hi !== undefined && num(r[col]) > num(hi)) return false;
      return true;
    }));

    const sortCol = cols.find(x => x.toLowerCase() === String(q.sort || '').toLowerCase());
    if (sortCol) {
      const dir = String(q.dir).toLowerCase() === 'asc' ? 1 : -1;
      rows = rows.slice().sort((a, b) => isNum[sortCol]
        ? (num(a[sortCol]) - num(b[sortCol])) * dir
        : String(a[sortCol] ?? '').localeCompare(String(b[sortCol] ?? '')) * dir);
    }

    // 4,000 rows is about 3.7 MB of JSON — the most that comfortably fits in one
    // response, and it turns a twelve-request book into three
    const limit = Math.min(Number(q.limit) || 100, 4000);
    const offset = Math.max(Number(q.offset) || 0, 0);

    // Facets mean a pass over every row for every text column, and the value
    // lists are a good slice of the response. A page past the first is only
    // ever asked for its rows, so ?slim=1 says don't bother.
    const slim = q.slim === '1';
    const facets = {};
    if (!slim) {
      const facetCols = cols.filter(x => !isNum[x] && !isDate[x] && !SKIP.test(x));
      facetCols.forEach(col => {
        const seen = new Set();
        c.rows.forEach(r => { const v = r[col]; if (v !== null && v !== '') seen.add(String(v)); });
        facets[col] = { count: seen.size, values: [...seen].sort().slice(0, 300) };
      });
    }

    return res.status(200).json({
      ok: true,
      account: ACCOUNT,
      generated: new Date(c.at).toISOString(),
      columns: cols,
      numeric: isNum,
      dates: isDate,
      facets,
      total: c.rows.length,
      matched: rows.length,
      totals: slim ? null : totals(rows, cols),       // the current filter
      totals_all: slim ? null : totals(c.rows, cols),  // the whole question
      limit, offset,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      rows: rows.slice(offset, offset + limit)
    });

  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
