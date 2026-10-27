/**
 * Arena Auctions — pipeline: what is in auction now, and what is waiting.
 *
 * GET /api/pipeline?view=active&category=card   lots currently accepting bids
 * category is card (default) or watch — each has its own attribute joins
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
 *   - the consumer card page is /cards/<sport>-<set>-<player>-8AC<number
 *     padded to 9>, built from cards.NUMBER (identical to items.NUMBER).
 *     There is no slug column, so it is constructed; verified against a live
 *     lot, punctuation included (J.J. McCarthy -> j-j-mccarthy). That page
 *     also shows the auction itself, which admin never had a route for.
 *   - admin.arenaclub.com has NO /auctions route (its nav is Vaulting, Packs,
 *     Tasks, Orders, Cards, Users), so an auction-id link 404s. The working
 *     deep link is /cards/<item_id>/estimate-value, verified against a live
 *     lot. Card 39238 still emits the dead /auctions/<id> form.
 *   - the on-screen sections are public.collections (NAME, IS_SHOEBOX) joined
 *     via items.COLLECTION_ID; verified against the account UI exactly
 *     (Auctions 3,079 / Shoebox 701; their live lots 55 + 93 = 148)
 *   - PREMIER_BLOCK names the curated block a live lot belongs to, or
 *     'standard'. Premier auctions are ordinary auction rows with a
 *     premier_auctions record pointing at them, so they were already counted
 *     here — just not distinguishable. Read as a scalar subquery because an
 *     auction can carry more than one premier record and a join would
 *     duplicate the lot.
 *   - both views are scoped to the card category. The account also holds
 *     watches, coins and wines; those have no row in ADMIN.CARDS, so they
 *     rendered as a line of dashes. It also matches COMPLETED AUCTIONS,
 *     which is cards-only by construction.
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
WITH cost_by_item AS (
  /* One cost per item: the latest row that actually carries a figure, falling
     back to the latest row when every one is zero. Card 39238 takes the latest
     row outright, which lets a later empty row hide the real acquisition cost —
     this avoids that. Verified: 909 of 910 live card lots resolve a cost. */
  SELECT ITEM_ID,
         /* MAX_BY returns expr1 OF THE LATEST ROW, so NULLIF(cost,0) there just
            yields NULL when the latest row is zero — it does not find the
            latest non-zero row. Nulling the ORDERING expression instead makes
            MAX_BY skip the zero rows, which is what we want. */
         COALESCE(MAX_BY(PURCHASE_COST_CENTS,
                         IFF(COALESCE(PURCHASE_COST_CENTS, 0) <> 0, CREATED_AT, NULL)),
                  MAX_BY(PURCHASE_COST_CENTS, CREATED_AT)) AS purchase_cost_cents
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY ITEM_ID
)
SELECT
    a.ID                                                            AS AUCTION_ID,
    CASE WHEN c.NUMBER IS NOT NULL THEN
      'https://arenaclub.com/cards/'
      || LOWER(TRIM(REGEXP_REPLACE(
             COALESCE(c.SPORT,'') || ' ' || COALESCE(c.SET_NAME,'') || ' ' || COALESCE(c.PLAYER_NAME,''),
             '[^A-Za-z0-9]+', '-'), '-'))
      || '-8AC' || LPAD(c.NUMBER::STRING, 9, '0')
    END                                                             AS PUBLIC_URL,
    'https://admin.arenaclub.com/cards/' || a.ITEM_ID || '/estimate-value' AS ADMIN_URL,
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
    ci.purchase_cost_cents / 100.0                                  AS PURCHASE_COST,
    ev.LAST_COMP_AT                                                 AS LAST_COMPED,
    DATEDIFF('day', ev.LAST_COMP_AT, CURRENT_DATE)                  AS COMP_AGE_DAYS,
    c.TEAM                                                          AS TEAM,
    c."YEAR"                                                        AS "YEAR",
    c.GRADING_COMPANY                                               AS GRADING_COMPANY,
    c.SET_NUMBER                                                    AS CARD_NUMBER,
    c.NUMBER                                                        AS AC_NUMBER,
    c.PARALLEL_NUMBER                                               AS PARALLEL_NUMBER,
    c.PARALLEL_TOTAL                                                AS PARALLEL_TOTAL,
    c.SLAB_KIND                                                     AS SLAB_TYPE,
    cert.CERT_NUMBER                                                AS CERT_NUMBER,
    c."RARITY"                                                      AS "RARITY",
    c."LANGUAGE"                                                    AS "LANGUAGE",
    c."EDITION"                                                     AS "EDITION",
    c.IS_ROOKIE                                                     AS IS_ROOKIE,
    c.IS_RELIC                                                      AS IS_RELIC,
    c.IS_FULL_ART                                                   AS IS_FULL_ART,
    c.ESTIMATED_VALUE_CENTS / 100.0                                 AS ESTIMATED_VALUE,
    a.START_VALUE_CENTS / 100.0                                     AS START_PRICE,
    a.RESERVE_VALUE_CENTS / 100.0                                   AS RESERVE,
    a.CURRENT_BID_VALUE_CENTS / 100.0                               AS CURRENT_BID,
    a.TOTAL_BIDS,
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
LEFT JOIN (
  /* The cert lives in its own admin table, not on cards, and a regrade
     writes another row — latest wins, through an aggregate so the join
     cannot fan a lot into two. */
  SELECT CARD_ID, MAX_BY(CERT_NUMBER, CREATED_AT) AS CERT_NUMBER
    FROM APP_PROD.ADMIN.CARD_CERT_NUMBER
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY CARD_ID
) cert ON cert.CARD_ID = a.ITEM_ID
LEFT JOIN cost_by_item ci ON ci.ITEM_ID = a.ITEM_ID
LEFT JOIN (
  /* When the card was last comped. Same source card 39238 uses — the
     estimate_value task — so the two tabs agree. cards.LAST_COMP_VALUE_CENTS
     exists but is written for nothing, so the comp VALUE cannot be shown. */
  SELECT CARD_ID, MAX(CREATED_AT::timestamp) AS LAST_COMP_AT
    FROM APP_PROD.ADMIN.TASKS
   WHERE SKILL_KIND = 'estimate_value'
   GROUP BY CARD_ID
) ev ON ev.CARD_ID = a.ITEM_ID

WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND a.STATUS = 'active'
  AND a.ITEM_CATEGORY = 'card'
/* One row per lot whatever the joins do. ADMIN.CARDS is joined on id and
   ought to be one-to-one, but a card id carrying a second, soft-deleted row
   was enough to list a lot twice — and a double-counted lot is a
   double-counted cost. */
QUALIFY ROW_NUMBER() OVER (PARTITION BY a.ID ORDER BY c.NUMBER NULLS LAST) = 1
ORDER BY a.END_AT, a.ID`,

  waiting: `
WITH cost_by_item AS (
  /* One cost per item: the latest row that actually carries a figure, falling
     back to the latest row when every one is zero. Card 39238 takes the latest
     row outright, which lets a later empty row hide the real acquisition cost —
     this avoids that. Verified: 909 of 910 live card lots resolve a cost. */
  SELECT ITEM_ID,
         /* MAX_BY returns expr1 OF THE LATEST ROW, so NULLIF(cost,0) there just
            yields NULL when the latest row is zero — it does not find the
            latest non-zero row. Nulling the ORDERING expression instead makes
            MAX_BY skip the zero rows, which is what we want. */
         COALESCE(MAX_BY(PURCHASE_COST_CENTS,
                         IFF(COALESCE(PURCHASE_COST_CENTS, 0) <> 0, CREATED_AT, NULL)),
                  MAX_BY(PURCHASE_COST_CENTS, CREATED_AT)) AS purchase_cost_cents
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY ITEM_ID
)
SELECT
    i.ID                                                            AS ITEM_ID,
    CASE WHEN c.NUMBER IS NOT NULL THEN
      'https://arenaclub.com/cards/'
      || LOWER(TRIM(REGEXP_REPLACE(
             COALESCE(c.SPORT,'') || ' ' || COALESCE(c.SET_NAME,'') || ' ' || COALESCE(c.PLAYER_NAME,''),
             '[^A-Za-z0-9]+', '-'), '-'))
      || '-8AC' || LPAD(c.NUMBER::STRING, 9, '0')
    END                                                             AS PUBLIC_URL,
    'https://admin.arenaclub.com/cards/' || i.ID || '/estimate-value' AS ADMIN_URL,
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
    ci.purchase_cost_cents / 100.0                                  AS PURCHASE_COST,
    ev.LAST_COMP_AT                                                 AS LAST_COMPED,
    DATEDIFF('day', ev.LAST_COMP_AT, CURRENT_DATE)                  AS COMP_AGE_DAYS,
    c.TEAM                                                          AS TEAM,
    c."YEAR"                                                        AS "YEAR",
    c.GRADING_COMPANY                                               AS GRADING_COMPANY,
    c.SET_NUMBER                                                    AS CARD_NUMBER,
    c.NUMBER                                                        AS AC_NUMBER,
    c.PARALLEL_NUMBER                                               AS PARALLEL_NUMBER,
    c.PARALLEL_TOTAL                                                AS PARALLEL_TOTAL,
    c.SLAB_KIND                                                     AS SLAB_TYPE,
    cert.CERT_NUMBER                                                AS CERT_NUMBER,
    c."RARITY"                                                      AS "RARITY",
    c."LANGUAGE"                                                    AS "LANGUAGE",
    c."EDITION"                                                     AS "EDITION",
    c.IS_ROOKIE                                                     AS IS_ROOKIE,
    c.IS_RELIC                                                      AS IS_RELIC,
    c.IS_FULL_ART                                                   AS IS_FULL_ART,
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
LEFT JOIN (
  /* The cert lives in its own admin table, not on cards, and a regrade
     writes another row — latest wins, through an aggregate so the join
     cannot fan a lot into two. */
  SELECT CARD_ID, MAX_BY(CERT_NUMBER, CREATED_AT) AS CERT_NUMBER
    FROM APP_PROD.ADMIN.CARD_CERT_NUMBER
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY CARD_ID
) cert ON cert.CARD_ID = i.ID
LEFT JOIN cost_by_item ci ON ci.ITEM_ID = i.ID
LEFT JOIN (
  /* When the card was last comped. Same source card 39238 uses — the
     estimate_value task — so the two tabs agree. cards.LAST_COMP_VALUE_CENTS
     exists but is written for nothing, so the comp VALUE cannot be shown. */
  SELECT CARD_ID, MAX(CREATED_AT::timestamp) AS LAST_COMP_AT
    FROM APP_PROD.ADMIN.TASKS
   WHERE SKILL_KIND = 'estimate_value'
   GROUP BY CARD_ID
) ev ON ev.CARD_ID = i.ID

