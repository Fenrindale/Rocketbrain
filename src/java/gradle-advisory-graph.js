'use strict';

const { maxTreeBytes } = require('./dependency-advisories');

const format='RocketbrainGradleAdvisoryGraph-v1';
const task='rocketbrainResolveDependencyAdvisories';
const scopes=['compileClasspath','runtimeClasspath','testRuntimeClasspath'];
const maxNodes=3000,maxEdges=12000,maxDepth=48,maxPaths=25000;
const coordinate=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;
const version=/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,120}$/;
const label=/^[^\u0000-\u001f\u007f]{1,180}$/;

const gradleInit = `import groovy.json.JsonOutput
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.api.artifacts.result.ResolvedDependencyResult

gradle.projectsEvaluated {
    def home = gradle.startParameter.currentDir.canonicalFile
    def target = gradle.rootProject.allprojects.find { it.projectDir.canonicalFile == home }
    if (target == null) return
    target.tasks.register('${task}') {
        doLast {
            def scope = System.getProperty('rocketbrain.advisories.configuration')
            def configuration = target.configurations.findByName(scope)
            if (configuration == null || !configuration.canBeResolved) {
                throw new GradleException('The selected Java classpath is unavailable.')
            }
            def resolution = configuration.incoming.resolutionResult
            def nodes = []
            def known = [:]
            int unresolved = 0
            int edges = 0
            def visit
            visit = { component, variant, depth ->
                def identifier = component.id
                def key = [identifier, variant]
                if (known.containsKey(key)) return known[key]
                if (depth > ${maxDepth} || nodes.size() >= ${maxNodes}) {
                    throw new GradleException('The Gradle dependency graph exceeds the reporting limit.')
                }
                def item = [children: []]
                if (identifier instanceof ModuleComponentIdentifier) {
                    item.putAll([kind:'module', group:identifier.group, artifact:identifier.module, version:identifier.version])
                } else if (identifier instanceof ProjectComponentIdentifier) {
                    item.putAll([kind:'project', label:'project ' + identifier.projectPath])
                } else {
                    item.putAll([kind:'unidentified', label:'unidentified component'])
                }
                int index = nodes.size()
                nodes.add(item)
                known[key] = index
                component.getDependenciesForVariant(variant).each { dependency ->
                    if (!dependency.constraint) {
                        if (++edges > ${maxEdges}) throw new GradleException('Too many Gradle dependency edges.')
                        if (dependency instanceof ResolvedDependencyResult) {
                            item.children.add(visit(dependency.selected, dependency.resolvedVariant, depth + 1))
                        } else {
                            unresolved++
                        }
                    }
                }
                return index
            }
            visit(resolution.rootComponent.get(), resolution.rootVariant.get(), 0)
            def data = [format:'${format}', project:[name:target.name, version:target.version.toString()],
                configuration:scope, unresolved:unresolved, nodes:nodes]
            def output = new File(System.getProperty('rocketbrain.workbench.output'))
            output.setText(JsonOutput.toJson(data), 'UTF-8')
        }
    }
}
`;

function parseGradleAdvisoryGraph(text,configuration) {
  if (typeof text!=='string'||Buffer.byteLength(text)>maxTreeBytes) throw Error('Use a bounded Gradle dependency graph.');
  let data;
  try { data=JSON.parse(text); } catch { throw Error('Gradle dependency metadata is invalid JSON.'); }
  const {project,nodes,unresolved}=data||{};
  const valid=(regex,value)=>typeof value==='string'&&regex.test(value);
  if (data?.format!==format||data.configuration!==configuration||!scopes.includes(configuration)||
      !valid(label,project?.name)||!valid(label,project.version)||!Number.isInteger(unresolved)||unresolved<0||
      !Array.isArray(nodes)||!nodes.length||nodes.length>maxNodes||nodes[0]?.kind!=='project') {
    throw Error('The Gradle dependency graph does not match the selected module and configuration.');
  }
  let edges=unresolved;
  for (const node of nodes) {
    if (!Array.isArray(node?.children)||(edges+=node.children.length)>maxEdges||
        node.children.some(index=>!Number.isInteger(index)||index<0||index>=nodes.length)) {
      throw Error('Invalid Gradle dependency edges.');
    }
    if (node.kind==='module') {
      if (!valid(coordinate,node.group)||!valid(coordinate,node.artifact)||!valid(version,node.version)) {
        throw Error('The Gradle graph includes an unsupported external package coordinate.');
      }
    } else if (!['project','unidentified'].includes(node.kind)||!valid(label,node.label)) {
      throw Error('The Gradle graph contains an unsupported component.');
    }
  }
  const packages=new Map();
  const pending=[{index:0,ancestors:[],chain:[]}];
  let visited=0;
  while (pending.length) {
    const {index,ancestors,chain}=pending.pop();
    if (ancestors.includes(index)) continue;
    if (++visited>maxPaths||ancestors.length>maxDepth) throw Error('Gradle dependency paths exceed the reporting bound.');
    const node=nodes[index], name=node.kind==='module'?node.group+':'+node.artifact:null;
    const key=name?name+'@'+node.version:null;
    const next=[...chain,key||node.label];
    if (key) {
      if (!packages.has(key)) packages.set(key,{name,version:node.version,key,direct:false,scopes:[configuration],paths:[]});
      const item=packages.get(key);
      item.direct ||= ancestors.length===1;
      if (item.paths.length<4&&!item.paths.some(old=>old.length===next.length&&old.every((value,i)=>value===next[i]))) item.paths.push(next);
    }
    for(const child of [...new Set(node.children)].reverse()) pending.push({index:child,ancestors:[...ancestors,index],chain:next});
  }
  return {project:{name:project.name,version:project.version},buildTool:'gradle',configuration,
    unresolved,packages:[...packages.values()].sort((a,b)=>a.key.localeCompare(b.key))};
}

module.exports={gradleInit,task,scopes,parseGradleAdvisoryGraph};
