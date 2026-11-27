import { DisposableStore } from '../../base/common/lifecycle.js';
import { MenuId, MenuRegistry } from '../../platform/actions/common/actions.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../common/contributions.js';
import { IViewDescriptorService, ViewContainerLocation } from '../common/views.js';
import { IExtensionService } from '../services/extensions/common/extensions.js';
import { IWorkbenchLayoutService, Parts, Position } from '../services/layout/browser/layoutService.js';
import { IViewsService } from '../services/views/common/viewsService.js';

// BEGIN ROCKETBRAIN WORKBENCH
type WorkspaceMode = 'java' | 'database';

interface WorkbenchAction {
	label: string;
	icon: string;
	command?: string;
	enabled?: () => boolean;
	run?: () => void | Promise<unknown>;
	button?: HTMLButtonElement;
	primary?: boolean;
	compact?: boolean;
}

const shellStyles = ''; // ROCKETBRAIN WORKBENCH CSS
const modeKey = 'rocketbrain.workspaceMode';
const projectContainer = 'workbench.view.extension.rocketbrain';
const filesContainer = 'workbench.view.explorer';
const debugContainer = 'workbench.view.debug';
const resultsContainer = 'workbench.view.extension.rocketbrain-query-panel';
const stateKeys = new Set([
	modeKey, 'isWorkspaceTrusted', 'workspaceFolderCount', 'inDebugMode',
	'rocketbrain.sqlToolbarRunnable', 'rocketbrain.sqlToolbarPendingTransaction',
]);

MenuRegistry.appendMenuItems([
	{ id: MenuId.MenubarFileMenu, item: { group: '5_autosave', order: 5, command: { id: 'rocketbrain.java.setup', title: 'Java Setup…' } } },
	{ id: MenuId.MenubarHelpMenu, item: { group: '6_updates', order: 1, command: { id: 'rocketbrain.desktop.checkForUpdates', title: 'Check for Rocketbrain Updates…' } } }
]);

class RocketbrainWorkbench {
	private readonly disposables = new DisposableStore();
	private readonly root: HTMLElement;
	private readonly titleBar: HTMLElement | undefined;
	private readonly editorPart: HTMLElement | undefined;
	private readonly commonActions: WorkbenchAction[];
	private readonly javaActions: WorkbenchAction[];
	private readonly databaseActions: WorkbenchAction[];
	private readonly javaMode: HTMLButtonElement;
	private readonly databaseMode: HTMLButtonElement;
	private readonly javaDock: HTMLElement;
	private readonly databaseDock: HTMLElement;
	private readonly javaNavigation: HTMLElement;
	private readonly databaseNavigation: HTMLElement;
	private readonly javaHome: HTMLElement;
	private readonly databaseHome: HTMLElement;
	private appliedMode: WorkspaceMode | undefined;
	private pending = Promise.resolve();
	private disposed = false;

