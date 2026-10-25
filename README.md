# Workspace Folder Scope

Scopes Obsidian's file explorer to one folder per workspace. While a workspace with a rule is active (core **Workspaces** plugin, or Workspaces Plus on top of it), the explorer shows only that folder's contents, as if its subfolders were at the top of the vault. Switch to a workspace without a rule and the whole vault is back.

New notes and folders follow the scope too:

- **New note** keeps your "Default location for new notes" setting, but if that would put the note outside the scoped folder (e.g. the active file lives elsewhere), it goes to the scoped folder instead.
- **New folder** from the explorer header, which Obsidian always creates at the vault root, goes into the active file's folder when that's inside the scope, otherwise into the scoped folder.

Use the **Toggle folder scope for this workspace** command to temporarily see the whole vault.

## Switching workspaces on mobile

Workspaces Plus puts its switcher in the status bar, which phones don't have. On mobile this plugin adds a bar at the top of the file explorer that names the active workspace; tap it to pick another. The **Switch workspace** command and a ribbon button (in the mobile menu) do the same.

On mobile, switching loads only the workspace's tabs. Workspaces are usually saved on the desktop, whose sidebars don't fit the phone's drawers; loading one whole would leave the drawers empty. The folder scope follows the switch.

Saved workspaces sync to every device, so by default this plugin also blocks saving a workspace on mobile. Otherwise Workspaces Plus's "Auto save the current workspace on layout change" writes the phone's layout over the one you saved on your computer. Turn **Don't let mobile overwrite saved workspaces** off in settings if you want to save from the phone.

## Hide files and folders

Right-click any file or folder and choose **Hide in file explorer** to keep it out of the explorer in every workspace, e.g. a `CLAUDE.md` you need in place but don't want to look at. It stays in the vault, in search and in links; the rule follows it when it's renamed or moved. Unhide items in the plugin settings, or run **Toggle hidden files and folders in the file explorer** to see them for a while.

## Settings

One rule per workspace: the workspace name and the folder path, e.g. `Work` → `Work/Acme`. Rules follow the folder when it's renamed or moved.

## Development

```sh
npm install
VAULTS="/path/to/vault" npm run build   # builds and installs into each vault
```
