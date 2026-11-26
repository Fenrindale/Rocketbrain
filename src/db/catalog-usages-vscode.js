'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeRequest, observeRoutineUsages } = require('./catalog-routine-usages');

function registerCatalogUsages(vscode, { inspect, check, currentFrame, captureFileUsages, openRoutine }) {
  const reports = new Map();

  async function capture(request, frame = currentFrame(), token) {
    const assertActive = () => {
      check(frame);
      if (token?.isCancellationRequested) throw new vscode.CancellationError();
    };
    assertActive();
    const scope = normalizeRequest(request);
    const { value: routines } = await inspect((query, context) => observeRoutineUsages(query, context, scope), frame, assertActive);
    const files = request.includeFiles ? await captureFileUsages(
      { kind: 'table', database: scope.target.schema, table: scope.target.name }, token,
      { scope: { roots: request.fileRoots, javaRoots: [] } }
    ) : null;
    assertActive();
    const reportId = randomUUID();
    while (reports.size >= 4) reports.delete(reports.keys().next().value);
    const report = { reportId, target: scope.target, schemas: scope.schemas, routines, files: files?.report ?? null, executedSql: false };
    reports.set(reportId, { frame, report, openFile: files?.open });
    return structuredClone(report);
  }

  async function open(reportId, group, index) {
    const captured = reports.get(reportId);
    if (!captured) throw Error('The catalog usage review expired. Find usages again.');
    check(captured.frame);
    if (!Number.isInteger(index) || index < 0) throw Error('Choose a location from the current catalog usage report.');
    if (group === 'file' && captured.openFile) {
      const destination = await captured.openFile(index);
      check(captured.frame);
      return destination;
    }
    const hit = group === 'procedure' && captured.report.routines.hits[index];
    if (!hit) throw Error('Choose a location from the current catalog usage report.');
    return openRoutine(hit, captured.frame);
  }

  async function browse(request, frame) {
    const report = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: 'Finding catalog usages', cancellable: true
    }, (_progress, token) => capture(request, frame, token));
    const target = report.target.schema + '.' + report.target.name;
    const routines = report.routines, files = report.files;
    const choices = [
      ...routines.hits.map((hit, index) => ({ label: hit.object.schema + '.' + hit.object.name,
        description: 'Procedure reference', detail: 'Source offset ' + hit.start, group: 'procedure', index })),
      ...(files?.references.map((hit, index) => {
        const resource = vscode.Uri.parse(hit.uri);
        return { label: vscode.workspace.asRelativePath(resource), description: 'SQL source · line ' + (hit.range.start.line + 1), group: 'file', index };
      }) ?? [])
    ];
    const displayed = choices.length, hidden = routines.opaque.length;
    const unknownFiles = files?.coverage.unknownFiles.length ?? 0;
    const detail = [routines.note, hidden ? hidden + ' procedure definitions were withheld, too large or outside the parser subset.' : '',
      unknownFiles ? unknownFiles + ' local SQL files had unresolved coverage.' : '',
      files?.truncated ? 'The displayed SQL file locations reached their limit.' : ''].filter(Boolean).join(' ');
    choices.push({ label: 'Review search coverage', description: hidden + ' unverified procedures · ' + unknownFiles + ' unverified files' });
    const chosen = await vscode.window.showQuickPick(choices, { title: 'Usages of ' + target + ' · ' + displayed + ' locations' });
    check(frame);
    if (chosen?.group) await open(report.reportId, chosen.group, chosen.index);
    else if (chosen) await vscode.window.showInformationMessage(detail);
    return report;
  }

  return { capture, open, browse, clear: () => reports.clear() };
}

module.exports = { registerCatalogUsages };
