'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { springSourceRoot, runJpaHibernateProof } = require('./jpa-scoped-relationships-host');

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const quote = name => '`' + name + '`';

function entitySource({ pkg, name, table, schema, composite }) {
  const catalog = schema ? ', catalog = "' + schema + '"' : '';
  const keys = composite ? `
    @jakarta.persistence.Id @jakarta.persistence.Column(name = "tenant_id", nullable = false)
    private Long tenant;

    public static class Key implements java.io.Serializable {
        public Long tenant;
        public Long id;
        public Key() {}
        public Key(Long tenant, Long id) { this.tenant = tenant; this.id = id; }
        public boolean equals(Object other) {
            return other instanceof Key key && java.util.Objects.equals(tenant, key.tenant)
                && java.util.Objects.equals(id, key.id);
        }
        public int hashCode() { return java.util.Objects.hash(tenant, id); }
    }
` : '';
  return `package ${pkg};

@jakarta.persistence.Entity
@jakarta.persistence.Table(name = "${table}"${catalog})
${composite ? '@jakarta.persistence.IdClass(' + name + '.Key.class)\n' : ''}public class ${name} {
    @jakarta.persistence.Id @jakarta.persistence.Column(name = "id", nullable = false)
    private Long id;

    public Long getId() { return id; }
    public void setId(Long value) { id = value; }
${keys}}
`;
}

