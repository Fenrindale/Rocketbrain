# Extract Java Variables, Fields and Constants

Select a whole return expression or local initializer in saved Java source. Use the ordinary **Extract to local variable** or **Extract to field** code action to name the declaration and review the diff. You can also run **Rocketbrain: Extract Java Local Variable** or **Rocketbrain: Extract Java Field** from the Command Palette. Javac checks the declaration and every generated use before the diff can be applied.

The local variable stays in its current block. Field extraction adds a private field and assigns it from the current method immediately before the original use. The field retains the assigned value on the instance, or on the class when the method is static. Both commands evaluate the expression once per original use and replace the selected occurrence. For eligible selections outside the naming workflow, choose **Review JDT Default Edit** to see the conventional edit. JDT's existing replace-all action is available separately.

## Extract a Constant

Select a complete expression in a saved Java class. Run **Rocketbrain: Extract Java Constant**, name the constant, and review the diff. The constant is a private static final field. The edit replaces the selected use and leaves other occurrences alone. The source stays unsaved after applying, and one Undo restores the original buffer.

The independent JDT engine proposes where the declaration belongs. Javac checks its type, constant initializer, and selected field reference. Supported selections use primitive or `String` literals and statically bound compile-time fields. Runtime calls, mutable values, and local bindings that cannot move are refused. All three naming workflows refuse names that would collide with source or inherited symbols. An edit or classpath change after review requires a new preview. [JDT refactoring handler](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.63.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/GetRefactorEditHandler.java)
