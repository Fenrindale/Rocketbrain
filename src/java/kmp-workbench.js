'use strict';

const { buildSnapshot,kmpSpec } = require('./kmp-gradle');
const { snapshotKmpSources,indexesFor } = require('./kmp-sources');
const { fail,cancelled } = require('./workbench-model');

function current(model) {
  if (JSON.stringify(buildSnapshot(model.root,model.modules))!==JSON.stringify(model.digests)) {
    throw fail('Gradle settings changed after Kotlin inspection. Inspect the project again.');
  }
}

async function runKmpTasks({model,modulePath,targetNames,action,tools,runner,workspaceTrusted,allowProjectExecution,cancellation}) {
  if (workspaceTrusted!==true || allowProjectExecution!==true) throw fail('Explicitly choose the Kotlin Gradle task in a trusted workspace.');
  if (cancelled(cancellation)) throw fail('Kotlin Gradle task cancelled.');
  if (!['compile','test','run'].includes(action) || !Array.isArray(targetNames) || !targetNames.length || targetNames.length>10 ||
      new Set(targetNames).size!==targetNames.length || action==='run' && targetNames.length!==1) {
    throw fail('Choose current Kotlin platform targets for this Gradle task.');
  }
  current(model);
  const module=model.modules.find(item => item.path===modulePath);
  if (!module) throw fail('Choose a Kotlin Multiplatform module reported by Gradle.');
  const selected=targetNames.map(name => module.targets.find(target => target.name===name));
  const tasks=selected.map(target => target?.[action+'Task']);
  if (tasks.some(task => !task)) throw fail('The selected targets have no observed '+action+' task.');
  const before=action==='compile' ? snapshotKmpSources(model,module,targetNames,cancellation) : undefined;
  const spec=await kmpSpec(model.root,tools,[...new Set(tasks)]);
  const result=await runner.execute(spec,{cancellation,timeoutMs:240000});
  const state=result.cancelled || cancelled(cancellation) ? 'cancelled' : result.code===0 ? 'succeeded' : 'failed';
  const receipt={state,modulePath,targets:targetNames,action,tasks,exitCode:result.code,terminationConfirmed:result.terminationConfirmed!==false};
  if (state!=='succeeded' || action!=='compile') return {result:receipt};
  current(model);
  if (before.fingerprint!==snapshotKmpSources(model,module,targetNames,cancellation).fingerprint) {
    throw fail('Kotlin source inputs changed while Gradle compiled. Build again before navigating actual declarations.');
  }
  const index=indexesFor(model,module,targetNames,before);
  return {result:{...receipt,sources:index.files.size,linkedDeclarations:index.links.size},index};
}

module.exports = { runKmpTasks };
