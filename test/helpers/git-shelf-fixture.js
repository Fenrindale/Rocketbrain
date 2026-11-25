'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {inspectWorktree}=require('../../src/vcs/worktree-context');
const {springJdbcClasspath,runJavaFixture}=require('./instance-inline-fixture');

const run=promisify(execFile);
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^GIT_/iu.test(name)));
env.GIT_OPTIONAL_LOCKS='0';

async function git(root,...args) {
  const platform=process.platform==='win32'?['-c','core.longpaths=true']:[];
  return (await run('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=',
    '-c','user.name=Rocketbrain Shelf Fixture','-c','user.email=shelf-fixture@example.invalid',
    '-c','commit.gpgSign=false',...platform,...args],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:20000})).stdout;
}

function sourceFixture(spring) {
  if(!spring) return Array.from({length:44},(_,index)=>'owned line '+(index+1)).join('\n')+'\n';
  const lines=['package fixture;', 'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;', 'public final class ShelfProbe {',
    '    // fixture line 5', '    // fixture line 6', '    // fixture line 7', '    static int factor() { return 1; }'];
  for(let line=9;line<=43;line++)lines.push('    // fixture line '+line);
  lines.push('    // fixture line 44','    public static void main(String[] args) {',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_GIT_SHELF_JDBC_URL"),',
    '            System.getenv("RB_GIT_SHELF_JDBC_USER"), System.getenv("RB_GIT_SHELF_JDBC_PASSWORD")));',
    '        int result = jdbc.queryForObject("SELECT 21", Integer.class) * factor();',
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + result);',
    '    }','}','');
  return lines.join('\n');
}

async function createShelfFixture(outer,{spring=false,crlf=false}={}) {
  const origin=path.join(outer,'origin'),target=path.join(outer,'target'),conflict=path.join(outer,'conflict');
  const name=spring?'ShelfProbe.java':'한 글.txt', other='second.txt';
  const filename=(root,item=name)=>path.join(root,item);
  const text=sourceFixture(spring), eol=value=>crlf?value.replaceAll('\n','\r\n'):value;
  const selected=spring?['return 1;','return 2;']:['owned line 8\n','selected line 8\n'];
  const untouched=spring?['fixture line 34','unfinished line 34']:['owned line 34\n','unfinished line 34\n'];
  const staged=spring?['fixture line 21','staged line 21']:['owned line 21\n','staged line 21\n'];
  const unrelated=spring?['fixture line 44','release line 44']:['owned line 2\n','release line 2\nextra release line\n'];
  const otherSource=Array.from({length:25},(_,index)=>'secondary line '+(index+1)).join('\n')+'\n';
  const otherEdit=['secondary line 8\n','selected second line 8\n'];
  const write=(root,item,content)=>fs.writeFile(filename(root,item),eol(content));
  await fs.mkdir(origin);
  await git(origin,'init','-q','--template=','--initial-branch=main');
  await git(origin,'config','core.autocrlf',crlf?'true':'false');
  await write(origin,name,text);await write(origin,other,otherSource);
  await git(origin,'add','--',name,other);
  await git(origin,'commit','-qm','owned shelf starting point');
  await git(origin,'branch','release');await git(origin,'branch','collision');
  await git(origin,'worktree','add','-q',target,'release');
  await git(origin,'worktree','add','-q',conflict,'collision');
  await write(target,name,text.replace(...unrelated));
  await git(target,'add','--',name);await git(target,'commit','-qm','unrelated release change');
  await write(conflict,name,text.replace(selected[0],spring?'return 9;':'conflict line 8\n'));
  await git(conflict,'add','--',name);await git(conflict,'commit','-qm','conflicting committed edit');
  const indexText=text.replace(...staged);
  await write(origin,name,indexText);await git(origin,'add','--',name);
  await write(origin,name,indexText.replace(...selected).replace(...untouched));
  await write(origin,other,otherSource.replace(...otherEdit));
  await fs.writeFile(filename(origin,'untracked.txt'),'owned scratch\n');
  async function identity(root) {
    const observed=await inspectWorktree(root,outer);
    return {...observed.current,key:observed.id,group:observed.group};
  }
  async function indexBytes(root) {
    const file=(await git(root,'rev-parse','--path-format=absolute','--git-path','index')).trim();
    return fs.readFile(file);
  }
  return {outer,origin,target,conflict,name,other,filename,text,eol,selected,untouched,staged,unrelated,
    indexText,otherSource,otherEdit,identity,indexBytes};
}

const runShelfSpring=options=>runJavaFixture({...options,jdbcPrefix:'RB_GIT_SHELF'});

module.exports={createShelfFixture,git,springJdbcClasspath,runShelfSpring};
