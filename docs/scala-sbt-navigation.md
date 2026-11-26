# Scala navigation with sbt

Configure Rocketbrain's independent JDK and the official sbt launcher. In the sbt build, enable SemanticDB for the sources you want to navigate. The Scala 2 fixture uses Scala 2.13.18 and the SemanticDB compiler plugin version 4.17.4. The Scala 3 fixture uses the compiler's built-in SemanticDB output. [SemanticDB setup](https://scalameta.org/docs/semanticdb/guide)

Run **Compile and Index Scala** for the selected sbt project. **Go to Definition** and **Find All References** use the compiled symbol for the selected identifier, so overloads resolve to their own declarations and uses. The reference workflow covers sources present in the selected build's compiled index. Recompile after changing a source or a build descriptor.

For **Debug sbt Main Class**, add `addSbtPlugin("ch.epfl.scala" % "sbt-debug-adapter" % "4.2.13")` to the trusted build's `project/plugins.sbt` and configure a JDK 25. Set a breakpoint in a saved Scala source, select the sbt subproject and its discovered main class, and use the VS Code debug controls. Rocketbrain restricts the pinned adapter to loopback and checks that the owned sbt JVM holds the listener before connecting. **Stop sbt Task** closes the managed process and its debuggee. [Scala Center debug adapter and license](https://github.com/scalacenter/scala-debug-adapter/tree/v4.2.13)
