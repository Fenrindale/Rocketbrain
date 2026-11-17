# Public source and verification

The public repository contains Rocketbrain's own extension, runtime helper source,
synthetic test fixtures, build scripts, and component notices. It is a development
preview with bounded support. Publishing source does not establish full parity
with IntelliJ IDEA or DataGrip.

The owner has not selected a redistribution license for original project code.
`package.json` therefore retains `UNLICENSED`; third-party components retain their
own terms and notices. Public visibility does not grant a new project license.

Local research archives, original-product observations, credentials, database
instances, runtime downloads, compiled fixtures, and raw validation logs are not
published. Paths in architecture policy that begin with `research/` identify local
evidence retained by the maintainer, rather than files available in this source
checkout. Public validation summaries should state the tested version, scope,
engine versions, results, and remaining limitations without including that data.

## Build from a fresh checkout

Use Node.js 22 or newer and pnpm 10. Keep the lockfile unchanged when reproducing a
build. The repository preserves source bytes, including existing line endings,
because Java helper sources are embedded verbatim in the extension. From the
repository root, run:

```sh
pnpm install --frozen-lockfile
pnpm run test:offline
pnpm run build
pnpm run package
```

The package command rebuilds the extension, collects the installed runtime
dependency license texts, and checks the VSIX file list, payload bytes and ZIP
checksums. A local VSIX is created; this does not publish to the VS Code Marketplace.
The packaged extension contains no Java engine or database server binary.

The offline selector excludes files that provision real database servers and
explicitly skips tests requiring an unavailable Java, database, browser or
extension-host runtime. A passing offline job is not a claim that those
integrations ran. GitHub CI labels these checks separately from the maintainer's
real Spring, MySQL and MariaDB verification. `pnpm test` retains the broader test
selection and can provision server fixtures on Windows.

## Integration tools

Java setup is explicit. `scripts/java-provision.js`,
`scripts/java-debug-provision.js`, and `scripts/java-test-provision.js` provision
independent public components, verify pinned artifacts, and retain notices in the
chosen local runtime directory. Read each command's arguments before running it.
The extension does not download these runtimes merely by activating.

The MySQL and MariaDB integration helpers are Windows fixtures. The following
commands download pinned public server archives on first use, start a new owned
loopback instance with synthetic data, run the selected tests, and clean up their
own instance:

```sh
pnpm run test:mysql
pnpm run test:integration
```

Additional Java, Spring, browser and native VS Code tests require the corresponding
explicit `ROCKETBRAIN_*` configuration and independent runtimes. Some maintainer
release checks additionally use private local evidence and are not included as
public release scripts. Never point disposable fixture tools at a production
database. Craft Anything remains an optional maintainer CLI tool, not a runtime
dependency or a bundled artifact.

## Publishing updates

The repository uses a restrictive `.gitignore`. Before staging, run
`node scripts/publication-audit.js`; after staging, run the same command with
`--staged`. The audit rejects paths outside the source allowlist, binary files,
oversized files, private user paths and common credential formats. It reports
locations and rule names without printing matching secret values. This is a
repeatable guard and still requires review of the staged changes.

Use explicit source paths when staging. Keep raw reports and runtime installations
outside the public commit. Publish a portable verification summary instead of
copying local evidence archives into Git history.
