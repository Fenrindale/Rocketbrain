# Reviewed Java static imports

In a trusted Java project, save the source and place the cursor at a JDT diagnostic for an unresolved static method or field. Open **Add Java Static Member Import** from Quick Fix or the Command Palette. Choose a JDT suggestion or enter the fully qualified declaring type. Inspect the diff, then apply the import. Standard editor Undo removes the insertion.

The review adds a single explicit `import static` declaration. Existing imports, comments, and source bodies keep their original bytes. Javac checks that every occurrence of the selected name resolves to the chosen static declaration, including the overload chosen at each method call. Source and classpath changes invalidate the review. Existing **Add Java Type Import** and **Organize Imports** workflows remain available.

Use `rocketbrain.java.staticImport.favorites` to choose which qualified members and declaring-type wildcards JDT can suggest. A favorite ending in `.*` expands the suggestion scope. The reviewed edit still names the specific member. Direct entry can resolve declaring types from the imported project and its compiler classpath.

Each review handles one unresolved member name in a saved Java production file. When the same name is already bound in the file, or other compiler errors are present, resolve those ambiguities before opening a review.