	constructor(
		@IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService private readonly context: IContextKeyService,
		@IViewDescriptorService private readonly descriptors: IViewDescriptorService,
		@IViewsService private readonly views: IViewsService,
		@IExtensionService private readonly extensions: IExtensionService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		this.root = layout.mainContainer;
		const window = this.root.ownerDocument.defaultView!;
		this.titleBar = layout.getContainer(window, Parts.TITLEBAR_PART)?.querySelector<HTMLElement>('.titlebar-container') ?? undefined;
		this.editorPart = layout.getContainer(window, Parts.EDITOR_PART);
		const statusBar = layout.getContainer(window, Parts.STATUSBAR_PART);

		const trusted = () => this.context.getContextKeyValue('isWorkspaceTrusted') === true;
		const project = () => trusted() && Number(this.context.getContextKeyValue('workspaceFolderCount')) > 0;
		const activeDebug = () => this.context.getContextKeyValue('inDebugMode') === true;
		const transaction = () => trusted() && this.context.getContextKeyValue('rocketbrain.sqlToolbarPendingTransaction') === true;

		this.javaActions = [
			{ label: 'Build', icon: 'tools', command: 'rocketbrain.java.workbench.build', enabled: project },
			{ label: 'Run Java', icon: 'play', run: () => this.launchJava(false), enabled: project, primary: true },
			{ label: 'Debug Java', icon: 'debug-alt', run: () => this.launchJava(true), enabled: project },
			{ label: 'Stop', icon: 'debug-stop', command: 'rocketbrain.java.workbench.stop', enabled: activeDebug, compact: true },
			{ label: 'Test', icon: 'beaker', command: 'rocketbrain.java.testing.discover', enabled: project },
			{ label: 'Java Setup', icon: 'gear', command: 'rocketbrain.java.setup' },
		];

		this.databaseActions = [
			{ label: 'New Connection', icon: 'plug', command: 'rocketbrain.connections.add', enabled: trusted },
			{ label: 'Open SQL Console', icon: 'terminal', command: 'rocketbrain.openConsole' },
			{ label: 'Run SQL', icon: 'play', command: 'rocketbrain.runQuery', enabled: () => trusted() && this.context.getContextKeyValue('rocketbrain.sqlToolbarRunnable') === true, primary: true },
			{ label: 'Commit', icon: 'check', command: 'rocketbrain.commit', enabled: transaction, compact: true },
			{ label: 'Rollback', icon: 'discard', command: 'rocketbrain.rollback', enabled: transaction, compact: true },
		];

		this.commonActions = [
			{ label: 'Find File', icon: 'search', command: 'workbench.action.quickOpen', compact: true },
			{ label: 'Settings', icon: 'settings-gear', command: 'workbench.action.openSettings', compact: true },
			{ label: 'Check for Updates', icon: 'cloud-download', command: 'rocketbrain.desktop.checkForUpdates', compact: true },
		];

		const header = this.element('div', 'rb-workbench-header');
		const modes = this.group('Workspace mode', 'rb-workbench-modes');
		this.javaMode = this.button({ label: 'Java Mode', icon: 'symbol-class', run: () => this.switchMode('java') });
		this.databaseMode = this.button({ label: 'Database Mode', icon: 'database', run: () => this.switchMode('database') });
		for (const [button, label] of [[this.javaMode, 'Java'], [this.databaseMode, 'Database']] as const) {
			button.lastElementChild!.textContent = label;
			modes.append(button);
		}

		this.javaNavigation = this.group('Java actions', 'rb-workbench-actions');
		this.javaNavigation.append(...this.javaActions.map(action => this.button(action)));
		this.databaseNavigation = this.group('Database actions', 'rb-workbench-actions');
		this.databaseNavigation.append(...this.databaseActions.map(action => this.button(action)));
		const utilities = this.group('Workspace utilities', 'rb-workbench-utilities');
		utilities.append(...this.commonActions.map(action => this.button(action)));
		header.append(modes, this.javaNavigation, this.databaseNavigation, utilities);

		this.javaDock = this.group('Java tool windows', 'rb-workbench-dock');
		this.javaDock.append(...[
			{ label: 'Project', icon: 'files', run: () => this.toggleContainer(projectContainer, Parts.SIDEBAR_PART) },
			{ label: 'Run', icon: 'play', run: () => this.toggleView('workbench.panel.repl.view', Parts.PANEL_PART) },
			{ label: 'Debug', icon: 'debug-alt', run: () => this.toggleContainer(debugContainer, Parts.PANEL_PART) },
			{ label: 'Problems', icon: 'warning', run: () => this.toggleView('workbench.panel.markers.view', Parts.PANEL_PART) },
			{ label: 'Terminal', icon: 'terminal', command: 'workbench.action.terminal.toggleTerminal' },
			{ label: 'Structure', icon: 'symbol-method', run: () => this.toggleView('outline', Parts.AUXILIARYBAR_PART) },
		].map(action => this.button(action)));

		this.databaseDock = this.group('Database tool windows', 'rb-workbench-dock');
		this.databaseDock.append(...[
			{ label: 'Database Explorer', icon: 'database', command: 'rocketbrain.databases.focus' },
			{ label: 'Query Results', icon: 'table', run: () => this.toggleContainer(resultsContainer, Parts.PANEL_PART) },
			{ label: 'Files', icon: 'folder', run: () => this.toggleContainer(filesContainer, Parts.AUXILIARYBAR_PART) },
		].map(action => this.button(action)));

		const home = this.element('section', 'rb-workbench-home');
		home.setAttribute('aria-label', 'Workspace actions');
		this.javaHome = this.launcher('Java workspace', [
			{ label: 'Open Project', icon: 'folder-opened', command: 'workbench.action.files.openFolder', primary: true },
			{ label: 'Open Recent', icon: 'history', command: 'workbench.action.openRecent' },
			{ label: 'Java Setup', icon: 'gear', command: 'rocketbrain.java.setup' },
		]);
		this.databaseHome = this.launcher('Database workspace', [
			{ label: 'Open SQL Console', icon: 'terminal', command: 'rocketbrain.openConsole', primary: true },
			{ label: 'New Connection', icon: 'plug', command: 'rocketbrain.connections.add', enabled: trusted },
			{ label: 'Open SQL Folder', icon: 'folder-opened', command: 'workbench.action.files.openFolder' },
		]);
		home.append(this.javaHome, this.databaseHome);

		const style = this.element('style', 'rb-workbench-style');
		style.textContent = shellStyles;
		this.root.append(style);
		const titleLeft = this.titleBar?.querySelector('.titlebar-left');
		const wordmark = this.element('span', 'rb-workbench-wordmark');
		wordmark.textContent = 'Rocketbrain';
		titleLeft?.prepend(wordmark);
		this.titleBar?.append(header);
		statusBar?.querySelector('.left-items')?.prepend(this.javaDock, this.databaseDock);
		this.editorPart?.append(home);
		this.root.classList.toggle('rb-workbench', this.titleBar !== undefined);
		this.disposables.add({ dispose: () => {
			this.disposed = true;
			this.root.classList.remove('rb-workbench');
			for (const element of [style, header, wordmark, home, this.javaDock, this.databaseDock]) {
				element.remove();
			}
		} });

		this.updateActions();
		this.disposables.add(this.context.onDidChangeContext(event => {
			if (event.affectsSome(stateKeys)) {
				this.updateActions();
				this.scheduleLayout();
			}
		}));
		this.scheduleLayout();
	}

