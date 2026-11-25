# Edit embedded languages in Java

Place the cursor inside a Java string literal or text block and run **Rocketbrain: Edit Embedded Language**. Choose **SQL**, **JSON**, **Java Regular Expression**, or **HTML**. The decoded text opens beside the Java source in its language mode.

The regular expression editor highlights Java syntax and uses the configured JDK's `java.util.regex.Pattern` when you review or apply an edit. Add inline flags such as `(?i)` when the validation needs them. HTML uses VS Code's built-in highlighting, completions, hover and tag editing. **Rename Symbol** on an HTML tag can update its paired tags in the embedded editor. [Java Pattern documentation](https://docs.oracle.com/en/java/javase/25/docs/api/java.base/java/util/regex/Pattern.html) · [VS Code HTML support](https://code.visualstudio.com/docs/languages/html)

Run **Review and Apply Embedded Source Edit** to compare the source change before applying it. In the regex and HTML workflows, quoted strings stay quoted and text blocks keep their Java form. The encoder preserves the decoded value, including significant spaces and final newlines. Save the Java editor to persist the changes, or use its normal Undo to restore the previous text.

Use **Reveal Embedded Java Source** to select the original source range, including escapes. When the embedded buffer differs from the original value, the command selects its entire host literal. Edit and review one literal at a time. The supported source is a Java workspace file whose literal boundaries are known.
