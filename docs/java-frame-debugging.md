# Java stack frames

Pause a Rocketbrain Java debug session at a breakpoint. Run **Rocketbrain: Restart Java Stack Frame** and choose a method from the paused thread. The debugger drops the selected frame and its more recent frames, then stops upon entering the selected method again. Side effects that already happened, such as field updates or finalised I/O, remain. [Java debug adapter handler](https://github.com/microsoft/java-debug/blob/5c7562ade22977b15f76f46d13c098e82cc58ced/com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/handler/RestartFrameHandler.java)

The picker offers up to 32 frames with callers and invalidates its selection when the debuggee resumes or stops at a different location. The active JVM must support JDI frame popping. The adapter rejects the bottom frame and stack paths that cross native frames. [JDI `ThreadReference.popFrames`](https://docs.oracle.com/en/java/javase/25/docs/api/jdk.jdi/com/sun/jdi/ThreadReference.html#popFrames(com.sun.jdi.StackFrame))

## Local value viewer

With the current independently installed Rocketbrain Java engine, pause on a Java breakpoint, select a stack frame, and run **Rocketbrain: Inspect Java Local Value**. Select an array, a `java.util.ArrayList` with the standard JDK backing layout, or a `String` from the frame's local variables. A page contains up to 100 array or list elements. Use **Previous**, **Next**, or a start index. Strings of up to 256 Ki UTF-16 units open in full with original whitespace and line breaks.

In a local launch or verified local process attach, longer Java and Kotlin JVM strings with recognized OpenJDK storage open in pages of up to 8,192 UTF-16 code units. Page positions start at zero. A surrogate split across two pages appears as its exact escaped code unit on each side. Update the Rocketbrain Java engine to enable long string pages.

The viewer reads JDI fields and the requested array range directly. For array and list entries it shows primitives, nulls, short strings and the type of other objects. Collection subclasses, other custom collections, unrecognized String layouts and frames without readable debug metadata are outside the supported scope. Changing the selected frame, stepping or resuming the session expires the current long string inspection. [JDI `ArrayReference.getValues`](https://docs.oracle.com/en/java/javase/25/docs/api/jdk.jdi/com/sun/jdi/ArrayReference.html#getValues(int,int))
