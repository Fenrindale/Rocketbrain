# Java branch coverage ranges

Run **Rocketbrain: Run Java Tests with Coverage** from the Command Palette or use **Coverage by Test (Serial)** in the native Testing view. Supported decisions show separate `then` and `else` annotations on their original return or throw statements in the editor. Select a test in the native coverage view to inspect the branches measured in that test's serial callback interval.

Rocketbrain reads the checked class bytes using the independent JDK Class-File API. It matches the conditional jump and the two independent terminal blocks to separate source lines. It publishes positions where JaCoCo's method branch counts, line instruction totals, and measured arm outcomes agree. The current source bytes must match the coverage snapshot when the editor loads those positions. Modified editor buffers and newer source files without rebuilt classes suppress the range annotations. [JaCoCo coverage counters](https://www.jacoco.org/jacoco/trunk/doc/counters.html)

The range workflow covers a single compiled conditional with explicit `if` and `else` terminal arms on distinct source lines. Other branches retain JaCoCo's line-level counts. Per-test measurements use the existing serial global probe intervals with separately recorded shared lifecycle work.
