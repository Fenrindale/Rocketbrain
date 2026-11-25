# Inline a Java Method Call

Place the cursor on a method name or select the full call in saved Java source in an imported project. Choose **Rocketbrain: Inline Java Method Call** from Code Actions or the Command Palette and review the diff. Applying the change updates one editor buffer, and a single Undo restores it.

The call must be the whole return expression or the whole initializer of one local variable. The method must be a private static declaration in the same class, with one return expression built from parameters, literals and supported Java operators. Use primitive or `String` parameters and return types. A call used inside a larger expression requires a separate refactoring.

Generated typed locals evaluate each argument once, in call order, including arguments that the original body never reads. The replacement preserves the selected overload's return conversion. Other calls and the method declaration stay available. Javac checks the replacement, argument bindings, inferred site type and whether a local would become a compile-time constant. Changes to the source or observed classpath require a new review.
