# Scala navigation with sbt

Configure Rocketbrain's independent JDK and the official sbt launcher. In the sbt build, enable SemanticDB for the sources you want to navigate. The Scala 2 fixture uses Scala 2.13.18 and the SemanticDB compiler plugin version 4.17.4. The Scala 3 fixture uses the compiler's built-in SemanticDB output. [SemanticDB setup](https://scalameta.org/docs/semanticdb/guide)

Run **Compile and Index Scala** for the selected sbt project. **Go to Definition** and **Find All References** use the compiled symbol for the selected identifier, so overloads resolve to their own declarations and uses. The reference workflow covers sources present in the selected build's compiled index. Recompile after changing a source or a build descriptor.
