# Local Dev Containers

Rocketbrain uses the open Dev Containers CLI 0.91.0 to read the workspace configuration, apply a single image or Dockerfile environment, and run commands inside the resulting container. A local Docker service and Node.js 20 or later are required. [Dev Containers CLI 0.91.0](https://github.com/devcontainers/cli/releases/tag/v0.91.0)

Install the CLI with `npm install --prefix <local-tool-folder> --save-exact @devcontainers/cli@0.91.0`. Set `rocketbrain.devcontainer.cliPath` in user settings to the resulting `node_modules/@devcontainers/cli` directory. Rocketbrain also accepts absolute paths to Node.js and Docker in `rocketbrain.devcontainer.nodePath` and `rocketbrain.devcontainer.dockerPath` when those executables are outside PATH.

1. Open and trust the local folder containing `.devcontainer/devcontainer.json` or `.devcontainer.json`.
2. Run **Rocketbrain: Inspect Dev Container Configuration** to see the selected image or Dockerfile, workspace mount and lifecycle hooks in the Output panel.
3. Run **Rocketbrain: Start Managed Dev Container**, review the displayed configuration and confirm. An `initializeCommand` can run on the host as specified by the project.
4. Run **Rocketbrain: Run in Managed Dev Container** and enter an argument array such as `["java", "-version"]`. The Output panel shows stdout, diagnostics and the exit code.
5. Use **Rocketbrain: Check Managed Dev Container Status** or **Rocketbrain: Stop Managed Dev Container**. Rocketbrain records the workspace session and verifies its exact Docker ID and ownership label before stopping it. Stopped containers remain available to the Docker CLI.

The current workflow covers one image or Dockerfile with a local Docker socket or named pipe. Docker Compose launch, the remote VS Code extension host, editor port forwarding, and debugger attachment are outside the current scope.

The Ubuntu validation workflow exercises actual image and Dockerfile builds, the workspace bind mount, a lifecycle command, remote environment, literal arguments, nonzero command exit, and the stopped container identity. [Dev Container runtime workflow](../.github/workflows/devcontainer-runtime.yml)
