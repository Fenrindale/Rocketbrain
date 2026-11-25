'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { springSourceRoot, runJpaHibernateProof } = require('./jpa-scoped-relationships-host');
const { existingRelationshipSelection, planExistingRelationship } = require('../src/jpa/entity-existing-relationships');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = name => '`' + name + '`';
const marker = 'ROCKETBRAIN_JPA_EMBEDDED_UNIQUE_JDBC_OK';

function declaration(pkg, name, table, members) {
  return `package ${pkg};
import jakarta.persistence.*;
@Entity
@Table(name = "${table}")
public class ${name} {
${members}
}
`;
}

const simpleIdentity = `    @Id @Column(name = "id", nullable = false)
    private Long id;
    public void setId(Long value) { this.id = value; }`;

function keySource(pkg, name) {
  return `package ${pkg};
import jakarta.persistence.*;
@Embeddable
public class ${name} implements java.io.Serializable {
    @Column(name = "tenant_id", nullable = false)
    private Long tenant;
    @Column(name = "id", nullable = false)
    private Long id;
    public ${name}() {}
    public ${name}(Long tenant, Long id) { this.tenant = tenant; this.id = id; }
    public boolean equals(Object other) {
        return other instanceof ${name} key && java.util.Objects.equals(tenant, key.tenant)
            && java.util.Objects.equals(id, key.id);
    }
    public int hashCode() { return java.util.Objects.hash(tenant, id); }
}
`;
}

