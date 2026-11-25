# Related rows in MySQL and MariaDB

Open a table and choose **Related Rows** in Grid or Record view. The picker lists both referenced and referencing tables visible to the current connection, including physical foreign keys across schemas on the same server. Each destination shows its schema and table name. Relationships with a `NULL` component are skipped.

Logical relationships saved in **Schema Diagram** also appear for their saved connection profile and schema. The picker labels these workspace annotations separately. Logical relationships require matching column types and text collations. `BINARY` and `VARBINARY` composite key components use bound bytes, and large integer values use exact numeric comparison.

Each related table opens in a separate read-only result tab, with its initial filters derived from the selected row. **Back to Source Row** reopens the retained source tab and selects the original row. If the source tab was closed, evicted or refreshed, the old row selection expires. The original console and its tab remain available while browsing the related result.

Navigation uses account-visible InnoDB base tables and currently starts from captured table previews. Arbitrary SQL result lineage and logical relationships spanning separate schemas or connections remain outside this scope. [MySQL foreign key metadata](https://dev.mysql.com/doc/refman/8.4/en/constraint-foreign-key.html)
