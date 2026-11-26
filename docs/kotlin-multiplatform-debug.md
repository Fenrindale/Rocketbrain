# Debug a Kotlin Multiplatform JVM target

Open a trusted Gradle Kotlin Multiplatform project that configures the JVM target main class. Configure the independent Java debugger and Gradle distribution, save project changes, then run **Rocketbrain: Debug Kotlin Multiplatform JVM Target**. Select the Gradle module and one of its JVM run targets.

With the Rocketbrain Java debug bundle 0.53.1.rocketbrain10, click the gutter beside an executable line in a saved `commonMain` or JVM source file. An enabled breakpoint becomes verified when its compiled class loads and the JVM confirms the source file, line, and location. Lines with ambiguous compiler locations and unsupported generated or inlined source mappings remain unverified. This workflow supports ordinary unconditional line breakpoints on JVM targets.

Function breakpoints also work in the Run and Debug view. For example, use `example.MainKt#loadItems` for a top-level Kotlin function compiled into that JVM class. Inspect the Kotlin source, step through the function, and read its local variables. The debugger keeps the function workflow with earlier supported bundles.

Use **Stop Kotlin Multiplatform Task** or stop the debugger to close the owned application and Gradle launch. Rocketbrain uses a separate local debugger connection for each launch and leaves the Gradle build files intact.
