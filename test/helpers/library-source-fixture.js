'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');

const execute=promisify(execFile);
const librarySource=`package library.fixture;

public final class Meter {
    // This exact comment exists only in the original source archive.
    private Meter() {}

    public static int convert(int input) {
        final int adjusted = input * 3;
        if (adjusted > 20) {
            return adjusted - 4;
        }
        return adjusted + 4;
    }
}`;
const consumerSource=`package consumer;
import library.fixture.Meter;
public class Sample {
    public static void main(String[] args) {
        System.out.print(Meter.convert(8) + ":" + Meter.convert(2));
    }
}
`;

async function prepareLibraryFixture({project,scratch,javaHome,name='LibraryFixture'}) {
  const root=path.join(scratch,'original'),entry='library/fixture/Meter.java',classes=path.join(scratch,'classes');
  const lib=path.join(project,'lib'),sources=path.join(scratch,'meter-sources.jar'),binary=path.join(lib,'meter.jar'),
    file=path.join(project,'src/consumer/Sample.java'),config=path.join(project,'.project');
  await fs.mkdir(path.dirname(path.join(root,entry)),{recursive:true});
  await fs.mkdir(classes,{recursive:true});
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.mkdir(lib,{recursive:true});
  await fs.writeFile(path.join(root,entry),librarySource+'\n',{flag:'wx'});
  const tool=(name,args)=>execute(path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':'')),args,{timeout:30000,windowsHide:true});
  await tool('javac',['--release','17','-g','-proc:none','-d',classes,path.join(root,entry)]);
  await tool('jar',['--create','--file',binary,'-C',classes,'.']);
  await tool('jar',['--create','--file',sources,'-C',root,'.']);
  await fs.writeFile(config,`<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
  <name>${name}</name>
  <buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments></arguments></buildCommand></buildSpec>
  <natures><nature>org.eclipse.jdt.core.javanature</nature></natures>
</projectDescription>`,{flag:'wx'});
  await fs.writeFile(path.join(project,'.classpath'),`<?xml version="1.0" encoding="UTF-8"?>
<classpath>
  <classpathentry kind="src" path="src"/>
  <classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>
  <classpathentry kind="lib" path="lib/meter.jar"/>
  <classpathentry kind="output" path="bin"/>
</classpath>`,{flag:'wx'});
  await fs.writeFile(file,consumerSource,{flag:'wx'});
  return {binary,sources,config,entry,file,source:consumerSource,original:librarySource+'\n',tool};
}

module.exports={prepareLibraryFixture,librarySource};
