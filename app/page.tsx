type Position = {
  symbol: string; shares: number; value: number; weight: number;
  priceDate: string; nextEarnings: string | null;
}
type Snapshot = { name: string; asOf: string; total: number; drawdown: number; positions: Position[] }
type Note = { id: string; title: string; body: string };
type Options = Record<string, string | string[] | undefined>;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 });

async function query<T>(operation: string, variables: Record<string, string>): Promise<T> {
  const endpoint = process.env.ADVISOR_API_URL ?? "http://127.0.0.1:4100/graphql";
  const result = await fetch(endpoint, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(5000),
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({query: operation, variables})
  });
  if (!result.ok) throw new Error("Portfolio service is unavailable.");
  const payload = await result.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  return payload.data as T;
}

export default async function Page({searchParams}: {searchParams: Promise<Options>}) {
  const params = await searchParams;
  const id = params.portfolio === "balanced" ? "balanced" : "growth";
  const asOf = typeof params.date === "string" ? params.date : "2026-10-10";
  const text = typeof params.q === "string" ? params.q.trim() : "";
  let snapshot: Snapshot | undefined;
  let notes: Note[] = [];
  let error = "";
  try {
    const view = await query<{portfolio: Snapshot}>(
      "query Portfolio($id: String!, $date: String!) { portfolio(id:$id, asOf:$date) { name asOf total drawdown positions { symbol shares value weight priceDate nextEarnings } } }",
      {id, date: asOf});
    snapshot = view.portfolio;
    if (text) {
      const research = await query<{researchNotes: Note[]}>(
        "query Research($id: String!, $text: String!) { researchNotes(id:$id, text:$text) { id title body } }",
        {id, text});
      notes = research.researchNotes;
    }
  } catch (problem) {
    error = problem instanceof Error ? problem.message : "Portfolio could not be loaded.";
  }

  return <>
    <header><h1>Portfolio Review</h1><p>Simulated positions and market data</p></header>
    <form>
      <label>Portfolio<select name="portfolio" defaultValue={id}><option value="growth">Growth</option><option value="balanced">Balanced</option></select></label>
      <label>Valuation date<input type="date" name="date" defaultValue={asOf} required/></label>
      <button>Apply</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {snapshot && <>
      <section aria-label={snapshot.name} className="summary">
        <div><h2>Market value</h2><p>{money.format(snapshot.total)}</p></div>
        <div><h2>Maximum historical drawdown</h2><p>{percent.format(snapshot.drawdown)}</p></div>
      </section>
      <section>
        <h2>Positions</h2>
        <div className="table"><table>
          <thead><tr><th>Symbol</th><th>Shares</th><th>Market value</th><th>Weight</th><th>Last quote</th><th>Next earnings</th></tr></thead>
          <tbody>{snapshot.positions.map((p) => <tr key={p.symbol}>
            <th scope="row">{p.symbol}</th><td>{p.shares}</td><td>{money.format(p.value)}</td>
            <td>{percent.format(p.weight)}</td><td>{p.priceDate}</td><td>{p.nextEarnings ?? "Unavailable"}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
      <section>
        <h2>Research notes</h2>
        <form>
          <input type="hidden" name="portfolio" value={id}/><input type="hidden" name="date" value={asOf}/>
          <label>Search notes<input type="search" name="q" maxLength={120} defaultValue={text} required/></label><button>Search</button>
        </form>
        {notes.map(note => <article key={note.id}><h3>{note.title}</h3><p>{note.body}</p><small>Source {note.id}</small></article>)}
        {text && !notes.length && !error && <p>No matching notes.</p>}
      </section>
    </>}
  </>;
}
