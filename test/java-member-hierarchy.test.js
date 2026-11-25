'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL,fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { hierarchyCandidates,hierarchyEdits,verifyHierarchyBindings } = require('../src/java/member-hierarchy');

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const runtimeTest = {skip:configuration ? false : 'Independent JDK25 runtime is not configured.',timeout:90000};

async function fixture(t) {
  const { javaHome } = JSON.parse(await fs.readFile(configuration,'utf8'));
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-member-hierarchy-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const unit = (name,body) => ({
    uri:pathToFileURL(path.join(root,name+'.java')).href,text:'package graph;\n'+body+'\n'
  });
  const inspect = sources => analyzeJavaSources({javaHome,storagePath:path.join(root,'inspections'),
    sources,inspection:{kind:'hierarchy'}});
  async function analyze(sources) {
    const report = await inspect(sources);
    assert.deepEqual(report.errors,[]);
    return report.hierarchy;
  }
  async function execute(sources) {
    const classes = path.join(root,'classes');
    await fs.mkdir(classes,{recursive:true});
    await Promise.all(sources.map(source => fs.writeFile(fileURLToPath(source.uri),source.text)));
    const program = name => path.join(javaHome,'bin',name+(process.platform === 'win32' ? '.exe' : ''));
    const run = promisify(execFile), options = {cwd:root,windowsHide:true,timeout:15000};
    await run(program('javac'),['--release','25','-proc:none','-d',classes,...sources.map(source => fileURLToPath(source.uri))],options);
    return (await run(program('java'),['-cp',classes,'graph.Caller'],options)).stdout.trim();
  }
  return {unit,inspect,analyze,execute};
}

function select(hierarchy,source,direction,names,target) {
  const request = {uri:source.uri,offset:0,direction};
  const review = hierarchyCandidates(hierarchy,request);
  const ids = names.map(name => review.members.find(item => item.name === name)?.key);
  assert.ok(ids.every(Boolean), names.join(', '));
  return {...request,targetId:'graph.'+target,memberIds:ids};
}

test('Javac proves instance methods and constants pulling up and pushing down with identical execution',runtimeTest,async t => {
  const h = await fixture(t);
  const base = h.unit('Base','class Base { protected int inherited = 3; }');
  const child = h.unit('Child',[
    'class Child extends Base {',
    '    static final int RATE = 2;',
    '    /** Calculates a price. */',
    '    int price(int value) { return inherited + value * RATE; }',
    '}'
  ].join('\n'));
  const sibling = h.unit('Sibling','class Sibling extends Base {}');
  const caller = h.unit('Caller','public class Caller { public static void main(String[] args) {'+
    'System.out.println(new Child().price(5) + ":" + Child.RATE); } }');
  const sources = [base,child,sibling,caller], start = await h.analyze(sources);
  const request = select(start,child,'pull',['price','RATE'],'Base');
  const up = hierarchyEdits(start,sources,request);
  assert.match(up.updated[0].text,/static final int RATE = 2;/);
  assert.match(up.updated[0].text,/Calculates a price/);
  assert.doesNotMatch(up.updated[1].text,/price\(|RATE/);
  const atBase = await h.analyze(up.updated);
  const pullProof = verifyHierarchyBindings(start,atBase,up);
  assert.ok(pullProof.movedReferences >= 3 && pullProof.otherReferences >= 5);
  assert.equal(await h.execute(up.updated),'13:2');
  const available = hierarchyCandidates(atBase,{uri:base.uri,offset:0,direction:'push'});
  assert.deepEqual(new Set(available.targets.map(type => type.name)),new Set(['Child','Sibling']));
  const down = hierarchyEdits(atBase,up.updated,select(atBase,base,'push',['price','RATE'],'Child'));
  const atChild = await h.analyze(down.updated);
  assert.ok(verifyHierarchyBindings(atBase,atChild,down).movedReferences >= 3);
  assert.doesNotMatch(down.updated[0].text,/price\(|RATE/);
  assert.match(down.updated[1].text,/Calculates a price/);
  assert.equal(await h.execute(down.updated),'13:2');
});

test('hierarchy proof rejects collisions, inaccessible members and an observed overload rebound',runtimeTest,async t => {
  const {unit,inspect,analyze} = await fixture(t);
  const root = unit('Base','class Base { int same(int x){ return x; } String choose(Object x){ return "base"; } }');
  const child = unit('Child','class Child extends Base { private int secret; int same(int x){ return 2*x; } '+
    'int inaccessible(){ return secret; } String choose(String x){ return "child"; } '+
    'int explicit(){ return this.secret; } }');
  const caller = unit('Caller','class Caller { String call(){ return new Base().choose("value"); } }');
  const sources = [root,child,caller], original = await analyze(sources);
  assert.throws(() => hierarchyEdits(original,sources,select(original,child,'pull',['same'],'Base')), /already declares or overrides/);
  assert.throws(() => hierarchyEdits(original,sources,select(original,child,'pull',['explicit'],'Base')), /explicit this or super/);
  const inaccessible = hierarchyEdits(original,sources,select(original,child,'pull',['inaccessible'],'Base'));
  assert.ok((await inspect(inaccessible.updated)).errors.some(error => /secret/.test(error.message)));
  const overload = hierarchyEdits(original,sources,select(original,child,'pull',['choose'],'Base'));
  const changed = await analyze(overload.updated);
  assert.throws(() => verifyHierarchyBindings(original,changed,overload), /would rebind a Java reference/);
  const needsBase = hierarchyEdits(original,sources,select(original,root,'push',['choose'],'Child'));
  assert.ok((await inspect(needsBase.updated)).errors.some(error => /choose/.test(error.message)));
  const wrongDirection = {...select(original,root,'push',['choose'],'Child'),targetId:'graph.Caller'};
  assert.throws(() => hierarchyEdits(original,sources,wrongDirection), /direct source hierarchy destination/);
});
