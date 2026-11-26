'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath, runJavaFixture } = require('./instance-inline-fixture');
const { populateSignatureReferences } = require('./java-signature-references-fixture');

const pkg = 'fixture.compat';
const folder = 'src/main/java/fixture/compat';
const owner = path.join(folder, 'InvoicePricing.java');
const caller = path.join(folder, 'WorkspaceCustomer.java');
const legacyDescriptor = '(Ljava/lang/String;I)Ljava/lang/String;';
const expandedDescriptor = '(Ljava/lang/String;IB)Ljava/lang/String;';
const marker = 'computeQuote(String';
const change = { type: 'byte', name: 'region', defaultValue: '7' };

const sources = new Map([[owner, [
  'package fixture.compat;',
  'public final class InvoicePricing {',
  '    private InvoicePricing() {}',
  '    public static String computeQuote(String label, int cents) {',
  '        return label + ":" + cents;',
  '    }',
  '    public static String checkedInvoice(String label) throws java.io.IOException {',
  '        return label;',
  '    }',
  '    @Deprecated public static int protectedInvoice(int amount) { return amount; }',
  '    public static String overloadedInvoice(int amount) { return String.valueOf(amount); }',
  '    public static String overloadedInvoice(String amount) { return amount; }',
  '}',
  ''
].join('\n')], [caller, [
  'package fixture.compat;',
  'public final class WorkspaceCustomer {',
  '    public static String order() { return InvoicePricing.computeQuote("Local", 42); }',
  '    public static String another() { return InvoicePricing.computeQuote("Other", 17); }',
  '}',
  ''
].join('\n')]]);

function tool(javaHome, name) {
  return path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function checked(javaHome, name, args, cwd) {
  const result = await execute(tool(javaHome, name), args, { cwd, timeoutMs: 30000 });
  assert.equal(result.code, 0, result.output);
  return result.output.trim();
}

async function populateCompatibility(root, classpathFile, engine) {
  await populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), sources);
}

async function compileCompatibility({ javaHome, root, scratch }) {
  await fs.mkdir(scratch, { recursive: true });
  const classes = path.join(scratch, 'classes'), archive = path.join(scratch, 'invoice-api.jar');
  await fs.mkdir(classes);
  await checked(javaHome, 'javac', ['-proc:none', '-encoding', 'UTF-8', '-d', classes,
    ...[...sources.keys()].map(relative => path.join(root, relative))], scratch);
  await checked(javaHome, 'jar', ['--create','--file',archive,'-C',classes,'.'], scratch);
  const descriptors = await checked(javaHome, 'javap', ['-classpath', archive, '-s', pkg + '.InvoicePricing'], scratch);
  const reference = 'fixture/compat/InvoicePricing.computeQuote:';
  const calls = await checked(javaHome, 'javap', ['-classpath', archive, '-c', pkg + '.WorkspaceCustomer'], scratch);
  return { archive, descriptors, oldCallerSites: calls.split(reference + legacyDescriptor).length - 1,
    newCallerSites: calls.split(reference + expandedDescriptor).length - 1 };
}

async function compileLegacyClient(javaHome, archive, scratch) {
  await fs.mkdir(scratch, { recursive: true });
  const file = path.join(scratch, 'PrecompiledClient.java');
  await fs.writeFile(file, [
    'import fixture.compat.InvoicePricing;',
    'public class PrecompiledClient {',
    '    public static void main(String[] args) {',
    '        System.out.print(InvoicePricing.computeQuote("Legacy", 42));',
    '    }',
    '}'
  ].join('\n'));
  await checked(javaHome, 'javac', ['-proc:none', '-classpath', archive, '-d', scratch,file], scratch);
  const output = await checked(javaHome, 'javap', ['-c','-classpath',scratch,'PrecompiledClient'], scratch);
  assert.ok(output.includes('fixture/compat/InvoicePricing.computeQuote:' + legacyDescriptor), output);
  return { scratch, bytecode: path.join(scratch, 'PrecompiledClient.class') };
}

async function checkLegacyClient(javaHome, archive, legacy) {
  const result = await checked(javaHome, 'java', ['-classpath',
    [legacy.scratch, archive].join(path.delimiter), 'PrecompiledClient'], legacy.scratch);
  assert.equal(result, 'Legacy:42');
  return { sha256: sha(await fs.readFile(legacy.bytecode)), result };
}

async function runCompatibilitySpring({ javaHome, archive, scratch, classpathFile, database, engine }) {
  await fs.mkdir(scratch, { recursive: true });
  const file = path.join(scratch, 'CompatibilitySpringProbe.java');
  await fs.writeFile(file, [
    'import fixture.compat.WorkspaceCustomer;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public class CompatibilitySpringProbe {',
    '    public static void main(String[] args) {',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_COMPAT_JDBC_URL"),',
    '            System.getenv("RB_COMPAT_JDBC_USER"), System.getenv("RB_COMPAT_JDBC_PASSWORD")));',
    '        String label = WorkspaceCustomer.order();',
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
    '            jdbc.queryForObject("SELECT ?", String.class, label));',
    '    }', '}'
  ].join('\n'));
  const result = await runJavaFixture({ javaHome, file, binaryDirectory: scratch, className: 'CompatibilitySpringProbe',
    classpath: [archive,...await springJdbcClasspath(classpathFile, engine)], config: database, engine, jdbcPrefix: 'RB_COMPAT' });
  assert.equal(result.output.trim(), 'Local:42');
  return { engine, server: result.server, value: result.output.trim() };
}

function assertCompatibilityPlan(info, plan) {
  assert.deepEqual(info.compatibility, { originalDescriptor: legacyDescriptor, sourceCallers: 2 });
  assert.deepEqual(plan.signature.compatibility, {
    originalDescriptor: legacyDescriptor, expandedDescriptor, sourceCallers: 2, forwarderVerified: true
  });
  assert.equal(plan.documents.length, 2);
  const updated = plan.documents.map(document => document.after).join('\n');
  assert.match(updated, /public static String computeQuote\(String label, int cents, byte region\)/u);
  assert.match(updated, /return fixture\.compat\.InvoicePricing\.computeQuote\(label, cents, \(byte\) 7\);/u);
  assert.match(updated, /InvoicePricing\.computeQuote\("Local", 42, \(byte\) 7\)/u);
}

module.exports = { owner, caller, sources, marker, change, legacyDescriptor, expandedDescriptor, populateCompatibility,
  compileCompatibility, compileLegacyClient, checkLegacyClient, runCompatibilitySpring, assertCompatibilityPlan };
