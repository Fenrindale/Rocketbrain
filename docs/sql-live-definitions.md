# SQL definitions and quick information

Use Go to Definition on a resolved MySQL or MariaDB SQL reference to open a read-only SQL document with the server's current SHOW CREATE result. The cursor lands on the object name, a table column declaration, or a view's output label. Qualified references distinguish objects with the same name in different schemas. Local aliases, CTE definitions and projected names continue to navigate within the SQL document.

The live source path supports resolved table, view and column references in SELECT and WITH, explicitly schema-qualified stored functions, and direct CALL procedure names. A schema qualifier establishes stored function intent even when a built-in function has the same name. Navigation does not invoke the routine or run the query.

Quick information uses the loaded metadata for the bound object and column, including type and nullability when available. A successful cross-schema definition request also provides quick information for that editor version. The extension reads source only on demand, checks that the active connection and editor are current, and uses the current account's privileges. When SHOW CREATE is unavailable or the exact DDL anchor cannot be determined, the editor receives no source location. Offline metadata and configured DDL previews continue to use their existing local analysis.

If an external change alters the live definition, the next successful request creates a source snapshot with the new text. Previous read-only snapshots remain available until the connection changes, a document closes, or the bounded source cache evicts them. Refresh SQL metadata after changes affecting name binding.

[MySQL stored function resolution](https://dev.mysql.com/doc/refman/8.4/en/function-resolution.html) · [Stored routine source privileges](https://dev.mysql.com/doc/refman/8.4/en/stored-routines-privileges.html)
