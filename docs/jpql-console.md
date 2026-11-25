# JPQL console

Prepare the Rocketbrain JPA Observer with an independent JDK 25 or newer. Set `consoleSelect` to `true` in the generated configuration, restart the application with the observer agent, and connect to the loopback observer using its private token. Execution is disabled by default.

Use **Open JPQL Console** to open a blank editor or copy a JPQL query from the workspace source index. You can also run a complete selection from an editor. Use **Review and Run JPQL SELECT** or Ctrl+Enter in a JPQL file. Choose the observed Hibernate factory, enter Hibernate-typed parameters, and review the exact selection before running it. The results tab shows typed column names, exact numeric text, NULL values and a truncation indicator.

The console supports explicit scalar projections, standard joins, grouping, aggregates and a bounded built-in function set. Named and positional scalar parameters use typed text or NULL. Use parameters for strings and temporal values.

With Hibernate 7.4, the console also supports nonrecursive CTEs, uncorrelated derived relations in `FROM`, and scalar `UNION`, `INTERSECT` and `EXCEPT` operands. Each set operand must return the same Java scalar types in the same order. Give each CTE or derived output a unique `AS` alias. The source index uses an observed Hibernate profile to type these fields in indexed Java and ORM XML queries and navigate to their declarations. Source findings remain conditional on the profile.

General entity projections, custom functions, collection bindings, recursive CTEs, lateral relations, set operations inside predicate subqueries, and native or modifying SQL are outside the scalar execution scope. The separate semantic validator can analyze some of those forms without executing SQL.

## Review fetched associations

Set `consoleFetchSnapshots` to `true` alongside `consoleSelect` to enable managed fetch snapshots. This setting is off by default. Select one managed root alias and up to three distinct direct associations with `INNER JOIN FETCH` or `LEFT JOIN FETCH`.

```hql
select o from Owner o
left join fetch o.items left join fetch o.manager
where o.id >= :first order by o.id
```

The review lists each requested association path in order. Results show the root's typed fields and a separate nested preview for each association. A null to-one association and an empty collection have distinct displays. The snapshot reads only initialized field-mapped state. It uses ordinary Hibernate hydration with standard, concrete entity mappings and skips polymorphic loads, large object fields, custom property access, converters, load callbacks, and extra eager fetch mappings. A second SQL statement is refused by the JDBC gate.

Fetch one collection alongside to-one associations, or fetch two associations mapped as standard Hibernate sets with supported unique entity identifiers. The set previews preserve the two collections independently after Hibernate hydrates the Cartesian result. A single fetched bag preserves legitimate duplicates. Queries with parallel bags or lists, nested fetch paths, fetched aliases, and repeated fetch paths are refused. [Hibernate association fetching](https://docs.hibernate.org/orm/7.4/querylanguage/html_single/#explicit-association-joins)

Each fetch snapshot is limited to 25 roots and 16 displayed children per association and root. All associations share a 512-row JDBC budget for physical joined rows and the same result payload limit. The view marks preview limits. An oversized joined result is rejected in full so a partially loaded relationship is never displayed as complete.

The execution path accepts only standard MySQL and MariaDB Hibernate dialects with an ordinary non-tenant connection pool. Each run uses an isolated Hibernate session on a leased connection, starts a database-enforced read-only transaction, permits one reviewed prepared SELECT, and rolls back before returning results. It caps results at 100 rows and 16 columns, with a three-second JDBC statement timeout. Execution uses the selected application’s trusted Hibernate mappings and database privileges. Use a development application and account appropriate for the data being read.

The observer does not retain console values, queries or result rows in its event history. The results tab holds the current result in memory and closes on observer disconnect. Application and database logging remain subject to their existing settings.

[Hibernate HQL language reference](https://docs.hibernate.org/orm/7.4/querylanguage/html_single/) · [MySQL transaction access mode](https://dev.mysql.com/doc/refman/8.4/en/commit.html) · [MariaDB transaction access mode](https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction)