WHERE NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND i.STATUS = 'in_marketplace'
  AND i.CATEGORY = 'card'
  AND NOT EXISTS (
        SELECT 1
          FROM APP_PROD.PUBLIC.AUCTION a
         WHERE a.ITEM_ID = i.ID
           AND a.STATUS = 'active'
           AND NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
      )
/* see the note on the active query: one row per lot, whatever the joins do */
QUALIFY ROW_NUMBER() OVER (PARTITION BY i.ID ORDER BY c.NUMBER NULLS LAST) = 1
ORDER BY c.ESTIMATED_VALUE_CENTS DESC NULLS LAST, i.ID`
};

/* Watches carry none of the card attributes — no row in ADMIN.CARDS at all.
   Their catalog lives in ADMIN.WATCH_TYPES (BRAND_NAME, MODEL, REFERENCE) and
   ADMIN.WATCH_CONDITIONS (CONDITION, ESTIMATED_VALUE_CENTS), reached from
   items.WATCH_TYPE_ID / items.WATCH_CONDITION_ID. Verified against the
   account: all 3,401 watches resolve brand, condition and value, no nulls.
   CONDITION and REFERENCE are quoted — both are reserved words. */
const WATCH_SQL = {
  active: `
WITH cost_by_item AS (
  /* One cost per item: the latest row that actually carries a figure, falling
     back to the latest row when every one is zero. Card 39238 takes the latest
     row outright, which lets a later empty row hide the real acquisition cost —
     this avoids that. Verified: 909 of 910 live card lots resolve a cost. */
  SELECT ITEM_ID,
         /* MAX_BY returns expr1 OF THE LATEST ROW, so NULLIF(cost,0) there just
            yields NULL when the latest row is zero — it does not find the
            latest non-zero row. Nulling the ORDERING expression instead makes
            MAX_BY skip the zero rows, which is what we want. */
         COALESCE(MAX_BY(PURCHASE_COST_CENTS,
                         IFF(COALESCE(PURCHASE_COST_CENTS, 0) <> 0, CREATED_AT, NULL)),
                  MAX_BY(PURCHASE_COST_CENTS, CREATED_AT)) AS purchase_cost_cents
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY ITEM_ID
)
SELECT
    a.ID                                                            AS AUCTION_ID,
    wt.BRAND_NAME                                                   AS BRAND,
    wt.MODEL                                                        AS MODEL,
    wt."REFERENCE"                                                  AS "REFERENCE",
    wc."CONDITION"                                                  AS "CONDITION",
    i.TAG,
    COALESCE(col.NAME, '(uncollected)')                             AS "COLLECTION",
    col.IS_SHOEBOX,
    i.CATEGORY                                                      AS ITEM_CATEGORY,
    CONVERT_TIMEZONE('America/Los_Angeles', a.START_AT)             AS START_AT,
    CONVERT_TIMEZONE('America/Los_Angeles', a.END_AT)               AS END_AT,
    DATEDIFF('hour', CURRENT_TIMESTAMP(), a.END_AT)                 AS HOURS_LEFT,
    ci.purchase_cost_cents / 100.0                                  AS PURCHASE_COST,
    wc.ESTIMATED_VALUE_CENTS / 100.0                                AS ESTIMATED_VALUE,
    a.START_VALUE_CENTS / 100.0                                     AS START_PRICE,
    a.RESERVE_VALUE_CENTS / 100.0                                   AS RESERVE,
    a.CURRENT_BID_VALUE_CENTS / 100.0                               AS CURRENT_BID,
    a.TOTAL_BIDS,
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
LEFT JOIN APP_PROD.ADMIN.WATCH_TYPES wt      ON wt.ID = i.WATCH_TYPE_ID
LEFT JOIN APP_PROD.ADMIN.WATCH_CONDITIONS wc ON wc.ID = i.WATCH_CONDITION_ID
LEFT JOIN cost_by_item ci ON ci.ITEM_ID = a.ITEM_ID
WHERE NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND a.STATUS = 'active'
  AND a.ITEM_CATEGORY = 'watch'
