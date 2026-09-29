import { app, Menu, BrowserWindow, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '../shared/ipc'
import { commandAllowed, modeSurface, DEFAULT_MODE, type StudioMode } from '../shared/mode'
import { surfaceAllowed, type Role } from '../shared/roles'

/**
 * The application menu.
 *
 * Until now Studio shipped Electron's *default* menu — the generic Edit/View/Window set every
 * unconfigured Electron app gets — so none of the app's own commands had a menu home, and a user
 * looking for "Save" or "New Terminal" in the menu bar found nothing.
 *
 * Every item here does something real. The rule this codebase enforces everywhere applies hardest
 * to a menu, because a greyed-out or dead menu item is the most convincing lie a desktop app can
 * tell: nothing is listed that isn't wired to working behaviour. Items whose target only exists
 * with a project open are enabled/disabled from the renderer's state (see `setMenuState`).
 *
 * Commands are sent to the focused window as `menu:<id>` strings; `App.tsx` maps them to the same
 * functions the buttons call, so there is exactly one implementation of each action.
 */

type Ctx = {
  hasProject: boolean
  previewRunning: boolean
  panelOpen: boolean
  agentOpen: boolean
  mode: StudioMode
  /** Null on an unmanaged install AND when signed out; `identityRequired` tells them apart. */
  role: Role | null
  /** True when a company IdP is configured. Off => no role gating at all (see surfaceAllowed). */
  identityRequired: boolean
}

let ctx: Ctx = {
  hasProject: false,
  previewRunning: false,
  panelOpen: false,
  agentOpen: false,
  mode: DEFAULT_MODE,
  role: null,
  identityRequired: false
}

function send(cmd: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send(IPC.menuCommand, cmd)
}

/**
 * A command item. `needsProject` greys it out when nothing is open, rather than failing silently.
 * Returns `null` when this command is not shown at all, for either of two independent reasons:
 *
 *   - the current MODE hides it — Builder Mode hides the code editor and terminal; or
 *   - the current ROLE lacks the capability it needs (`shared/roles.ts`), on a managed install.
 *
 * Both are the same principle: a menu item that opens a panel the window doesn't render, or fires
 * a command the server will refuse, is exactly the dead control this menu was written to avoid.
 * Returning `null` (rather than `enabled: false`) is what removes the accelerator too, so a
 * hidden surface has no keyboard back-door. `clean()` drops the nulls and the separators they
 * leave stranded.
 */
const cmd = (
  label: string,
  id: string,
  accelerator?: string,
  opts: { needsProject?: boolean; enabled?: boolean } = {}
): MenuItemConstructorOptions | null =>
  commandAllowed(ctx.mode, id) && surfaceAllowed(ctx.identityRequired, ctx.role, id)
    ? {
        label,
        accelerator,
        enabled: opts.enabled ?? (opts.needsProject ? ctx.hasProject : true),
        click: () => send(id)
      }
    : null

type Entry = MenuItemConstructorOptions | null

/** Drop hidden items, then any separator left leading, trailing, or doubled by their removal. */
function clean(items: Entry[]): MenuItemConstructorOptions[] {
  const kept = items.filter((i): i is MenuItemConstructorOptions => i != null)
  const out: MenuItemConstructorOptions[] = []
  for (const item of kept) {
    if (item.type === 'separator') {
      if (!out.length || out[out.length - 1].type === 'separator') continue
    }
    out.push(item)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/** A whole top-level menu whose items are all hidden is removed, not left as an empty title. */
function menu(label: string, items: Entry[]): MenuItemConstructorOptions | null {
  const submenu = clean(items)
  return submenu.length ? { label, submenu } : null
}

function template(): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin'
  const surface = modeSurface(ctx.mode)

  const appMenu: (MenuItemConstructorOptions | null)[] = isMac
    ? [
        menu('ATOMIC Studio', [
          { label: 'About ATOMIC Studio', click: () => send('help.about') },
          { type: 'separator' },
          cmd('Settings…', 'file.settings', 'CmdOrCtrl+,'),
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ])
      ]
    : []

  return [
    ...appMenu,
    menu('File', [
      cmd('New File…', 'file.newFile', 'CmdOrCtrl+N', { needsProject: true }),
      cmd('New Folder…', 'file.newFolder', undefined, { needsProject: true }),
      cmd('New Window', 'file.newWindow', 'Shift+CmdOrCtrl+N'),
      { type: 'separator' },
      cmd('Open Project…', 'file.open', 'CmdOrCtrl+O'),
      cmd('New Project…', 'file.newProject'),
      { type: 'separator' },
      cmd('Save', 'file.save', 'CmdOrCtrl+S', { needsProject: true }),
      cmd('Save All', 'file.saveAll', 'Alt+CmdOrCtrl+S', { needsProject: true }),
      { type: 'separator' },
      cmd('Close Editor', 'file.closeEditor', 'CmdOrCtrl+W', { needsProject: true }),
      cmd('Close Project', 'file.closeProject', undefined, { needsProject: true }),
      { label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' },
      ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, cmd('Settings…', 'file.settings', 'CmdOrCtrl+,')]),
      ...(isMac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'quit' as const }])
    ]),
    menu('Edit', [
      // Roles, not custom handlers: these must work in every input, the terminal and Monaco,
      // and only the platform's own undo stack knows which of those has focus.
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      cmd('Find', 'edit.find', 'CmdOrCtrl+F', { needsProject: true }),
      cmd('Replace', 'edit.replace', 'Alt+CmdOrCtrl+F', { needsProject: true }),
      { type: 'separator' },
      cmd('Toggle Line Comment', 'edit.comment', 'CmdOrCtrl+/', { needsProject: true }),
      cmd('Format Document', 'edit.format', 'Shift+Alt+F', { needsProject: true }),
      { type: 'separator' },
      cmd('Edit with AI…', 'edit.ai', 'CmdOrCtrl+K', { needsProject: true }),
      cmd('Undo Last AI Change', 'edit.undoAi', undefined, { needsProject: true })
    ]),
    // Every item here is a Monaco cursor command, so the whole menu belongs to the code surface.
    // In Builder Mode it would be a menu of shortcuts for an editor that isn't on screen.
    surface.code
      ? menu('Selection', [
          { role: 'selectAll' },
          { type: 'separator' },
          cmd('Expand Selection', 'sel.expand', 'Ctrl+Shift+Right', { needsProject: true }),
          cmd('Shrink Selection', 'sel.shrink', 'Ctrl+Shift+Left', { needsProject: true }),
          { type: 'separator' },
          cmd('Copy Line Up', 'sel.copyLineUp', 'Shift+Alt+Up', { needsProject: true }),
          cmd('Copy Line Down', 'sel.copyLineDown', 'Shift+Alt+Down', { needsProject: true }),
          cmd('Move Line Up', 'sel.moveLineUp', 'Alt+Up', { needsProject: true }),
          cmd('Move Line Down', 'sel.moveLineDown', 'Alt+Down', { needsProject: true }),
          { type: 'separator' },
          cmd('Add Cursor Above', 'sel.cursorAbove', 'Alt+CmdOrCtrl+Up', { needsProject: true }),
          cmd('Add Cursor Below', 'sel.cursorBelow', 'Alt+CmdOrCtrl+Down', { needsProject: true }),
          cmd('Select All Occurrences', 'sel.allOccurrences', 'Shift+CmdOrCtrl+L', { needsProject: true })
        ])
      : null,
    menu('View', [
      cmd('Command Palette…', 'view.palette', 'Shift+CmdOrCtrl+P'),
      { type: 'separator' },
      cmd('Explorer', 'view.explorer', 'CmdOrCtrl+B'),
      cmd('Search Everywhere', 'view.search'), // ⌘P is shown on Go ▸ Go to File, not twice
      cmd('Source Control', 'view.scm', 'CmdOrCtrl+Shift+G'),
      cmd('Extensions', 'view.extensions'),
      cmd('Create images & video', 'view.media'),
      cmd('Account', 'view.account'),
      { type: 'separator' },
      { label: ctx.panelOpen ? 'Hide Panel' : 'Show Panel', accelerator: 'CmdOrCtrl+J', click: () => send('view.togglePanel') },
      cmd(ctx.agentOpen ? 'Hide Agent' : 'Show Agent', 'view.toggleAgent', 'CmdOrCtrl+Shift+A'),
      cmd('Focus Mode', 'view.focusMode', 'CmdOrCtrl+Shift+F'),
      { type: 'separator' },
      menu('Panel', [
        cmd('Insight', 'panel.insight'),
        cmd('Activity', 'panel.activity'),
        cmd('Problems', 'panel.problems'),
        cmd('Changes', 'panel.changes'),
        cmd('Workspaces', 'panel.company'),
        cmd('Terminal', 'panel.terminal')
      ]),
      { type: 'separator' },
      {
        label: 'Appearance',
        submenu: [
          // No accelerator here on purpose: VS Code's binding is the chord ⌘K ⌘T, and Electron
          // accelerators are single combos only. The renderer owns the chord; this is the discoverable
          // route to the same command.
          { label: 'Colour Theme…', click: () => send('view.theme') },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { type: 'separator' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' }
    ]),
    menu('Go', [
      cmd('Go to File…', 'go.file', 'CmdOrCtrl+P'),
      cmd('Go to Symbol…', 'go.symbol', 'Shift+CmdOrCtrl+O', { needsProject: true }),
      cmd('Go to Line/Column…', 'go.line', 'Ctrl+G', { needsProject: true }),
      { type: 'separator' },
      cmd('Next Editor', 'go.nextTab', 'Alt+CmdOrCtrl+Right', { needsProject: true }),
      cmd('Previous Editor', 'go.prevTab', 'Alt+CmdOrCtrl+Left', { needsProject: true }),
      { type: 'separator' },
      cmd('Preview Tab', 'go.preview')
    ]),
    menu('Run', [
      {
        label: ctx.previewRunning ? 'Stop Preview' : 'Run Preview',
        accelerator: 'CmdOrCtrl+R',
        enabled: ctx.hasProject,
        click: () => send('run.togglePreview')
      },
      cmd('Restart Preview', 'run.restartPreview', undefined, { needsProject: true }),
      { type: 'separator' },
      cmd('Run Doctor', 'run.doctor', undefined, { needsProject: true }),
      cmd('Generate Tests for This File', 'run.genTests', undefined, { needsProject: true }),
      { type: 'separator' },
      cmd('Ask the Agent…', 'run.agent', 'CmdOrCtrl+I', { needsProject: true }),
      cmd('Stop the Agent', 'run.stopAgent', undefined, { needsProject: true })
    ]),
    menu('Terminal', [
      cmd('New Terminal', 'term.new', 'Ctrl+`', { needsProject: true }),
      cmd('Show Terminal', 'term.show', undefined, { needsProject: true }),
      { type: 'separator' },
      cmd('Clear Terminal', 'term.clear', undefined, { needsProject: true }),
      cmd('Close Terminal', 'term.close', undefined, { needsProject: true })
    ]),
    menu('Window', isMac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }, { type: 'separator' }, cmd('New Window', 'file.newWindow')]
      : [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, cmd('New Window', 'file.newWindow'), { role: 'close' }]),
    {
      role: 'help',
      submenu: [
        { label: 'About ATOMIC Studio', click: () => send('help.about') },
        { label: 'Keyboard Shortcuts', click: () => send('help.shortcuts') },
        { type: 'separator' },
        { label: 'ATOMIC on the web', click: () => void shell.openExternal('https://atomic.limited') },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ].filter((m): m is MenuItemConstructorOptions => m != null)
}

export function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template()))
}

/**
 * Rebuild with fresh renderer state. Menus are static once built, so the labels that flip
 * ("Run/Stop Preview", "Show/Hide Panel") and the project-dependent enabling only stay truthful if
 * the menu is rebuilt when that state changes. The renderer pushes it; cheap enough to just rebuild.
 */
export function setMenuState(next: Partial<Ctx>): void {
  const merged = { ...ctx, ...next }
  if (
    merged.hasProject === ctx.hasProject &&
    merged.previewRunning === ctx.previewRunning &&
    merged.panelOpen === ctx.panelOpen &&
    merged.agentOpen === ctx.agentOpen &&
    merged.mode === ctx.mode &&
    merged.role === ctx.role &&
    merged.identityRequired === ctx.identityRequired
  ) {
    return // nothing that the menu renders has changed
  }
  ctx = merged
  buildMenu()
}

/** Recent projects live in the renderer's localStorage; nothing to do here yet. */
export function refreshMenu(): void {
  buildMenu()
}

export { app as _app }
