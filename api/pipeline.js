/**
 * Arena Auctions — pipeline: what is in auction now, and what is waiting.
 *
 * GET /api/pipeline?view=active            lots currently accepting bids
 * GET /api/pipeline?view=waiting           inventory queued, not yet listed
 * GET /api/pipeline?view=active&facet=SPORT&fq=base
 *
 * Scoped to one seller account (AUCTION_ACCOUNT, default slabpacks@arenaclub.com).
 * Filtering/paging/sorting match /api/auction so the front end can treat them
 * the same: any returned column filters by name, min_/max_ for numbers,
 * from_/to_ for dates, sort + dir, limit + offset.
 *
 * The SQL runs through Metabase's native-query endpoint rather than a saved
 * question, so it stays in version control next to the dashboard.
 *
 * Env: METABASE_HOST, METABASE_API_KEY, optionally AUCTION_DB (default 397,
 * Snowflake APP_PROD) and AUCTION_ACCOUNT.
 *
 * Schema notes (verified against APP_PROD, 2026-09-30):
 *   - auction.USER_ID is the seller, so no items hop is needed to scope it
 *   - auction.ITEM_ID + ITEM_CATEGORY are the live links; CARD_ID is deprecated
 *   - START_AT/END_AT are TIMESTAMP_LTZ; CREATED_AT is NTZ
 *   - card attributes and grading live in ADMIN.CARDS (admin owns OVERALL and
 *     ESTIMATED_VALUE_CENTS); items.id = cards.id for the card category
 *   - every table needs the _SNOWFLAKE_DELETED guard, in the JOIN when outer
 *   - INSERT and COLLECTION are reserved words in Snowflake, so both are
 *     quoted; unquoted they fail to compile at the following AS
 *   - the on-screen sections are public.collections (NAME, IS_SHOEBOX) joined
 *     via items.COLLECTION_ID; verified against the account UI exactly
 *     (Auctions 3,079 / Shoebox 701; their live lots 55 + 93 = 148)
 *   - an item leaves 'in_marketplace' when its auction goes active, so the two
 *     views cannot double-count (measured: 0 overlap)
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.AUCTION_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';

const esc = s => String(s).replace(/'/g, "''");

const SQL = {
  active: `
SELECT
    a.ID                                                            AS AUCTION_ID,
    'https://admin.arenaclub.com/auctions/' || a.ID                 AS AUCTION_URL,
    'https://admin.arenaclub.com/cards/' || a.ITEM_ID || '/estimate-value' AS CARD_URL,
    c.FRONT_SLAB_PICTURE_URL,
    c.PLAYER_NAME,
    c.SET_NAME,
    c.SPORT,
    c.OVERALL                                                       AS GRADE,
    c."INSERT"                                                      AS INSERT_NAME,
    c.PARALLEL_NAME,
    i.TAG,
    COALESCE(col.NAME, '(uncollected)')                             AS "COLLECTION",
    col.IS_SHOEBOX,
    i.CATEGORY                                                      AS ITEM_CATEGORY,
    CONVERT_TIMEZONE('America/Los_Angeles', a.START_AT)             AS START_AT,
    CONVERT_TIMEZONE('America/Los_Angeles', a.END_AT)               AS END_AT,
    DATEDIFF('hour', CURRENT_TIMESTAMP(), a.END_AT)                 AS HOURS_LEFT,
    c.ESTIMATED_VALUE_CENTS / 100.0                                 AS ESTIMATED_VALUE,
    a.START_VALUE_CENTS / 100.0                                     AS START_PRICE,
    a.RESERVE_VALUE_CENTS / 100.0                                   AS RESERVE,
    a.CURRENT_BID_VALUE_CENTS / 100.0                               AS CURRENT_BID,
    a.TOTAL_BIDS,
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
WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND a.STATUS = 'active'
ORDER BY a.END_AT`,

  waiting: `
SELECT
    i.ID                                                            AS ITEM_ID,
    'https://admin.arenaclub.com/cards/' || i.ID || '/estimate-value' AS CARD_URL,
    c.FRONT_SLAB_PICTURE_URL,
    c.PLAYER_NAME,
    c.SET_NAME,
    c.SPORT,
    c.OVERALL                                                       AS GRADE,
    c."INSERT"                                                      AS INSERT_NAME,
    c.PARALLEL_NAME,
    i.TAG,
    COALESCE(col.NAME, '(uncollected)')                             AS "COLLECTION",
    col.IS_SHOEBOX,
    i.CATEGORY                                                      AS ITEM_CATEGORY,
    i.STATUS                                                        AS ITEM_STATUS,
    c.ESTIMATED_VALUE_CENTS / 100.0                                 AS ESTIMATED_VALUE,
    (SELECT COUNT(*)
       FROM APP_PROD.PUBLIC.AUCTION a2
      WHERE a2.ITEM_ID = i.ID
        AND NOT COALESCE(a2._SNOWFLAKE_DELETED, FALSE))             AS PAST_AUCTIONS
FROM APP_PROD.PUBLIC.ITEMS i
JOIN APP_PROD.PUBLIC.USERS u
  ON u.ID = i.USER_ID
 AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN APP_PROD.PUBLIC.COLLECTIONS col
  ON col.ID = i.COLLECTION_ID
 AND NOT COALESCE(col._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN APP_PROD.ADMIN.CARDS c
  ON c.ID = i.ID
 AND NOT COALESCE(c._SNOWFLAKE_DELETED, FALSE)
WHERE NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND i.STATUS = 'in_marketplace'
  AND NOT EXISTS (
        SELECT 1
          FROM APP_PROD.PUBLIC.AUCTION a
         WHERE a.ITEM_ID = i.ID
           AND a.STATUS = 'active'
           AND NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
      )
ORDER BY c.ESTIMATED_VALUE_CENTS DESC NULLS LAST`
};

const cache = {};
const TTL_MS = 5 * 60 * 1000;

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
};
const terms = v => String(v == null ? '' : v).split(/[,\n\r\t;]+/).map(t => t.trim()).filter(Boolean);
const hasAny = (hay, raw) => {
  const list = terms(raw);
  if (!list.length) return true;
  const h = String(hay == null ? '' : hay).toLowerCase();
  return list.some(t => h.includes(t.toLowerCase()));
};
const asTime = v => { const t = Date.parse(String(v == null ? '' : v).trim()); return isNaN(t) ? null : t; };
const looksDate = v => {
  const t = String(v == null ? '' : v).trim();
  if (!t || /^-?\d+([.,]\d+)?$/.test(t)) return false;
  return /^\d{4}-\d{2}-\d{2}/.test(t);
};

async function load(view) {
  const c = cache[view];
  if (c && Date.now() - c.at < TTL_MS) return c;

  const base = SQL[view].replace('{{ACCOUNT}}', esc(ACCOUNT));

  // Metabase caps an ad-hoc native query at 2,000 bare rows and ignores a
  // requested constraint, so walk the result with LIMIT/OFFSET and stitch the
  // pages together. Both queries end in ORDER BY, which makes the paging
  // deterministic. PAGE stays under the cap; MAX_PAGES is a runaway guard.
  const PAGE = 2000, MAX_PAGES = 25;
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
    if (batch.length < PAGE) break;       // last page
  }

  cache[view] = { at: Date.now(), rows, cols };
  return cache[view];
}

/** Totals: lot/item count plus the money columns each view actually carries. */
function totals(rows, view) {
  const sum = k => rows.reduce((a, r) => a + num(r[k]), 0);
  const base = { count: rows.length, est_value: sum('ESTIMATED_VALUE') };
  if (view === 'active') {
    const withBids = rows.filter(r => num(r.TOTAL_BIDS) > 0);
    return {
      ...base,
      current_bid: sum('CURRENT_BID'),
      start_price: sum('START_PRICE'),
      bids: sum('TOTAL_BIDS'),
      with_bids: withBids.length,
      no_bids: rows.length - withBids.length,
      closing_24h: rows.filter(r => num(r.HOURS_LEFT) >= 0 && num(r.HOURS_LEFT) <= 24).length,
      reserve_total: sum('RESERVE')
    };
  }
  return { ...base, relists: rows.filter(r => num(r.PAST_AUCTIONS) > 0).length };
}