ORDER BY a.END_AT, a.ID`,

  waiting: `
WITH cost_by_item AS (
  /* One cost per item: the latest row that actually carries a figure, falling
     back to the latest row when every one is zero. Card 39238 takes the latest
     row outright, which lets a later empty row hide the real acquisition cost —
     this avoids that. Verified: 909 of 910 live card lots resolve a cost. */
  SELECT ITEM_ID,
         /* MAX_BY returns expr1 OF THE LATEST ROW, so NULLIF(cost,0) there just
            yields NULL when the latest row is zero — it does not find the
            latest non-zero row. Nulling the ORDERING expression instead makes
            MAX_BY skip the zero rows, which is what we want. */
         COALESCE(MAX_BY(PURCHASE_COST_CENTS,
                         IFF(COALESCE(PURCHASE_COST_CENTS, 0) <> 0, CREATED_AT, NULL)),
                  MAX_BY(PURCHASE_COST_CENTS, CREATED_AT)) AS purchase_cost_cents
    FROM APP_PROD.PUBLIC.ITEM_COST_ACCOUNTING
   WHERE NOT COALESCE(_SNOWFLAKE_DELETED, FALSE)
   GROUP BY ITEM_ID
)
SELECT
    i.ID                                                            AS ITEM_ID,
    wt.BRAND_NAME                                                   AS BRAND,
    wt.MODEL                                                        AS MODEL,
    wt."REFERENCE"                                                  AS "REFERENCE",
    wc."CONDITION"                                                  AS "CONDITION",
    i.TAG,
    COALESCE(col.NAME, '(uncollected)')                             AS "COLLECTION",
    col.IS_SHOEBOX,
    i.CATEGORY                                                      AS ITEM_CATEGORY,
    i.STATUS                                                        AS ITEM_STATUS,
    ci.purchase_cost_cents / 100.0                                  AS PURCHASE_COST,
    wc.ESTIMATED_VALUE_CENTS / 100.0                                AS ESTIMATED_VALUE,
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
LEFT JOIN APP_PROD.ADMIN.WATCH_TYPES wt      ON wt.ID = i.WATCH_TYPE_ID
LEFT JOIN APP_PROD.ADMIN.WATCH_CONDITIONS wc ON wc.ID = i.WATCH_CONDITION_ID
LEFT JOIN cost_by_item ci ON ci.ITEM_ID = i.ID
WHERE NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
  AND i.STATUS = 'in_marketplace'
  AND i.CATEGORY = 'watch'
  AND NOT EXISTS (
        SELECT 1
          FROM APP_PROD.PUBLIC.AUCTION a
         WHERE a.ITEM_ID = i.ID
           AND a.STATUS = 'active'
           AND NOT COALESCE(a._SNOWFLAKE_DELETED, FALSE)
      )
