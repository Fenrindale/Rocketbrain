'use strict';

function staticImportFixture(packageName, name, kind) {
  const expression=kind==='field'?'MAX_VALUE+":"+MAX_VALUE':kind==='explicit'?'RB_STATIC_LIMIT+":"+RB_STATIC_LIMIT':'max(3,7)+":"+max(1.0,2.0)';
  return 'package '+packageName+';\n\nimport java.util.*;\nimport static java.lang.Math.PI; // preserve unrelated import\n\n'+
    'public class '+name+' {\n'+
    '  static String value() { return '+expression+'; }\n'+
    '  public static void main(String[] args) { System.out.print(value()); }\n}\n';
}

module.exports={staticImportFixture};
