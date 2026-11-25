'use strict';

const path=require('node:path');
const fs=require('node:fs/promises');

async function javaNullFixture(project,packageName,name) {
  const dir=path.join(project,'src/main/java',...packageName.split('.'));
  await fs.mkdir(dir,{recursive:true});
  const files=[];
  try {
    for(const [type,target] of [['Maybe','{ElementType.TYPE_USE}'],['Required','{ElementType.TYPE_USE}'],
      ['RequiredByDefault','{ElementType.TYPE, ElementType.PACKAGE, ElementType.METHOD}'],
      ['AlternateDefault','{ElementType.TYPE, ElementType.PACKAGE, ElementType.METHOD}']]) {
      const file=path.join(dir,type+'.java');
      await fs.writeFile(file,`package ${packageName};
import java.lang.annotation.*;
@Target(${target}) @Retention(RetentionPolicy.CLASS)
public @interface ${type} {}
`,{flag:'wx'});
      files.push(file);
    }
    const file=path.join(dir,name+'.java'),source=`package ${packageName};
import java.io.FileInputStream;
import java.io.IOException;

class ${name} {
    static int unsafeLength(@Maybe String value) { return value.length(); }
    static @Required String unsafeResult() { return null; }
    static int read() throws IOException {
        var stream = new FileInputStream("never-executed");
        return stream.read();
    }
    @RequiredByDefault static String defaultResult() { return null; }
    public static void main(String[] args) {
        System.out.print(unsafeLength(null) + ":" + unsafeLength("value") + ":" + unsafeResult() + ":" + defaultResult());
    }
}
`;
    await fs.writeFile(file,source,{flag:'wx'});
    files.push(file);
    const fixed=source.replace('return value.length();','return value == null ? 0 : value.length();')
      .replaceAll('return null;','return "ready";').replace('var stream = new FileInputStream("never-executed");\n        return stream.read();',
        'try (var stream = new FileInputStream("never-executed")) {\n            return stream.read();\n        }');
    return {file,source,fixed,files,profile:{profile:'custom',nullable:packageName+'.Maybe',nonnull:packageName+'.Required',
      nonnullByDefault:packageName+'.RequiredByDefault'}};
  }catch(error){for(const file of files)await fs.rm(file,{force:true});throw error;}
}

const kotlinNullFixture=`package editor.fixture

fun unsafeLength(value: String?): Int = value.length
`;
const kotlinNullFixed=kotlinNullFixture.replace('value.length','value?.length ?: 0');
const javaNullable=diagnostic=>/null pointer access|may be null/i.test(diagnostic.message);
const javaContract=diagnostic=>/null type mismatch|null specification violation/i.test(diagnostic.message);
const javaResource=diagnostic=>/resource leak|never closed/i.test(diagnostic.message);
const kotlinNullable=diagnostic=>/safe \(\?\.\).*nullable receiver|nullable receiver.*safe/i.test(diagnostic.message);

module.exports={javaNullFixture,kotlinNullFixture,kotlinNullFixed,javaNullable,javaContract,javaResource,kotlinNullable};
