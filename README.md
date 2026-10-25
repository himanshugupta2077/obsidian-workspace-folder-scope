# Workspace Folder Scope

Scopes Obsidian's file explorer to one folder per workspace. While a workspace with a rule is active (core **Workspaces** plugin, or Workspaces Plus on top of it), the explorer shows only that folder's contents, as if its subfolders were at the top of the vault. Switch to a workspace without a rule and the whole vault is back.

New notes and folders follow the scope too:

- **New note** keeps your "Default location for new notes" setting, but if that would put the note outside the scoped folder (e.g. the active file lives elsewhere), it goes to the scoped folder instead.
- **New folder** from the explorer header, which Obsidian always creates at the vault root, goes into the active file's folder when that's inside the scope, otherwise into the scoped folder.

Use the **Toggle folder scope for this workspace** command to temporarily see the whole vault.

## Hide files and folders

Right-click any file or folder and choose **Hide in file explorer** to keep it out of the explorer in every workspace, e.g. a `CLAUDE.md` you need in place but don't want to look at. It stays in the vault, in search and in links; the rule follows it when it's renamed or moved. Unhide items in the plugin settings, or run **Toggle hidden files and folders in the file explorer** to see them for a while.

## Settings

One rule per workspace: the workspace name and the folder path, e.g. `Work` → `Work/Acme`. Rules follow the folder when it's renamed or moved.

## Development

```sh
npm install
VAULTS="/path/to/vault" npm run build   # builds and installs into each vault
```
