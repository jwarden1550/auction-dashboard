/* Throwaway. Asks the warehouse what a table looks like, so a column name
   goes into the real query because it was read, not because it was guessed.
   Deleted once the answer is in. */
const HOST = (process.env.METABASE_HOST || '').replace(/\/$/, '');
const KEY = process.env.METABASE_API_KEY || '';
const DB = Number(process.env.METABASE_DB || 397);

const SQL = `
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
  FROM APP_PROD.INFORMATION_SCHEMA.COLUMNS
 WHERE (TABLE_NAME = 'CARD_CERT_NUMBER')
    OR (TABLE_NAME = 'CARDS' AND COLUMN_NAME ILIKE '%CERT%')
 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  try {
    const r = await fetch(`${HOST}/api/dataset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ database: DB, type: 'native', native: { query: SQL } })
    });
    const b = await r.json().catch(() => null);
    if (!r.ok || !b || b.error || !b.data) {
      throw new Error(String((b && (b.error || b.message)) || `HTTP ${r.status}`).slice(0, 300));
    }
    const cols = (b.data.cols || []).map(c => c.name);
    return res.status(200).json({
      ok: true,
      rows: (b.data.rows || []).map(row => Object.fromEntries(cols.map((c, i) => [c, row[i]])))
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
};
