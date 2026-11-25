'use strict';

function inheritedStructureFixture(packageName,base,child,{spring=false}={}) {
  return {
    [base+'.java']:[
      'package '+packageName+';',
      'interface '+base+'Contract<T> {',
      '    default T contract(T value) { return value; }',
      '}',
      'public class '+base+'<T> implements '+base+'Contract<T> {',
      '    protected T /* generic member */ inherited(T value) { return value; }',
      '    protected int inherited(int value) { return value; }',
      '    protected T shared;',
      '    protected String copied = values(this.duplicate, "copy"), duplicate = "second";',
      '    private String values(String a, String b) { return b; }',
      '    protected int hidden;',
      '    private int secret;',
      '    protected void replaced() {}',
      '    protected static class SharedType {}',
      '}',
      ''
    ].join('\r\n'),
    [child+'.java']:[
      'package '+packageName+';',
      ...(spring?['@org.springframework.stereotype.Component']:[]),
      'public final class '+child+' extends '+base+'<String> {',
      '    int hidden;',
      '    @Override protected void replaced() {}',
      '    public static class Member {}',
      '    Runnable create() {',
      '        class Local {}',
      '        return new Runnable() {',
      '            @Override public void run() { new Local(); }',
      '        };',
      '    }',
      '    java.util.function.Consumer<String> another() {',
      '        class Local {}',
      '        return new java.util.function.Consumer<String>() {',
      '            @Override public void accept(String entry) { new Local(); }',
      '        };',
      '    }',
      '}',
      ''
    ].join('\n')
  };
}

module.exports={inheritedStructureFixture};