const SKIP = /url$|^id$|_id$/i;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');

  if (!HOST || !KEY) {
    noStore();
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }

  const q = req.query || {};
  const view = SQL[q.view] ? q.view : 'active';

  try {
    const c = await load(view);
    const cols = c.cols;
    const isDate = {}, isNum = {};
    cols.forEach(col => {
      const sample = c.rows.slice(0, 200).map(r => r[col]).filter(v => v !== null && v !== '');
      isDate[col] = sample.length > 0 && sample.every(looksDate);
      isNum[col] = !isDate[col] && sample.length > 0 && sample.every(v =>
        typeof v === 'number' || /^-?[$]?[\d,]+(\.\d+)?%?$/.test(String(v).trim()));
    });

    if (q.facet) {
      const key = cols.find(x => x.toLowerCase() === String(q.facet).toLowerCase());
      if (!key) { noStore(); return res.status(200).json({ ok: false, error: 'unknown facet' }); }
      const needle = String(q.fq || '').toLowerCase();
      const seen = new Set();
      c.rows.forEach(r => { const v = r[key]; if (v !== null && v !== '') seen.add(String(v)); });
      return res.status(200).json({
        ok: true, view, facet: key, total: seen.size,
        values: [...seen].filter(v => !needle || v.toLowerCase().includes(needle)).sort().slice(0, 300)
      });
    }

    let rows = c.rows.filter(r => cols.every(col => {
      const v = q[col];
      if (v !== undefined && !hasAny(r[col], v)) return false;
      if (isDate[col]) {
        const from = q['from_' + col], to = q['to_' + col];
        const t = asTime(r[col]);
        if (from) { if (t === null || t < Date.parse(from)) return false; }
        if (to) { if (t === null || t > Date.parse(to) + 86399999) return false; }
        return true;
      }
      const lo = q['min_' + col], hi = q['max_' + col];
      if (lo !== undefined && lo !== '' && num(r[col]) < num(lo)) return false;
      if (hi !== undefined && hi !== '' && num(r[col]) > num(hi)) return false;
      return true;
    }));

    const sortCol = cols.find(x => x.toLowerCase() === String(q.sort || '').toLowerCase());
    if (sortCol) {
      const dir = String(q.dir).toLowerCase() === 'asc' ? 1 : -1;
      rows = rows.slice().sort((a, b) => isNum[sortCol]
        ? (num(a[sortCol]) - num(b[sortCol])) * dir
        : String(a[sortCol] ?? '').localeCompare(String(b[sortCol] ?? '')) * dir);
    }

    const limit = Math.min(Number(q.limit) || 100, 1000);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const facets = {};
    cols.filter(x => !isNum[x] && !isDate[x] && !SKIP.test(x)).forEach(col => {
      const seen = new Set();
      c.rows.forEach(r => { const v = r[col]; if (v !== null && v !== '') seen.add(String(v)); });
      facets[col] = { count: seen.size, values: [...seen].sort().slice(0, 300) };
    });

    return res.status(200).json({
      ok: true,
      view,
      account: ACCOUNT,
      generated: new Date(c.at).toISOString(),
      columns: cols,
      numeric: isNum,
      dates: isDate,
      facets,
      total: c.rows.length,
      matched: rows.length,
      totals: totals(rows, view),
      totals_all: totals(c.rows, view),
      limit, offset,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      rows: rows.slice(offset, offset + limit)
    });
  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, view, error: e.message || String(e) });
  }
};
