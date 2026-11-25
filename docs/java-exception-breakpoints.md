# Java exception breakpoints

Open a trusted Java workspace and run **Rocketbrain: Configure Java Exception Breakpoints**. Enter exact binary names such as `java.lang.IllegalStateException` or `com.example.Outer$NestedException`. Rocketbrain's open Java debugger includes the selected type's subclasses.

You can also limit where an exception is thrown. Each allowed class pattern must match the throw site. A skipped class pattern suppresses a matching throw site. Class patterns accept a name or one leading or trailing wildcard, for example `com.example.*` or `*.GeneratedClient`. An empty type list matches all exception types.

Use the **Caught Exceptions** and **Uncaught Exceptions** toggles in the VS Code Breakpoints view to decide when to pause. The workspace policy applies to all Rocketbrain Java sessions in the current window and can be changed while a session is running.

Run **Rocketbrain: Install and Configure Independent Java Engine** to select multiple exception types. Overlapping selections, such as a parent and a child exception type, produce a single stop per throw.

The Debug Adapter uses the existing Java engine's JDI requests. The filter is based on exception type and throw-site class. [Public Java debugger exception handler](https://github.com/microsoft/java-debug/blob/5c7562ade22977b15f76f46d13c098e82cc58ced/com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/handler/SetExceptionBreakpointsRequestHandler.java)
