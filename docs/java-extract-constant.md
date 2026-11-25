# Extract Java Constant

Select a complete expression in a saved Java class. Run **Rocketbrain: Extract Java Constant**, name the constant, and review the diff. The constant is a private static final field. The edit replaces the selected use and leaves other occurrences alone. The source stays unsaved after applying, and one Undo restores the original buffer.

The independent JDT engine proposes where the declaration belongs. Javac checks its type, constant initializer, and selected field reference. Supported selections use primitive or `String` literals and statically bound compile-time fields. Runtime calls, mutable values, local bindings that cannot move, and names that would collide with source or inherited symbols are refused. An edit or classpath change after review requires a new preview. [JDT refactoring handler](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.63.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/GetRefactorEditHandler.java)
