import { Codicon } from '../../base/common/codicons.js';
import { MenuId, MenuRegistry } from '../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { ViewContainerLocation } from '../common/views.js';
import { IPaneCompositePartService } from '../services/panecomposite/browser/panecomposite.js';

// Body also applied to the pinned compiled Code OSS distribution.
// BEGIN ROCKETBRAIN WORKBENCH
const modeKey = 'rocketbrain.workspaceMode';
const javaMode = ContextKeyExpr.notEquals(modeKey, 'datagrip');
const databaseMode = ContextKeyExpr.equals(modeKey, 'datagrip');
const trusted = ContextKeyExpr.has('isWorkspaceTrusted');
const trustedProject = ContextKeyExpr.and(trusted, ContextKeyExpr.greater('workspaceFolderCount', 0));
const selectJavaCommand = 'rocketbrain.desktop.workbench.selectJava';

CommandsRegistry.registerCommand(selectJavaCommand, async accessor => {
	const commands = accessor.get(ICommandService);
	const panes = accessor.get(IPaneCompositePartService);
	await commands.executeCommand('rocketbrain.mode.intellij');
	if (panes.getActivePaneComposite(ViewContainerLocation.Panel)?.getId() === 'rocketbrain-query-panel') {
		panes.hideActivePaneComposite(ViewContainerLocation.Panel);
	}
});

MenuRegistry.appendMenuItems([
	{ command: { id: selectJavaCommand, title: 'Java Mode', icon: Codicon.fileCode, toggled: javaMode } },
	{ command: { id: 'rocketbrain.mode.datagrip', title: 'Database Mode', icon: Codicon.database, toggled: databaseMode } },
	{ command: { id: 'rocketbrain.java.workbench.run', title: 'Run Java', icon: Codicon.play, precondition: trustedProject }, when: javaMode },
	{ command: { id: 'rocketbrain.java.workbench.debug', title: 'Debug Java', icon: Codicon.debugAlt, precondition: trustedProject }, when: javaMode },
	{ command: { id: 'rocketbrain.databases.focus', title: 'Database Explorer', icon: Codicon.listTree }, when: databaseMode },
	{ command: { id: 'rocketbrain.openConsole', title: 'Open SQL Console', icon: Codicon.terminal }, when: databaseMode },
	{ command: { id: 'rocketbrain.runQuery', title: 'Run SQL', icon: Codicon.play,
		precondition: ContextKeyExpr.and(trusted, ContextKeyExpr.has('rocketbrain.sqlToolbarRunnable')) }, when: databaseMode },
	{ command: { id: 'rocketbrain.showQueryResults', title: 'Query Results', icon: Codicon.table }, when: databaseMode },
].map((item, order) => ({ id: MenuId.TitleBarAdjacentCenter, item: { ...item, group: '0_rocketbrain', order } })));
// END ROCKETBRAIN WORKBENCH
