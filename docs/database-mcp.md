# MySQL and MariaDB tools over local MCP

The Rocketbrain stdio executable can be started with `db_catalog`, `db_sample`, or both. Add each selected tool as an `--allow-tool` flag. Pass an absolute `--workspace` directory and a separate `--db-scope` JSON path to `node <extension-directory>/dist/ide-mcp-server.js`. Supply the dedicated database reader's password through the MCP client's launch environment as `ROCKETBRAIN_MCP_DB_PASSWORD`. Keep the password in the client's secret store or launch environment.

An approval file binds one explicit numeric loopback address, port, schema, username and set of tables and columns for the life of the process. Edit the file and restart the client process to change the scope. Approval is independent of any active VS Code DB profile. Use a MySQL or MariaDB account with direct `SELECT` access to the chosen tables or columns. Rocketbrain checks the grants before reading and opens a read-only transaction for each request. The check includes MySQL mandatory roles and MariaDB `PUBLIC` grants where supported. Use ordinary InnoDB base tables. Objects with executable definitions, remote storage engines and generated columns are outside the row sampling scope.

```json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 3306,
  "schema": "journal",
  "username": "journal_reader",
  "tables": [{ "name": "events", "columns": ["id", "summary", "created_at"] }]
}
```

`db_catalog` accepts no arguments or an exact approved `table` name. It returns live metadata for the approved columns. `db_sample` requires `table` and `columns`. It accepts a `limit` of 1–50, up to four equality filters in `equals` and up to three approved sort columns in `order`. For example, `{"table":"events","columns":["id","summary"],"equals":[{"column":"id","kind":"integer","value":"9007199254740993"}],"order":[{"column":"id","direction":"asc"}]}`. Equality follows the column type and database collation. Use decimal strings for exact numeric filters and `{"column":"summary","kind":"null"}` for a SQL `NULL` filter.

The `structuredContent` result includes column metadata and typed cells. Integers, decimals and temporal values are represented as strings. Binary cells use base64. MariaDB's JSON alias is reported as text. Cells over 2 KiB receive a truncation marker counted in `clippedCells`. Samples have a 96 KiB result budget. Database values are untrusted data for the client to interpret. The MCP process generates a fixed SELECT from approved identifiers and bound equality values.

For the owned Spring integration fixture, set `ROCKETBRAIN_ENABLE_DB_MCP_FIXTURE=1` and run `node scripts/spring-project.js run --engine mysql -- test/db-mcp-host.js` after building the extension. The same runner accepts `--engine mariadb`. [MySQL read-only transaction behavior](https://dev.mysql.com/doc/refman/8.4/en/set-transaction.html)
