# JPQL console

Prepare the Rocketbrain JPA Observer with an independent JDK 25 or newer. Set `consoleSelect` to `true` in the generated configuration, restart the application with the observer agent, and connect to the loopback observer using its private token. Execution is disabled by default.

Use **Open JPQL Console** to open a blank editor or copy a JPQL query from the workspace source index. You can also run a complete selection from an editor. Use **Review and Run JPQL SELECT** or Ctrl+Enter in a JPQL file. Choose the observed Hibernate factory, enter Hibernate-typed parameters, and review the exact selection before running it. The results tab shows typed column names, exact numeric text, NULL values and a truncation indicator.

The console supports explicit scalar projections, standard joins, grouping, aggregates and a bounded built-in function set. Named and positional scalar parameters use typed text or NULL. Use parameters for strings and temporal values.

With Hibernate 7.4, the console also supports nonrecursive CTEs, uncorrelated derived relations in `FROM`, and scalar `UNION`, `INTERSECT` and `EXCEPT` operands. Each set operand must return the same Java scalar types in the same order. Give each CTE or derived output a unique `AS` alias. The source index uses an observed Hibernate profile to type these fields in indexed Java and ORM XML queries and navigate to their declarations. Source findings remain conditional on the profile.

Entity projections, custom functions, collection bindings, recursive CTEs, lateral relations, set operations inside predicate subqueries, and native or modifying SQL are outside this execution scope. The separate semantic validator can analyze some of those forms without executing SQL.

The execution path accepts only standard MySQL and MariaDB Hibernate dialects with an ordinary non-tenant connection pool. Each run uses an isolated Hibernate session on a leased connection, starts a database-enforced read-only transaction, permits one reviewed prepared SELECT, and rolls back before returning results. It caps results at 100 rows and 16 columns, with a three-second JDBC statement timeout. Execution uses the selected application’s trusted Hibernate mappings and database privileges. Use a development application and account appropriate for the data being read.

The observer does not retain console values, queries or result rows in its event history. The results tab holds the current result in memory and closes on observer disconnect. Application and database logging remain subject to their existing settings.

[Hibernate HQL language reference](https://docs.hibernate.org/orm/7.4/querylanguage/html_single/) · [MySQL transaction access mode](https://dev.mysql.com/doc/refman/8.4/en/commit.html) · [MariaDB transaction access mode](https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction)
