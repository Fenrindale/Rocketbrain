'use strict';

const { parseArgs }=require('node:util');
const { approveWorkspace,workspaceTools }=require('../src/mcp/workspace-tools');
const { stdioServer }=require('../src/mcp/stdio-server');
const { version }=require('../package.json');

const usage=`Usage: node ide-mcp-server.js --workspace ABSOLUTE_DIRECTORY --allow-tool TOOL [--allow-tool TOOL ...]

Read-only local MCP server over standard input and output. Available tools:
  project_inventory    Count source files and list known build files.
  java_quality         Inspect saved Git revisions with the owned Java gate.
  sql_structure        Analyze inline SQL without a database connection.
`;

async function main() {
  let values;
  try { ({values}=parseArgs({strict:true,allowPositionals:false,options:{workspace:{type:'string'},
    'allow-tool':{type:'string',multiple:true},help:{type:'boolean',short:'h'}}})); }
  catch { throw Error('Use --workspace and --allow-tool to start Rocketbrain MCP.'); }
  if (values.help) { process.stderr.write(usage);return; }
  const root=await approveWorkspace(values.workspace).catch(()=>{throw Error('Set --workspace to an existing absolute local directory.');});
  const registry=workspaceTools(root,values['allow-tool'] ?? []);
  await stdioServer(process.stdin,process.stdout,registry,{version});
}

main().catch(error=>{process.stderr.write('Rocketbrain MCP: '+error.message+'\n');process.exitCode=2;});
