'use strict';

function extractMethodFixture(pkg,name,{spring=false}={}) {
  const selected=[
    'T result = normalize(value, suffix);',
    '        if (allow < 0) throw failure;',
    '        if (allow == 0) return value;',
    '        return result;'
  ].join('\n');
  const text=[
    'package '+pkg+';',
    'import java.io.IOException;',
    ...(spring?['@org.springframework.stereotype.Component']:[]),
    'public class '+name+' {',
    '    private static <T extends CharSequence> T normalize(T value, String suffix) {',
    '        System.out.print(suffix); return value;',
    '    }',
    '    private static Object normalize(Object value, Object suffix) { throw new AssertionError(); }',
    '    public static <T extends CharSequence, E extends IOException> T run(T value, int allow, E failure) throws E {',
    '        String suffix = "+";',
    '        '+selected,
    '    }',
    '    static int cannot(int count) {',
    '        count++;',
    '        return count;',
    '    }',
    '    public static void main(String[] args) throws IOException {',
    '        IOException failure = new IOException("same");',
    '        System.out.print(run("ok",1,failure));',
    '        System.out.print(run("zero",0,failure));',
    '        try { run("error",-1,failure); } catch (IOException seen) { System.out.print(seen==failure ? ":same" : ":wrong"); }',
    '    }',
    '}',''
  ].join('\n');
  return {text,selected,unsafe:'count++;\n        return count;'};
}

module.exports={extractMethodFixture};
