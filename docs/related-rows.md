# Related rows in MySQL and MariaDB

Open a table and choose **Related Rows** in Grid or Record view. The picker lists both referenced and referencing tables visible to the current connection, including physical foreign keys across schemas on the same server. Each destination shows its schema and table name. Relationships with a `NULL` component are skipped.

Logical relationships saved in **Schema Diagram** also appear for their saved connection profile and schema. The picker labels these workspace annotations separately. Logical relationships require matching column types and text collations. `BINARY` and `VARBINARY` composite key components use bound bytes, and large integer values use exact numeric comparison.

Each related table opens in a separate read-only result tab, with its initial filters derived from the selected row. **Back to Source Row** reopens the retained source tab and selects the original row. If the source tab was closed, evicted or refreshed, the old row selection expires. The original console and its tab remain available while browsing the related result.

**Related Rows** also appears in Grid and Record for ordinary read-only MySQL/MariaDB SELECT results with a single observed InnoDB base table. Use `SELECT *`, one qualified wildcard or direct columns with optional aliases. Include every primary-key column and the column values required by the relationship. The extension correlates projection positions with the server's physical column metadata, so repeated display labels still identify the correct values.

Following a SQL result rechecks the current editor, console, account, physical server, source definition and the captured row by its typed primary key. The original statement is never rerun. The related preview uses the same server and account on a separate read-only console. The observed row and destination are separate reads.

Joins, computed projections, CTEs, views, unsupported keys, explicit transactions and consoles previously used for writes stay outside this SQL result workflow. Saved logical relationships remain scoped to their connection profile and schema. [MySQL foreign key metadata](https://dev.mysql.com/doc/refman/8.4/en/constraint-foreign-key.html)
