'use strict';

const sites = Object.freeze([
  {name:'Breakpoint.java', entry:'com/microsoft/java/debug/core/Breakpoint.java',
    sha256:'cd9ba1df2fc497b918ef4d0787e0d9a62841f6fe938567527b6bacb1957d384b'},
  {name:'SetBreakpointsRequestHandler.java', entry:'com/microsoft/java/debug/core/adapter/handler/SetBreakpointsRequestHandler.java',
    sha256:'7b6c5a6ba97b5d9db5edd0148d6684d0612dec5abd2c52882cd569908d95cf4c'},
  {name:'StackTraceRequestHandler.java', entry:'com/microsoft/java/debug/core/adapter/handler/StackTraceRequestHandler.java',
    sha256:'671553d0e16f1433e4950b5f3eab3afaf5e9bd5b01bff67434381734df0e7780'}
]);

function replace(source,before,after) {
  if (source.split(before).length!==2) throw Error('Unexpected pinned Java breakpoint source.');
  return source.replace(before,after);
}

function patchKotlinLines(name,source) {
  if (name==='Breakpoint.java') {
    const before='        if (this.sourceLocation.methodName() != null) {\n            locationsFuture = collectLocations(refTypes, this.sourceLocation.methodName(), this.sourceLocation.methodSignature());';
    return replace(source,before,[
      '        if (this.sourceLocation instanceof KotlinLineBreakpoints.Site) {',
      '            locationsFuture = CompletableFuture.completedFuture(((KotlinLineBreakpoints.Site) this.sourceLocation).resolve(refTypes));',
      '        } else '+before.trimStart()
    ].join('\n'));
  }
  if (name==='StackTraceRequestHandler.java') {
    source=replace(source,'import com.microsoft.java.debug.core.IBreakpoint;',
      'import com.microsoft.java.debug.core.IBreakpoint;\nimport com.microsoft.java.debug.core.KotlinLineBreakpoints;');
    source=replace(source,'        Types.Source clientSource = convertDebuggerSourceToClient(jdiFrame.typeName, jdiFrame.sourceName, jdiFrame.sourcePath, context);',[
      '        KotlinLineBreakpoints.Site kotlin = KotlinLineBreakpoints.frame(context, jdiFrame.location);',
      '        Types.Source clientSource = kotlin == null ? convertDebuggerSourceToClient(jdiFrame.typeName, jdiFrame.sourceName, jdiFrame.sourcePath, context)',
      '                : kotlin.clientSource(context);'
    ].join('\n'));
    source=replace(source,'int clientLineNumber = AdapterUtils.convertLineNumber(jdiFrame.lineNumber, context.isDebuggerLinesStartAt1(), context.isClientLinesStartAt1())',
      'int clientLineNumber = AdapterUtils.convertLineNumber(kotlin == null ? jdiFrame.lineNumber : kotlin.lineNumberInSourceFile(), context.isDebuggerLinesStartAt1(), context.isClientLinesStartAt1())');
    return replace(source,'} else if (DebugSettings.getCurrent().debugSupportOnDecompiledSource == Switch.ON',
      '} else if (kotlin == null && DebugSettings.getCurrent().debugSupportOnDecompiledSource == Switch.ON');
  }
  if (name!=='SetBreakpointsRequestHandler.java') throw Error('Unknown Kotlin breakpoint source.');
  source=replace(source,'import com.microsoft.java.debug.core.JavaBreakpointLocation;','import com.microsoft.java.debug.core.JavaBreakpointLocation;\nimport com.microsoft.java.debug.core.KotlinLineBreakpoints;');
  source=replace(source,'this.convertClientBreakpointsToDebugger(sourcePath, bpArguments.breakpoints, context)',
    'this.convertClientBreakpointsToDebugger(sourcePath, bpArguments.breakpoints, context, bpArguments.sourceModified)');
  source=replace(source,'private IBreakpoint[] convertClientBreakpointsToDebugger(String sourceFile, Types.SourceBreakpoint[] sourceBreakpoints, IDebugAdapterContext context)',
    'private IBreakpoint[] convertClientBreakpointsToDebugger(String sourceFile, Types.SourceBreakpoint[] sourceBreakpoints, IDebugAdapterContext context, boolean sourceModified)');
  source=replace(source,'        JavaBreakpointLocation[] locations = sourceProvider.getBreakpointLocations(sourceFile, debugSourceBreakpoints);',[
    '        JavaBreakpointLocation[] locations = KotlinLineBreakpoints.locations(context, sourceFile, sourceBreakpoints, debugSourceBreakpoints, sourceModified);',
    '        if (locations == null) {',
    '            locations = sourceProvider.getBreakpointLocations(sourceFile, debugSourceBreakpoints);',
    '        }'
  ].join('\n'));
  source=replace(source,'            if (DebugSettings.getCurrent().debugSupportOnDecompiledSource == Switch.ON) {',
    '            if (!KotlinLineBreakpoints.managed(locations[i]) && DebugSettings.getCurrent().debugSupportOnDecompiledSource == Switch.ON) {');
  return replace(source,'if (sourceProvider.supportsRealtimeBreakpointVerification() && StringUtils.isNotBlank(locations[i].className()))',
    'if (!KotlinLineBreakpoints.managed(locations[i]) && sourceProvider.supportsRealtimeBreakpointVerification() && StringUtils.isNotBlank(locations[i].className()))');
}

module.exports={kotlinLineSites:sites,patchKotlinLines};
