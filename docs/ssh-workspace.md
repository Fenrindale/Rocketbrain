# SSH workspace processes

Open a trusted SSH workspace with the selected profile and verified host key. Use **Open Reviewed SSH Workspace Terminal** to review the host and physical workspace directory. The terminal opens an interactive shell in that directory. Commands run when you type them. The terminal uses UTF-8 text and its initial SSH terminal size.

Use **Start Reviewed SSH Java Analysis** to select the independent JDK 25 or newer and the extracted Eclipse JDT LS distribution on the same host. Open Java files through the SSH workspace tree to use hover, diagnostics and Go to Definition. Definitions open in the same SSH workspace. If someone changes a source on the server, reopen its editor to match the server before requesting Java information.

The Java process serves read-only saved source navigation. It uses its own temporary state without automatically importing Maven or Gradle builds. Local Java editors keep their local engine. **Stop SSH Java Analysis** stops the language process. **Close SSH Workspace** closes its owned processes and file connection. Open the workspace again after a host-key file change.

**Attach Reviewed SSH Java Debugger** attaches to a running, same-account HotSpot JVM on a Windows SSH host. Start the JVM with its JDWP listener on IPv4 loopback and its reported working directory set to the reviewed SSH workspace. Select the corresponding saved local Java source and supply the exact remote PID, port and independent JDK 25 directory. The command checks the JVM start time and Windows TCP ownership, then compares the local source with the file at the same relative path on the SSH host. It derives the local Java package root from that source.

The reviewed relay accepts one loopback client, verifies the remote socket owner before sending debugger traffic and closes when the Java debugger disconnects. Editing the selected local source closes the reviewed attach. **Disconnect SSH Java Debugger** releases its relay and keeps the JVM running. Compile the remote class from the matching source before setting breakpoints. The selected saved source is checked before attachment and can be used in the local editor.
