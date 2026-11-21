# Advisor Portfolio Dashboard

A local TypeScript prototype for reviewing portfolio positions, valuation dates, scheduled earnings, and research notes. Next.js renders the React interface and calls a NestJS GraphQL service. The service uses PGlite, an embedded PostgreSQL engine. The external feed is a local HTTP fixture with synthetic prices and an FMP-style contract. Run it with the built-in market data.

## Reproduce

Use Node.js 24 and npm.

```sh
npm ci
ADVISOR_TEST_REPORT=results/reproduced_api.json npm test
NEXT_TELEMETRY_DISABLED=1 npm run build
ADVISOR_WEB_REPORT=results/reproduced_web.json node verify_web.mjs
```

To open the demo, build first and run these commands in separate terminals.

```sh
npm run api
npm run web
```

Open http://127.0.0.1:3000. Choose a portfolio and a date on or after September 1, 2026. Search for "drawdown" in Growth or "concentration" in Balanced. The API and market data fixture listen on loopback. Use the `ADVISOR_API_PORT`, `ADVISOR_API_URL`, and `ADVISOR_DATA_DIR` variables to override the local ports or data directory.

## Data and verification

The provider client uses an API key, bounds retry attempts for HTTP 429 and 503, rejects HTTP authentication errors, and verifies the expected fields and calendar dates. It fetches all four symbols' prices and earnings schedules before publishing them in a single transaction. Each successful refresh replaces the previous earnings calendar for those symbols, including dates removed by the source. The quote key comprises symbol and date. Repeated imports of the same fixture retain 160 quotes and four earnings rows. Provider failures and invalid responses leave the last successful snapshot intact. Integration tests reopen the database to verify persistence and start the command-line API with a port already in use to verify clean startup failure.

Each valuation reads the portfolio in one database transaction. It uses the most recent price at or before the requested date and displays the source date per position. Positions have fixed shares. The drawdown query uses common observation dates and compares daily value with its running maximum. The sample balanced portfolio has a positive drawdown that was checked against an independent loop, along with both portfolio values. Earnings dates come from the fixture's current calendar. Notes are filtered to the selected portfolio and ranked through PostgreSQL full-text search. The user interface displays the source ID and exact matching note text.

The fixture contains four invented securities, each with 40 calendar-day quotes and fixed holdings. Earnings and note results use the synthetic data provided by the demo. The included integration and production-build HTTP tests exercise local workflows.

References

- [NestJS GraphQL quick start](https://docs.nestjs.com/graphql/quick-start)
- [FMP API quick start](https://site.financialmodelingprep.com/developer/docs/quickstart)
