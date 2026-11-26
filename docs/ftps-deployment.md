# FTPS project deployment

Use **Review FTPS Project Deployment** in a trusted local workspace to browse a remote directory, compare a saved local file, or review creation of one remote folder.

## Configure a route

Set `rocketbrain.deploy.ftps.profiles` in VS Code User Settings. Give each route a unique `label`, `host`, `user`, and absolute remote `root`. The `port` defaults to 21. The `tlsServerName` defaults to the host. Set it explicitly if you connect to an address while verifying a DNS name on the certificate. To trust a private issuer, set `caFile` to an absolute local path to a PEM CA file. The password prompt shows the host, user, and TLS identity.

Use an account with permissions confined to its intended deployment directory. The server controls the virtual filesystem and permissions. It must support explicit `AUTH TLS`, binary transfers over protected `EPSV` data connections, and machine-readable `MLSD` directory listings. Every new data connection must authenticate the same server certificate as the control connection. The flow requires at least TLS 1.2 and performs the control TLS checks before sending the account password.

## Review and publish

1. Choose a saved local file and an existing or absent remote comparison path. The review displays byte counts, SHA-256 hashes, the route certificate, and the filename prefix for a new upload. **Compare FTPS Deployment File** opens read-only snapshots for UTF-8 texts of at most 64 KiB.
2. Run **Publish Reviewed FTPS Change** and approve the exact file review or folder creation. A review is valid for two minutes. The extension checks the file contents, configured route, and TLS trust again before publishing.
3. Upload uses the server’s `STOU` operation. The server reports a new filename starting with the approved prefix, for example `Example.java.rb-upload.` followed by a server-generated suffix. Rocketbrain reads back the new file and verifies its SHA-256. The existing comparison file stays in place.

Files are limited to 2 MiB and directory listings to 256 entries. New folders require an existing parent. A server without the supported `STOU` response can still browse and compare files. Uploads do not automatically retry. If a transfer is interrupted, inspect the reported filename or directory. A server may have allocated an empty or partial file and the extension does not delete it automatically.

This flow supports reviewed unique-file publishing and folder creation. FTP does not provide a portable exact-name conditional replacement or an atomic directory deployment. Implicit FTPS, active FTP, plain FTP, remote deletion, recursive synchronization, and servers that require TLS session resumption on data connections are outside this workflow.

Protocol references include [FTPS negotiation](https://www.rfc-editor.org/info/rfc4217/), [EPSV](https://www.rfc-editor.org/info/rfc2428/), [MLSD](https://www.rfc-editor.org/info/rfc3659/), and [STOU response requirements](https://www.rfc-editor.org/rfc/rfc1123.html#section-4.1.2.9).
