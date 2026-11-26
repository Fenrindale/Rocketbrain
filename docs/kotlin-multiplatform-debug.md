# Debug a Kotlin Multiplatform JVM target

Open a trusted Gradle Kotlin Multiplatform project that configures the JVM target main class. Configure the independent Java debugger and Gradle distribution, save project changes, then run **Rocketbrain: Debug Kotlin Multiplatform JVM Target**. Select the Gradle module and one of its JVM run targets.

With the Rocketbrain Java debug bundle 0.53.1.rocketbrain10, click the gutter beside an executable line in a saved `commonMain` or JVM source file. An enabled breakpoint becomes verified when its compiled class loads and the JVM confirms the source file, line, and location. Lines with ambiguous compiler locations and unsupported generated or inlined source mappings remain unverified. This workflow supports ordinary unconditional line breakpoints on JVM targets.

Function breakpoints also work in the Run and Debug view. For example, use `example.MainKt#loadItems` for a top-level Kotlin function compiled into that JVM class. Inspect the Kotlin source, step through the function, and read its local variables. The debugger keeps the function workflow with earlier supported bundles.

Use **Stop Kotlin Multiplatform Task** or stop the debugger to close the owned application and Gradle launch. Rocketbrain uses a separate local debugger connection for each launch and leaves the Gradle build files intact.

## Debug a Kotlin/Native Linux x64 executable

Use a trusted workspace in a Linux x64 extension host with GDB installed. Build the module with `linkDebugExecutableLinuxX64`. Open a saved Kotlin file from the same module and set an unconditional gutter breakpoint. Run **Rocketbrain: Debug Kotlin/Native Executable**. Choose the `.kexe` in `build/bin/linuxX64/debugExecutable`, enter the program arguments as a JSON string array, and review the file, checksum and GDB path before launching. [Kotlin/Native debugging](https://kotlinlang.org/docs/native-debugging.html)

The debugger verifies a single executable DWARF location at each selected breakpoint. At a stop in that file, use Step Over, Continue, and the Locals view for observed 32-bit integer values. The selected executable and source are checked again on launch, and the stopped process must have loaded the reviewed executable. Rebuild after editing the source. [GDB/MI breakpoint commands](https://sourceware.org/gdb/current/onlinedocs/gdb.html/GDB_002fMI-Breakpoint-Commands.html)

This workflow reads the top frame for the selected source file and starts a local owned process. Terminal I/O is disabled to keep the application output separate from the debugger protocol. Attach, expression evaluation and variable edits are outside this workflow. Use the debugger's Stop button or **Stop Kotlin Multiplatform Task** to close the session.
