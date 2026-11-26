# Compare local and remote deployment changes

Run **Review Local and Remote Deployment Changes** in a trusted workspace. Choose an SFTP, FTPS, or WebDAV route, a local workspace folder, and the corresponding folder below the remote route’s configured root.

The first observation records file hashes on both sides. Later observations report additions, modifications, and deletions relative to those baseline hashes. The review distinguishes changes from one side, disagreements after both sides change, and paths whose contents agree. If they differed at the first observation, the initial difference remains visible. **Set Deployment Change Baseline** uses the last successful observation as the new baseline after you confirm.

Use **Refresh Deployment Changes** for a manual read or select **Monitor Both Sides for 10 Minutes** at the start. Monitoring reads both folders about every ten seconds. It pauses if either side cannot be read reliably. **Stop Monitoring Deployment Changes** closes the session and releases the temporary credential. A changed route or workspace also stops the session.

**Compare Deployment Change** opens the exact observed snapshots. Small UTF-8 files open in a read-only diff. Other files show the byte count and SHA-256. **Review Deployment Change for Upload** opens a fresh review for an eligible local file through the existing protocol. The fresh review must match the captured local and remote hashes. Use that protocol’s normal confirmation to publish. SFTP, FTPS, and WebDAV retain their own operation and server requirements. Remote-only edits, deletions, and conflicts are shown for review.

The mapping covers one existing folder on each side, up to 64 direct entries and 20 files of at most 2 MiB each. Each side has an 8 MiB total read limit. Nested folders, excluded entries, and non-file entries are listed separately. Case or Unicode normalization collisions pause comparison. Remote WebDAV monitoring requires HTTPS, with authenticated loopback HTTP available for a local server.

The review records individually read file contents. It does not create a distributed atomic snapshot or copy changes automatically. To apply a remote-side change locally, inspect the observed content and make an explicit local edit.