	private element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
		const element = this.root.ownerDocument.createElement(tag);
		element.className = className;
		return element;
	}

	private group(label: string, className: string): HTMLDivElement {
		const group = this.element('div', className);
		group.setAttribute('role', 'group');
		group.setAttribute('aria-label', label);
		return group;
	}

	private button(action: WorkbenchAction): HTMLButtonElement {
		const button = this.element('button', 'rb-workbench-button');
		const icon = this.element('span', 'codicon codicon-' + action.icon);
		const text = this.element('span', 'rb-workbench-label');
		icon.setAttribute('aria-hidden', 'true');
		text.textContent = action.label;
		button.type = 'button';
		button.title = action.label;
		button.setAttribute('aria-label', action.label);
		button.classList.toggle('rb-workbench-primary', action.primary === true);
		button.classList.toggle('rb-workbench-compact', action.compact === true);
		button.disabled = action.enabled?.() === false;
		button.append(icon, text);
		const click = () => {
			void Promise.resolve().then(() => action.command ?
				this.commands.executeCommand(action.command) : action.run?.()).catch(error => this.notifications.error(error));
		};
		button.addEventListener('click', click);
		this.disposables.add({ dispose: () => button.removeEventListener('click', click) });
		action.button = button;
		return button;
	}

	private launcher(label: string, actions: WorkbenchAction[]): HTMLElement {
		const launcher = this.element('div', 'rb-workbench-launcher');
		const heading = this.element('h1', 'rb-workbench-launcher-title');
		heading.textContent = label;
		const links = this.group(label + ' shortcuts', 'rb-workbench-launcher-actions');
		links.append(...actions.map(action => this.button(action)));
		launcher.append(heading, links);
		return launcher;
	}

	private currentMode(): WorkspaceMode {
		return this.context.getContextKeyValue(modeKey) === 'datagrip' ? 'database' : 'java';
	}

	private updateActions(): void {
		const database = this.currentMode() === 'database';
		this.root.dataset.rocketbrainMode = database ? 'database' : 'java';
		this.javaMode.setAttribute('aria-pressed', String(!database));
		this.databaseMode.setAttribute('aria-pressed', String(database));
		for (const element of [this.javaNavigation, this.javaDock, this.javaHome]) {
			element.hidden = database;
		}
		for (const element of [this.databaseNavigation, this.databaseDock, this.databaseHome]) {
			element.hidden = !database;
		}
		for (const action of [...this.commonActions, ...this.javaActions, ...this.databaseActions]) {
			action.button!.disabled = action.enabled?.() === false;
		}
	}

	private async switchMode(mode: WorkspaceMode): Promise<void> {
		await this.commands.executeCommand(mode === 'database' ? 'rocketbrain.mode.datagrip' : 'rocketbrain.mode.intellij');
		this.scheduleLayout();
	}

	private scheduleLayout(): void {
		this.pending = this.pending.then(async () => {
			await this.extensions.whenInstalledExtensionsRegistered();
			const mode = this.currentMode();
			if (this.disposed || this.appliedMode === mode) {
				return;
			}
			await this.arrange(mode);
			this.appliedMode = mode;
		}).catch(error => this.notifications.error(error));
	}

	private moveContainer(id: string, location: ViewContainerLocation): void {
		const container = this.descriptors.getViewContainerById(id);
		if (container && this.descriptors.getViewContainerLocation(container) !== location) {
			this.descriptors.moveViewContainerToLocation(container, location, undefined, 'rocketbrain-workbench');
		}
	}

	private async arrange(mode: WorkspaceMode): Promise<void> {
		const database = mode === 'database';
		this.layout.setPartHidden(true, Parts.ACTIVITYBAR_PART);
		this.layout.setPanelPosition(Position.BOTTOM);
		this.moveContainer(projectContainer, ViewContainerLocation.Sidebar);
		this.moveContainer(filesContainer, database ? ViewContainerLocation.AuxiliaryBar : ViewContainerLocation.Sidebar);
		this.moveContainer(debugContainer, ViewContainerLocation.Panel);
		this.moveContainer(resultsContainer, ViewContainerLocation.Panel);

		const currentOutline = this.descriptors.getViewDescriptorById('outline');
		if (currentOutline && this.descriptors.getViewLocationById(currentOutline.id) !== ViewContainerLocation.AuxiliaryBar) {
			this.descriptors.moveViewToLocation(currentOutline, ViewContainerLocation.AuxiliaryBar, 'rocketbrain-workbench');
		}

		await this.views.openViewContainer(projectContainer);
		if (database) {
			await this.views.openViewContainer(filesContainer);
			await this.views.openViewContainer(resultsContainer);
		} else {
			if (this.views.isViewContainerVisible(resultsContainer)) {
				this.layout.setPartHidden(true, Parts.PANEL_PART);
			}
			if (this.titleBar && this.layout.getSize(Parts.EDITOR_PART).width >= 400) {
				await this.views.openView('outline');
			}
		}
	}

	private async toggleContainer(id: string, part: Parts.SIDEBAR_PART | Parts.AUXILIARYBAR_PART | Parts.PANEL_PART): Promise<void> {
		if (this.views.isViewContainerVisible(id)) {
			this.layout.setPartHidden(true, part);
		} else {
			await this.views.openViewContainer(id, true);
		}
	}

	private async toggleView(id: string, part: Parts.AUXILIARYBAR_PART | Parts.PANEL_PART): Promise<void> {
		if (this.views.isViewVisible(id)) {
			this.layout.setPartHidden(true, part);
		} else {
			await this.views.openView(id, true);
		}
	}

	private async launchJava(debug: boolean): Promise<void> {
		if (debug) {
			await this.views.openViewContainer(debugContainer);
		} else {
			await this.views.openView('workbench.panel.repl.view');
		}
		await this.commands.executeCommand(debug ? 'rocketbrain.java.workbench.debug' : 'rocketbrain.java.workbench.run');
	}

	dispose(): void {
		this.disposables.dispose();
	}
}

registerWorkbenchContribution2('rocketbrain.desktop.workbench', RocketbrainWorkbench, WorkbenchPhase.AfterRestored);
// END ROCKETBRAIN WORKBENCH
