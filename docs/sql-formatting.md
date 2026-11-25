# MySQL and MariaDB SQL formatting

Use **Rocketbrain: Format SQL** or VS Code’s **Format Document** in a SQL editor. Use **Format Selection** for a self-contained query or select a stored-program definition with its `DELIMITER` lines. The formatter uses the active catalog’s MySQL or MariaDB dialect and SQL modes and follows the editor’s indentation settings.

`rocketbrain.sql.formatting.style` defaults to `expanded`, which puts ordinary query clauses on separate lines. `compact` keeps ordinary query clauses on one line where the comment and token layout allows it. `rocketbrain.sql.formatting.keywordCase` defaults to `preserve`. `upper` and `lower` apply to recognized statement, clause and stored-program block keywords.

The formatter lays out `BEGIN` blocks, procedural `IF` and `CASE`, labeled `WHILE`, `REPEAT` and `LOOP`, and MariaDB’s `BEGIN NOT ATOMIC`. It recognizes procedure, function, trigger and event definitions. Strings, quoted identifiers, comments, client directives and separators keep their original spelling. Use standalone `DELIMITER` lines between complete statements. Supported separators include `;`, `$$`, `//` and punctuation-led custom markers such as `~commit~`. Formatting is limited to 128 KiB and 100 SQL statements. If a script has malformed quotes, an unsupported executable comment or a block the formatter cannot match, the command leaves the input intact and reports the problem.

Stored-program definitions are formatted as text in the editor. Test evidence for execution uses the official `mysql` and `mariadb` clients with disposable servers and databases. [MySQL compound statement syntax](https://dev.mysql.com/doc/refman/8.4/en/begin-end.html)
