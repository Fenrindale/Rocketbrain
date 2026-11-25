# Foreign-key JOIN completion

In a trusted SQL editor, type a JOIN and then a space, or invoke completion while typing a table prefix. You can use a schema-qualified prefix to narrow the list. Choose a suggestion to insert the target table and its ON predicate at the cursor. The editor preserves JOIN modifiers, adjacent statements and text outside the range it replaces. The generated SQL remains in the editor for review before execution.

MySQL and MariaDB suggestions use bound, current-account catalog metadata for visible tables in both directions of a physical foreign key. Composite keys use the declared column order. This also works inside nested SELECTs and through CTEs or derived tables when every required key is projected directly and has an unambiguous output name. Physical suggestions from offline metadata are marked as cached.

On a saved connection profile, the same workspace relationships you explicitly configure in the schema diagram can supply JOIN predicates between compatible columns in that schema. Suggestions label those relationships separately from physical foreign keys. Removing the saved relationship stops it from appearing in new completions.

Completion requires a supported, bound SELECT and only changes its active JOIN target. It omits proposals that would introduce ambiguous references, that cannot prove all projected keys, or that follow a prior statement changing the schema or SQL mode. Recursive CTEs, unsupported syntax and computed or mixed-origin key projections are outside this scope.

[MySQL common table expressions](https://dev.mysql.com/doc/refman/8.4/en/with.html) · [MySQL foreign-key catalog columns](https://dev.mysql.com/doc/refman/8.4/en/information-schema-key-column-usage-table.html) · [MariaDB foreign-key catalog columns](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-key_column_usage-table)
