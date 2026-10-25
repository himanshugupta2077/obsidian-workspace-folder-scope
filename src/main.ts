import { App, Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFolder, View, debounce, normalizePath, setIcon } from "obsidian";

interface ScopeRule {
	/** Name of a saved workspace (core Workspaces plugin). */
	workspace: string;
	/** Vault path of the folder the explorer is scoped to while that workspace is active. */
	folder: string;
}

interface Settings {
	rules: ScopeRule[];
	/** Vault paths of files and folders never shown in the file explorer, in any workspace. */
	hidden: string[];
	/** On mobile, stop Workspaces Plus auto-saving this device's layout into the shared saved workspaces. */
	guardMobileAutoSave: boolean;
}

const DEFAULT_SETTINGS: Settings = {
	rules: [],
	hidden: [],
	guardMobileAutoSave: true,
};

// Undocumented internals this plugin relies on. Everything is feature-checked before use.
interface ExplorerItem {
	el: HTMLElement;
	setCollapsed: (this: ExplorerItem, collapsed: boolean, animate?: boolean) => Promise<void> | void;
}

interface FileExplorerView extends View {
	fileItems?: Record<string, ExplorerItem | undefined>;
	tree?: { infinityScroll?: { invalidateAll(): void } };
}

interface WorkspacesInstance {
	activeWorkspace?: string;
	workspaces?: Record<string, unknown>;
	loadWorkspace?(name: string): void;
	setActiveWorkspace?(name: string): void;
	saveWorkspace?(name: string, ...rest: unknown[]): unknown;
}

interface FileManagerInternals {
	getNewFileParent: (this: FileManagerInternals, sourcePath: string, newFilePath?: string) => TFolder;
	createNewFile: (this: FileManagerInternals, parent?: TFolder | null, ...rest: unknown[]) => Promise<unknown>;
	createNewFolder: (this: FileManagerInternals, parent?: TFolder | null) => Promise<unknown>;
}

// Each folder from the vault root down to the scope folder is a "chain" item: its row is hidden,
// its children are un-indented, and everything beside it is hidden, so the scope folder's
// contents render as if they were the top level of the explorer. Chain folders above the scope
// folder are also "ancestors", whose other children are hidden. Siblings are found from the item
// itself (and the explorer's root list) because Obsidian resets the class of child containers.
const BODY_CLASS = "workspace-folder-scope-active";
const CHAIN_CLASS = "workspace-folder-scope-chain";
const ANCESTOR_CLASS = "workspace-folder-scope-ancestor";
const HIDDEN_CLASS = "workspace-folder-scope-hidden";
const SHOW_HIDDEN_CLASS = "workspace-folder-scope-show-hidden";
const SWITCHER_CLASS = "workspace-folder-scope-switcher";

