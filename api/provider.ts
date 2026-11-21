import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

export type Price = { symbol: string; date: string; close: number };
export type Earnings = { symbol: string; date: string };

export const symbols = ["ALFA", "BRVO", "CHAR", "DLTA"] as const;
export const fixtureKey = "demo-market-feed";
export const firstDate = "2026-09-01";
export const lastDate = "2026-10-10";

export function validDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T00:00:00Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

export function priceHistory(symbol: string): Price[] {
  const base = 40 + 15 * symbols.indexOf(symbol as typeof symbols[number]);
  return Array.from({ length: 40 }, (_, offset) => ({
    symbol,
    date: new Date(Date.parse(firstDate) + offset * 86400000).toISOString().slice(0, 10),
    close: Math.round((base + offset * 0.25 + 3 * Math.sin(offset / 5 + base)) * 100) / 100,
  }));
}

export async function startFixture() {
  const controls = { failSymbol: "", earningsDate: "2026-11-06" as string | null,
    changedPrices: false, attempts: 0, rateLimited: 0 };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const symbol = url.searchParams.get("symbol") ?? "";
    const reply = (status: number, payload: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(payload));
    controls.attempts++;
    if (url.searchParams.get("apikey") !== fixtureKey) return reply(401, { message: "Invalid key" });
    if (url.pathname === "/stable/historical-price-eod/full" && controls.rateLimited === 0) {
      controls.rateLimited++;
      res.setHeader("Retry-After", "0");
      return reply(429, { message: "Try again" });
    }
    if (symbol === controls.failSymbol) return reply(503, { message: "Unavailable" });
    if (!symbols.some(item => item === symbol)) return reply(404, { message: "Unknown symbol" });

    if (url.pathname === "/stable/historical-price-eod/full") {
      const prices = priceHistory(symbol).map(row => controls.changedPrices ? { ...row, close: row.close + 20 } : row);
      return reply(200, prices.reverse());
    }
    if (url.pathname === "/stable/earnings") {
      return reply(200, controls.earningsDate === null ? [] : [{ symbol, date: controls.earningsDate }]);
    }
    return reply(404, { message: "Not found" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { origin: "http://127.0.0.1:" + port, controls,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

export class MarketFeed {
  public retries = 0;

  constructor(private readonly origin: string, private readonly key: string) {}

  private async get(path: string, symbol: string, minimumRows: number): Promise<unknown[]> {
    const url = new URL(path, this.origin);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", this.key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500), redirect: "error" });
      if (response.ok) {
        const body: unknown = await response.json();
        if (Array.isArray(body) && body.length >= minimumRows && body.length <= 10000) return body;
        throw new Error("Invalid provider payload");
      }
      if (attempt === 2 || ![429, 503].includes(response.status)) {
        throw new Error("Provider returned HTTP " + response.status);
      }
      const header = response.headers.get("Retry-After");
      const wait = header === null ? 30 * (attempt + 1) : Math.min(250, Math.max(0, Number(header) * 1000));
      await response.body?.cancel();
      this.retries++;
      await sleep(Number.isFinite(wait) ? wait : 30);
    }
    throw new Error("Provider retry budget exhausted");
  }

  async prices(symbol: string): Promise<Price[]> {
    const body = await this.get("/stable/historical-price-eod/full", symbol, 1);
    return body.map(row => {
      const p = row as Partial<Price> | null;
      if (!p || p.symbol !== symbol || !validDate(p.date) || typeof p.close !== "number"
        || !Number.isFinite(p.close) || p.close <= 0 || p.close > 1000000) {
        throw new Error("Invalid quote data");
      }
      return { symbol, date: p.date, close: p.close };
    });
  }

  async earnings(symbol: string): Promise<Earnings[]> {
    const body = await this.get("/stable/earnings", symbol, 0);
    return body.map(row => {
      const e = row as Partial<Earnings> | null;
      if (!e || e.symbol !== symbol || !validDate(e.date)) throw new Error("Invalid earnings data");
      return { symbol, date: e.date };
    });
  }
}
