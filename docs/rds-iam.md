# AWS RDS IAM database connections

In Rocketbrain’s **New Database Connection** editor, select **AWS RDS IAM** under Authentication. Enter the lowercase RDS instance or Aurora cluster endpoint, its port and region, the IAM-enabled database username, and the database schema. Select the official RDS CA bundle for the endpoint’s AWS partition. The editor selects direct TCP and verified TLS for the configured endpoint. [AWS RDS TLS certificates](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.SSL.html)

Install AWS CLI v2 on the host running the Rocketbrain extension. Choose either **AWS environment credentials**, supplied through `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and optionally `AWS_SESSION_TOKEN` in the process that launches VS Code, or **Named AWS CLI profile**. For a named profile, enter its exact name as configured in AWS CLI. Complete any sign-in required by the profile through AWS CLI before connecting. AWS CLI may refresh temporary credentials for a configured profile. [AWS CLI configuration and credentials](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html)

The selected AWS principal needs `rds-db:connect` permission for the database resource and database user, and the database user must be configured for IAM authentication. When the database requests authentication over verified TLS, Rocketbrain uses `aws rds generate-db-auth-token` to create a token for that host, port, region and user. It requests a token on each new physical connection, including an explicit reconnect. An authenticated session continues under the original database grants. Profile exports retain the endpoint and region, and you reselect the local credential source and CA bundle after importing. [AWS IAM database authentication](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.Connecting.html)

The connector supports RDS MySQL or Aurora MySQL direct instance and cluster endpoints. Proxy endpoints, custom DNS names, SSH-forwarded routes and PostgreSQL IAM authentication are outside this scope. The offline verification signs with synthetic keys using official AWS CLI v2, independently checks the SigV4 signature, and uses a disposable loopback MySQL protocol fixture for the TLS authentication exchange. It does not require an AWS account.

## Verify a separately approved live cloud fixture

The offline tests use synthetic AWS signing credentials, simulated token delivery and disposable loopback MySQL TLS. Run the separate verifier against a pre-existing fixture that you own and approve for this read-only check. It reads the current database account and one known row before and after reconnecting. Output contains provider, TLS version and boolean results. Keep the local fixture configuration outside the repository.

Prepare a database account with SELECT on the fixture schema and table only. The table is `rocketbrain_live_auth_proof`, with integer primary key `fixture_id` and text column `nonce`. Its row with `fixture_id = 1` must contain the same 32–64 character lowercase hexadecimal marker specified in the input file. Use a separate named AWS CLI profile with `rds-db:connect` for this exact RDS MySQL instance or Aurora MySQL cluster and exact IAM-enabled database user. Sign in to that profile separately if needed. Use the actual vendor endpoint and its official AWS partition CA bundle. [AWS database account setup](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.DBAccounts.html) · [AWS scoped IAM permission](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html)

Use an unrelated self-signed CA certificate as the negative TLS control. The verifier connects to the same endpoint with that CA and requires the TLS handshake to be refused before sending any token.

```json
{
  "format": "RocketbrainOwnedCloudMySqlFixture-v1",
  "approval": "owned-cloud-fixture-read-only",
  "host": "fixture-db.example123.us-east-1.rds.amazonaws.com",
  "port": 3306,
  "user": "rb_fixture_auth",
  "database": "rb_fixture",
  "auth": {
    "kind": "aws-rds-iam",
    "region": "us-east-1",
    "source": "profile",
    "profile": "rb-fixture-only"
  },
  "caPath": "D:/owned-fixtures/rds-global-bundle.pem",
  "wrongCaPath": "D:/owned-fixtures/unrelated-test-root.pem",
  "nonce": "54ae1a629e6e43a2b1b52cfce71caf50"
}
```

Pass an absolute local path to the fixture JSON from the Rocketbrain repository.

```powershell
node scripts/verify-cloud-mysql-auth.js --fixture 'D:/owned-fixtures/rds-proof.json'
```

To exercise the provider’s token expiry, allow up to 20 minutes and provide an explicit UTC deadline. The selected profile must still be able to acquire a fresh credential at the end of the check. The verifier holds the first accepted token in memory until the AWS expiry timestamp is past, requires the real server to deny that token, then reconnects through the normal profile with a fresh credential. A normal run reports expiry as `not-requested`. [AWS IAM token lifetime](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.IAMDBAuth.Connecting.html)

```powershell
$deadline = (Get-Date).ToUniversalTime().AddMinutes(18).ToString('yyyy-MM-ddTHH:mm:ssZ')
node scripts/verify-cloud-mysql-auth.js --fixture 'D:/owned-fixtures/rds-proof.json' --with-rds-expiry --deadline $deadline
```

For a separately approved public Azure Database for MySQL Flexible Server fixture, use its exact `.mysql.database.azure.com` hostname and port 3306, the mapped database username, Microsoft’s published CA roots, and `"auth": {"kind": "azure-mysql-entra", "account": "<signed-in user principal name>", "tenant": "<tenant ID>", "subscription": "<subscription ID>"}`. Use an existing reviewed Azure CLI sign-in to that account. The verifier checks access-token acquisition on each physical connection. Azure CLI can return a still-valid cached token. Run the basic command for Azure. [Microsoft Entra authentication setup](https://learn.microsoft.com/en-us/azure/mysql/security/security-how-to-entra) · [Azure MySQL TLS roots](https://learn.microsoft.com/en-us/azure/mysql/security/security-tls)
