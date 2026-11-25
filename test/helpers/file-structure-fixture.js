'use strict';

function javaStructureSource(namespace,name,{spring=false,bulk=0}={}) {
  const fields=Array.from({length:bulk},(_,i)=>`  private int modelField${i} = ${i};`).join('\n');
  return `package ${namespace};\n\n${spring?'import org.springframework.stereotype.Component;\n\n@Component\n':''}public class ${name}<T> {\n  private int seed = 5, second = 7;\n  public ${name}() {}\n  public void display(int input) {}\n  public void display(String input) {}\n  static record Inner(String text) { int len() { return text.length(); } }\n  interface Nested { void callback(); }\n${fields}\n}\n`;
}

function kotlinStructureSource(namespace,name) {
  return `package ${namespace}\n\nclass ${name}(val first: Int) {\n  fun display(x: Int) = "hello"\n  fun display(x: String) = x\n  private val answer = 5\n  companion object { const val FLAG = 1 }\n  data class Inner(val detail: String) { fun visible() = detail }\n}\nfun topLevel() { }\nfun \`spaced name\`() { }\n`;
}

module.exports = {javaStructureSource,kotlinStructureSource};
