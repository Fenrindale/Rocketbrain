# Java Smart Step

Pause in the top Java frame at a line that calls several methods. Run **Rocketbrain: Step Into a Java Call** and choose one of the displayed call expressions. The choices include source columns so calls on the same line can be distinguished. The Java debugger resolves the selected method's signature and steps to it. [Java debugger step-target handler](https://github.com/microsoft/java-debug/blob/5c7562ade22977b15f76f46d13c098e82cc58ced/com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/handler/StepInTargetsRequestHandler.java)

Set `rocketbrain.java.stepFilters` in Settings to skip package or class locations. For example, set `skipClasses` to `["com.example.vendor.*", "com.example.logging.ExactWrapper"]`. To restrict stepping to matching patterns, use `allowClasses`. A class must match every include pattern when includes are configured. You can also skip synthetic methods, static initializers or constructors. A `stepFilters` object in `launch.json` overrides the matching fields for that session.

Smart Step selects by the resolved method signature. Repeated invocations of the same signature can share a runtime target. Class filters still apply to the chosen call, and attached sources must match the running classes. Java async submission chains require a separate runtime trace.
