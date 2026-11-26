'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const modulePath = 'modules/jdbc fixture';
const selectedFile = '/' + modulePath + '/src/main/java/compilefixture/AccountRead.java';
const companion = 'TableName.java';
const frameworkDependencies = ['spring-context', 'spring-jdbc', 'spring-tx', 'spring-beans', 'spring-core'];

async function stageJavaCompile(fixture, springConfig) {
  const root = fixture.profile.root;
  const source = path.join(root, modulePath, 'src', 'main', 'java', 'compilefixture');
  await fs.mkdir(source, { recursive: true });
  let dependencies = [];
  const jars = [];
  if (springConfig) {
    const config = JSON.parse(await fs.readFile(springConfig, 'utf8'));
    const entries = JSON.parse(await fs.readFile(path.join(config.projectPath, 'build', 'dependencies.json'), 'utf8'));
    dependencies = frameworkDependencies.map(name => {
      const matches = entries.filter(item => item.group === 'org.springframework' && item.name === name);
      assert.equal(matches.length, 1, name);
      return matches[0];
    });
    const libraries = path.join(root, 'libraries');
    await fs.mkdir(libraries);
    for (const item of dependencies) {
      const leaf = path.basename(item.file);
      assert.equal(leaf, item.name + '-' + item.version + '.jar');
      await fs.copyFile(item.file, path.join(libraries, leaf));
      jars.push('/libraries/' + leaf);
    }
  }
  await fs.writeFile(path.join(root, selectedFile), springConfig
    ? 'package compilefixture;\nimport org.springframework.jdbc.core.JdbcTemplate;\n' +
      'import org.springframework.stereotype.Repository;\n@Repository\n' +
      'public class AccountRead {\n  public Integer count(JdbcTemplate db) {\n' +
      '    return db.queryForObject("SELECT COUNT(*) FROM " + TableName.PEOPLE, Integer.class);\n  }\n}\n'
    : 'package compilefixture;\npublic class AccountRead {\n  public String table() { return TableName.PEOPLE; }\n}\n');
  const companionFile = path.join(source, companion);
  const companionText = 'package compilefixture;\nfinal class TableName { static final String PEOPLE = "people"; }\n';
  await fs.writeFile(companionFile, companionText);
  return { source, selectedFile, module: '/' + modulePath, companionFile, companionText, jars,
    framework: Object.fromEntries(dependencies.map(({ name, version }) => [name, version])) };
}

module.exports = { stageJavaCompile };
