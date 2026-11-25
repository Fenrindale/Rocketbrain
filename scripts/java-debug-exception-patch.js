'use strict';

const EXCEPTION_SOURCE_PATH = 'com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/DebugSession.java';
const EXCEPTION_SOURCE_SHA256 = '3001256f42fd04dd9f9985d331658e478b780335973a7db8f71f39131096c425';

function patchExceptionSession(source) {
  const changes = [
    [
      'import com.sun.jdi.ObjectCollectedException;',
      'import com.sun.jdi.ClassType;\nimport com.sun.jdi.ObjectCollectedException;'
    ], [
      '    public void setExceptionBreakpoints(boolean notifyCaught, boolean notifyUncaught, String[] exceptionTypes,\n' +
      '        String[] classFilters, String[] classExclusionFilters) {',
      '    public synchronized void setExceptionBreakpoints(boolean notifyCaught, boolean notifyUncaught, String[] exceptionTypes,\n' +
      '        String[] classFilters, String[] classExclusionFilters) {'
    ], [
      '                classPrepareRequest.enable();\n                eventRequests.add(classPrepareRequest);',
      '                eventRequests.add(classPrepareRequest);'
    ], [
      '                        && eventRequests.contains(debugEvent.event.request()))\n' +
      '                    .subscribe(debugEvent -> {\n' +
      '                        ClassPrepareEvent event = (ClassPrepareEvent) debugEvent.event;\n' +
      '                        createExceptionBreakpoint(event.referenceType(), notifyCaught, notifyUncaught, classFilters, classExclusionFilters);\n' +
      '                    });',
      [
        '                        && classPrepareRequest.equals(debugEvent.event.request()))',
        '                    .subscribe(debugEvent -> {',
        '                        synchronized (this) {',
        '                            if (eventRequests.contains(classPrepareRequest)) {',
        '                                ClassPrepareEvent event = (ClassPrepareEvent) debugEvent.event;',
        '                                createExceptionBreakpoint(event.referenceType(), notifyCaught, notifyUncaught, classFilters, classExclusionFilters);',
        '                            }',
        '                        }',
        '                    });'
      ].join('\n')
    ], [
      '                subscriptions.add(subscription);\n\n' +
      '                // register exception breakpoint in the loaded classes.\n' +
      '                for (ReferenceType refType : vm.classesByName(exceptionType)) {\n' +
      '                    createExceptionBreakpoint(refType, notifyCaught, notifyUncaught, classFilters, classExclusionFilters);\n' +
      '                }',
      [
        '                subscriptions.add(subscription);',
        '                classPrepareRequest.enable();',
        '                // Reconcile classes already prepared before the request was enabled.',
        '                for (ReferenceType refType : vm.classesByName(exceptionType)) {',
        '                    if (refType.isPrepared()) {',
        '                        createExceptionBreakpoint(refType, notifyCaught, notifyUncaught, classFilters, classExclusionFilters);',
        '                    }',
        '                }'
      ].join('\n')
    ], [
      '    private void createExceptionBreakpoint(ReferenceType refType, boolean notifyCaught, boolean notifyUncaught,\n' +
      '            String[] classFilters, String[] classExclusionFilters) {\n' +
      '        EventRequestManager manager = vm.eventRequestManager();',
      [
        '    private static boolean subclassOrSame(ReferenceType candidate, ReferenceType selected) {',
        '        for (ReferenceType type = candidate; type instanceof ClassType; type = ((ClassType) type).superclass()) {',
        '            if (type.equals(selected)) return true;',
        '        }',
        '        return false;',
        '    }',
        '',
        '    private void createExceptionBreakpoint(ReferenceType refType, boolean notifyCaught, boolean notifyUncaught,',
        '            String[] classFilters, String[] classExclusionFilters) {',
        '        EventRequestManager manager = vm.eventRequestManager();',
        '        List<ExceptionRequest> covered = new ArrayList<>();',
        '        for (ExceptionRequest previous : manager.exceptionRequests()) {',
        '            ReferenceType previousType = previous.exception();',
        '            if (subclassOrSame(refType, previousType)) return;',
        '            if (subclassOrSame(previousType, refType)) covered.add(previous);',
        '        }',
        '        if (!covered.isEmpty()) manager.deleteEventRequests(covered);'
      ].join('\n')
    ]
  ];
  for (const [from, to] of changes) {
    if (source.split(from).length !== 2) throw Error('Unexpected pinned Java DebugSession exception request source.');
    source = source.replace(from, to);
  }
  return source;
}

module.exports = { EXCEPTION_SOURCE_PATH, EXCEPTION_SOURCE_SHA256, patchExceptionSession };
