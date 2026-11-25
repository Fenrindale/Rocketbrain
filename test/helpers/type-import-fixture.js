'use strict';

function typeImportFixture(pkg,name,{spring=false}={}) {
  return [
    'package '+pkg+';','',
    'import java.time.*; // keep the wildcard',
    'import static java.lang.Math.abs; // keep the static import',
    'import java.util.List; // keep the unused import for separate cleanup','',
    ...(spring?['@org.springframework.stereotype.Component']:[]),
    'public class '+name+' {',
    '    static Date value() { return new Date(abs(-1)); }',
    '    public static void main(String[] args) {',
    '        System.out.print(value().getClass().getName() + ":" + Instant.EPOCH.getEpochSecond());',
    '    }','}',''
  ].join('\n');
}

module.exports={typeImportFixture};
