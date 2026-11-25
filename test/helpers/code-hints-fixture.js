'use strict';

function javaHintsFixture(pkg,name,{spring=false}={}) {
  return [
    'package '+pkg+';',
    ...(spring?['@org.springframework.stereotype.Component']:[]),
    'public class '+name+' {',
    '    static String renderHint(String caption, int count) { return caption.repeat(count); }',
    '    public void hintValues() {',
    '        int amount = 2;',
    '        var output = renderHint("literal", 3);',
    '        renderHint(output, amount);',
    '        java.util.function.Function<String,Integer> length = item -> item.length();',
    '    }','}',''
  ].join('\n');
}
const kotlinHintsFixture=[
  'package editor.fixture',
  'fun renderHint(caption: String, count: Int) = caption.repeat(count)',
  'fun hintValues() {',
  '    val amount = 2',
  '    val output = renderHint("literal", 3)',
  '    renderHint(output, amount)',
  '}',''
].join('\n');

module.exports={javaHintsFixture,kotlinHintsFixture};
