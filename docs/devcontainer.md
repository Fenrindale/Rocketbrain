# Managed Dev Containers

Use the local Docker CLI and the independently installed `@devcontainers/cli` 0.91.0. Choose an open local workspace with a Dev Container configuration and run **Inspect Dev Container Configuration** before approval.

For a Compose project, set `dockerComposeFile` to one to four explicit workspace YAML files and `service` to the workspace service. Optional `runServices` names the additional services to start. Rocketbrain shows the resulting service list including the selected app and its dependencies. Without `runServices`, the review lists the services resolved by Compose.

**Start Dev Container** requires approval of the file and service review. It starts the selected project under a new local Compose identity and verifies the exact workspace and dependency container IDs. The CLI applies the project’s configuration, build, mounts, and lifecycle hooks. **Run in Managed Dev Container** targets the verified workspace container with the supplied executable and argument array. Changes to the reviewed files or resolved Compose model require a fresh start review.

**Dev Container Status** reports the state of the app and its dependency services. After an interrupted startup, the session can report a partial project. **Stop Managed Dev Container** stops the exact verified app and dependency containers. Images, volumes, networks, and retained stopped containers can be managed separately with Docker.

The managed Compose route accepts up to eight services with one container per service, project-scoped networks and volumes, direct YAML files, and conventional dependencies. Service profiles, external container references, externally named Docker resources, and indirect YAML includes require a separate Docker Compose workflow. The review contains file and service identifiers. Resolved environment values stay in the local tool process.
