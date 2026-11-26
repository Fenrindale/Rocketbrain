# Prepared WITH UPDATE in migration review

The stored program inspection and guarded same-server rebuild can bind one nonrecursive lookup CTE in a finite prepared UPDATE. The connected server's observed version must be MySQL 8.4 or newer, or MariaDB 12.3 or newer. MariaDB 11.4 uses the existing prepared UPDATE JOIN route.

The CTE reads a schema-qualified InnoDB base table and projects up to 16 ordinary integer columns with explicit aliases. It can filter one physical integer column by equality to an integer literal or a bound value. The outer UPDATE joins the CTE once, writes one ordinary unindexed integer column of a different schema-qualified InnoDB table and filters the write table by one integer equality. The join's projected equality columns must resolve to every part of an observed non-null unique lookup key with the same integer types and signedness.

The inspection lists both physical read dependencies and the single physical write dependency. Rebuild review binds the observed engine version and includes both physical tables in its lock and fence scope. Apply rechecks the source and its lookup metadata. The procedure stays in place with its original creation context during rebuild and recovery. Inspection, rebuild and recovery never execute it.

The existing writable server requirement recognizes MariaDB 12's observed `read_only=OFF` enum. Its read-only and lock-prohibiting modes are refused.

An apply refused before its first persistent write reports `preflight-refused` and consumes the review. Refresh the comparison before another attempt. Once a journal write has been submitted, failures follow the existing recovery path, including an ambiguous acknowledgment.

Multiple or recursive CTEs, computed projections, arbitrary filters and joins, DDL in PREPARE and opaque program inputs remain outside this review. The reviewed schema workflow retains its existing same-server recovery boundaries.

Upstream references are [MySQL WITH](https://dev.mysql.com/doc/refman/8.4/en/with.html), [MariaDB UPDATE](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/changing-deleting-data/update#cte-syntax) and [MariaDB read_only](https://mariadb.com/docs/server/server-management/variables-and-modes/server-system-variables#read_only).
