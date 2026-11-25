# Go to Code Target

In a trusted Java workspace, put the cursor on a symbol and run **Rocketbrain: Go to Code Target**. Choose **Declaration**, **Type Declaration**, **Implementations**, or **Super Method**. For multiple locations, select the file and line to open. **Go to Java Super Method** opens the nearest overridden declaration that JDT resolves. Java targets include workspace sources and available JDK source from the independent JDT server. [JDT super-method lookup](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.63.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/FindLinksHandler.java)

In a trusted Kotlin Gradle project with the independent Kotlin editor engine configured, the same command opens the declaration selected by Kotlin type resolution. This includes top-level extension functions and same-name extensions for different receiver types. If the source or local destination changes between searching and opening it, search again.

## Find Usages

Place the cursor over a symbol or key and run **Rocketbrain: Find JVM & Spring Usages** from the editor menu or Command Palette. Choose **Current File**, **Containing Workspace Folder**, or **Open Workspace**, then select a result to open the exact source range. Results show their file, line, and provider. An edited result requires a fresh search.

- Java references come from the independent JDT server's imported projects. Java type uses also include qualified `class` attributes in standard Spring bean XML under `src/main/resources` or `src/test/resources`. Starting from such an attribute searches Java when the enclosing workspace folder has a unique matching source declaration.
- Kotlin references come from the configured open Kotlin Gradle editor server for the active project. Same-name functions remain distinct when the provider resolves different receiver types.
- An application properties or scalar YAML key, a recognized Java `@Value` literal placeholder, or a standard Spring bean XML `value` placeholder can start a search for that exact key. It finds Java `@Value` and Spring XML placeholder uses in scope. The `findUsages` extension API also accepts `includeDeclaration` to include matching application key declarations.

Scope filters locations the providers can resolve. Kotlin and Java providers operate on their imported project models. Spring search covers static qualified class attributes and literal keys. Runtime registration, reflection, dynamic expressions, mixed-language classpath references, and unrelated XML dialects require separate analysis.

## File Structure

Open a trusted Java or Kotlin workspace file and run **Rocketbrain: File Structure** from the editor menu or Command Palette. Filter by types, methods and functions, or fields and properties. Search the results by name, signature, or parent. Selecting a result opens its declaration in the current buffer. The current member appears first when it matches the chosen filter.

VS Code Outline and File Structure use the current JDT or configured open Kotlin provider. The bridge checks reported positions against the editor text. If the declaration name is verifiable and its enclosing range is malformed, the bridge retains the exact declaration span. Results reflect the current buffer and must be refreshed after an edit. The bridge accepts files up to 2 MiB and up to 2,500 symbol records from the provider.
