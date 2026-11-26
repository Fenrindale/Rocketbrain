# Inspect Java advisory call sites

Start with **Audit Maven Dependencies with OSV** or **Audit Gradle Dependencies with OSV** in a trusted workspace. Review the dependency versions and choose which public coordinates to send to OSV. Open the report and run **Inspect Java Advisory Call Sites**.

After approval, Rocketbrain asks the selected build tool for the module’s actual compile classpath. An independent JDK attributes the saved Java sources in `src/main/java` without executing application code, loading compiler plugins, or running annotation processors. Source content stays local. Only the separate dependency lookup sends the chosen package versions to OSV.

The inspection matches the declaring type, exact listed method signature, and SHA-256 of the vendor artifact on the classpath. Source shadowing, duplicate owners, unverified artifacts, and compiler errors produce explicit review states. **Open Java Advisory Call Site** navigates to a verified invocation or method reference if the source, reviewed build inputs, and classpath bytes still match.

The catalog covers the Apache Commons Text interpolation entry points listed for versions 1.5 through 1.9, as available by release, and Guava JRE 31.1 `Files.createTempDir()`. It includes the vendor’s fixed release guidance. Review reported package or input changes before editing a build. The report does not automatically update a dependency or replace code.

The inspection covers standard saved Java production sources for a selected Maven or Gradle module. No listed use observed means the compiler found no listed call in that packet. It does not establish application reachability, input trust, reflection behavior, or whether the workspace is free of security issues. Package-level OSV results remain available for other dependencies and versions.

Supporting sources include the [Apache Commons Text security report](https://commons.apache.org/proper/commons-text/security.html), [Apache release notes](https://commons.apache.org/proper/commons-text/changes.html), [Guava advisory](https://github.com/advisories/GHSA-5mg8-w23w-74h3), and [Guava release notes](https://github.com/google/guava/releases/tag/v32.0.1).