export default class WorkspaceFolderScopePlugin extends Plugin {
	settings: Settings = DEFAULT_SETTINGS;
	/** Set by the toggle command to show the whole vault until the next toggle or restart. */
	private suspended = false;
	private scope: TFolder | null = null;
	/** Chain items whose `setCollapsed` is wrapped so "Collapse all" can't hide the scope. */
	private pinned = new Set<ExplorerItem>();
	private requestApply = debounce(() => {
		this.apply();
		this.applyHidden();
	}, 100, true);
	/** Set by the toggle command to show hidden items until the next toggle or restart. */
	private showHidden = false;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<Settings> | null);
		this.settings.hidden = [...(this.settings.hidden ?? [])];
		this.addSettingTab(new FolderScopeSettingTab(this.app, this));
		this.patchFileManager();

		this.app.workspace.onLayoutReady(() => this.applyHidden());
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, source) => {
				if (source !== "file-explorer-context-menu" || file.path === "/") return;
				menu.addItem((item) =>
					item
						.setTitle("Hide in file explorer")
						.setIcon("eye-off")
						.setSection("action")
						.onClick(() => void this.setHidden(file.path, true))
				);
			})
		);
		this.addCommand({
			id: "toggle-hidden",
			name: "Toggle hidden files and folders in the file explorer",
			callback: () => {
				this.showHidden = !this.showHidden;
				this.applyHidden();
			},
		});

		this.addCommand({
			id: "toggle",
			name: "Toggle folder scope for this workspace",
			callback: () => {
				this.suspended = !this.suspended;
				this.apply();
			},
		});

		// Mobile has no status bar, so Workspaces Plus offers no visible way to switch there.
		this.addCommand({
			id: "switch-workspace",
			name: "Switch workspace",
			callback: () => this.openSwitcher(),
		});
		if (Platform.isMobile) {
			this.addRibbonIcon("layout-dashboard", "Switch workspace", (evt) => this.openSwitcher(evt));
			this.app.workspace.onLayoutReady(() => this.guardMobileAutoSave());
			this.register(() => document.querySelectorAll(`.${SWITCHER_CLASS}`).forEach((el) => el.remove()));
		}

		this.app.workspace.onLayoutReady(() => this.apply());
		// Loading a workspace sets the active name before swapping the layout, so layout-change sees it.
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refresh()));
		this.registerEvent(this.app.vault.on("create", (file) => (file instanceof TFolder || this.settings.hidden.includes(file.path)) && this.refresh()));
		this.registerEvent(this.app.vault.on("delete", (file) => file instanceof TFolder && this.refresh()));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
	}

	onunload() {
		this.scope = null;
		this.clear();
		document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => el.removeClass(HIDDEN_CLASS));
		document.body.removeClass(SHOW_HIDDEN_CLASS);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.apply();
	}

	/** Applies now, and again once the explorer has finished rebuilding after a layout swap. */
	private refresh() {
		this.renderSwitchers();
		this.apply();
		this.applyHidden();
		this.requestApply();
	}

	private workspacesPlugin(): WorkspacesInstance | null {
		const plugins = (this.app as App & { internalPlugins?: { getEnabledPluginById?(id: string): unknown } })
			.internalPlugins;
		return (plugins?.getEnabledPluginById?.("workspaces") as WorkspacesInstance | null) ?? null;
	}

	private activeWorkspace(): string {
		return this.workspacesPlugin()?.activeWorkspace ?? "";
	}

	/** Lists the saved workspaces (a bottom sheet on mobile) and loads the one picked. */
	openSwitcher(evt?: MouseEvent) {
		const workspaces = this.workspacesPlugin();
		const names = Object.keys(workspaces?.workspaces ?? {});
		if (!workspaces?.loadWorkspace || names.length === 0) {
			new Notice("No saved workspaces. Save one with the core Workspaces plugin first.");
			return;
		}
		const active = this.activeWorkspace();
		const menu = new Menu();
		for (const name of names) {
			const scoped = this.settings.rules.some((r) => r.workspace === name && r.folder.trim());
			menu.addItem((item) =>
				item
					.setTitle(name)
					.setIcon(scoped ? "folder" : "layout-dashboard")
					.setChecked(name === active)
					.onClick(() => void this.switchWorkspace(name))
			);
		}
		if (evt) menu.showAtMouseEvent(evt);
		else menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 3 });
	}

	async switchWorkspace(name: string) {
		const workspaces = this.workspacesPlugin();
		if (!workspaces?.loadWorkspace || name === this.activeWorkspace()) return;
		const saved = workspaces.workspaces?.[name] as { main?: unknown; active?: string } | undefined;
		if (!Platform.isMobile || !saved?.main) {
			workspaces.loadWorkspace(name);
			return;
		}
		// Saved layouts come from the desktop, whose split sidebars don't fit the phone's drawers:
		// loading one whole leaves the drawers empty (no file explorer). Take only its tabs.
		// Copied, because the phone rewrites the layout it is given (e.g. merges tab groups) and the
		// saved workspace would otherwise change with it.
		const layout = this.app.workspace.getLayout();
		await this.app.workspace.changeLayout({ ...layout, main: structuredClone(saved.main), active: saved.active });
		workspaces.setActiveWorkspace?.(name);
		// Workspaces Plus updates its own state (status, remembered mobile workspace) on this event.
		this.app.workspace.trigger("workspace-load", name);
		this.refresh();
	}

	/** On mobile, a bar at the top of each file explorer that names the active workspace and switches it. */
	private renderSwitchers() {
		if (!Platform.isMobile) return;
		const name = this.activeWorkspace() || "No workspace";
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const container = leaf.view.containerEl;
			let bar = container.querySelector<HTMLElement>(`:scope > .${SWITCHER_CLASS}`);
			if (!bar) {
				bar = createDiv({ cls: SWITCHER_CLASS, attr: { role: "button", "aria-label": "Switch workspace" } });
				container.prepend(bar);
				bar.addEventListener("click", (evt) => this.openSwitcher(evt));
			}
			if (bar.dataset.workspace === name) continue;
			bar.dataset.workspace = name;
			bar.empty();
			setIcon(bar.createSpan({ cls: `${SWITCHER_CLASS}-icon` }), "layout-dashboard");
			bar.createSpan({ cls: `${SWITCHER_CLASS}-name`, text: name });
			setIcon(bar.createSpan({ cls: `${SWITCHER_CLASS}-chevron` }), "chevrons-up-down");
		}
	}

	// Saved workspaces sync to every device, so a save on the phone (Workspaces Plus's "auto save
	// on layout change", or its save-before-switch) writes the phone's layout over the desktop's.
	private guardMobileAutoSave() {
		if (!this.settings.guardMobileAutoSave) return;
		const workspaces = this.workspacesPlugin();
		const original = workspaces?.saveWorkspace;
		if (!workspaces || typeof original !== "function") return;
		const guarded = (name: string) => {
			console.debug(`workspace-folder-scope: blocked saving workspace "${name}" on mobile`);
		};
		workspaces.saveWorkspace = guarded;
		this.register(() => {
			if (workspaces.saveWorkspace === guarded) workspaces.saveWorkspace = original;
		});
	}

	private resolveScope(): TFolder | null {
		if (this.suspended) return null;
		const active = this.activeWorkspace();
		const rule = this.settings.rules.find((r) => r.workspace === active && r.folder.trim());
		if (!rule) return null;
		const folder = this.app.vault.getAbstractFileByPath(normalizePath(rule.folder));
		return folder instanceof TFolder && !folder.isRoot() ? folder : null;
	}

	apply() {
		this.clear();
		this.scope = this.resolveScope();
		const scope = this.scope;
		if (!scope) return;

		document.body.addClass(BODY_CLASS);
		const chain: string[] = [];
		for (let f: TFolder | null = scope; f && !f.isRoot(); f = f.parent) chain.unshift(f.path);

		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const view = leaf.view as FileExplorerView;
			for (const path of chain) {
				const item = view.fileItems?.[path];
				if (!item) continue;
				item.el.addClass(CHAIN_CLASS);
				if (path !== scope.path) item.el.addClass(ANCESTOR_CLASS);
				this.pin(item);
			}
			view.tree?.infinityScroll?.invalidateAll();
		}
	}

	private clear() {
		document.body.removeClass(BODY_CLASS);
		document.querySelectorAll(`.${CHAIN_CLASS}`).forEach((el) => el.removeClass(CHAIN_CLASS));
		document.querySelectorAll(`.${ANCESTOR_CLASS}`).forEach((el) => el.removeClass(ANCESTOR_CLASS));
		for (const item of this.pinned) delete (item as Partial<ExplorerItem>).setCollapsed;
		this.pinned.clear();
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			(leaf.view as FileExplorerView).tree?.infinityScroll?.invalidateAll();
		}
	}

	/** Expands a chain folder and keeps it expanded: its row is hidden, so it can't be reopened by hand. */
	private pin(item: ExplorerItem) {
		if (this.pinned.has(item) || typeof item.setCollapsed !== "function") return;
		const original = item.setCollapsed;
		item.setCollapsed = (collapsed, animate) =>
			collapsed ? Promise.resolve() : original.call(item, collapsed, animate);
		this.pinned.add(item);
		void original.call(item, false, false);
	}

	private isInScope(file: TAbstractFile | null | undefined): boolean {
		const scope = this.scope;
		if (!scope || !file) return false;
		return file.path === scope.path || file.path.startsWith(scope.path + "/");
	}

	/** Folder of the active file when it's inside the scope, otherwise the scope folder itself. */
	private currentScopedFolder(): TFolder | null {
		const parent = this.app.workspace.getActiveFile()?.parent;
		return parent && this.isInScope(parent) ? parent : this.scope;
	}

	// While scoped, anything that would be created at the vault root (or, for "new note", in a
	// folder outside the scope) lands in the current folder inside the scope instead, so it never
	// disappears from the explorer. Explicit non-root destinations chosen by other plugins are kept.
	private patchFileManager() {
		const fm = this.app.fileManager as unknown as FileManagerInternals;
		const getNewFileParent = fm.getNewFileParent;
		const createNewFile = fm.createNewFile;
		const createNewFolder = fm.createNewFolder;
		if (typeof getNewFileParent !== "function") return;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the wrappers need the file manager as `this`
		const plugin = this;

		const toScope = (parent: TFolder | null | undefined) =>
			this.scope && (!parent || parent.isRoot()) ? this.currentScopedFolder() : parent;

		fm.getNewFileParent = function (sourcePath, newFilePath) {
			const parent = getNewFileParent.call(this, sourcePath, newFilePath);
			return plugin.scope && !plugin.isInScope(parent) ? (plugin.currentScopedFolder() ?? parent) : parent;
		};
		if (typeof createNewFile === "function") {
			fm.createNewFile = function (parent, ...rest) {
				return createNewFile.call(this, toScope(parent), ...rest);
			};
		}
		if (typeof createNewFolder === "function") {
			fm.createNewFolder = function (parent) {
				return createNewFolder.call(this, toScope(parent));
			};
		}
		this.register(() => {
			fm.getNewFileParent = getNewFileParent;
			if (typeof createNewFile === "function") fm.createNewFile = createNewFile;
			if (typeof createNewFolder === "function") fm.createNewFolder = createNewFolder;
		});
	}

	async setHidden(path: string, hidden: boolean) {
		const rest = this.settings.hidden.filter((p) => p !== path);
		this.settings.hidden = hidden ? [...rest, path] : rest;
		await this.saveData(this.settings);
		this.applyHidden();
	}

	/** Marks each hidden item's explorer row. Re-run whenever the explorer may have rebuilt items. */
	applyHidden() {
		document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => el.removeClass(HIDDEN_CLASS));
		document.body.toggleClass(SHOW_HIDDEN_CLASS, this.showHidden);
		for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
			const view = leaf.view as FileExplorerView;
			for (const path of this.settings.hidden) view.fileItems?.[path]?.el.addClass(HIDDEN_CLASS);
			view.tree?.infinityScroll?.invalidateAll();
		}
	}

	/** Keeps rules pointing at their folder when it (or a parent) is renamed or moved. */
	private onRename(file: TAbstractFile, oldPath: string) {
		const moved = (p: string) => (p === oldPath ? file.path : p.startsWith(oldPath + "/") ? file.path + p.slice(oldPath.length) : p);
		const hidden = this.settings.hidden.map(moved);
		if (hidden.some((p, i) => p !== this.settings.hidden[i])) {
			this.settings.hidden = hidden;
			void this.saveData(this.settings);
			this.applyHidden();
		}
		if (!(file instanceof TFolder)) return;
		let changed = false;
		for (const rule of this.settings.rules) {
			const folder = normalizePath(rule.folder);
			if (folder === oldPath || folder.startsWith(oldPath + "/")) {
				rule.folder = file.path + folder.slice(oldPath.length);
				changed = true;
			}
		}
		if (changed) void this.saveData(this.settings);
		this.refresh();
	}
}

class FolderScopeSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: WorkspaceFolderScopePlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setDesc(
				"While a workspace below is active, the file explorer shows only the contents of its folder, at the top level. New notes and folders that would land outside it are created in the current folder inside it."
			);

		this.plugin.settings.rules.forEach((rule, i) => {
			new Setting(containerEl)
				.setName(`Rule ${i + 1}`)
				.addText((text) =>
					text
						.setPlaceholder("Workspace name")
						.setValue(rule.workspace)
						.onChange(async (value) => {
							rule.workspace = value.trim();
							await this.plugin.saveSettings();
						})
				)
				.addText((text) =>
					text
						.setPlaceholder("Folder path")
						.setValue(rule.folder)
						.onChange(async (value) => {
							rule.folder = value.trim();
							await this.plugin.saveSettings();
						})
				)
				.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove rule")
						.onClick(async () => {
							this.plugin.settings.rules.splice(i, 1);
							await this.plugin.saveSettings();
							this.display();
						})
				);
		});

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Add rule").onClick(async () => {
				this.plugin.settings.rules.push({ workspace: "", folder: "" });
				await this.plugin.saveSettings();
				this.display();
			})
		);

		new Setting(containerEl)
			.setName("Don't let mobile overwrite saved workspaces")
			.setDesc(
				"Saved workspaces sync to all your devices. On mobile, block every save of a workspace so the phone's layout never replaces the one saved on your computer. Switching still works. Takes effect after restarting Obsidian on the phone."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.guardMobileAutoSave).onChange(async (value) => {
					this.plugin.settings.guardMobileAutoSave = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Hidden in file explorer")
			.setHeading()
			.setDesc(
				"Right-click a file or folder and choose Hide in file explorer. Hidden items stay in the vault and in search; they just don't show in the file explorer, in any workspace. The toggle command shows them for a while."
			);
		if (this.plugin.settings.hidden.length === 0) {
			containerEl.createEl("p", { text: "Nothing hidden.", cls: "setting-item-description" });
		}
		for (const path of this.plugin.settings.hidden) {
			new Setting(containerEl).setName(path).addButton((button) =>
				button.setButtonText("Show").onClick(async () => {
					await this.plugin.setHidden(path, false);
					this.display();
				})
			);
		}
	}
}
