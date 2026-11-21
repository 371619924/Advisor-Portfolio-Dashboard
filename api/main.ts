import "reflect-metadata";
import { PGlite } from "@electric-sql/pglite";
import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import { Inject, Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Args, GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import { AdvisorStore } from "./store";
import { fixtureKey, MarketFeed, startFixture } from "./provider";

const types = `
type Position {
  symbol: String!
  shares: Int!
  close: Float!
  value: Float!
  weight: Float!
  priceDate: String!
  nextEarnings: String
}
type Snapshot {
  id: String!
  name: String!
  asOf: String!
  total: Float!
  drawdown: Float!
  positions: [Position!]!
}
type Note {
  id: String!
  title: String!
  body: String!
}
type Query {
  portfolio(id: String!, asOf: String!): Snapshot!
  researchNotes(id: String!, text: String!): [Note!]!
}
`;

@Resolver()
class AdvisorResolver {
  constructor(@Inject(AdvisorStore) private readonly store: AdvisorStore) {}

  @Query("portfolio")
  portfolio(@Args("id") id: string, @Args("asOf") date: string) {
    return this.store.snapshot(id, date);
  }

  @Query("researchNotes")
  researchNotes(@Args("id") id: string, @Args("text") text: string) {
    return this.store.search(id, text);
  }
}

export async function startApi(db: PGlite, feed: MarketFeed, port = 0) {
  const store = new AdvisorStore(db, feed);

  @Module({
    imports: [GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver, typeDefs: types, sortSchema: true, playground: false,
      introspection: false, includeStacktraceInErrorResponses: false,
    })],
    providers: [AdvisorResolver, { provide: AdvisorStore, useValue: store }],
  })
  class ApiModule {}

  let app: INestApplication | undefined;
  try {
    await store.initialize();
    app = await NestFactory.create(ApiModule, { logger: false, abortOnError: false });
    await app.listen(port, "127.0.0.1");
    const listeningApp = app;
    return { store, endpoint: (await app.getUrl()) + "/graphql", close: async () => {
      try {
        await listeningApp.close();
      } finally {
        await store.close();
      }
    } };
  } catch (error) {
    await app?.close().catch(() => {});
    await store.close().catch(() => {});
    throw error;
  }
}

async function main() {
  const fixture = await startFixture();
  let api: Awaited<ReturnType<typeof startApi>> | undefined;
  try {
    api = await startApi(new PGlite(process.env.ADVISOR_DATA_DIR ?? "./portfolio-data"),
      new MarketFeed(fixture.origin, fixtureKey), Number(process.env.ADVISOR_API_PORT ?? 4100));
    await api.store.refresh();
  } catch (error) {
    await Promise.allSettled([api?.close(), fixture.close()]);
    throw error;
  }
  const runningApi = api;
  process.stdout.write(runningApi.endpoint + "\n");
  const shutdown = async () => {
    try {
      await runningApi.close();
    } finally {
      await fixture.close();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
