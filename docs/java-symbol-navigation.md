# Go to Code Target

In a trusted Java workspace, put the cursor on a symbol and run **Rocketbrain: Go to Code Target**. Choose **Declaration**, **Type Declaration**, **Implementations**, or **Super Method**. For multiple locations, select the file and line to open. **Go to Java Super Method** opens the nearest overridden declaration that JDT resolves. Java targets include workspace sources and available JDK source from the independent JDT server. [JDT super-method lookup](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.63.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/FindLinksHandler.java)

In a trusted Kotlin Gradle project with the independent Kotlin editor engine configured, the same command opens the declaration selected by Kotlin type resolution. This includes top-level extension functions and same-name extensions for different receiver types. If the source or local destination changes between searching and opening it, search again.
