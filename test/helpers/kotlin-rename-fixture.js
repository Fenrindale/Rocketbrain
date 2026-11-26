'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const kotlinPath = (...names)=>path.join('src/main/kotlin/editor/fixture',...names);
const javaPath = (...names)=>path.join('src/main/java/editor/fixture',...names);
const kotlinOnly = {
  begins:[kotlinPath('OrderSummary.kt'),'invoice.number',9],
  newName:'invoiceNumber',output:'ORDER-21'
};
const mixed = {
  begins:[kotlinPath('RenameSupport.kt'),'hiddenLabel(count)',2],
  newName:'privateOrderLabel',output:'ORDER-21/MIXED-21'
};

async function populate(root,{mixedProject=false}={}) {
  await fs.cp(path.join(__dirname,'../fixtures/java/kotlin-editor'),root,{recursive:true});
  if (!mixedProject) return;
  await fs.writeFile(path.join(root,kotlinPath('RenameSupport.kt')),[
    'package editor.fixture','',
    'private fun hiddenLabel(count: Int): String = "MIXED-"+count',
    'fun publicLabel(count: Int): String = hiddenLabel(count)',''
  ].join('\n'),{flag:'wx'});
  await fs.mkdir(path.join(root,javaPath()),{recursive:true});
  await fs.writeFile(path.join(root,javaPath('MixedCaller.java')),[
    'package editor.fixture;',
    'public final class MixedCaller {',
    '    public static String verify(int count) { return RenameSupportKt.publicLabel(count); }',
    '}',''
  ].join('\n'),{flag:'wx'});
}

function jdbcSource(mixedProject) {
  return [
    'package fixture;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'import editor.fixture.Invoice;',
    'import editor.fixture.OrderSummaryKt;',
    ...(mixedProject ? ['import editor.fixture.MixedCaller;'] : []),
    'public class KotlinRenameProbe {',
    '    public static void main(String[] args) {',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_KRENAME_JDBC_URL"),',
    '            System.getenv("RB_KRENAME_JDBC_USER"), System.getenv("RB_KRENAME_JDBC_PASSWORD")));',
    '        int count = jdbc.queryForObject("SELECT 21", Integer.class);',
    '        String number = OrderSummaryKt.summarize(new Invoice("order-"+count,21L));',
    ...(mixedProject ? ['        number += "/"+MixedCaller.verify(count);'] : []),
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + number);',
    '    }',
    '}', ''
  ].join('\n');
}

module.exports = {kotlinPath,javaPath,kotlinOnly,mixed,populate,jdbcSource};
