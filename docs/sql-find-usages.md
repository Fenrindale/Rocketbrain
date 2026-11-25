# Semantic SQL Find References

Use **Find All References** in a trusted workspace with current MySQL or MariaDB catalog metadata. The extension searches the selected SQL roots for bound physical table and column references. Local aliases and CTE references stay inside their own query scope.

To include embedded Java SQL, set **Rocketbrain › SQL › Project: Java Roots** (`rocketbrain.sql.project.javaRoots`) to the relevant source folders inside the workspace. The setting is empty by default. You can start the search from a recognized SQL token in one of those Java files or from a SQL editor.

The supported Java sources include native Spring Data repository query annotations, JPA named native queries, and direct calls on observed Spring JDBC and JPA receiver declarations. String literals, text blocks and all-literal concatenations preserve their host source ranges. Bound scalar placeholders can coexist with resolved table and column references. Java results remain available for review. The combined database and source Rename workflow requires an SQL-only editable plan.

Run **Show SQL Usage Coverage** to see the selected roots, analyzed files, Java fragment counts and unresolved positions from the last physical search. Dynamic SQL arguments, interpolation, unsupported statements and disjoint source spans appear with their reasons. General runtime builders, framework transformations, other embedded languages and a complete dependency graph remain outside this scan. The extension inspects source and metadata during the search without running the located queries.

The selected scope is limited to 200 files, 128 KiB per file, and 8 MiB total. Build outputs, version control, and dependency directories are excluded. A change to the catalog, file list or source buffer invalidates an in-flight search.

[Spring Data JPA native queries](https://docs.spring.io/spring-data/jpa/reference/jpa/query-methods.html) · [Spring JdbcTemplate SQL arguments](https://docs.spring.io/spring-framework/docs/current/javadoc-api/org/springframework/jdbc/core/JdbcTemplate.html) · [Java text blocks](https://docs.oracle.com/javase/specs/jls/se25/html/jls-3.html#jls-3.10.6)
