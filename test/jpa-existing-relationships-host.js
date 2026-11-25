'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { springSourceRoot, runJpaHibernateProof } = require('./jpa-scoped-relationships-host');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function runJpaExistingRelationshipChecks(api, vscode, checks) {
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const marker = await readJson(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.jpa.reviewExistingRelationship'));
  const scoped = api.jpaScaffold;
  assert.ok(scoped?.prepareExistingRelationship && scoped?.applyExistingRelationship);
  const pkg = 'fixture.boot';
  const workspace = vscode.workspace.workspaceFolders[0];
  const { project, root } = await springSourceRoot(api, workspace.uri.fsPath, pkg);
  const suffix = randomBytes(5).toString('hex'), foreignKey = 'fk_pair_' + suffix;
  const parentTable = 'rb_jpa_pair_parent_' + suffix, childTable = 'rb_jpa_pair_child_' + suffix;
  const parentClass = 'RbJpaPairParent' + suffix, childClass = 'RbJpaPairChild' + suffix;
  const directory = path.join(root.path, ...pkg.split('.'));
  const files = [childClass, parentClass].map(name => path.join(directory, name + '.java'));
  const uris = files.map(file => vscode.Uri.file(file));
  const tables = [childTable, parentTable];
  const originals = [childClass, parentClass].map((name, index) => `package ${pkg};
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "${tables[index]}")
public class ${name} {
    @Id
    @Column(name = "id", nullable = false)
    private Long id;

    public Long getId() { return id; }
    public void setId(Long value) { id = value; }
}
`);
  const selection = {
    projectUri:project.uri, foreignKey,
    child:{ uri:uris[0].toString(), type:pkg + '.' + childClass, table:childTable, property:'parentReference' },
    parent:{ uri:uris[1].toString(), type:pkg + '.' + parentClass, table:parentTable, property:'children' }
  };
  const connection = await mysql.createConnection(config);
  let docs = [];
  const added = [];
  const prepare = () => scoped.prepareExistingRelationship(selection);
  const quoted = value => '`' + value + '`';
  try {
    await connection.query('CREATE TABLE ' + quoted(parentTable) + ' (id BIGINT NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    await connection.query('CREATE TABLE ' + quoted(childTable) + ' (id BIGINT NOT NULL PRIMARY KEY, parent_id BIGINT NULL, ' +
      'CONSTRAINT ' + quoted(foreignKey) + ' FOREIGN KEY(parent_id) REFERENCES ' + quoted(parentTable) + '(id)) ENGINE=InnoDB');
    await connection.query('INSERT INTO ' + quoted(parentTable) + ' VALUES (11)');
    await connection.query('INSERT INTO ' + quoted(childTable) + ' VALUES (21,11)');
    for (const [index, file] of files.entries()) {
      await fs.writeFile(file, originals[index], { flag:'wx' });
      added.push(file);
    }
    docs = await Promise.all(uris.map(uri => vscode.workspace.openTextDocument(uri)));
    // Editors in a CRLF workspace may use normalized text after a save. Keep the proof
    // bound to the exact content observed through both the API and disk.
    assert.deepEqual(docs.map(doc => doc.getText()), originals);
    await api.connectMysql(config);

    const staleCatalog = await prepare();
    await connection.query('ALTER TABLE ' + quoted(parentTable) + ' ADD COLUMN later_note VARCHAR(20) NULL');
    await assert.rejects(scoped.applyExistingRelationship(staleCatalog.id), /relationship metadata changed/);
    assert.deepEqual(docs.map(doc => doc.getText()), originals);

    const staleJava = await prepare();
    const mutation = new vscode.WorkspaceEdit();
    mutation.insert(uris[1], docs[1].positionAt(0), '// Changed while open\n');
    assert.ok(await vscode.workspace.applyEdit(mutation));
    await assert.rejects(scoped.applyExistingRelationship(staleJava.id), /source changed/);
    assert.equal(docs[0].getText(), originals[0]);
    const revert = new vscode.WorkspaceEdit();
    revert.replace(uris[1], new vscode.Range(docs[1].positionAt(0), docs[1].positionAt('// Changed while open\n'.length)), '');
    assert.ok(await vscode.workspace.applyEdit(revert));
    assert.ok(await docs[1].save());
    assert.deepEqual(docs.map(doc => doc.getText()), originals);

    const review = await prepare();
    assert.equal(review.relationship.ownership, 'association');
    assert.deepEqual(review.documents.map(file => file.before), originals);
    assert.match(review.documents[0].after, /jakarta.persistence.ManyToOne/);
    assert.match(review.documents[1].after, /jakarta.persistence.OneToMany\(mappedBy = "parentReference"/);
    const previews = await Promise.all(review.documents.map((_, index) => vscode.workspace.openTextDocument(
      vscode.Uri.parse('rocketbrain-java-refactor:/' + review.id + '/' + index + '/after.java'))));
    assert.deepEqual(previews.map(doc => doc.getText()), review.documents.map(item => item.after));
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), originals);
    const applied = await scoped.applyExistingRelationship(review.id);
    assert.equal(applied.state, 'applied');
    assert.equal(applied.savedToDisk, false);
    assert.deepEqual(applied.files, uris.map(uri => uri.toString()));
    assert.ok(docs.every(doc => doc.isDirty));
    assert.deepEqual(docs.map(doc => doc.getText()), review.documents.map(item => item.after));
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), originals);
    assert.ok((await Promise.all(docs.map(doc => doc.save()))).every(Boolean));
    assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file, 'utf8'))), review.documents.map(item => item.after));

    await runJpaHibernateProof(api, runtime, config, files, [selection.child.type, selection.parent.type],
      'ExistingBidirectionalRelationshipProof', 'ROCKETBRAIN_JPA_EXISTING_JDBC_OK');
    const [[child]] = await connection.query('SELECT COUNT(*) AS count FROM ' + quoted(childTable));
    assert.equal(Number(child.count), 1);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Reviewed the two existing JPA entity diffs and applied both as one text edit across VS Code buffers. Stale physical metadata and a dirty Java target prevented apply.');
    checks.push('Hibernate mapped the two edited sources in the owned Spring fixture classpath. Both association directions read correctly, and an owning-side insert could be read back and rolled back.');
    return { engine:runtime.dbEngine, twoPreviews:true, oneWorkspaceEdit:true, diskUntouchedUntilSave:true,
      staleMetadataRefused:true, staleJavaRefused:true, bidirectionalRead:true, owningWrite:true, rollback:true, isolation };
  } finally {
    for (const document of docs) if (document.isDirty) await document.save();
    for (const file of added) await fs.unlink(file);
    try { for (const table of tables) await connection.query('DROP TABLE IF EXISTS ' + quoted(table)); }
    finally { await connection.end(); await api.disconnectMysql(); }
  }
}

module.exports = { runJpaExistingRelationshipChecks };
