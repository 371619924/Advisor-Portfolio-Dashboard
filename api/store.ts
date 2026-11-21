import { PGlite } from "@electric-sql/pglite";
import { firstDate, MarketFeed, symbols, validDate, type Price, type Earnings } from "./provider";

const schema = `
CREATE TABLE IF NOT EXISTS portfolio (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS holding (
  portfolio_id text REFERENCES portfolio(id), symbol text, shares integer NOT NULL CHECK (shares > 0),
  PRIMARY KEY (portfolio_id, symbol)
);
CREATE TABLE IF NOT EXISTS price (
  symbol text, day date, close numeric(12,2) NOT NULL CHECK (close > 0), PRIMARY KEY (symbol, day)
);
CREATE TABLE IF NOT EXISTS earnings (
  symbol text, day date, PRIMARY KEY (symbol, day)
);
CREATE TABLE IF NOT EXISTS research_note (
  id text PRIMARY KEY, portfolio_id text REFERENCES portfolio(id), title text NOT NULL, body text NOT NULL
);
CREATE INDEX IF NOT EXISTS research_note_text ON research_note USING gin (to_tsvector('english', title || ' ' || body));
INSERT INTO portfolio VALUES ('growth','Growth portfolio'), ('balanced','Balanced portfolio') ON CONFLICT DO NOTHING;
INSERT INTO holding VALUES ('growth','ALFA',100), ('growth','BRVO',80), ('growth','CHAR',65),
  ('balanced','ALFA',50), ('balanced','CHAR',90), ('balanced','DLTA',100) ON CONFLICT DO NOTHING;
INSERT INTO research_note VALUES
  ('note-drawdown','growth','Drawdown review','Compare the latest valuation with its prior peak before the allocation review.'),
  ('note-earnings','growth','Earnings review','Review issuer earnings dates and the portfolio exposure ahead of scheduled updates.'),
  ('note-balanced','balanced','Concentration review','Review the largest holdings when assessing concentration and rebalance proposals.')
  ON CONFLICT DO NOTHING;
`;

export class AdvisorStore {
  constructor(private readonly db: PGlite, private readonly feed: MarketFeed) {}

  async initialize() { await this.db.exec(schema); }
  async close() { await this.db.close(); }

  async refresh() {
    const priorRetries = this.feed.retries;
    const batch: { symbol: string; prices: Price[]; earnings: Earnings[] }[] = [];
    for (const symbol of symbols) {
      batch.push({ symbol, prices: await this.feed.prices(symbol), earnings: await this.feed.earnings(symbol) });
    }
    await this.db.transaction(async tx => {
      for (const { symbol, prices, earnings } of batch) {
        for (const q of prices) {
          await tx.query(`INSERT INTO price VALUES ($1,$2,$3)
            ON CONFLICT(symbol, day) DO UPDATE SET close = EXCLUDED.close`, [q.symbol, q.date, q.close]);
        }
        await tx.query("DELETE FROM earnings WHERE symbol = $1", [symbol]);
        for (const item of earnings) {
          await tx.query("INSERT INTO earnings VALUES ($1,$2) ON CONFLICT DO NOTHING", [item.symbol, item.date]);
        }
      }
    });
    return { prices: batch.reduce((n, b) => n + b.prices.length, 0),
      earnings: batch.reduce((n, b) => n + b.earnings.length, 0), retries: this.feed.retries - priorRetries };
  }

  async counts() {
    const { rows } = await this.db.query<{ prices: number; earnings: number }>(
      "SELECT (SELECT count(*)::int FROM price) AS prices, (SELECT count(*)::int FROM earnings) AS earnings");
    return rows[0];
  }

  async snapshot(id: string, asOf: string) {
    if (!validDate(asOf) || asOf < firstDate) throw new Error("Invalid reporting date");
    return this.db.transaction(async tx => {
      const portfolio = await tx.query<{ name: string }>("SELECT name FROM portfolio WHERE id = $1", [id]);
      if (portfolio.rows.length !== 1) throw new Error("Unknown portfolio");

      const priced = await tx.query<{ symbol: string; shares: number; close: number | null;
        value: number | null; nextEarnings: string | null; priceDate: string | null }>(`
        SELECT h.symbol, h.shares, q.close::float8, (q.close * h.shares)::float8 AS value,
          q.day::text AS "priceDate", e.day::text AS "nextEarnings"
        FROM holding h
        LEFT JOIN LATERAL (
          SELECT p.close, p.day FROM price p WHERE p.symbol=h.symbol AND p.day <= $2::date
          ORDER BY p.day DESC LIMIT 1
        ) q ON true
        LEFT JOIN LATERAL (
          SELECT min(day) AS day FROM earnings WHERE symbol=h.symbol AND day >= $2::date
        ) e ON true
        WHERE h.portfolio_id = $1 ORDER BY h.symbol`, [id, asOf]);
      if (priced.rows.some(p => p.value === null)) throw new Error("Incomplete price coverage");
      const total = priced.rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
      if (total <= 0) throw new Error("No holdings available");

      const risk = await tx.query<{ drawdown: number }>(`
        WITH daily AS (
          SELECT p.day, sum(p.close * h.shares) AS valuation FROM price p JOIN holding h USING(symbol)
          WHERE h.portfolio_id = $1 AND p.day <= $2::date GROUP BY p.day
          HAVING count(*) = (SELECT count(*) FROM holding WHERE portfolio_id = $1)
        ), peak AS (
          SELECT valuation, max(valuation) OVER (ORDER BY day) AS high_water_mark FROM daily
        )
        SELECT coalesce(max((high_water_mark - valuation) / high_water_mark),0)::float8 AS drawdown FROM peak
      `, [id, asOf]);
      return { id, name: portfolio.rows[0].name, asOf, total: Math.round(total * 100) / 100, drawdown: risk.rows[0].drawdown,
        positions: priced.rows.map(row => ({ ...row, weight: (row.value ?? 0) / total })) };
    });
  }

  async search(id: string, text: string) {
    if (!text.trim() || text.length > 120) throw new Error("Enter a search term of 1 to 120 characters");
    const { rows } = await this.db.query<{ id: string; title: string; body: string }>(`
      SELECT id, title, body FROM research_note
      WHERE portfolio_id = $1 AND to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', $2)
      ORDER BY ts_rank(to_tsvector('english', title || ' ' || body), plainto_tsquery('english', $2)) DESC, id
      LIMIT 8
    `, [id, text]);
    return rows;
  }
}
