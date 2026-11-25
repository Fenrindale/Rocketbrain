# Attach to a local Java process

Start your Java application with a loopback JDWP listener. To let the operating system select the port, pass `-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0` to Java.

In a trusted Windows workspace, run **Rocketbrain: Attach to Local Java Process** and choose the matching PID from the picker. It shows the application label and the port without application arguments. Rocketbrain reads the JVM's JDWP endpoint and checks that the operating system reports the same process as the listener owner. [Java Attach API](https://docs.oracle.com/en/java/javase/25/docs/api/jdk.attach/com/sun/tools/attach/VirtualMachine.html)

For an attach entry in `launch.json`, use `type` set to `rocketbrain-java`, `request` set to `attach`, and `processId` set to the local JVM PID. Use `projectName` to select a source project when several projects provide a matching Java class.

Local PID discovery supports IPv4 loopback JDWP listeners on Windows. Host-and-port attach is available separately. To debug a JVM started without JDWP, start it again with the listener enabled.
