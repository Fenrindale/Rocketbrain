# Managed Dev Containers

Use the local Docker CLI and the independently installed `@devcontainers/cli` 0.91.0. Choose an open local workspace with a Dev Container configuration and run **Inspect Dev Container Configuration** before approval.

For a Compose project, set `dockerComposeFile` to one to four explicit workspace YAML files and `service` to the workspace service. Optional `runServices` names the additional services to start. Rocketbrain shows the resulting service list including the selected app and its dependencies. Without `runServices`, the review lists the services resolved by Compose.

**Start Dev Container** requires approval of the file and service review. It starts the selected project under a new local Compose identity and verifies the exact workspace and dependency container IDs. The CLI applies the project’s configuration, build, mounts, and lifecycle hooks. **Run in Managed Dev Container** targets the verified workspace container with the supplied executable and argument array. Changes to the reviewed files or resolved Compose model require a fresh start review.

**Dev Container Status** reports the state of the app and its dependency services. After an interrupted startup, the session can report a partial project. **Stop Managed Dev Container** stops the exact verified app and dependency containers. Images, volumes, networks, and retained stopped containers can be managed separately with Docker.

The managed Compose route accepts up to eight services with one container per service, project-scoped networks and volumes, direct YAML files, and conventional dependencies. Service profiles, external container references, externally named Docker resources, and indirect YAML includes require a separate Docker Compose workflow. The review contains file and service identifiers. Resolved environment values stay in the local tool process.

## Forward a local port

Start a managed Linux Dev Container with its own network namespace. Ensure it has Python 3 and an application listening on IPv4 loopback. Use **Forward Managed Dev Container Port** to enter its TCP port and a local port. Enter `0` to have the OS choose an unused local port. Review the exact container and connection before approving.

Connect with the address shown in **Check Managed Dev Container Status**. Rocketbrain forwards from `127.0.0.1` on this machine to `127.0.0.1` inside the verified container. Other local processes can connect, so review sensitive services such as JDWP before opening them. This works without publishing Docker ports and supports up to four simultaneous forwards per workspace and eight connections per forward. Connections idle for thirty minutes close automatically.

Use **Close Managed Dev Container Port** to release one listener. A managed stop, detected container exit or restart, workspace removal, or VS Code shutdown releases the affected listeners and connections. Restarting the container requires a fresh port review.
