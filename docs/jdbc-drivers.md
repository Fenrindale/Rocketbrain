# Custom JDBC drivers

Configure a standalone JDK 25 or newer in `rocketbrain.java.javaHome`. Obtain the driver JAR and its fully qualified `java.sql.Driver` implementation from the database vendor. Use a trusted workspace and run **Add JDBC Driver**. The approval identifies the exact local file, class and SHA‑256. Copies prepared for the JVM must continue to match that checksum.

Run **Manage JDBC Profiles** to choose a driver, enter the JDBC URL and credentials, and open its database catalog. Rocketbrain keeps these connection values in memory until the connection closes. The workspace profile stores the name, local JAR path, class and checksum.

Use **Browse JDBC Tables and Views** for column types and nullability. **New JDBC Query** opens a separate SQL editor, and **Run JDBC Query** executes one supported read query and opens the typed result. This workflow creates a fresh JDBC connection per operation. Use the database's own read-only account for least privilege.

Each operation uses a separate JVM with its environment filtered. The class loader resolves only the approved JAR and the Java platform classes. A JAR's manifest does not load extra artifacts. Driver code runs with the permissions of your user account and receives the URL and credentials you provide. Use vetted JARs from a source you trust.

Oracle MySQL Connector/J and MariaDB Connector/J were tested over TCP. Their query sessions request server read-only transactions. Other drivers must acknowledge JDBC read-only mode and use the supported SQL subset. Extra driver dependencies, vendor-specific authentication combinations, writes, persistent transactions, and complete multi-dialect SQL are outside this workflow.

Queries sample up to 500 rows and 128 columns. Output is limited to 4 MiB and individual values to 64 KiB. The result preserves exact integer and decimal text, Unicode, binary hex and SQL NULL with JDBC metadata. Cancellation requests `Statement.cancel()` and closes the JVM if needed.
