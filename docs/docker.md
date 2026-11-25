# Docker workbench

Install the Docker CLI and start a daemon available through an existing Docker context. Open the **Docker** view in a trusted workspace and choose **Select Docker Context**. The selection shows the endpoint before it connects and applies to the current extension session.

- **Containers** shows the selected daemon's running and stopped containers. Select a container to read its latest 200 log lines. Use **Manage Docker Container** to review and approve a start, stop or restart of the selected full container ID.
- **Images** lists local image tags and digests.
- **Compose** uses the Docker Compose CLI to list projects and the daemon's project labels to inspect member containers.
- **Inspect Registry Manifest** looks up a registry-qualified tag or digest with the Docker CLI after you approve the request. Docker uses its existing registry sign-in, when configured. The CLI must support `docker manifest inspect`.

The listing is limited to 500 objects per category. The Docker workbench checks the context endpoint and the daemon identity again before it sends commands. Lifecycle approval expires after one minute and remains tied to the exact container and reviewed state.
