/**
 * Completed auctions, read from Snowflake directly.
 *
 * The tab used to read saved Metabase question 39238, which sat a week
 * behind the auctions that had actually ended — 13,081 lots whose newest
 * sale was 13 October while a thousand-odd lots had closed since. That
 * question belongs to another collection and is read-only here, so this
 * asks the warehouse the same question itself.
 *
 * Lineage, per the Arena data dictionary:
 *   auction        — the listing. auction.item_id + item_category (not
 *                    card_id, which the cards→items swap retired).
 *   items          — ownership, tag, collection. Scoped by users.email.
 *   ADMIN.CARDS    — the card's attributes.
 *   item_cost_accounting — what the lot cost.
 *
 * GET /api/sold                      first page
 * GET /api/sold?probe=1              what statuses exist, and how far they run
 *
 * Paging, filtering and the response shape match /api/auction exactly, so
 * the front end reads either one without knowing which.
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.METABASE_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';

const esc = s => String(s).replace(/'/g, "''");

/* What the account's auctions look like by status: how many, how far back,
   how far forward, how many carry a winning bid. Everything this endpoint
   decides about which statuses count as sold rests on this. */
const PROBE = `
SELECT a.STATUS                                        AS "STATUS",
       COUNT(*)                                        AS "LOTS",
       MIN(CONVERT_TIMEZONE('America/Los_Angeles', a.END_AT))::date AS "FIRST_END",
       MAX(CONVERT_TIMEZONE('America/Los_Angeles', a.END_AT))::date AS "LAST_END",
       SUM(IFF(COALESCE(a.CURRENT_BID_VALUE_CENTS,0) > 0, 1, 0))    AS "WITH_A_BID",
       SUM(IFF(a.ORDER_ID IS NOT NULL, 1, 0))          AS "WITH_AN_ORDER",
       SUM(a.CURRENT_BID_VALUE_CENTS) / 100.0          AS "BID_TOTAL"
  FROM APP_PROD.PUBLIC.AUCTION a
  JOIN APP_PROD.PUBLIC.USERS u
    ON u.ID = a.USER_ID
   AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
 WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
   AND u.EMAIL = '{{ACCOUNT}}'
 GROUP BY 1
 ORDER BY 2 DESC`;

async function run(sql) {
  const res = await fetch(`${HOST}/api/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ database: DB, type: 'native', native: { query: sql } })
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.error || !body.data) {
    throw new Error(String((body && (body.error || body.message)) || `HTTP ${res.status}`).slice(0, 300));
  }
  const cols = (body.data.cols || []).map(c => c.name);
  const rows = (body.data.rows || []).map(r => {
    const o = {};
    cols.forEach((name, i) => { o[name] = r[i]; });
    return o;
  });
  return { cols, rows };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!HOST || !KEY) {
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }
  try {
    const out = await run(PROBE.replace('{{ACCOUNT}}', esc(ACCOUNT)));
    return res.status(200).json({ ok: true, account: ACCOUNT, probe: out.rows });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
