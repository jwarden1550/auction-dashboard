/**
 * Arena Auctions — premier auction blocks, as an auction_id → block lookup.
 *
 * GET /api/premier            { ok, count, blocks: { "<auction id>": "<block name>" } }
 * GET /api/premier?fresh=1    skip the cache
 *
 * Why this exists: COMPLETED AUCTIONS reads Metabase card 39238, which does
 * not expose the premier block and which we cannot edit. Rather than rebuild
 * that whole query, this returns just the mapping — a couple of hundred rows
 * for the account — and the dashboard joins it client-side on the auction id,
 * which it recovers from the AUCTION_URL the card does return.
 *
 * Env: METABASE_HOST, METABASE_API_KEY, AUCTION_DB (default 397),
 *      AUCTION_ACCOUNT (default slabpacks@arenaclub.com).
 */

const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.AUCTION_DB || 397);
const ACCOUNT = process.env.AUCTION_ACCOUNT || 'slabpacks@arenaclub.com';

const esc = s => String(s).replace(/'/g, "''");
const cache = { at: 0, blocks: null };
const TTL_MS = 10 * 60 * 1000;

const SQL = `
SELECT
    pa.AUCTION_ID                                                   AS AUCTION_ID,
    MAX(pb.NAME)                                                    AS BLOCK_NAME
FROM APP_PROD.PUBLIC.PREMIER_AUCTIONS pa
JOIN APP_PROD.PUBLIC.USERS u
  ON u.ID = pa.USER_ID
 AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
JOIN APP_PROD.PUBLIC.PREMIER_AUCTION_BLOCKS pb
  ON pb.ID = pa.BLOCK_ID
 AND NOT COALESCE(pb._SNOWFLAKE_DELETED, FALSE)
WHERE NOT COALESCE(pa._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND pa.APPROVAL_STATUS = 'approved'
  AND pa.AUCTION_ID IS NOT NULL
GROUP BY pa.AUCTION_ID`;

async function load(force) {
  if (!force && cache.blocks && Date.now() - cache.at < TTL_MS) return cache;

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
  const idIdx = cols.indexOf('AUCTION_ID');
  const nameIdx = cols.indexOf('BLOCK_NAME');
  const blocks = {};
  (body.data.rows || []).forEach(r => {
    if (r[idIdx]) blocks[String(r[idIdx])] = r[nameIdx];
  });
  cache.blocks = blocks;
  cache.at = Date.now();
  return cache;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
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
      ok: true,
      account: ACCOUNT,
      generated: new Date(c.at).toISOString(),
      count: Object.keys(c.blocks).length,
      blocks: c.blocks
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
