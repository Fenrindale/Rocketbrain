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
const marker = 'ROCKETBRAIN_JPA_DERIVED_IDENTITY_JDBC_OK';

function keyDeclaration(name, fields) {
  const declarations = fields.map(([field, column]) => `    @Column(name = "${column}", nullable = false) private Long ${field};`);
  const parameters = fields.map(([field]) => 'Long ' + field).join(', ');
  const assignments = fields.map(([field]) => `this.${field} = ${field};`).join(' ');
  const equality = fields.map(([field]) => `java.util.Objects.equals(${field}, key.${field})`).join(' && ');
  return `@Embeddable
public class ${name} implements java.io.Serializable {
${declarations.join('\n')}
    public ${name}() {}
    public ${name}(${parameters}) { ${assignments} }
    public boolean equals(Object other) { return other instanceof ${name} key && ${equality}; }
    public int hashCode() { return java.util.Objects.hash(${fields.map(([field]) => field).join(', ')}); }
}`;
}

const simpleId = `    @Id @Column(name = "id", nullable = false) private Long id;
    public void setId(Long value) { this.id = value; }`;

async function runJpaDerivedIdentityChecks(api, vscode, checks) {
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const owner = await readJson(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const pkg = 'fixture.boot';
  const suffix = randomBytes(5).toString('hex');
  const table = role => 'rb40_' + role + '_' + suffix;
  const overrideParent = table('override_parent'), overrideChild = table('override_child'), overrideFk = table('fk_override');
  const derivedParent = table('derived_parent'), derivedChild = table('derived_child'), derivedFk = table('fk_derived');
  const { project, root } = await springSourceRoot(api, vscode.workspace.workspaceFolders[0].uri.fsPath, pkg);
  const folder = path.join(root.path, ...pkg.split('.'));
  const source = (role, body, selection) => {
    const name = 'Rb40' + role + suffix, file = path.join(folder, name + '.java');
    return { name, file, uri:vscode.Uri.file(file).toString(), type:pkg + '.' + name, ...selection,
      text:`package ${pkg};\nimport jakarta.persistence.*;\n${body(name)}\n` };
  };
  const key = (role, ...fields) => source(role, name => keyDeclaration(name, fields));
  const entity = (role, table, property, members) => source(role, name => `@Entity @Table(name = "${table}")
public class ${name} {
${members}
}`, { table, property });
  const overrideKey = key('OverrideKey', ['tenant', 'legacy_tenant'], ['external', 'legacy_external']);
  const derivedKey = key('DerivedKey', ['owner', 'owner_fk'], ['sequence', 'legacy_seq']);
  const overridden = [entity('OverrideChild', overrideChild, 'parentReference', simpleId),
    entity('OverrideParent', overrideParent, 'children', `    @EmbeddedId
    @AttributeOverrides({
        @AttributeOverride(name = "external", column = @Column(name = "account_id", nullable = false)),
        @AttributeOverride(name = "tenant", column = @Column(name = "tenant_id", nullable = false))
    })
    private ${overrideKey.name} identity;`)];
  const derived = [entity('DerivedChild', derivedChild, 'ownerReference', `    @EmbeddedId
    @AttributeOverride(name = "sequence", column = @Column(name = "seq_no", nullable = false))
    private ${derivedKey.name} identity;
    public void setIdentity(${derivedKey.name} value) { this.identity = value; }`),
    entity('DerivedParent', derivedParent, 'children', simpleId)];
  const endpoint = ({ uri, type, table, property }) => ({ uri, type, table, property });
  const request = ([child, parent], foreignKey) => ({ projectUri:project.uri, foreignKey, child:endpoint(child), parent:endpoint(parent) });
  const overrideRequest = request(overridden, overrideFk), derivedRequest = request(derived, derivedFk);
  const all = [...overridden, overrideKey, ...derived, derivedKey], documents = new Map(), files = [], tables = [];
  const sql = await mysql.createConnection(config);
  const scaffold = api.jpaScaffold;
  const add = async (table, definition) => {
    await sql.query('CREATE TABLE ' + quote(table) + ' (' + definition + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    tables.unshift(table);
  };
  try {
    const derivedConstraint = 'CONSTRAINT ' + quote(derivedFk) + ' FOREIGN KEY (owner_fk) REFERENCES ' + quote(derivedParent) + ' (id)';
    await add(overrideParent, 'tenant_id BIGINT NOT NULL, account_id BIGINT NOT NULL, PRIMARY KEY (tenant_id, account_id)');
    await add(overrideChild, 'id BIGINT PRIMARY KEY, parent_tenant BIGINT NULL, parent_account BIGINT NULL, CONSTRAINT ' + quote(overrideFk) +
      ' FOREIGN KEY (parent_tenant, parent_account) REFERENCES ' + quote(overrideParent) + ' (tenant_id, account_id)');
    await add(derivedParent, 'id BIGINT PRIMARY KEY');
    await add(derivedChild, 'owner_fk BIGINT NOT NULL, seq_no BIGINT NOT NULL, PRIMARY KEY (owner_fk, seq_no), ' + derivedConstraint);
    await sql.query('INSERT INTO ' + quote(overrideParent) + ' VALUES (5, 11), (6, 11)');
    await sql.query('INSERT INTO ' + quote(overrideChild) + ' VALUES (21, 5, 11)');
    await sql.query('INSERT INTO ' + quote(derivedParent) + ' VALUES (51), (52)');
    await sql.query('INSERT INTO ' + quote(derivedChild) + ' VALUES (51, 7)');
    for (const item of all) {
      await fs.writeFile(item.file, item.text, { flag:'wx' });
      files.push(item.file);
      documents.set(item.uri, await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri)));
    }
    await api.connectMysql(config);
    const staleSource = await scaffold.prepareExistingRelationship(derivedRequest);
    await fs.appendFile(derivedKey.file, '// companion changed after review\n');
    await assert.rejects(scaffold.applyExistingRelationship(staleSource.id), /Java source changed after review/);
    await fs.writeFile(derivedKey.file, derivedKey.text);
    assert.ok(derived.every(item => !documents.get(item.uri).isDirty));

    const staleForeignKey = await scaffold.prepareExistingRelationship(derivedRequest);
    await sql.query('ALTER TABLE ' + quote(derivedChild) + ' DROP FOREIGN KEY ' + quote(derivedFk));
    await assert.rejects(scaffold.applyExistingRelationship(staleForeignKey.id), /relationship metadata changed/);
    await sql.query('ALTER TABLE ' + quote(derivedChild) + ' ADD ' + derivedConstraint);
    assert.ok(derived.every(item => !documents.get(item.uri).isDirty));

    const catalog = await api.databaseCatalog();
    assert.throws(() => planExistingRelationship({ catalog, selection:existingRelationshipSelection(derivedRequest),
      sources:[{ ...derived[0], text:derived[0].text.replace('@EmbeddedId', '@EmbeddedId\n' +
        '    @AttributeOverride(name = "owner", column = @Column(name = "owner_fk"))') }, derived[1], derivedKey] }),
    /cannot change the member supplied by MapsId/);

    async function apply(selection, pair, verify) {
      const review = await scaffold.prepareExistingRelationship(selection);
      verify(review);
      assert.deepEqual(review.documents.map(item => item.before), pair.map(item => item.text));
      const previews = await Promise.all(review.documents.map((_, index) => vscode.workspace.openTextDocument(vscode.Uri.parse(
        'rocketbrain-java-refactor:/' + review.id + '/' + index + '/after.java'))));
      assert.deepEqual(previews.map(doc => doc.getText()), review.documents.map(item => item.after));
      const result = await scaffold.applyExistingRelationship(review.id);
      assert.equal(result.state, 'applied');
      assert.equal(result.savedToDisk, false);
      assert.deepEqual(result.files, pair.map(item => item.uri));
      assert.deepEqual(await Promise.all(pair.map(item => fs.readFile(item.file, 'utf8'))), pair.map(item => item.text));
      const editors = pair.map(item => documents.get(item.uri));
      assert.ok(editors.every(doc => doc.isDirty));
      assert.ok((await Promise.all(editors.map(doc => doc.save()))).every(Boolean));
    }
    await apply(overrideRequest, overridden, review => {
      assert.deepEqual(review.relationship.embeddedKeyOverrides, [{ entity:overridden[1].type, embeddedId:'identity',
        columns:[{ attribute:'tenant', column:'tenant_id' }, { attribute:'external', column:'account_id' }] }]);
      assert.deepEqual(review.relationship.referencedKey.columns, ['tenant_id', 'account_id']);
      assert.match(review.documents[0].after, /referencedColumnName = "tenant_id"[\s\S]*referencedColumnName = "account_id"/);
    });
    await apply(derivedRequest, derived, review => {
      assert.equal(review.relationship.ownership, 'derived-identity');
      assert.deepEqual(review.relationship.derivedIdentity,
        { embeddedId:'identity', attribute:'owner', column:'owner_fk', referencedColumn:'id' });
      assert.deepEqual(review.relationship.embeddedKeyOverrides, [{ entity:derived[0].type, embeddedId:'identity',
        columns:[{ attribute:'sequence', column:'seq_no' }] }]);
      assert.match(review.documents[0].after, /jakarta\.persistence\.MapsId\("owner"\)/);
      assert.match(review.documents[1].after, /OneToMany\(mappedBy = "ownerReference"/);
    });
    for (const key of [overrideKey, derivedKey]) assert.equal(await fs.readFile(key.file, 'utf8'), key.text);
    await runJpaHibernateProof(api, runtime, config, files, all.map(item => item.type), 'DerivedIdentityRelationshipProof', marker);
    const [[overrideRows]] = await sql.query('SELECT COUNT(*) AS n FROM ' + quote(overrideChild));
    const [[derivedRows]] = await sql.query('SELECT COUNT(*) AS n FROM ' + quote(derivedChild));
    assert.deepEqual([Number(overrideRows.n), Number(derivedRows.n)], [1, 1]);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Hibernate read both directions and wrote the overridden EmbeddedId and MapsId relationships using their exact observed database keys. Both inserts rolled back.');
    checks.push('Each relationship applied as one two-file WorkspaceEdit. A changed ID companion, a removed foreign key, and an override of the derived member prevented edits.');
    return { engine:runtime.dbEngine, overriddenKeyColumns:3, derivedKeyMembers:1, bidirectionalReads:true, owningWrites:true,
      rollback:true, oneWorkspaceEditPerPair:true, diskUntouchedUntilSave:true, staleIdentitySourceRefused:true,
      staleForeignKeyRefused:true, derivedOverrideRefused:true, isolation };
  } finally {
    for (const doc of documents.values()) if (doc.isDirty) await doc.save();
    for (const file of files) await fs.unlink(file);
    try { for (const table of tables) await sql.query('DROP TABLE IF EXISTS ' + quote(table)); }
    finally { await sql.end(); await api.disconnectMysql(); }
  }
}

module.exports = { runJpaDerivedIdentityChecks };
