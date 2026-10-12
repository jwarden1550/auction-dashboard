/**
 * Arena Auctions — premier auction blocks.
 *
 * GET /api/blocks                      one row per block, newest first
 * GET /api/blocks?view=lots&block=ID   this account's lots inside one block
 * GET /api/blocks?fresh=1              skip the cache
 *
 * Every block is listed, including ones with nothing in them yet — a block is
 * created before lots are submitted to it, so a new block shows up here from
 * the moment it exists. Blocks are shared across sellers, so SUBMISSIONS counts
 * everyone's while LOTS and the money columns are this account only.
 *
 * Env: METABASE_HOST, METABASE_API_KEY, AUCTION_DB (397), AUCTION_ACCOUNT.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.AUCTION_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';

const esc = s => String(s).replace(/'/g, "''");
const cache = {};
const TTL_MS = 5 * 60 * 1000;

const COST_CTE = `
cost_by_item AS (
  SELECT ITEM_ID,
         COALESCE(MAX_BY(NULLIF(PURCHASE_COST_CENTS, 0), CREATED_AT),
                  MAX_BY(PURCHASE_COST_CENTS, CREATED_AT)) AS purchase_cost_cents
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY ITEM_ID
)`;

/* this account's premier submissions, with their auction and attributes */
const MINE_CTE = `
mine AS (
  SELECT
      pa.BLOCK_ID,
      pa.ITEM_ID,
      pa.ITEM_CATEGORY,
      pa.APPROVAL_STATUS,
      a.ID                            AS AUCTION_ID,
      a.STATUS                        AS AUCTION_STATUS,
      a.CURRENT_BID_VALUE_CENTS       AS BID_CENTS,
      a.TOTAL_BIDS                    AS TOTAL_BIDS,
      a.END_AT                        AS END_AT,
      COALESCE(c.ESTIMATED_VALUE_CENTS, wc.ESTIMATED_VALUE_CENTS) AS EST_CENTS,
      COALESCE(c.PLAYER_NAME, wt.BRAND_NAME)                      AS TITLE,
      COALESCE(c.SET_NAME, wt.MODEL)                              AS SUBTITLE,
      COALESCE(c.SPORT, wc."CONDITION")                           AS DETAIL,
      ci.purchase_cost_cents          AS COST_CENTS
    FROM APP_PROD.PUBLIC.PREMIER_AUCTIONS pa
    JOIN APP_PROD.PUBLIC.USERS u
      ON u.ID = pa.USER_ID
     AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
    LEFT JOIN APP_PROD.PUBLIC.AUCTION a
      ON a.ID = pa.AUCTION_ID
     AND NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
    LEFT JOIN APP_PROD.PUBLIC.ITEMS i
      ON i.ID = pa.ITEM_ID
     AND NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
    LEFT JOIN APP_PROD.ADMIN.CARDS c
      ON c.ID = pa.ITEM_ID
     AND pa.ITEM_CATEGORY = 'card'
     AND NOT COALESCE(c._SNOWFLAKE_DELETED, FALSE)
    LEFT JOIN APP_PROD.ADMIN.WATCH_TYPES wt      ON wt.ID = i.WATCH_TYPE_ID
    LEFT JOIN APP_PROD.ADMIN.WATCH_CONDITIONS wc ON wc.ID = i.WATCH_CONDITION_ID
    LEFT JOIN cost_by_item ci ON ci.ITEM_ID = pa.ITEM_ID
   WHERE NOT COALESCE(pa._SNOWFLAKE_DELETED, FALSE)
     AND u.EMAIL = '{{ACCOUNT}}'
)`;

