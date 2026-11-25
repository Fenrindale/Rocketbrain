'use strict';

const { parseArgs }=require('node:util');
const { approveWorkspace,workspaceTools }=require('../src/mcp/workspace-tools');
const { stdioServer }=require('../src/mcp/stdio-server');
const { names:databaseNames,approveDatabaseScope,databaseTools }=require('../src/mcp/database-tools');
const { version }=require('../package.json');

const usage=`Usage: node ide-mcp-server.js --workspace ABSOLUTE_DIRECTORY --allow-tool TOOL [--allow-tool TOOL ...] [--db-scope ABSOLUTE_JSON]

Read-only local MCP server over standard input and output. Available tools:
  project_inventory    Count source files and list known build files.
  java_quality         Inspect saved Git revisions with the owned Java gate.
  sql_structure        Analyze inline SQL without a database connection.
  db_catalog           Read approved MySQL/MariaDB table and column metadata.
  db_sample            Sample typed values in approved MySQL/MariaDB columns.

Database tools require an explicit approval file, a dedicated read-only account,
and ROCKETBRAIN_MCP_DB_PASSWORD supplied in the launch environment.
`;

async function main() {
  let values;
  try { ({values}=parseArgs({strict:true,allowPositionals:false,options:{workspace:{type:'string'},
    'allow-tool':{type:'string',multiple:true},'db-scope':{type:'string'},help:{type:'boolean',short:'h'}}})); }
  catch { throw Error('Use --workspace and --allow-tool to start Rocketbrain MCP.'); }
  if (values.help) { process.stderr.write(usage);return; }
  const root=await approveWorkspace(values.workspace).catch(()=>{throw Error('Set --workspace to an existing absolute local directory.');});
  const selected=values['allow-tool']??[];
  const enableDatabase=selected.some(name=>databaseNames.includes(name));
  const password=process.env.ROCKETBRAIN_MCP_DB_PASSWORD;
  delete process.env.ROCKETBRAIN_MCP_DB_PASSWORD;
  if (values['db-scope']!==undefined&&!enableDatabase) throw Error('Allow a database tool before adding a DB scope.');
  const extra=enableDatabase?databaseTools(await approveDatabaseScope(values['db-scope'],password)):undefined;
  const registry=workspaceTools(root,selected,extra);
  await stdioServer(process.stdin,process.stdout,registry,{version});
}

main().catch(error=>{process.stderr.write('Rocketbrain MCP: '+error.message+'\n');process.exitCode=2;});