async function runJpaEmbeddedUniqueChecks(api, vscode, checks) {
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const owner = await readJson(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const pkg = 'fixture.boot';
  const suffix = randomBytes(5).toString('hex');
  const embedParent = 'rb39_embed_parent_' + suffix, embedChild = 'rb39_embed_child_' + suffix;
  const uniqueParent = 'rb39_unique_parent_' + suffix, uniqueChild = 'rb39_unique_child_' + suffix;
  const embedForeign = 'rb39_fk_embed_' + suffix, uniqueForeign = 'rb39_fk_unique_' + suffix;
  const uniqueIndex = 'rb39_natural_' + suffix;
  const { project, root } = await springSourceRoot(api, vscode.workspace.workspaceFolders[0].uri.fsPath, pkg);
  const folder = path.join(root.path, ...pkg.split('.'));
  const source = (role, table, property, members) => {
    const name = 'Rb39' + role + suffix, file = path.join(folder, name + '.java');
    return { file, uri:vscode.Uri.file(file).toString(), type:pkg + '.' + name, table, property,
      text:table ? declaration(pkg, name, table, members) : keySource(pkg, name) };
  };
  const key = source('Key');
  const embedded = [
    source('EmbeddedChild', embedChild, 'parentReference', simpleIdentity),
    source('EmbeddedParent', embedParent, 'children', '    @EmbeddedId private ' + key.type.split('.').pop() + ' identity;')
  ];
  const unique = [
    source('UniqueChild', uniqueChild, 'parentReference', simpleIdentity),
    source('UniqueParent', uniqueParent, 'children', simpleIdentity + `
    @Column(name = "tenant_code", nullable = false) private Long tenant;
    @Column(name = "account_code", nullable = false) private String account;`)
  ];
  const request = ([child, parent], foreignKey) => ({ projectUri:project.uri, foreignKey,
    child:{ uri:child.uri, type:child.type, table:child.table, property:child.property },
    parent:{ uri:parent.uri, type:parent.type, table:parent.table, property:parent.property } });
  const embedRequest = request(embedded, embedForeign), uniqueRequest = request(unique, uniqueForeign);
  const all = [...embedded, ...unique, key], documents = new Map(), files = [], tables = [];
  const sql = await mysql.createConnection(config);
  const scaffold = api.jpaScaffold;
  const add = async (table, definition) => {
    await sql.query('CREATE TABLE ' + quote(table) + ' (' + definition + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    tables.unshift(table);
  };
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.jpa.reviewExistingRelationship'));
    await add(embedParent, 'tenant_id BIGINT NOT NULL, id BIGINT NOT NULL, PRIMARY KEY (tenant_id, id)');
    await add(embedChild, 'id BIGINT PRIMARY KEY, parent_tenant BIGINT NULL, parent_id BIGINT NULL, CONSTRAINT ' +
      quote(embedForeign) + ' FOREIGN KEY (parent_tenant, parent_id) REFERENCES ' + quote(embedParent) + ' (tenant_id, id)');
    await add(uniqueParent, 'id BIGINT PRIMARY KEY, tenant_code BIGINT NOT NULL, account_code VARCHAR(24) NOT NULL, UNIQUE KEY ' +
      quote(uniqueIndex) + ' (tenant_code, account_code)');
    await add(uniqueChild, 'id BIGINT PRIMARY KEY, parent_tenant BIGINT NULL, parent_account VARCHAR(24) NULL, CONSTRAINT ' +
      quote(uniqueForeign) + ' FOREIGN KEY (parent_tenant, parent_account) REFERENCES ' + quote(uniqueParent) + ' (tenant_code, account_code)');
    await sql.query('INSERT INTO ' + quote(embedParent) + ' VALUES (5, 11), (6, 11)');
    await sql.query('INSERT INTO ' + quote(embedChild) + ' VALUES (21, 5, 11)');
    await sql.query('INSERT INTO ' + quote(uniqueParent) + " VALUES (51, 9, 'north'), (52, 9, 'south')");
    await sql.query('INSERT INTO ' + quote(uniqueChild) + " VALUES (61, 9, 'north')");
    for (const item of all) {
      await fs.writeFile(item.file, item.text, { flag:'wx' });
      files.push(item.file);
      documents.set(item.uri, await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri)));
    }
    await api.connectMysql(config);
    const staleIdentity = await scaffold.prepareExistingRelationship(embedRequest);
    await fs.appendFile(key.file, '// reviewed companion has changed\n');
    await assert.rejects(scaffold.applyExistingRelationship(staleIdentity.id), /Java source changed after review/);
    assert.ok(embedded.every(item => !documents.get(item.uri).isDirty));
    await fs.writeFile(key.file, key.text);

    const staleUnique = await scaffold.prepareExistingRelationship(uniqueRequest);
    assert.deepEqual(staleUnique.relationship.referencedKey, { kind:'unique', columns:['tenant_code','account_code'], indexes:[uniqueIndex] });
    const newIndex = 'rb39_second_natural_' + suffix;
    await sql.query('ALTER TABLE ' + quote(uniqueParent) + ' ADD UNIQUE INDEX ' + quote(newIndex) + ' (tenant_code, account_code)');
    await assert.rejects(scaffold.applyExistingRelationship(staleUnique.id), /relationship metadata changed/);
    assert.ok(unique.every(item => !documents.get(item.uri).isDirty));
    const catalog = await api.databaseCatalog();
    const parentMetadata = catalog.tables.find(table => table.name === uniqueParent);
    const observed = parentMetadata.indexes.filter(index => index.unique && !index.primaryKey);
    assert.ok(observed.some(index => index.name === uniqueIndex && index.columns.length === 2));
    const narrowed = structuredClone(catalog);
    const narrowedParent = narrowed.tables.find(table => table.name === uniqueParent);
    for (const candidate of narrowedParent.indexes.filter(index => index.unique && !index.primaryKey)) candidate.columns.pop();
    assert.throws(() => planExistingRelationship({ catalog:narrowed, selection:existingRelationshipSelection(uniqueRequest),
      sources:unique }), /complete ordered non-prefix/);

    async function apply(selection, pair, columnNames) {
      const review = await scaffold.prepareExistingRelationship(selection);
      assert.deepEqual(review.relationship.referencedKey.columns, columnNames);
      assert.deepEqual(review.documents.map(item => item.before), pair.map(item => item.text));
      assert.match(review.documents[0].after, /jakarta.persistence.JoinColumns/);
      assert.match(review.documents[1].after, /OneToMany\(mappedBy = "parentReference"/);
      const previews = await Promise.all(review.documents.map((_, index) => vscode.workspace.openTextDocument(vscode.Uri.parse(
        'rocketbrain-java-refactor:/' + review.id + '/' + index + '/after.java'))));
      assert.deepEqual(previews.map(doc => doc.getText()), review.documents.map(item => item.after));
      const applied = await scaffold.applyExistingRelationship(review.id);
      assert.equal(applied.state, 'applied');
      assert.equal(applied.savedToDisk, false);
      assert.deepEqual(applied.files, pair.map(item => item.uri));
      assert.deepEqual(await Promise.all(pair.map(item => fs.readFile(item.file, 'utf8'))), pair.map(item => item.text));
      const editors = pair.map(item => documents.get(item.uri));
      assert.ok(editors.every(doc => doc.isDirty));
      assert.ok((await Promise.all(editors.map(doc => doc.save()))).every(Boolean));
    }
    await apply(embedRequest, embedded, ['tenant_id','id']);
    await apply(uniqueRequest, unique, ['tenant_code','account_code']);
    assert.equal(await fs.readFile(key.file, 'utf8'), key.text);
    await runJpaHibernateProof(api, runtime, config, files, all.map(item => item.type), 'EmbeddedUniqueRelationshipProof', marker);
    const [[embeddedRows]] = await sql.query('SELECT COUNT(*) AS n FROM ' + quote(embedChild));
    const [[uniqueRows]] = await sql.query('SELECT COUNT(*) AS n FROM ' + quote(uniqueChild));
    assert.deepEqual([Number(embeddedRows.n), Number(uniqueRows.n)], [1, 1]);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Existing Jakarta relationships preserved both byte-identical companion inputs and database rows until reviewed edits and transaction-local writes. Hibernate read and wrote the full EmbeddedId primary key and the alternate UNIQUE key through both associations, then rolled back.');
    checks.push('Changing the standalone EmbeddedId source or the observed unique index set refused the pending preview, and the planner rejected a truncated unique index profile.');
    return { engine:runtime.dbEngine, embeddedKeyColumns:2, uniqueKeyColumns:2, embeddedReads:true, uniqueReads:true, owningWrites:true,
      rollback:true, oneWorkspaceEditPerPair:true, diskUntouchedUntilSave:true, staleIdentitySourceRefused:true,
      staleUniqueIndexRefused:true, narrowKeyRefused:true, isolation };
  } finally {
    for (const doc of documents.values()) if (doc.isDirty) await doc.save();
    for (const file of files) await fs.unlink(file);
    try { for (const table of tables) await sql.query('DROP TABLE IF EXISTS ' + quote(table)); }
    finally { await sql.end(); await api.disconnectMysql(); }
  }
}

module.exports = { runJpaEmbeddedUniqueChecks };
