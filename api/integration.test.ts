import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { startApi } from "./main";
import { fixtureKey, lastDate, MarketFeed, priceHistory, startFixture } from "./provider";

const snapshotQuery = `query Snapshot($id: String!, $date: String!) {
  portfolio(id:$id,asOf:$date) { asOf total drawdown positions { symbol shares value weight priceDate nextEarnings } }
}`;

function calculate(positions: Record<string, number>, days: number) {
  const values = Array.from({length:days}, (_, i) => Object.entries(positions)
    .reduce((sum, [symbol, quantity]) => sum + quantity * priceHistory(symbol)[i].close, 0));
  let peak = 0, drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    drawdown = Math.max(drawdown, (peak - value) / peak);
  }
  return {total: Math.round(values.at(-1)! * 100) / 100, drawdown};
}

test("provider recovery, PostgreSQL transactions, GraphQL valuation and notes", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-db-"));
  const path = join(root, "data");
  const feedFixture = await startFixture();
  const feed = new MarketFeed(feedFixture.origin, fixtureKey);
  const api = await startApi(new PGlite(path), feed);
  let closed = false;
  async function graphql(query: string, variables: Record<string, string>) {
    const response = await fetch(api.endpoint, {method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({query,variables})});
    assert.equal(response.status, 200);
    return response.json();
  }

  try {
    assert.deepEqual(await api.store.refresh(), {prices:160, earnings:4, retries:1});
    assert.deepEqual(await api.store.refresh(), {prices:160, earnings:4, retries:0});
    assert.deepEqual(await api.store.counts(), {prices:160, earnings:4});
    const date = "2026-09-25";
    const response = await graphql(snapshotQuery, {id:"growth",date});
    assert.equal(response.errors, undefined);
    const {portfolio} = response.data;
    const expected = calculate({ALFA:100, BRVO:80, CHAR:65},25);
    assert.equal(portfolio.total, expected.total);
    assert.ok(Math.abs(portfolio.drawdown - expected.drawdown) < 1e-12);
    assert.ok(Math.abs(portfolio.positions.reduce((sum: number, p: {weight:number}) => sum + p.weight, 0) - 1) < 1e-12);
    assert.ok(portfolio.positions.every((p: {priceDate:string; nextEarnings:string}) =>
      p.priceDate === date && p.nextEarnings === "2026-11-06"));

    const later = await graphql(snapshotQuery, {id:"balanced",date:"2026-10-13"});
    const balanced = calculate({ALFA:50, CHAR:90, DLTA:100},40);
    assert.equal(later.data.portfolio.total, balanced.total);
    assert.ok(balanced.drawdown > 0);
    assert.ok(Math.abs(later.data.portfolio.drawdown - balanced.drawdown) < 1e-12);
    assert.deepEqual(later.data.portfolio.positions.map((p: {symbol:string}) => p.symbol), ["ALFA","CHAR","DLTA"]);
    assert.ok(later.data.portfolio.positions.every((p: {priceDate:string}) => p.priceDate === lastDate));
    assert.ok((await graphql(snapshotQuery, {id:"growth",date:"2026-02-31"})).errors);
    const notesQuery = "query Notes($id:String!,$text:String!){researchNotes(id:$id,text:$text){id title}}";
    const growthNotes = (await graphql(notesQuery, {id:"growth",text:"drawdown"})).data.researchNotes;
    assert.equal(growthNotes[0].id, "note-drawdown");
    assert.deepEqual((await graphql(notesQuery, {id:"balanced",text:"drawdown"})).data.researchNotes, []);

    feedFixture.controls.changedPrices = true;
    feedFixture.controls.earningsDate = "2026-02-31";
    await assert.rejects(api.store.refresh(), /Invalid earnings data/);
    feedFixture.controls.earningsDate = "2026-11-16";
    feedFixture.controls.failSymbol = "DLTA";
    await assert.rejects(api.store.refresh(), /503/);
    const authorization = new MarketFeed(feedFixture.origin, "wrong-key");
    await assert.rejects(authorization.prices("ALFA"), /401/);
    assert.equal(authorization.retries, 0);
    assert.deepEqual(await graphql(snapshotQuery, {id:"growth",date}), response);

    feedFixture.controls.failSymbol = "";
    await api.store.refresh();
    assert.deepEqual(await api.store.counts(), {prices:160, earnings:4});
    const updated = (await graphql(snapshotQuery, {id:"growth",date})).data.portfolio;
    assert.equal(updated.total, portfolio.total + 20 * 245);
    assert.ok(updated.positions.every((p: {nextEarnings:string}) => p.nextEarnings === "2026-11-16"));
    feedFixture.controls.earningsDate = null;
    await api.store.refresh();
    assert.deepEqual(await api.store.counts(), {prices:160, earnings:0});
    const cleared = (await graphql(snapshotQuery, {id:"growth",date})).data.portfolio;
    assert.ok(cleared.positions.every((p: {nextEarnings:string | null}) => p.nextEarnings === null));

    await api.close();
    closed = true;
    const reopened = new PGlite(path);
    try {
      const {rows} = await reopened.query("SELECT count(*)::int AS value FROM price");
      assert.equal((rows[0] as {value:number}).value, 160);
    } finally {
      await reopened.close();
    }
    if (process.env.ADVISOR_TEST_REPORT) {
      const report = process.env.ADVISOR_TEST_REPORT;
      await mkdir(join(report,".."), {recursive:true});
      await writeFile(report, JSON.stringify({
        quotes:160, earnings:4, matchedIndependentValuation:true, matchedIndependentDrawdown:true,
        retryOnRateLimit:true, authorizationFailureNotRetried:true, repeatedRefreshCreatedDuplicates:false,
        preservedSnapshotOnProviderFailure:true, persistedAfterRestart:true, portfolioScopedNotes:true,
        rescheduledEarningsReplaced:true, removedEarningsCleared:true,
        samplePortfolio:portfolio, balancedPortfolio:later.data.portfolio
      },null,2) + "\n");
    }
  } finally {
    if (!closed) await api.close();
    await feedFixture.close();
    await rm(root, {recursive:true, force:true});
  }
});

test("API CLI exits after an occupied port prevents startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-port-"));
  const occupied = createServer();
  try {
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const { port } = occupied.address() as AddressInfo;
    const run = promisify(execFile)(process.execPath, [join(__dirname, "main.js")], {
      env: { ...process.env, ADVISOR_API_PORT: String(port), ADVISOR_DATA_DIR: join(root, "db") },
      timeout: 12000,
    });
    await assert.rejects(run, { code: 1, message: /EADDRINUSE/ });
  } finally {
    if (occupied.listening) {
      await new Promise<void>((resolve, reject) =>
        occupied.close(error => error ? reject(error) : resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
