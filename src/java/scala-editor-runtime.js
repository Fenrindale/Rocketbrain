'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { independentJavaExecutable } = require('./debug-runtime');
const { allocatePort } = require('./testing-debug');
const { workspacePath, fail } = require('./workbench-model');

const version = '1.6.9';
const artifactName = 'metals_2.13-'+version+'.jar';
const artifactSha256 = 'a38a26249d81dfb26222a2b93a5546750dd27b826f04e0f2724af3d7cc842a55';

async function readRuntime(classpathFile) {
  if (!path.isAbsolute(classpathFile || '')) throw fail('Configure an absolute Scala language runtime classpath file.');
  const file = await fs.realpath(classpathFile);
  const folder = path.dirname(file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 128*1024 || path.relative(file,classpathFile)) throw fail('Choose a physical bounded Scala runtime classpath.');
  const raw = (await fs.readFile(file,'utf8')).trim();
  if (!raw || /[\u0000\r\n]/u.test(raw)) throw fail('The Scala runtime classpath must contain one line.');
  const entries = raw.split(path.delimiter);
  if (entries.length < 4 || entries.length > 512 || new Set(entries).size !== entries.length) {
    throw fail('The Scala runtime classpath must contain bounded distinct library paths.');
  }
  for (const item of entries) {
    if (!path.isAbsolute(item) || !item.endsWith('.jar')) throw fail('Use absolute Scala runtime library JAR paths.');
    workspacePath(item,[folder],{directory:false});
  }
  const metals = entries.filter(item => path.basename(item) === artifactName);
  if (metals.length !== 1 || (await fs.stat(metals[0])).size > 32*1024*1024 ||
      createHash('sha256').update(await fs.readFile(metals[0])).digest('hex')!==artifactSha256) {
    throw fail('The Scala language server must be the supported Metals '+version+' library.');
  }
  return {folder,entries};
}

async function scalaEditorLaunch({root,javaHome,classpathFile,sbtCacheDirectory}) {
  const runtime = await readRuntime(classpathFile);
  const command = independentJavaExecutable(javaHome && path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const bin = path.dirname(command);
  const port = await allocatePort();
  const classpath = runtime.entries.join(path.delimiter);
  if (process.platform==='win32' && classpath.length+command.length>32000) {
    throw fail('Provision the Scala runtime in a shorter local path for the Windows Java launcher.');
  }
  let cache = path.join(runtime.folder,'cache');
  if (sbtCacheDirectory) {
    if (!path.isAbsolute(sbtCacheDirectory)) throw fail('Configure an absolute sbt cache directory.');
    const existing=await fs.realpath(sbtCacheDirectory);
    cache=path.join(existing,'coursier');
  }
  const env = {...process.env,JAVA_HOME:path.dirname(bin),COURSIER_CACHE:cache,COURSIER_REPOSITORIES:'https://repo.maven.apache.org/maven2'};
  for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','JAVA_OPTS','SBT_OPTS','METALS_OPTS']) delete env[key];
  const args = ['-XX:ActiveProcessorCount=4','-Dfile.encoding=UTF-8','-Dmetals.status-bar=off','-Dmetals.http=off',
    '-Dmetals.bloop-port='+port,'-classpath',classpath,'scala.meta.metals.Main'];
  return {command,args,options:{cwd:root,env,windowsHide:true},port,root,version};
}

function configureScalaTransport(transports,onError) {
  const configuration={metals:{autoImportBuilds:'off',targetBuildTool:'sbt',defaultBspToBuildTool:false,startMcpServer:false}};
  const {reader,writer}=transports;
  return {...transports,reader:{
    onError:reader.onError,onClose:reader.onClose,onPartialMessage:reader.onPartialMessage,
    dispose:()=>reader.dispose(),
    listen(listener) {
      return reader.listen(message => {
        // Metals requests these settings while initialize is outstanding.
        // The client registers its normal configuration handler after that response.
        if (message.method!=='workspace/configuration'||!Object.hasOwn(message,'id')) return listener(message);
        const items=message.params?.items ?? [];
        const result=items.map(item=>item.section ? item.section.split('.')
          .reduce((section,key)=>section&&Object.hasOwn(section,key)?section[key]:null,configuration) : configuration);
        void writer.write({jsonrpc:'2.0',id:message.id,result}).catch(onError);
      });
    }
  }};
}

module.exports = { scalaEditorLaunch, configureScalaTransport, version };
