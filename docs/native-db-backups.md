# Native MySQL and MariaDB backups

Use **Create Native Database Dump** to select InnoDB tables and the matching installed vendor client bin directory. The file includes the source rows and table definitions, so handle it according to the data it contains. **Review and Restore Native Dump** checks that the file matches its workspace receipt and restores it to the selected empty schema.

Choose **Add schema objects** during backup to include a dependency graph of selected views, routines and triggers. Include the selected tables and all named dependencies. For each selected trigger group, select every trigger with the same table, timing and event. The backup restores table data before creating triggers. Review lists the objects in order and the final checksum.

Graph backup accepts bounded SELECT and JOIN views, static procedures, deterministic scalar functions, and structured triggers with compatible UTF‑8 creation settings. The workflow preserves the effective definer, SQL SECURITY, routine context and trigger order. The source definitions are checked again after the native table dump. Restore checks the server account, schema defaults, and restored table and object definitions.

Restore a graph into a different empty schema on the same server under the same effective account. The schema's default collation must match. Existing privileges apply to the backup and restore. Use the workflow's review path when preserving the original definer matters. Unsupported dynamic SQL, cross-schema dependencies, other definers, external table storage and version-dependent table clauses are rejected.

Restoring DDL commits changes on the server. A failure or cancellation can leave partial changes in the chosen schema. The workflow reports the outcome and leaves cleanup to the operator.