ORDER BY wc.ESTIMATED_VALUE_CENTS DESC NULLS LAST, i.ID`
};

/* Every section the account owns, listed whether or not anything is in it.
   The other views build their section list out of the lots they return, so a
   section nobody has listed into yet is invisible there -- a newly created
   one shows up only once it holds a lot. This is the catalog, so the
   dashboard can show it at zero from the day it is made.

   ITEMS counts everything filed in the section, not just what is live or
   queued, so a section holding stock in neither pipeline view still reads
   as non-empty. It is the figure the public showroom prints under the
   section name. */
SQL.sections = `
SELECT
    col.ID                                            AS COLLECTION_ID,
    col.NAME                                          AS "COLLECTION",
    col.IS_SHOEBOX,
    COUNT(i.ID)                                       AS ITEMS
FROM APP_PROD.PUBLIC.COLLECTIONS col
JOIN APP_PROD.PUBLIC.USERS u
  ON u.ID = col.USER_ID
 AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
LEFT JOIN APP_PROD.PUBLIC.ITEMS i
  ON i.COLLECTION_ID = col.ID
 AND NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
WHERE NOT COALESCE(col._SNOWFLAKE_DELETED, FALSE)
  AND u.EMAIL = '{{ACCOUNT}}'
GROUP BY col.ID, col.NAME, col.IS_SHOEBOX
ORDER BY COUNT(i.ID) DESC, col.ID`;

/* TEMPORARY -- an audit of everything the account owns, by status and
   category, so the views above can be checked for what they leave out.
   Remove once read. */
SQL.audit = `
SELECT i.STATUS AS BUCKET,
       i.CATEGORY AS CATEGORY,
       COUNT(*) AS N,
       COUNT(col.ID) AS IN_A_SECTION
  FROM APP_PROD.PUBLIC.ITEMS i
  JOIN APP_PROD.PUBLIC.USERS u
    ON u.ID = i.USER_ID AND NOT COALESCE(u._SNOWFLAKE_DELETED, FALSE)
  LEFT JOIN APP_PROD.PUBLIC.COLLECTIONS col
    ON col.ID = i.COLLECTION_ID AND NOT COALESCE(col._SNOWFLAKE_DELETED, FALSE)
 WHERE NOT COALESCE(i._SNOWFLAKE_DELETED, FALSE)
   AND u.EMAIL = '{{ACCOUNT}}'
 GROUP BY 1,2
 ORDER BY 1,2`;

const BY_CATEGORY = { card: SQL, watch: WATCH_SQL };

const cache = {};
const TTL_MS = 15 * 60 * 1000;

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

const inflight = {};
async function load(view, force, category) {
  // ?fresh=1 (the REFRESH button) skips the cache; everything else reuses it
  const key = `${category}:${view}`;
  const c = cache[key];
  if (!force && c && Date.now() - c.at < TTL_MS) return c;
  // Each view walks Snowflake 2,000 rows at a time, so two requests landing
  // on a cold instance together would run the whole walk twice. One walk.
  if (!force && inflight[key]) return inflight[key];
  inflight[key] = loadNow(view, force, category, key)
    .finally(() => { delete inflight[key]; });
  return inflight[key];
}

async function loadNow(view, force, category, key) {

  const base = BY_CATEGORY[category][view].replace('{{ACCOUNT}}', esc(ACCOUNT));

  // Metabase caps an ad-hoc native query at 2,000 bare rows and ignores a
  // requested constraint, so walk the result with LIMIT/OFFSET and stitch the
  // pages together. PAGE stays under the cap; MAX_PAGES is a runaway guard.
  //
  // Every query ends in an ORDER BY whose last term is a row id, and it has
  // to: LIMIT/OFFSET over an order with ties is free to break them
  // differently on each page, which lands the same row on two pages and
  // drops another entirely. Ordering by close time or estimated value alone
  // did exactly that — a waiting view of 2,280 lots came back with one
  // duplicate on one read and four on the next, each duplicate standing in
  // for a lot that was silently missing.
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

  cache[key] = { at: Date.now(), rows, cols };
  return cache[key];
}

/** Totals: lot/item count plus the money columns each view actually carries. */
function totals(rows, view) {
  const sum = k => rows.reduce((a, r) => a + num(r[k]), 0);
  const base = { count: rows.length, est_value: sum('ESTIMATED_VALUE'), cost: sum('PURCHASE_COST') };
  if (view === 'active') {
    const withBids = rows.filter(r => num(r.TOTAL_BIDS) > 0);
    const bid = sum('CURRENT_BID');
    return {
      ...base,
      // where these lots stand if every one sold at its current bid
      pl_at_bid: bid - base.cost,
      margin_at_bid: bid ? ((bid - base.cost) / bid) * 100 : null,
      current_bid: sum('CURRENT_BID'),
      start_price: sum('START_PRICE'),
      bids: sum('TOTAL_BIDS'),
      with_bids: withBids.length,
      no_bids: rows.length - withBids.length,
      closing_24h: rows.filter(r => num(r.HOURS_LEFT) >= 0 && num(r.HOURS_LEFT) <= 24).length,
      reserve_total: sum('RESERVE')
    };
  }
  // waiting has no sale price, so measure against the estimate instead
  return {
    ...base,
    relists: rows.filter(r => num(r.PAST_AUCTIONS) > 0).length,
    margin_at_ev: base.est_value ? ((base.est_value - base.cost) / base.est_value) * 100 : null
  };
}

const SKIP = /url$|^id$|_id$/i;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const noStore = () => res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');

  if (!HOST || !KEY) {
    noStore();
    return res.status(200).json({ ok: false, error: 'METABASE_HOST / METABASE_API_KEY not set' });
  }

  const q = req.query || {};
  const category = BY_CATEGORY[q.category] ? q.category : 'card';
  const view = BY_CATEGORY[category][q.view] ? q.view : 'active';

  try {
    const fresh = q.fresh === '1' || q.fresh === 'true';
    if (fresh) noStore();
    const c = await load(view, fresh, category);
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
        ok: true, view, category, facet: key, total: seen.size,
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
      cols.filter(x => !isNum[x] && !isDate[x] && !SKIP.test(x)).forEach(col => {
        const seen = new Set();
        c.rows.forEach(r => { const v = r[col]; if (v !== null && v !== '') seen.add(String(v)); });
        facets[col] = { count: seen.size, values: [...seen].sort().slice(0, 300) };
      });
    }

    return res.status(200).json({
      ok: true,
      view,
      category,
      account: ACCOUNT,
      generated: new Date(c.at).toISOString(),
      columns: cols,
      numeric: isNum,
      dates: isDate,
      facets,
      total: c.rows.length,
      matched: rows.length,
      totals: slim ? null : totals(rows, view),
      totals_all: slim ? null : totals(c.rows, view),
      limit, offset,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      rows: rows.slice(offset, offset + limit)
    });
  } catch (e) {
    noStore();
    return res.status(200).json({ ok: false, view, error: e.message || String(e) });
  }
};
