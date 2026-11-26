# Local Jakarta WAR on WildFly

Set `rocketbrain.java.jakarta.wildflyHome` in User Settings to the physical directory of the extracted [stock WildFly 42.0.0.Final ZIP](https://github.com/wildfly/wildfly/releases/tag/42.0.0.Final). Use an independent JDK 25. The launcher checks the selected installation's stock standalone configuration and core launcher files before using it. [WildFly installation guide](https://docs.wildfly.org/42/Getting_Started_Guide.html)

In a trusted local workspace, import a Maven module with explicit `war` packaging into Java Projects and use **Build Jakarta WAR**. Run **Review and Deploy Jakarta WAR on WildFly**, then select a WAR from the module's `target` folder and a lowercase application context. Review the selected installation, WAR and SHA-256 in the confirmation dialog. A new review is required after changing the Maven build, WAR or selected runtime.

**Show WildFly Jakarta Deployment** displays the application URL and can open it. **Stop WildFly Jakarta Deployment** stops the owned JVM and removes its temporary server base. HTTP, HTTPS and management sockets use OS-assigned loopback ports. WildFly runs the reviewed application with your user permissions and keeps mutable server configuration, deployments and logs in that temporary base. The original WildFly configuration and existing servers stay untouched. [WildFly standalone configuration paths and deployment markers](https://docs.wildfly.org/42/Admin_Guide.html#deployment-scanner)

The workflow supports one local standalone WAR at a time. WARs with a WildFly-specific context override require a separate deployment workflow. Remote WildFly management, domain mode, EAR, incremental replacement and debugging remain outside this command.
