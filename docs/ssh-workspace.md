# SSH workspace processes

Open a trusted SSH workspace with the selected profile and verified host key. Use **Open Reviewed SSH Workspace Terminal** to review the host and physical workspace directory. The terminal opens an interactive shell in that directory. Commands run when you type them. The terminal uses UTF-8 text and its initial SSH terminal size.

Use **Start Reviewed SSH Java Analysis** to select the independent JDK 25 or newer and the extracted Eclipse JDT LS distribution on the same host. Open Java files through the SSH workspace tree to use hover, diagnostics and Go to Definition. Definitions open in the same SSH workspace. If someone changes a source on the server, reopen its editor to match the server before requesting Java information.

The Java process serves read-only saved source navigation. It uses its own temporary state without automatically importing Maven or Gradle builds. Local Java editors keep their local engine. **Stop SSH Java Analysis** stops the language process. **Close SSH Workspace** closes both remote processes and the file connection. Open the workspace again after a host-key file change.
