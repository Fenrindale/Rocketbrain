# Review Java File Cleanup

Save a Java file in an imported production source root, then choose **Rocketbrain: Review Java File Cleanup** from the Command Palette or editor menu. The review shows all supported changes for that file together. Apply them after checking the diff. The changes stay unsaved, and one Undo restores the buffer.

The review removes unused explicit type imports, standalone empty statements directly inside blocks, and extra parentheses in supported expression positions. It retains named imports mentioned in source or Javadoc, static and wildcard imports, embedded comments, empty loop and branch bodies, and parentheses required for operator precedence. A file with raw Unicode escapes requires manual cleanup.

Rocketbrain checks the original and proposed file against the classpath of the imported project. It compares their relevant attributed syntax, expression types and symbol bindings. It verifies that the saved source files, editor version and analyzed classpath still match the review before applying the edits. Resolve existing compiler errors and save affected Java files before starting. The workflow covers one production file in a classpath project.