const SQL = {
  summary: `
WITH ${COST_CTE},${MINE_CTE}
SELECT
    b.ID                                                            AS BLOCK_ID,
    b.NAME                                                          AS BLOCK_NAME,
    CONVERT_TIMEZONE('America/Los_Angeles', b.STARTS_AT)            AS STARTS_AT,
    CONVERT_TIMEZONE('America/Los_Angeles', b.ENDS_AT)              AS ENDS_AT,
    CASE WHEN b.CANCELLED_AT IS NOT NULL THEN 'cancelled'
         WHEN CURRENT_TIMESTAMP() < b.STARTS_AT THEN 'upcoming'
         WHEN CURRENT_TIMESTAMP() > b.ENDS_AT   THEN 'finished'
         ELSE 'running' END                                         AS BLOCK_STATE,
    b.IS_VISIBLE                                                    AS IS_VISIBLE,
    (SELECT COUNT(*) FROM APP_PROD.PUBLIC.PREMIER_AUCTIONS pa2
      WHERE pa2.BLOCK_ID = b.ID
        AND NOT COALESCE(pa2._SNOWFLAKE_DELETED, FALSE))            AS SUBMISSIONS_ALL_SELLERS,
    COUNT(m.ITEM_ID)                                                AS LOTS,
    COUNT_IF(m.ITEM_CATEGORY = 'card')                              AS CARDS,
    COUNT_IF(m.ITEM_CATEGORY = 'watch')                             AS WATCHES,
    COUNT_IF(m.APPROVAL_STATUS <> 'approved')                       AS NOT_APPROVED,
    COUNT_IF(m.AUCTION_STATUS = 'active')                           AS LIVE,
    COUNT_IF(m.AUCTION_STATUS = 'completed')                        AS SOLD,
    SUM(m.COST_CENTS) / 100.0                                       AS COST,
    SUM(m.EST_CENTS) / 100.0                                        AS EST_VALUE,
    SUM(IFF(m.AUCTION_STATUS = 'active',    m.BID_CENTS, 0)) / 100.0 AS CURRENT_BIDS,
    SUM(IFF(m.AUCTION_STATUS = 'completed', m.BID_CENTS, 0)) / 100.0 AS SOLD_VALUE,
    SUM(m.TOTAL_BIDS)                                               AS BIDS
FROM APP_PROD.PUBLIC.PREMIER_AUCTION_BLOCKS b
LEFT JOIN mine m ON m.BLOCK_ID = b.ID
WHERE NOT COALESCE(b._SNOWFLAKE_DELETED, FALSE)
GROUP BY b.ID, b.NAME, b.STARTS_AT, b.ENDS_AT, b.CANCELLED_AT, b.IS_VISIBLE
ORDER BY b.STARTS_AT DESC NULLS LAST`,

  lots: `
WITH ${COST_CTE},${MINE_CTE}
SELECT
    m.TITLE                                                         AS TITLE,
    m.SUBTITLE                                                      AS SUBTITLE,
    m.DETAIL                                                        AS DETAIL,
    m.ITEM_CATEGORY                                                 AS ITEM_CATEGORY,
    m.APPROVAL_STATUS                                               AS APPROVAL,
    COALESCE(m.AUCTION_STATUS, 'not listed')                        AS AUCTION_STATUS,
    CONVERT_TIMEZONE('America/Los_Angeles', m.END_AT)               AS END_AT,
    m.COST_CENTS / 100.0                                            AS PURCHASE_COST,
    m.EST_CENTS / 100.0                                             AS ESTIMATED_VALUE,
    m.BID_CENTS / 100.0                                             AS CURRENT_BID,
    m.TOTAL_BIDS                                                    AS TOTAL_BIDS
FROM mine m
WHERE m.BLOCK_ID = '{{BLOCK}}'
ORDER BY m.EST_CENTS DESC NULLS LAST`
};

async function load(view, block, force) {
  const key = `${view}:${block || ''}`;
  const c = cache[key];
  if (!force && c && Date.now() - c.at < TTL_MS) return c;

  const sql = SQL[view]
    .replace(/\{\{ACCOUNT\}\}/g, esc(ACCOUNT))
    .replace(/\{\{BLOCK\}\}/g, esc(block || ''));

  const res = await fetch(`${HOST}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ database: DB, type: 'native', native: { query: sql } })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || !body.data) {
    throw new Error(String((body && (body.error || body.message)) || `HTTP ${res.status}`).slice(0, 300));
  }
  const cols = (body.data.cols || []).map(x => x.name);
  const rows = (body.data.rows || []).map(r => {
    const o = {};
    cols.forEach((n, idx) => { o[n] = r[idx]; });
    return o;
  });
  cache[key] = { at: Date.now(), rows, cols };
  return cache[key];
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!HOST || !KEY) { noStore(); return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' }); }

  const q = req.query || {};
  const view = SQL[q.view] ? q.view : 'summary';
  const block = q.block || null;
  if (view === 'lots' && !block) { noStore(); return res.status(200).json({ ok: false, error: 'lots needs ?block=<id>' }); }

  try {
    const fresh = q.fresh === '1' || q.fresh === 'true';
    if (fresh) noStore();
    const c = await load(view, block, fresh);
    return res.status(200).json({
      ok: true, view, block, account: ACCOUNT,
      generated: new Date(c.at).toISOString(),
      columns: c.cols, total: c.rows.length, rows: c.rows
    });
  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, view, error: e.message || String(e) });
  }
};
