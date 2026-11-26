# Debug a Kotlin Multiplatform JVM target

Open a trusted Gradle Kotlin Multiplatform project that configures the JVM target main class. Configure the independent Java debugger and Gradle distribution, save project changes, then run **Rocketbrain: Debug Kotlin Multiplatform JVM Target**. Select the Gradle module and one of its JVM run targets.

Add a function breakpoint through VS Code's Run and Debug view. For example, use `example.MainKt#loadItems` for a top-level Kotlin function compiled into that JVM class. When it stops, inspect the Kotlin source, step through the function, and read its local variables. The debug session uses the selected target's common and JVM Kotlin source roots. Kotlin gutter breakpoints and non-JVM targets are outside this workflow.

Use **Stop Kotlin Multiplatform Task** or stop the debugger to close the owned application and Gradle launch. Rocketbrain uses a separate local debugger connection for each launch and leaves the Gradle build files intact.
