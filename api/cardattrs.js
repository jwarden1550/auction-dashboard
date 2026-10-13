/**
 * Arena Auctions — card attributes card 39238 does not return.
 *
 * GET /api/cardattrs        { ok, count, cols:[...], rows:[[id, ...values]] }
 * GET /api/cardattrs?fresh=1
 *
 * COMPLETED AUCTIONS reads card 39238, which selects a fixed column set and
 * cannot be edited. Rather than rebuild that query, this returns the extra
 * attributes for every card the account has had at auction, and the dashboard
 * merges them in on the card id it recovers from CARD_URL.
 *
 * Sent as cols + array rows rather than objects per row: the same data with the
 * key names written once instead of 13,000 times.
 *
 * Env: METABASE_HOST, METABASE_API_KEY, AUCTION_DB (397), AUCTION_ACCOUNT.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.AUCTION_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';

const esc = s => String(s).replace(/'/g, "''");
const cache = { at: 0, payload: null };
const TTL_MS = 30 * 60 * 1000;   // attributes barely change; cache hard

const SQL = `
WITH mine AS (
  SELECT DISTINCT a.ITEM_ID
    FROM APP_PROD.PUBLIC.AUCTION a
    JOIN APP_PROD.PUBLIC.USERS u
      ON u.ID = a.USER_ID
     AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
   WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
     AND u.EMAIL = '{{ACCOUNT}}'
)
SELECT
    c.ID                AS CARD_ID,
    c.TEAM              AS TEAM,
    c."YEAR"            AS "YEAR",
    c.GRADING_COMPANY   AS GRADING_COMPANY,
    c.SET_NUMBER        AS CARD_NUMBER,
    c.NUMBER            AS AC_NUMBER,
    c.PARALLEL_NUMBER   AS PARALLEL_NUMBER,
    c.SLAB_KIND         AS SLAB_TYPE,
    c."RARITY"          AS "RARITY",
    c."LANGUAGE"        AS "LANGUAGE",
    c."EDITION"         AS "EDITION",
    c.IS_ROOKIE         AS IS_ROOKIE,
    c.IS_RELIC          AS IS_RELIC,
    c.IS_FULL_ART       AS IS_FULL_ART
FROM APP_PROD.ADMIN.CARDS c
JOIN mine ON mine.ITEM_ID = c.ID
WHERE NOT COALESCE(c._SNOWFLAKE_DELETED, FALSE)`;

async function load(force) {
  if (!force && cache.payload && Date.now() - cache.at < TTL_MS) return cache;
  const res = await fetch(`${HOST}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({
      database: DB, type: 'native',
      native: { query: SQL.replace('{{ACCOUNT}}', esc(ACCOUNT)) },
      constraints: { 'max-results': 100000, 'max-results-bare-rows': 100000 }
    })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || !body.data) {
    throw new Error(String((body && (body.error || body.message)) || `HTTP ${res.status}`).slice(0, 300));
  }
  cache.payload = {
    cols: (body.data.cols || []).map(c => c.name),
    rows: body.data.rows || []
  };
  cache.at = Date.now();
  return cache;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');
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
      count: c.payload.rows.length,
      cols: c.payload.cols,
      rows: c.payload.rows
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
