# SFTP project deployment

Select **Review SFTP Project Deployment** from Rocketbrain in a trusted local workspace. You can browse a remote folder, compare a saved workspace file with a remote file, or review creation of one remote folder.

## Configure a route

Set `rocketbrain.deploy.sftp.profiles` in VS Code User Settings. Each profile supplies a unique `label`, `host`, `user`, absolute SFTP `root`, and independently verified OpenSSH SHA-256 `hostFingerprint`. The `port` defaults to 22. Choose `password` or `encrypted-key` as the `authentication` value. An encrypted key profile also requires the absolute local `privateKeyPath` to a supported passphrase-protected OpenSSH key.

The operation prompts for the password or key passphrase after showing the endpoint and fingerprint. Rocketbrain verifies the SSH host key before submitting that credential. It uses a direct SFTP channel over the authenticated SSH connection. Enter credentials in the prompt and keep them out of the settings file.

## Review and publish

1. Choose a route and a saved local file or a destination directory. Browse the configured root or enter a relative destination path. A new folder requires an existing parent.
2. Inspect the review. It gives the remote endpoint, target path, operation, and the byte counts and SHA-256 hashes for existing file contents. Use **Compare SFTP Deployment File** to open the two read-only snapshots for UTF-8 text of at most 64 KiB.
3. Run **Publish Reviewed SFTP Change** and confirm the transfer or folder creation. Rocketbrain rechecks the active profile, local file, and remote destination. A successful transfer ends with a fresh readback of the remote SHA-256.

A review authorizes one operation for two minutes. Files are limited to 2 MiB and a directory listing to 256 entries. Save changes before reviewing a local file. The review expires if the configured route or local workspace changes. Symbolic links at the destination or along the configured remote path are refused.

Rocketbrain stages file contents in a verified temporary sibling. Creation uses SFTP v3 rename, which rejects an existing destination. Replacement requires the server’s OpenSSH POSIX rename extension and a staging file with the same observable owner, group, and basic permission bits. The server applies the rename atomically on a filesystem that supports this operation. Use a directory with stable parents and coordinate with other writers. SFTP provides no conditional replacement by content hash, so an independent writer can change an existing destination between the last hash check and the rename. Other server metadata such as ACLs or extended attributes is beyond this review.

If the connection drops during publication, inspect the reported remote path and any reported staging path before opening a new review. The route supports individual files and folders. Recursive synchronization, FTPS, remote deletions, and directory-wide atomic publishing are outside this workflow.