async function runJpaCompositeJoinChecks(api, vscode, checks) {
  const runtime = await readJson(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const config = await readJson(runtime.dbConfigPath);
  const ownerDir = path.dirname(runtime.dbConfigPath);
  const marker = await readJson(path.join(ownerDir, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(marker.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const crossConfig = process.env.ROCKETBRAIN_SCHEMA_CROSS_CONFIG;
  assert.ok(crossConfig && !path.relative(path.join(ownerDir, 'cross-schema.json'), crossConfig));
  const cross = await readJson(crossConfig);
  assert.deepEqual(cross.schemas, [config.database, 'rocketbrain_related']);
  assert.equal(cross.fixtureId, marker.id);
  assert.match(runtime.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const remote = cross.schemas[1];
  const pkg = 'fixture.boot', suffix = randomBytes(5).toString('hex');
  const parentTable = 'rb_jpa38_parent_' + suffix, childTable = 'rb_jpa38_child_' + suffix;
  const endpoint = 'rb_jpa38_endpoint_' + suffix, joinTable = 'rb_jpa38_join_' + suffix;
  const foreignKey = 'fk_38_child_' + suffix, ownerForeignKey = 'fk_38_owner_' + suffix, targetForeignKey = 'fk_38_target_' + suffix;
  const table = (schema, name) => quote(schema) + '.' + quote(name);
  const parentSql = table(config.database, parentTable), childSql = table(config.database, childTable);
  const ownerSql = table(config.database, endpoint), targetSql = table(remote, endpoint), joinSql = table(remote, joinTable);
  const { project, root } = await springSourceRoot(api, vscode.workspace.workspaceFolders[0].uri.fsPath, pkg);
  const javaDirectory = path.join(root.path, ...pkg.split('.'));
  const originals = [
    { name:'RbJpa38Child' + suffix, table:childTable, property:'parentReference' },
    { name:'RbJpa38Parent' + suffix, table:parentTable, property:'children', composite:true },
    { name:'RbJpa38Owner' + suffix, table:endpoint, property:'tags' },
    { name:'RbJpa38Target' + suffix, table:endpoint, schema:remote, property:'owners', composite:true }
  ].map(entity => {
    const file = path.join(javaDirectory, entity.name + '.java');
    return { ...entity, file, type:pkg + '.' + entity.name, uri:vscode.Uri.file(file), text:entitySource({ pkg, ...entity }) };
  });
  const [child, parent, owner, target] = originals;
  const role = ({ uri, type, table, property }, schema) => ({ uri:uri.toString(), type, table, property, ...(schema && { schema }) });
  const direct = { projectUri:project.uri, foreignKey, child:role(child), parent:role(parent) };
  const through = { kind:'manyToMany', projectUri:project.uri, joinSchema:remote, joinTable, ownerForeignKey, targetForeignKey,
    owner:role(owner, config.database), target:role(target, remote) };
  const actor = await mysql.createConnection(config);
  const tables = [], files = [], docs = [];
  const addTable = async (name, definition) => {
    await actor.query('CREATE TABLE ' + name + ' (' + definition + ') ENGINE=InnoDB');
    tables.unshift(name);
  };
  const generator = api.jpaScaffold;
  try {
    assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.jpa.reviewExistingRelationship'));
    await addTable(parentSql, 'tenant_id BIGINT NOT NULL, id BIGINT NOT NULL, PRIMARY KEY(tenant_id, id)');
    await addTable(childSql, 'id BIGINT PRIMARY KEY, parent_tenant BIGINT NULL, parent_id BIGINT NULL, CONSTRAINT ' + quote(foreignKey) +
      ' FOREIGN KEY(parent_tenant, parent_id) REFERENCES ' + parentSql + '(tenant_id, id)');
    await addTable(ownerSql, 'id BIGINT NOT NULL PRIMARY KEY');
    await addTable(targetSql, 'tenant_id BIGINT NOT NULL, id BIGINT NOT NULL, PRIMARY KEY(tenant_id, id)');
    await addTable(joinSql, 'owner_id BIGINT NOT NULL, target_tenant BIGINT NOT NULL, target_id BIGINT NOT NULL, ' +
      'PRIMARY KEY(owner_id, target_tenant, target_id), CONSTRAINT ' + quote(ownerForeignKey) + ' FOREIGN KEY(owner_id) REFERENCES ' +
      ownerSql + '(id), CONSTRAINT ' + quote(targetForeignKey) + ' FOREIGN KEY(target_tenant, target_id) REFERENCES ' +
      targetSql + '(tenant_id, id)');
    await actor.query('INSERT INTO ' + parentSql + ' VALUES (5, 11), (6, 11)');
    await actor.query('INSERT INTO ' + childSql + ' VALUES (21, 5, 11)');
    await actor.query('INSERT INTO ' + ownerSql + ' VALUES (31)');
    await actor.query('INSERT INTO ' + targetSql + ' VALUES (7, 41), (8, 41)');
    await actor.query('INSERT INTO ' + joinSql + ' VALUES (31, 7, 41)');
    for (const entity of originals) {
      await fs.writeFile(entity.file, entity.text, { flag:'wx' });
      files.push(entity.file);
      docs.push(await vscode.workspace.openTextDocument(entity.uri));
    }
    await api.connectMysql(config);
    const proof = await api.relationshipJoinCatalog({ joinSchema:remote, joinTable });
    assert.deepEqual(proof.targets.map(item => item.database).sort(), [config.database, remote].sort());
    assert.ok(proof.targets.every(item => item.selectedTable === endpoint));
    const stale = await generator.prepareExistingRelationship(through);
    await actor.query('ALTER TABLE ' + joinSql + ' ADD INDEX rb38_target_tenant (target_tenant, owner_id)');
    await assert.rejects(generator.applyExistingRelationship(stale.id), /relationship metadata changed/);
    assert.ok(docs.every(doc => !doc.isDirty));

    async function edit(request, targets, documents, ownership) {
      const review = await generator.prepareExistingRelationship(request);
      assert.equal(review.relationship.ownership, ownership);
      assert.deepEqual(review.documents.map(item => item.before), targets.map(entity => entity.text));
      const previews = await Promise.all(documents.map((_, index) => vscode.workspace.openTextDocument(vscode.Uri.parse(
        'rocketbrain-java-refactor:/' + review.id + '/' + index + '/after.java'))));
      assert.deepEqual(previews.map(doc => doc.getText()), review.documents.map(item => item.after));
      const applied = await generator.applyExistingRelationship(review.id);
      assert.equal(applied.state, 'applied');
      assert.equal(applied.savedToDisk, false);
      assert.deepEqual(applied.files, targets.map(entity => entity.uri.toString()));
      assert.ok(documents.every(doc => doc.isDirty));
      assert.deepEqual(await Promise.all(targets.map(entity => fs.readFile(entity.file, 'utf8'))), targets.map(entity => entity.text));
      assert.deepEqual(documents.map(doc => doc.getText()), review.documents.map(item => item.after));
      assert.ok((await Promise.all(documents.map(doc => doc.save()))).every(Boolean));
      return review.documents.map(item => item.after);
    }
    const directSources = await edit(direct, originals.slice(0, 2), docs.slice(0, 2), 'association');
    assert.match(directSources[0], /jakarta\.persistence\.JoinColumns/);
    const joinSources = await edit(through, originals.slice(2), docs.slice(2), 'join-table');
    assert.match(joinSources[0], /catalog = "rocketbrain_related"/);
    assert.match(joinSources[1], /ManyToMany\(mappedBy = "tags"/);
    await runJpaHibernateProof(api, runtime, config, files, [...originals.map(entity => entity.type), remote, joinTable],
      'CompositeJoinRelationshipProof', 'ROCKETBRAIN_JPA_COMPOSITE_JOIN_JDBC_OK');
    const [[childCount]] = await actor.query('SELECT COUNT(*) AS count FROM ' + childSql);
    const [[joinCount]] = await actor.query('SELECT COUNT(*) AS count FROM ' + joinSql);
    assert.deepEqual([Number(childCount.count), Number(joinCount.count)], [1, 1]);
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.ok(response.ok);
    const isolation = await response.json();
    assert.deepEqual(isolation, { people:2, departments:1, rolledBackNames:0 });
    checks.push('Both existing JPA pairs applied as previewed text edits. Hibernate read the full composite FK and the qualified cross-schema join in both directions, wrote links through the owners, and rolled both changes back.');
    checks.push('Active and auxiliary endpoint tables used the same name with different keys. The same connection observed their exact catalog identities, and an auxiliary index change invalidated its preview.');
    return { engine:runtime.dbEngine, compositeKeys:2, qualifiedJoinTable:true, bidirectionalCompositeRead:true,
      bidirectionalCrossSchemaRead:true, owningWrites:true, rollback:true, oneWorkspaceEditPerPair:true,
      diskUntouchedUntilSave:true, staleCrossSchemaRefused:true, isolation };
  } finally {
    for (const doc of docs) if (doc.isDirty) await doc.save();
    for (const file of files) await fs.unlink(file);
    try { for (const name of tables) await actor.query('DROP TABLE IF EXISTS ' + name); }
    finally { await actor.end(); await api.disconnectMysql(); }
  }
}

module.exports = { runJpaCompositeJoinChecks };
