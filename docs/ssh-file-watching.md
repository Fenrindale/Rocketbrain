# SSH workspace file changes

Open a file from a connected SSH workspace to see edits made on the remote host. Rocketbrain checks the paths watched by VS Code and the open SSH editor files together over the pinned connection. It refreshes the file and its tree when a tracked path changes, disappears or returns.

Polling covers up to 64 paths in the active connection. It observes the tracked paths directly, including watched folders. Close the SSH workspace to stop watching. Uploads still use the separate reviewed upload command.
