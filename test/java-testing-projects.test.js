'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{pathToFileURL}=require('node:url');
const {resolveTestingProjects}=require('../src/java/testing-projects');
function fixture(jars){
 const root=path.resolve('test/fixtures/spring-boot-app'),uri=file=>({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});
 const vscode={workspace:{isTrusted:true,workspaceFolders:[{uri:uri(root)}],getConfiguration:()=>({get:(key,fallback)=>key==='javaHome'?root:fallback}),findFiles:async()=>[uri(path.join(root,'src/test/java/fixture/boot/RocketbrainSpringTest.java'))]}};
 const java={requestWorkspaceCommand:async command=>command==='java.project.getClasspaths'?{projectRoot:root,classpaths:[path.join(root,'build/classes/java/main'),path.join(root,'build/classes/java/test'),...jars.map(file=>path.join(root,file))]}:{'org.eclipse.jdt.ls.core.vm.location':root}};
 return {root,vscode,java,context:{globalStorageUri:uri(root)}};
}
test('automatic test profiles separate imported JUnit and TestNG frameworks',async()=>{
 const h=fixture(['junit-jupiter-api-6.0.3.jar','testng-7.11.0.jar']);const projects=await resolveTestingProjects(h.context,h.vscode,h.java);
 assert.deepEqual(projects.map(p=>p.framework),['junit','testng']);assert.notEqual(projects[0].id,projects[1].id);assert.equal(projects[0].workspace,projects[1].workspace);
 const only=fixture(['testng-7.11.0.jar']);assert.deepEqual((await resolveTestingProjects(only.context,only.vscode,only.java)).map(p=>p.framework),['testng']);
});
test('explicit test framework profiles reject unsupported runners',async()=>{
 const h=fixture([]);await assert.rejects(resolveTestingProjects(h.context,h.vscode,h.java,[{workspace:h.root,classPath:[h.root],framework:'invented'}]),/junit or testng/);
 const projects=await resolveTestingProjects(h.context,h.vscode,h.java,[{workspace:h.root,classPath:[h.root],framework:'testng'}]);assert.equal(projects[0].framework,'testng');
});
