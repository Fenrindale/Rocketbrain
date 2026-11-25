'use strict';

function javaInformationFixture(pkg,name,{spring=false,binary=true}={}) {
  return [
    'package '+pkg+';',
    ...(spring?['@org.springframework.stereotype.Component']:[]),
    'public class '+name+' {',
    '    /** Repeats the exact Java label for the caller.',
    '     * @param label caller label',
    '     * @param count repeat count',
    '     * @return the repeated label',
    '     */',
    '    static String render(String label, int count) { return label.repeat(count); }',
    '    /** Adds the Java suffix to the caller label. */',
    '    static String render(String label, String suffix) { return label + suffix; }',
    '    static String use() {',
    '        String local = render("seed", 2);',
    ...(binary?['        return local + library.BinaryOnly.format("wire", 3);']:['        return local;']),
    '    }','}',''
  ].join('\n');
}
const kotlinInformationFixture=[
  'package editor.fixture',
  '/** Builds a distinct Kotlin KDoc test result.',
  ' * @param label exact Kotlin caller label',
  ' * @param count how often the value is repeated',
  ' */',
  'fun report(label: String, count: Int): String = label.repeat(count)',
  '/** Adds the Kotlin suffix. */',
  'fun report(label: String, suffix: String): String = label + suffix',
  'fun consume() = report("seed", 2)',''
].join('\n');
const binaryInformationFixture='package library;\npublic class BinaryOnly {\n'+
  ' public static String format(String token, int copies) { return token.repeat(copies); }\n'+
  ' public static String format(String token, String suffix) { return token + suffix; }\n}\n';

module.exports={javaInformationFixture,kotlinInformationFixture,binaryInformationFixture};
