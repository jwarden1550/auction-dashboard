/**
 * Arena Auctions — cost corrections for COMPLETED AUCTIONS.
 *
 * GET /api/costfix      { ok, count, costs: { "<item id>": <dollars> } }
 * GET /api/costfix?fresh=1
 *
 * Metabase card 39238 values a lot at its LATEST cost row, even when that row
 * carries zero — so a later empty row hides the real acquisition cost and the
 * lot reports a 100% margin. PIPELINE already uses the better rule (latest row
 * that actually carries a figure), which left the two tabs disagreeing, and a
 * lot could change value simply by closing.
 *
 * Card 39238 cannot be edited, so this returns the corrected cost for only the
 * lots where the two rules disagree — latest row is zero while an earlier row
 * is not — and the dashboard applies them client-side. A handful of rows, not
 * a second copy of the book.
 *
 * Env: METABASE_HOST, METABASE_API_KEY, AUCTION_DB (397), AUCTION_ACCOUNT.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.AUCTION_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';

const esc = s => String(s).replace(/'/g, "''");
const cache = { at: 0, costs: null };
const TTL_MS = 10 * 60 * 1000;

const SQL = `
WITH mine AS (
  SELECT DISTINCT a.ITEM_ID
    FROM APP_PROD.PUBLIC.AUCTION a
    JOIN APP_PROD.PUBLIC.USERS u
      ON u.ID = a.USER_ID
     AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
   WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
     AND u.EMAIL = '{{ACCOUNT}}'
),
ica AS (
  SELECT x.ITEM_ID, x.PURCHASE_COST_CENTS AS C, x.CREATED_AT
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING x
    JOIN mine ON mine.ITEM_ID = x.ITEM_ID
   WHERE NOT COALESCE(x._SNOWFLAKE_DELETED, FALSE)
)
/* Keep only the lots where the two rules disagree, and filter with HAVING on
   the aggregates themselves. Computing the same thing in a CTE and filtering
   in an outer SELECT returned nothing — this form is the one verified against
   the three known items. */
SELECT
    ITEM_ID,
    MAX_BY(C, IFF(COALESCE(C, 0) <> 0, CREATED_AT, NULL)) / 100.0 AS CORRECTED_COST
  FROM ica
 GROUP BY ITEM_ID
HAVING COALESCE(MAX_BY(C, CREATED_AT), 0) = 0
   AND MAX(C) > 0`;

async function load(force) {
  if (!force && cache.costs && Date.now() - cache.at < TTL_MS) return cache;
  const res = await fetch(`${HOST}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({
      database: DB, type: 'native',
      native: { query: SQL.replace('{{ACCOUNT}}', esc(ACCOUNT)) }
    })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || !body.data) {
    throw new Error(String((body && (body.error || body.message)) || `HTTP ${res.status}`).slice(0, 300));
  }
  const cols = (body.data.cols || []).map(c => c.name);
  const idI = cols.indexOf('ITEM_ID'), costI = cols.indexOf('CORRECTED_COST');
  const costs = {};
  (body.data.rows || []).forEach(r => { if (r[idI] != null) costs[String(r[idI])] = r[costI]; });
  cache.costs = costs; cache.at = Date.now();
  return cache;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
  if (!HOST || !KEY) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }
  try {
    const q = req.query || {};
    const fresh = q.fresh === '1' || q.fresh === 'true';
    if (fresh) res.setHeader('Cache-Control', 'no-store, max-age=0');
    const c = await load(fresh);
    return res.status(200).json({
      ok: true, account: ACCOUNT,
      generated: new Date(c.at).toISOString(),
      count: Object.keys(c.costs).length,
      costs: c.costs
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
