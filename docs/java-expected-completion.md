# Complete a Java value by expected type

Place the cursor where a Java value belongs, or type the beginning of its name. Choose **Rocketbrain: Complete Java Value by Expected Type** in the Command Palette or Java editor menu. Select a compatible visible parameter or initialized local value. Rocketbrain inserts the completed identifier into the editor, and Undo restores the previous draft.

The action covers a reference-typed local initializer, method return, or expression lambda. For example, `Stream<List<String>> output = rows.stream().map(row -> partial)` expects `List<String>` at `partial`. The list uses Java's attributed generic types, so an in-scope `List<Integer>` cannot satisfy that target. A reassigned outer local cannot be captured by the lambda. [Java Stream.map](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/stream/Stream.html#map(java.util.function.Function))

The file may contain an unfinished identifier or empty value position. Keep the surrounding Java syntax complete and save the project's other sources. The compiler evaluates an in-memory copy with a placeholder, then checks the chosen declaration, expected type and enclosing invocation again before the edit. Use an imported Java classpath project. Ordinary member, type and import completion remains available through JDT.
