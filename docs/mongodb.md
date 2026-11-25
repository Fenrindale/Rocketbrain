# Local MongoDB document workbench

Run **Rocketbrain: Connect to Local MongoDB** from the VS Code Command Palette. Enter the numeric loopback address, port, authentication database and SCRAM-SHA-256 credentials. Loopback points to the host running the Rocketbrain extension. Credentials are held for the connection session. A MongoDB account with the built-in `read` role can use the workbench for its authorized databases.

Run **Rocketbrain: Browse MongoDB Collections** to choose an authorized database and a collection or view. This opens a JSON find editor. Save the editor with a `.mongo.json` suffix to reuse the query after reconnecting. **Rocketbrain: Run Read-Only MongoDB Find** opens a read-only JSON preview beside the query. The preview reports whether a row count or byte budget stopped the read. Closing the MongoDB connection clears retained previews.

```json
{
  "database": "journal",
  "collection": "events",
  "filter": {
    "serial": { "$gte": { "$numberLong": "9007199254740993" } },
    "eventAt": { "$gte": { "$date": "2026-01-01T00:00:00.000Z" } }
  },
  "projection": { "serial": 1, "eventAt": 1, "_id": 0 },
  "sort": { "eventAt": -1 },
  "limit": 50
}
```

Filters accept equality, comparisons, `$in`, `$nin`, `$exists`, `$and`, `$or` and `$nor`. Canonical Extended JSON literals support ObjectId, numeric BSON types, dates and binary values. Results preserve native BSON types in canonical Extended JSON, including integers beyond the JavaScript safe integer range. The query cap is 64 KiB, with up to 200 returned documents, a 256 KiB document budget, a 1 MiB aggregate document budget and a five-second server read limit. The current connection targets one loopback server and exposes catalog browsing and find queries.

The official MongoDB Node.js driver is distributed under Apache-2.0 with its dependency notices included in the VSIX. MongoDB Community Server is a separately obtained SSPL component. The portable vendor runtime used for verification is outside the VSIX. [MongoDB licensing](https://www.mongodb.com/legal/licensing/community-edition)

## Disposable actual-server verification

Obtain the official MongoDB Community Server distribution and check its published signature. Run `node test/mongodb-host.js <absolute-path-to-mongod>` after installing the repository dependencies. The test starts an auth-enabled loopback process in a new temporary data directory, creates fixture-only accounts and databases, and removes the data directory after stopping its own child. The native extension host hook uses `ROCKETBRAIN_MONGODB_TEST_BIN` to locate the same runtime. [MongoDB release integrity documentation](https://www.mongodb.com/docs/v8.0/tutorial/verify-mongodb-packages/)
