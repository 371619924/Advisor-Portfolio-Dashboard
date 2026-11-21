import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function ready(child, pattern) {
  return new Promise((resolve, reject) => {
    let log = "";
    const timeout = setTimeout(() => reject(new Error("Server did not start\n" + log)), 15000);
    const fail = () => { clearTimeout(timeout); reject(new Error(log)); };
    child.once("exit", fail);
    function collect(data) {
      log += data;
      const match = log.match(pattern);
      if (match) {
        child.removeListener("exit", fail);
        clearTimeout(timeout);
        resolve(match[1]);
      }
    }
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
  });
}

const temp = await mkdtemp(join(tmpdir(), "advisor-web-"));
const children = [];
function start(args, env) {
  const child = spawn(process.execPath, args, {
    env: {...process.env, NEXT_TELEMETRY_DISABLED:"1", ...env}, stdio:["ignore","pipe","pipe"],
  });
  children.push(child);
  return child;
}

try {
  const api = start(["dist/main.js"], {ADVISOR_API_PORT:"0", ADVISOR_DATA_DIR:join(temp,"data")});
  const endpoint = await ready(api, /(http:\/\/127\.0\.0\.1:\d+\/graphql)/);
  const client = start(["node_modules/next/dist/bin/next","start","-H","127.0.0.1","-p","0"], {ADVISOR_API_URL:endpoint});
  const origin = await ready(client, /(http:\/\/127\.0\.0\.1:\d+)/);
  const growth = await fetch(origin + "/?portfolio=growth&date=2026-09-25&q=drawdown");
  assert.equal(growth.status,200);
  const html = await growth.text();
  assert.match(html,/Portfolio Review/);
  assert.match(html,/<th scope="row">BRVO<\/th>/);
  assert.match(html,/<td>2026-09-25<\/td>/);
  assert.match(html,/Drawdown review/);

  const balanced = await fetch(origin + "/?portfolio=balanced&date=2026-10-13&q=concentration");
  assert.equal(balanced.status,200);
  const switched = await balanced.text();
  assert.match(switched,/<th scope="row">DLTA<\/th>/);
  assert.doesNotMatch(switched,/<th scope="row">BRVO<\/th>/);
  assert.match(switched,/<td>2026-10-10<\/td>/);
  assert.match(switched,/Concentration review/);

  const invalid = await fetch(origin + "/?date=2026-02-31");
  assert.match(await invalid.text(), /role="alert">Invalid reporting date/);
  const report = {
    productionNextRendering: "passed",
    filters: ["portfolio","valuation date","full-text note search"],
    missingPriceDate: "most recent available quote is displayed",
    invalidDate: "error alert",
    transport: "Next.js server to NestJS GraphQL and embedded PostgreSQL"
  };
  if (process.env.ADVISOR_WEB_REPORT) {
    await mkdir(dirname(process.env.ADVISOR_WEB_REPORT), {recursive:true});
    await writeFile(process.env.ADVISOR_WEB_REPORT, JSON.stringify(report,null,2)+"\n");
  }
  console.log(JSON.stringify(report,null,2));
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child,"exit");
      child.kill("SIGTERM");
      await stopped;
    }
  }
  await rm(temp, {recursive:true,force:true});
}
