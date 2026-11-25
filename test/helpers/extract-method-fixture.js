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

function voidMethodFixture(pkg,name,{spring=false}={}) {
  const outsideLoop='if (repeat == 0) continue;';
  const selected=[
    'log.add(value);',
    '            if (failure != null) throw failure;',
    '            for (int repeat = 0; repeat < 3; repeat++) {',
    '                '+outsideLoop,
    '                log.add(value.toUpperCase(java.util.Locale.ROOT));',
    '                break;',
    '            }'
  ].join('\n');
  const escaping='String retained = value;\n        log.add(retained);';
  const earlyReturn='if (value.isEmpty()) return;\n        log.add(value);';
  const text=[
    'package '+pkg+';',
    'import java.io.IOException;',
    'import java.util.ArrayList;',
    'import java.util.List;',
    ...(spring?['@org.springframework.stereotype.Component']:[]),
    'public class '+name+' {',
    '    private final List<String> log = new ArrayList<>();',
    '    private final String retained = "field";',
    '    public void append(String value, IOException failure) throws IOException {',
    '        log.add("before");',
    '        if (!value.isEmpty()) {',
    '            '+selected,
    '        }',
    '        log.add("after");',
    '    }',
    '    public void escaping(String value) {',
    '        '+escaping,
    '        log.add(retained);',
    '    }',
    '    public void early(String value) {',
    '        '+earlyReturn,
    '    }',
    '    public static void main(String[] args) throws IOException {',
    '        '+name+' sample = new '+name+'();',
    '        sample.append("one", null);',
    '        sample.append("", null);',
    '        IOException failure = new IOException("identity");',
    '        try { sample.append("two", failure); } catch (IOException seen) {',
    '            sample.log.add(seen == failure ? "same" : "wrong");',
    '        }',
    '        System.out.print(String.join(",", sample.log));',
    '    }',
    '}',''
  ].join('\n');
  return {text,selected,escaping,earlyReturn,outsideLoop};
}

module.exports={extractMethodFixture,voidMethodFixture};
