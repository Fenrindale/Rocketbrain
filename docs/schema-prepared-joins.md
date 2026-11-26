# Prepared UPDATE JOIN in schema reviews

Use **Inspect Stored Program Dependencies** to review a visible stored procedure that assembles a finite `UPDATE … JOIN` statement. The same dependency analysis is used for guarded schema rebuild reviews and original-table recovery. Inspecting or migrating a schema leaves the procedure definition in place and does not run the prepared statement.

The common MySQL and MariaDB form uses one inner join between two named InnoDB tables, an explicit `AS` alias for each, and one equality filter against the write alias. Join columns must match the observed integer type and signedness. The non-null lookup columns must cover an entire plain unique key. The assignment writes one ordinary unindexed integer column of the first table. The result lists both direct read targets and the one direct write target. The migration graph includes both tables.

Value parameters stay in value positions. The supported assignment reads a qualified integer column or uses one integer value, with an optional integer adjustment. If metadata differs or an invocation needs an explicit SQL input, the review limits its conclusion accordingly. Explicit invocation cases do not become general migration dependencies. Joined updates with outer joins, calculated keys or several write targets and dynamic CTE statements require separate analysis.
