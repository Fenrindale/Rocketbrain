# Custom JDBC drivers

Configure a standalone JDK 25 or newer in `rocketbrain.java.javaHome`. Obtain the driver JAR and its fully qualified `java.sql.Driver` implementation from the database vendor. Use a trusted workspace and run **Add JDBC Driver**. Select any additional local JARs the driver requires. The approval identifies the exact files, class, per-file SHA‑256 values and ordered classpath checksum. Copies prepared for the JVM must continue to match those checksums.

Run **Manage JDBC Profiles** to choose a driver, enter the JDBC URL and credentials, and open its database catalog. Rocketbrain keeps these connection values in memory until the connection closes. The workspace profile stores its name, local artifact paths, class and checksums.

Use **Manage driver versions** inside a profile to add a named version and its own libraries. Selecting a version closes that profile's active connection and clears its in-memory credentials. Open the profile again to test the selected version. To roll back, select a previously approved version and reconnect. Remove inactive version approvals from the same menu.

Use **Browse JDBC Tables and Views** for column types and nullability. **New JDBC Query** opens a separate SQL editor, and **Run JDBC Query** executes one supported read query and opens the typed result. This workflow creates a fresh JDBC connection per operation. Use the database's own read-only account for least privilege.

## PostgreSQL

Choose **PostgreSQL** when adding a JDBC driver and select the official [pgJDBC JAR](https://jdbc.postgresql.org/download/). Save the host, port, database and schema in the profile. The profile uses `org.postgresql.Driver`. Verified TLS requires a local trusted CA file. A connection without TLS is available for the numeric loopback addresses `127.0.0.1` and `::1`.

The catalog shows visible tables, views and materialized views in the selected schema and reports exact column metadata. The query editor supports one PostgreSQL read statement, including dollar-quoted literals, nested comments, casts and JSON operators. Before executing it, Rocketbrain checks the server's `transaction_read_only` setting. Database permissions still govern schema access and functions.

From the JDBC editor, run **Estimate PostgreSQL Query Plan** for a statement such as `SELECT id, amount FROM events WHERE id = 42`. Use one ordinary table in the approved schema, simple unquoted column names or `*`, and an optional equality on a built-in smallint, integer or bigint column. The workflow requires PostgreSQL 14 or newer. It shows the operator tree, cost units, row estimates and filters from the server's JSON. **Open Original PostgreSQL Plan JSON** opens the exact response and **Compare PostgreSQL Estimated Plans** compares two captures of the same statement and relation. Up to eight captures live in the active connection and expire when it closes.

The planner runs in a verified read-only transaction and captures estimates only. Use an owned, trusted server and schema with a dedicated SELECT account. The capture checks visible heap metadata and holds an access-share lock. It refuses observed views, inheritance, row-security policies, check constraints, expression statistics and custom or expression indexes. Coordinate concurrent schema changes with the schema owner.

For reviewed cell editing, add a separate PostgreSQL profile and select **Allow reviewed PostgreSQL cell edits**. This profile still uses read-only JDBC query and estimate sessions. Open **Open PostgreSQL Table Grid** for a supported table with one integer primary key, then choose a text or integer cell. The grid previews at most 100 rows and the first column shows the row key. The confirmation shows the key and the exact old and new value. Commit applies one cell in its own transaction and rechecks the table metadata and complete row version. PostgreSQL must grant the connection account SELECT and UPDATE for the table. Table features that can cause indirect writes, such as triggers and generated columns, are outside this grid.

Open a fresh grid after five minutes. If the row or its schema changed, the reviewed update is refused. If the client loses the receipt while committing, reopen the grid and confirm the current value before submitting another edit.

pgJDBC uses the [BSD 2-Clause license](https://jdbc.postgresql.org/license/). Install it separately. The VS Code extension bundles neither the driver nor PostgreSQL server binaries.

## Runtime bounds

Each operation uses a separate JVM with its environment filtered. The class loader resolves classes from the Java platform, the primary driver JAR and the approved libraries in order. Duplicate class definitions across JARs are rejected. A JAR's manifest does not load extra artifacts. Driver code runs with the permissions of your user account and receives the URL and credentials you provide. Use vetted JARs from a source you trust.

Oracle MySQL Connector/J and MariaDB Connector/J were tested over TCP. Their query sessions request server read-only transactions. Other drivers must acknowledge JDBC read-only mode and use the supported SQL subset. Automatic dependency discovery, vendor-specific authentication combinations, writes, persistent transactions, and complete multi-dialect SQL are outside this workflow.

Each profile can keep eight approved versions. Each version accepts up to six explicit library JARs and 128 MiB total. Queries sample up to 500 rows and 128 columns. Output is limited to 4 MiB and individual values to 64 KiB. The result preserves exact integer and decimal text, Unicode, binary hex and SQL NULL with JDBC metadata. Cancellation requests `Statement.cancel()` and closes the JVM if needed.
