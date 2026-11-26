# OpenBao passwords for saved database connections

Choose **OpenBao KV v2** as the authentication source in a MySQL or MariaDB profile. Enter the server origin, KV v2 mount, relative secret path and the field containing the database password. The database username and address stay in the database profile. For a private HTTPS trust chain, enter a local public CA PEM path and review its SHA-256 fingerprint.

Test, save or connect by entering an OpenBao token scoped to read the single reviewed KV v2 path. Rocketbrain reads the latest available version directly from that endpoint and uses its selected field during the database connection attempt. It verifies HTTPS, rejects redirects and allows unencrypted HTTP only on numeric loopback for a local test instance.

After rotating the database password and updating the corresponding secret, reconnect with a fresh scoped token to use the new version. Token and password values remain in the operation or active DB driver memory. The profile and VS Code Secret Storage contain neither value. Portable profile format 9 keeps the authentication kind, and the importing workspace supplies its own OpenBao endpoint, path and local trust. A scheduled workflow that cannot ask for an OpenBao token requires a different profile.

This connector was verified with OpenBao 2.7.3 and a short-lived, single-path read policy. Dynamic database leases, automatic server-side rotation, brokered authentication and namespace header routing are outside this workflow. [OpenBao KV v2 documentation](https://openbao.org/docs/secrets/kv/kv-v2/)
