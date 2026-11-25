# Server-side table sorting

Open a live MySQL or MariaDB table and choose **Sort and Filter**. Add up to eight sort rules and move them to choose precedence. For each rule, choose an ascending or descending direction and keep the server’s NULL order or place NULLs first or last. For text, the collation menu shows compatible names observed from the current server’s catalog. Choose **Apply Sort and Filters** to execute the updated table page.

An expression can reference exact catalog column names. Use backticks around a name containing punctuation and double any embedded backtick. The expression must reference the chosen sort column. Numeric expressions accept decimal literals, parentheses, arithmetic operators and `ABS`. Text expressions accept `LOWER`, `UPPER`, `TRIM` and `CHAR_LENGTH`. The server supplies the sorting semantics, so arithmetic precision, collation behavior and results may vary with its engine and settings. SQL fragments, arbitrary functions and geometry comparisons are outside this expression grammar.

Small fixed or variable binary columns sort by their bytes. The grid fills in `BYTE_PREFIX(column)` for wider binary values and `JSON_TEXT(column)` for JSON. These compare up to 512 bytes of each server’s stored binary value or serialized JSON text. Values sharing a prefix tie. JSON member order and text representation depend on the server, and this ordering compares serialized bytes.

The grid adds the unmodified primary key as the last tiebreaker when needed, including after a transformation or alternate collation of a primary-key column. Offset pages can still shift when another session changes rows. For tables without a primary key, the grid offers the first page.

Use **Save Applied Sort** to store an ordered preset for this connection and table in the current workspace. **Load Sort** fills the editor so you can review the rules before applying them. A preset whose referenced columns or required collation changed remains visible for removal.

[MySQL NULL ordering and comparison](https://dev.mysql.com/doc/refman/8.4/en/working-with-null.html) · [MySQL collation names and character sets](https://dev.mysql.com/doc/refman/8.4/en/charset-collation-names.html) · [MariaDB COLLATIONS catalog](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-collations-table)
