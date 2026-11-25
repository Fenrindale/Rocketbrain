# Review a Java module's runtime

In **Java Projects**, choose **Review Java Runtime Compatibility** on a module. It shows the imported source level, the observed local classfile target and the independently queried JVM versions. Configure standalone JVM paths in `rocketbrain.java.projectJdks`. The Java 8 execution environment is `JavaSE-1.8`. [Java execution environment names](https://code.visualstudio.com/docs/java/java-project#_configure-runtime-for-projects)

**Add Java Run Configuration**, **Configure Spring Boot Run**, and **Change Saved Java Runtime** use that review when choosing a JVM. Preview classfiles require the same Java release and explicit confirmation to save `--enable-preview`. Imported targets and measured classfile targets are reported separately. If the build output or the selected JVM changes during review, reopen the choice. [JVM classfile version rules](https://docs.oracle.com/javase/specs/jvms/se25/html/jvms-4.html#jvms-4.1)

The measurement covers observed class directories inside the selected module. Use the build's toolchain declaration for compilation. Compatibility of dependencies in external JARs or other modules requires its own review. When local classfiles are unavailable, the picker shows the configured runtimes with the measurement pending.
