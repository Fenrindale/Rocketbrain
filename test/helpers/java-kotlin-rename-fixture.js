'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { input, configureJdt, rebuild, runJdbc } = require('./mixed-type-rename-fixture');

const owner = 'src/main/java/mixed/reverse/domain/Shipment.java';
const target = 'src/main/java/mixed/reverse/domain/ReviewedShipment.java';
const caller = 'src/main/java/mixed/reverse/app/JavaUsage.java';
const shadow = 'src/main/java/mixed/reverse/shadow/Shipment.java';
const kotlin = 'src/main/kotlin/mixed/reverse/app/Shipping.kt';
const newName = 'ReviewedShipment';
const files = new Map([
  [owner, [
    'package mixed.reverse.domain;',
    'public final class Shipment {',
    '  private final String label;',
    '  private final int number;',
    '  public Shipment(String label, int number) { this.label = label; this.number = number; }',
    '  public String render() { return label + ":" + number; }',
    '}', ''
  ].join('\n')],
  [caller, [
    'package mixed.reverse.app;',
    'import mixed.reverse.domain.Shipment;',
    'public final class JavaUsage {',
    '  public static Shipment shipped(int number) { return new Shipment("java", number); }',
    '}', ''
  ].join('\n')],
  [shadow, [
    'package mixed.reverse.shadow;',
    'public final class Shipment {',
    '  public Shipment() {}',
    '  public String render() { return "shadow"; }',
    '}', ''
  ].join('\n')],
  [kotlin, [
    'package mixed.reverse.app',
    'import mixed.reverse.domain.Shipment',
    'import org.springframework.jdbc.core.JdbcTemplate',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource',
    '',
    'fun ship(number: Int): Shipment = Shipment("kotlin", number)',
    'fun show(item: mixed.reverse.domain.Shipment): String = item.render()',
    'fun shadow(): mixed.reverse.shadow.Shipment = mixed.reverse.shadow.Shipment()',
    '',
    'fun main() {',
    '    val source = DriverManagerDataSource(System.getenv("RB_KRENAME_JDBC_URL"),',
    '        System.getenv("RB_KRENAME_JDBC_USER"), System.getenv("RB_KRENAME_JDBC_PASSWORD"))',
    '    val jdbc = JdbcTemplate(source)',
    '    val number = jdbc.queryForObject("SELECT 42", Int::class.javaObjectType)!!',
    '    val server = jdbc.queryForObject("SELECT VERSION()", String::class.java)',
    '    println(server + "|" + show(ship(number)) + "/" + JavaUsage.shipped(number).render() + "/" + shadow().render())',
    '}', ''
  ].join('\n')]
]);

async function populate(root, tools, { deployedRoot = root } = {}) {
  await fs.mkdir(root, { recursive: true });
  for (const file of ['settings.gradle', 'build.gradle', 'gradle.properties']) {
    await fs.copyFile(path.join(input, file), path.join(root, file));
  }
  for (const [file, text] of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text, { flag: 'wx' });
  }
  await rebuild(root, tools);
  await configureJdt(root, { deployedRoot });
}

function readDatabase(root, tools, config, engine) {
  return runJdbc(root, tools, config, engine, {
    mainClass: 'mixed.reverse.app.ShippingKt', expectedOutput: 'kotlin:42/java:42/shadow'
  });
}

module.exports = { owner, target, caller, shadow, kotlin, newName, files, populate, rebuild, readDatabase };
