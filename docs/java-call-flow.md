# Trace Java value flow across calls

In a saved Java file in an imported project, place the cursor on an argument, parameter, local value, call or return keyword. Run **Rocketbrain: Trace Java Value Across Calls**. Choose **To Here** to see the inputs to the selected value or **From Here** to see its uses. Select a result to open its precise source range. **Trace Java Local Value** remains available for a single straight-line method.

Javac resolves each overload. The trace follows primitive and String arguments into their parameters and follows return values into the calling expression. It spans saved project sources and supports direct static calls and same-instance calls with private or final dispatch. When multiple call sites reach the selected method, choose an individual caller. This keeps each site's values separate, even if two invocations occur in the same method. [Java method invocation specification](https://docs.oracle.com/javase/specs/jls/se25/html/jls-15.html#jls-15.12)

A supported ternary shows the condition and possible value branches, including a literal `null`. A literal boolean selects one branch. An unknown condition leaves both branches in the static graph. If a reviewed source changes, run the trace again before following an old link.

The analysis covers straight-line bodies with initialized scalar locals, simple assignments and value returns, up to five active frames and 48 nested calls. Recursive calls, dynamic dispatch, dependency-only bodies, heap and alias flow, and general statement branches such as loops or `try` require a different analysis.
