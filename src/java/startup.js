'use strict';

const jvmLanguages = new Set(['java','kotlin','groovy']);
const projectFiles = '**/{pom.xml,build.gradle,build.gradle.kts,build.sbt,*.java}';
const excluded = '**/{.git,.gradle,node_modules,build,target,out,bin}/**';
const javaSource = document => !document.isClosed && document.uri?.scheme==='file' && jvmLanguages.has(document.languageId);

function registerJavaAutostart(vscode,start,reportError) {
  let closed=false, admitted=false, generation=0;
  const workspace = vscode.workspace;
  function eligible() {
    return !closed && !admitted && workspace.isTrusted;
  }
  function admit() {
    if (!eligible()) return;
    admitted=true;
    void start().catch(reportError);
  }
  async function inspect() {
    if (!eligible()) return;
    const request=++generation;
    if (workspace.textDocuments.some(javaSource)) return admit();
    if (!workspace.workspaceFolders?.length) return;
    const files = await workspace.findFiles(projectFiles,excluded,1);
    if (files.length && generation===request) admit();
  }
  const check = () => { void inspect().catch(error => { if(!closed)reportError(error); }); };
  const subscriptions = [
    workspace.onDidOpenTextDocument(document => { if(javaSource(document))admit(); }),
    workspace.onDidChangeWorkspaceFolders(check),
    workspace.onDidGrantWorkspaceTrust(check)
  ];
  check();
  return {dispose(){
    closed=true;
    for(const subscription of subscriptions)subscription.dispose();
  }};
}

function registerJavaDefinitionStartup(vscode, { start, provider, isAvailable }) {
  return vscode.languages.registerDefinitionProvider({ scheme: 'file', language: 'java' }, {
    async provideDefinition(document, position, token) {
      if (token.isCancellationRequested || !isAvailable() || provider(document)) return;
      const version = document.version;
      try {
        await start();
      } catch {
        // Java startup already publishes the failure and recovery action in its status item.
        return;
      }
      if (token.isCancellationRequested || document.isClosed || document.version !== version || !isAvailable()) return;
      return provider(document)?.provideDefinition(document, position, token);
    }
  });
}

function createDefinitionReadiness(timeout = 30000) {
  const { promise, resolve } = Promise.withResolvers();
  const deadline = Date.now() + timeout;
  let ready = false;
  return {
    complete() { ready = true; resolve(); },
    stop: resolve,
    async wait(token) {
      const remaining = deadline - Date.now();
      if (ready || remaining <= 0 || token.isCancellationRequested) return;
      let timer, subscription;
      try {
        await Promise.race([promise, new Promise(done => {
          timer = setTimeout(done, remaining);
          subscription = token.onCancellationRequested(done);
        })]);
      } finally {
        clearTimeout(timer);
        subscription?.dispose();
      }
    }
  };
}

module.exports = {registerJavaAutostart, registerJavaDefinitionStartup, createDefinitionReadiness};
