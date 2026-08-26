import { dialog, shell, app, clipboard, type BrowserWindow } from 'electron';
import { homedir, release, tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Store } from '../store';
import type { PtyHost } from '../ptyHost';
import { PtyBatcher } from '../ptyBatch';
import { applyOpenAtLogin, effectiveOpenAtLogin } from '../autostart';
import { scanFolders, isRepo } from '../scanner';
import { getGitInfo, getRepoUrl, getGitBranchDirty, getRecentCommits } from '../gitInfo';
import { getProvider, availableAgents, resolveOpenSession, resolveProjectOpenCommand } from '../agents';
import { toAgentId, type AgentId, type Folder, type OpenMode, type ProjectOpenIntent, type SessionMeta } from '../../shared/types';
import { isAllowedPath, isAllowedFilePath, resolveAgentFilePath, AGENT_OPEN_EXT } from '../../shared/pathGuard';
import { basename, cwdKey } from '../../shared/paths';
import { isAllowedExternalUrl, isSafeRepoUrl, isOpenableTerminalLink } from '../../shared/externalUrl';
import { makeTtlCache } from '../../shared/ttlCache';
import { buildProjectList } from '../projects';
import { createProject } from '../createProject';
import { openProjects, openInEditor, resolveShellPath, makeCliGuard } from '../launcher';
import type { WtTab } from '../../shared/wtArgs';
import { scanUsage } from '../usageScan';
import { scanCodexUsage } from '../codexUsageScan';
import { combineLocalUsageScans } from '../localUsageReport';
import { PASTE_IMAGE_PREFIX } from '../tempClean';
import { listClaudeProjectDirs } from '../usageProjectsScan';
import { classifyUsageProjects } from '../../shared/usageProjects';
import { sanitizeTodos } from '../../shared/tasks';
import { getClaudeUsage, readClaudeCredentials, fetchUsageApi } from '../claudeUsage';
import { getCodexUsage, spawnCodexAppServer } from '../codexUsage';
import { UsageCoordinator, antigravityUsage } from '../usageProviders';
import { pickAdoptedSessionId, pickDriftedSessionId, type PersistedSession } from '../../shared/cockpitPersist';
import { makeAgentProbe } from '../agentProcess';
import { loginPowerShellCommand } from '../cliExecutable';
import { listSessionStats, listSessionIds } from '../sessions';
import { listCodexSessionStats, indexCodexSessionsByCwd, readCodexSessionMeta } from '../codexSessions';
import { indexAntigravitySessionsByCwd } from '../antigravitySessions';
import { makeProjectSessionScan } from '../sessionScan';
import { readClaudeSessionMeta } from '../sessionMeta';
import { readActiveTaskForm } from '../claudeTasks';
import { makeAiSummarizer } from '../aiSummary';
import { pickSessionSummary, buildAiSourceText } from '../../shared/sessionSummary';
import type { TrayController } from '../tray';
import { DEFAULT_THRESHOLDS } from '../../shared/staleness';
import type { ShutdownScheduler } from '../shutdownScheduler';
import { pendingBootBanner } from '../shutdownScheduler';
import { emptyProjectMemory, makeProjectMemoryService } from '../projectMemory';
import type { ShutdownLog } from '../shutdownLog';
import type { ShutdownSessionSummary } from '../../shared/shutdownIdle';
import { allow, blocked, localOnly, makeMethodTable, type DeckApi } from './methods';
import type { LinkService } from '../link/linkService';
import { isRemoteId, parseRemoteId, qualifyRemoteId } from '../../shared/link/machine';
import { makeEventHub, type EventHub } from './events';

/** Everything a transport needs to serve this machine: what can be called, and what it pushes. */
export interface DeckApiBundle {
  readonly methods: DeckApi;
  readonly events: EventHub;
}

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
const CLAUDE_TASKS = join(homedir(), '.claude', 'tasks');
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');
const ANTIGRAVITY_DIR = join(homedir(), '.gemini', 'antigravity');
const REPO_URL = 'https://github.com/writingdeveloper/devdeck';
/** Paste-image ceiling. A screenshot is around a megabyte; this is generous and still far below the
 *  link's frame limit once base64 expansion is counted. */
const MAX_PASTE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface DeckApiConfig {
  win: BrowserWindow;
  defaultBaseDir: string;
  store: Store;
  sendError: (msg: string) => void;
  defaultLanguage: string;
  ptyHost: PtyHost;
  /** False when the node-pty native binding failed to load — the renderer then hides the cockpit entirely. */
  ptyAvailable: boolean;
  tray: TrayController;
  /** Idle-shutdown feature (win32 only) — null elsewhere, which skips channel registration. */
  shutdown: ShutdownScheduler | null;
  shutdownLog: ShutdownLog | null;
  bootTimeMs: () => number;
  /**
   * The link, once it exists. Late-bound because the link SERVES this table — building it needs the
   * table, so the table cannot be handed a finished link at construction time. Null until then, and
   * on any machine where the link never starts.
   */
  link?: () => LinkService | null;
}

/**
 * Build this machine's capability table. Pure assembly: nothing is bound to a transport here, so
 * the same table backs the local IPC bridge (ipc.ts) and, later, a paired remote machine.
 */
export function createDeckApi(cfg: DeckApiConfig): DeckApiBundle {
  const { invoke, send, table } = makeMethodTable();
  const events = makeEventHub();
  let lastTrayCounts = { attention: 0, turn: 0, overdue: 0 }; // remember the latest counts so a tray-alert setting change re-applies at once
  // Legacy single-base value, retained only for the settings:get response (back-compat); not used for scanning or the security guard.
  const effBaseDir = () => cfg.store.getBaseDir() ?? cfg.defaultBaseDir;
  const effThresholds = () => cfg.store.getThresholds() ?? DEFAULT_THRESHOLDS;
  // No implicit scan root: ~/Documents/GitHub is a guess that doesn't hold for every
  // machine or every user's repo layout, and open-sourced software shouldn't start
  // walking a folder the user never chose. An empty deck's hint sends them to Settings
  // to add one explicitly (settings:addFolder), which is the only way folders get here.
  const effFolders = (): Folder[] => cfg.store.getFolders();
  // One deck reload() calls both projects:list and usage:report; each used to run scanFolders
  // independently (double disk walk + .git probes). Share one in-flight scan for ~8s (well under the
  // ~45s auto-refresh) keyed by the folder set, so the two handlers await the same Promise.
  const scanCache = makeTtlCache<ReturnType<typeof scanFolders>>(8_000);
  const memoScan = (): ReturnType<typeof scanFolders> => {
    const folders = effFolders();
    const key = JSON.stringify(folders);
    const now = Date.now();
    const hit = scanCache.get(key, now);
    if (hit) return hit;
    const p = scanFolders(folders);
    scanCache.set(key, now, p);
    return p;
  };

  // First-run guidance: if the agent CLI the terminal is about to run isn't on PATH, toast an
  // install hint alongside the shell's own error. Windows-only: a GUI-launched app on macOS/Linux
  // sees a truncated PATH (no /opt/homebrew/bin, ~/.npm-global/bin, …) while the login-shell
  // terminal that actually runs the command resolves it fine — probing there would false-alarm on
  // every open. Async + fire-and-forget so the probe never delays or blocks the actual launch.
  const cliGuard = makeCliGuard();
  const warnIfCliMissing = (command: string): void => {
    if (process.platform !== 'win32') return;
    void cliGuard(command).then((warn) => { if (warn) cfg.sendError(warn); });
  };

  // Opt-in AI layer for the cockpit's per-session summary line (see aiSummary.ts). Constructed
  // regardless of the setting — it is inert while disabled — so toggling it needs no restart.
  const aiSummarizer = makeAiSummarizer();
  aiSummarizer.setEnabled(cfg.store.getAiSessionSummary());

  const activeAgent = (): AgentId => {
    const a = cfg.store.getAgent();
    return a === 'antigravity' || a === 'claude' || a === 'codex' ? a : 'claude';
  };
  const agent = () => getProvider(activeAgent());
  // A session belongs to the provider it was OPENED with. Every session-scoped handler resolves that
  // provider from the request's agentId; the globally selected agent is the fallback only for callers
  // with no session context (a brand-new open from the deck). Without this, flipping the selection to
  // Codex made a Claude tile restore/restart/`+ new session` relaunch under `codex` — a different agent
  // reading a conversation it doesn't own.
  const agentFor = (id: unknown) => getProvider(toAgentId(id) ?? activeAgent());
  const providerHistory = async (a: ReturnType<typeof getProvider>, projectPath: string): Promise<SessionMeta[]> => {
    try { return await a.listSessions(projectPath); } catch { return []; }
  };
  // The deck reads EVERY installed provider (not the selected one): a project's history belongs to
  // whichever agents wrote it, and each session carries its owner so the card's mark and the agent
  // "open" launches are both true to disk. One scan per use — the flat Codex/Antigravity stores are
  // indexed once and shared by all projects of that scan instead of re-read per project.
  // …and shared briefly ACROSS scans: the deck refreshes on a 45s timer AND on every window focus, so
  // an alt-tab burst would otherwise re-walk both stores each time. Shorter than the refresh cycle, so
  // a normal refresh still sees current data.
  const INDEX_TTL_MS = 30_000;
  const codexIndexCache = makeTtlCache<Map<string, SessionMeta[]>>(INDEX_TTL_MS);
  const antigravityIndexCache = makeTtlCache<Map<string, SessionMeta[]>>(INDEX_TTL_MS);
  const cachedIndex = (
    cache: ReturnType<typeof makeTtlCache<Map<string, SessionMeta[]>>>,
    dir: string,
    build: () => Map<string, SessionMeta[]>,
  ): Map<string, SessionMeta[]> => {
    const now = Date.now();
    const hit = cache.get(dir, now);
    if (hit) return hit;
    const built = build();
    cache.set(dir, now, built);
    return built;
  };
  const makeDeckScan = () => makeProjectSessionScan({
    installed: availableAgents(),
    perProject: { claude: (p, limit) => getProvider('claude').listSessions(p, limit) },
    indexed: {
      codex: () => cachedIndex(codexIndexCache, CODEX_SESSIONS, () => indexCodexSessionsByCwd(CODEX_SESSIONS)),
      antigravity: () => cachedIndex(antigravityIndexCache, ANTIGRAVITY_DIR, () => indexAntigravitySessionsByCwd(ANTIGRAVITY_DIR)),
    },
  });
  const memoryService = makeProjectMemoryService({
    now: () => Date.now(),
    gitInfo: (p) => getGitInfo(p),
    commits: (p) => getRecentCommits(p, 20),
    sessions: (p, limit) => makeDeckScan().sessions(p, limit),
    lastUserMessage: (p, session) => getProvider(session.agentId).lastUserMessage(p, session.id),
    entry: (p) => cfg.store.get(p),
  });
  invoke('projects:list', allow('observe'), async () => {
    const scan = makeDeckScan();
    return buildProjectList({
      nowMs: Date.now(),
      thresholds: effThresholds(),
      scan: memoScan,
      git: (dir) => getGitInfo(dir),
      sessions: (p) => scan.sessions(p),
      resumeCue: (p, session) => getProvider(session.agentId).lastUserMessage(p, session.id),
      getEntry: (p) => cfg.store.get(p),
    });
  });
  invoke('project:memory', allow('observe'), (projectPath: string, fresh?: boolean) => {
    const projectPathString = String(projectPath);
    if (!isAllowedPath(effFolders(), projectPathString)) return emptyProjectMemory();
    return memoryService.get(projectPathString, fresh === true);
  });

  // These persist to state.json keyed by `path`. Guard with the same allowlist every other path-taking
  // handler uses — a compromised renderer must not be able to write store entries (10KB notes, todo
  // lists) for arbitrary paths outside any scanned folder and grow state.json unboundedly.
  invoke('project:setNote', allow('write'), (path: string, note: string) => {
    if (!isAllowedPath(effFolders(), path)) return;
    cfg.store.setNote(path, String(note).slice(0, 10000));
  });
  invoke('project:setTodos', allow('write'), (path: string, todos: unknown) => {
    if (!isAllowedPath(effFolders(), path)) return;
    // store.setTodos sanitizes (drops junk, caps text + list length), so an untrusted array is safe.
    cfg.store.setTodos(path, sanitizeTodos(todos));
  });
  invoke('project:setPinned', allow('write'), (path: string, pinned: boolean) => {
    if (!isAllowedPath(effFolders(), path)) return;
    cfg.store.setPinned(path, pinned);
  });
  invoke('project:setHidden', allow('write'), (path: string, hidden: boolean) => {
    if (!isAllowedPath(effFolders(), path)) return;
    cfg.store.setHidden(path, hidden);
  });

  invoke('usage:report', allow('observe'), async (sinceMs: number) => {
    const ms = (Number.isFinite(sinceMs) || sinceMs === Infinity) ? sinceMs : 0;
    const claude = (async () => {
      const scanned = await memoScan();
      // Reconcile the live deck with ~/.claude so DELETED projects (folder gone, usage still on disk)
      // remain visible and counted in the totals — honest "where did my tokens go" accounting.
      const claudeProjects = await listClaudeProjectDirs(CLAUDE_PROJECTS);
      const all = classifyUsageProjects({ scanned, claudeProjects, exists: existsSync });
      return scanUsage(all, CLAUDE_PROJECTS, ms);
    })();
    const codex = scanCodexUsage({
      sessionsDir: CODEX_SESSIONS,
      cachePath: join(app.getPath('userData'), 'codex-usage-index.json'),
      sinceMs: ms,
    });
    return combineLocalUsageScans(claude, codex);
  });
  invoke('settings:getLanguage', localOnly, () => cfg.store.getLanguage() ?? cfg.defaultLanguage);
  invoke('settings:setLanguage', localOnly, (lang: string) => cfg.store.setLanguage(lang));
  invoke('settings:getAgent', allow('observe'), () => activeAgent());
  invoke('settings:availableAgents', allow('observe'), () => availableAgents());
  invoke('settings:setAgent', allow('write'), (id: string) => {
    if (id === 'claude' || id === 'antigravity' || id === 'codex') cfg.store.setAgent(id);
  });

  invoke('settings:get', allow('observe'), () => ({
    baseDir: effBaseDir(), thresholds: effThresholds(), language: cfg.store.getLanguage() ?? cfg.defaultLanguage,
    openAtLogin: effectiveOpenAtLogin(cfg.store.getOpenAtLogin()), platform: process.platform, osRelease: release(), ptyAvailable: cfg.ptyAvailable,
    viewMode: cfg.store.getViewMode(), trayAlert: cfg.store.getTrayAlert(), contextWindow: cfg.store.getContextWindow(),
    shutdownIdleMinutes: cfg.store.getShutdownIdleMinutes(),
    cockpitSidebarCollapsed: cfg.store.getCockpitSidebarCollapsed(),
    sessionSummary: cfg.store.getSessionSummary(), aiSessionSummary: cfg.store.getAiSessionSummary(),
  }));
  invoke('settings:setSessionSummary', allow('write'), (on: boolean) => cfg.store.setSessionSummary(on === true));
  invoke('settings:setAiSessionSummary', allow('write'), (on: boolean) => {
    cfg.store.setAiSessionSummary(on === true);
    aiSummarizer.setEnabled(on === true); // takes effect on the next meta refresh, no restart
  });
  invoke('settings:setCockpitSidebar', localOnly, (collapsed: boolean) => cfg.store.setCockpitSidebarCollapsed(collapsed)); // store setter owns the strict-boolean coercion
  invoke('settings:setContextWindow', allow('write'), (w: number) => cfg.store.setContextWindow(w === 200_000 ? 200_000 : 1_000_000));
  invoke('settings:setTrayAlert', localOnly, (mode: string) => {
    cfg.store.setTrayAlert(mode === 'off' || mode === 'all' ? mode : 'attention');
    cfg.tray.applyCounts(lastTrayCounts, cfg.store.getTrayAlert()); // re-apply immediately with the latest counts
  });
  invoke('settings:setOpenAtLogin', localOnly, (enabled: boolean) => {
    const on = !!enabled;
    cfg.store.setOpenAtLogin(on);
    applyOpenAtLogin(on);
  });
  invoke('settings:setViewMode', localOnly, (mode: string) => {
    cfg.store.setViewMode(mode === 'list' ? 'list' : 'cards');
  });
  invoke('settings:setBaseDir', localOnly, (dir: string) => cfg.store.setBaseDir(String(dir).slice(0, 2000)));
  invoke('settings:getFolders', allow('observe'), () => effFolders());
  // addFolder is the one handler that WIDENS the scan allowlist every other path guard checks against,
  // so it accepts only a directory the user just chose via the native pickFolder dialog (a dialog a
  // compromised renderer can't silently confirm) — never an arbitrary path the renderer names itself.
  const blessedFolderPicks = new Set<string>();
  // `kind` is the user's own choice from Settings: 'root' = walk it for repos, 'repo' = this folder
  // IS one project. Omitting it keeps the legacy auto-detection (a `.git` here ⇒ 'repo'), which the
  // new-project modal and older callers rely on.
  invoke('settings:addFolder', blocked('the scan allowlist may only be widened by a native picker on the machine itself (v1.24.0 invariant)'), async (p: string, k?: unknown) => {
    const path = String(p).trim().slice(0, 2000);
    if (!blessedFolderPicks.delete(path)) { // one-time consume; false ⇒ this path never came from pickFolder
      cfg.sendError(`Folder must be chosen via the picker: ${path}`);
      return effFolders();
    }
    let isDir = false;
    try { isDir = (await stat(path)).isDirectory(); } catch { isDir = false; }
    if (!isDir) {
      cfg.sendError(`Not a folder: ${path}`);
      return effFolders();
    }
    const kind: Folder['kind'] = k === 'root' || k === 'repo' ? k : ((await isRepo(path)) ? 'repo' : 'root');
    cfg.store.addFolder({ path, kind });
    return effFolders();
  });
  invoke('settings:removeFolder', blocked('allowlist mutation stays on the machine that owns the folders'), (p: string) => {
    cfg.store.removeFolder(String(p).slice(0, 2000));
    return effFolders();
  });
  invoke('settings:setThresholds', allow('write'), (t: { freshDays: number; warnDays: number; neglectedDays: number }) => {
    const { freshDays, warnDays, neglectedDays } = t ?? {};
    if (
      typeof freshDays === 'number' && typeof warnDays === 'number' && typeof neglectedDays === 'number' &&
      freshDays > 0 && freshDays <= warnDays && warnDays <= neglectedDays
    ) {
      cfg.store.setThresholds({ freshDays, warnDays, neglectedDays });
    }
  });
  invoke('settings:pickFolder', blocked('opens a native dialog on the host screen - nobody is sitting there'), async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    const picked = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    if (picked) blessedFolderPicks.add(picked.trim().slice(0, 2000)); // bless it for one subsequent addFolder
    return picked;
  });
  invoke('app:info', allow('observe'), () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    repoUrl: REPO_URL,
    packaged: app.isPackaged,
    // Who this machine IS. A viewer needs it to label remote rows and to tell two decks apart; asking
    // over the link is also how it learns the name changed without re-pairing.
    machineId: cfg.store.getMachineId(),
    machineName: cfg.store.getMachineName(),
  }));
  invoke('shell:openExternal', localOnly, async (url: string) => {
    const u = String(url);
    if (isAllowedExternalUrl(u)) await shell.openExternal(u);
    else cfg.sendError(`Blocked external URL: ${u}`);
  });

  invoke('projects:open', allow('spawn'), async (items: ProjectOpenIntent[]) => {
    const now = new Date().toISOString();
    const folders = effFolders();
    const tabs: WtTab[] = [];
    for (const it of items) {
      if (!isAllowedPath(folders, it.path)) {
        cfg.sendError(`Path outside allowed folders: ${it.path}`);
        continue;
      }
      // The visible provider choice is authoritative. A historical session carries its owner in the
      // same field; missing/invalid legacy input falls back only to the persisted header selection.
      const a = agentFor(it.agentId);
      const command = resolveProjectOpenCommand(a, {
        mode: it.mode === 'new' ? 'new' : 'auto',
        sessionId: typeof it.sessionId === 'string' ? it.sessionId : null,
        hasHistory: it.mode === 'new' ? false : (await providerHistory(a, it.path)).length > 0,
      });
      tabs.push({
        name: basename(it.path),
        dir: it.path,
        command,
      });
      // Record lastOpened only for accepted (validated) projects.
      cfg.store.setLastOpened(it.path, now);
    }
    // A batch can now span providers (each project resumes under its own agent), so probe one command
    // per distinct binary rather than assuming the whole batch runs the same one.
    for (const command of new Set(tabs.map((t) => t.command.split(' ')[0]))) warnIfCliMissing(command);
    openProjects(tabs, { onError: cfg.sendError });
  });

  // Open the project folder in the OS file manager.
  invoke('project:openFolder', allow('spawn'), async (p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside allowed folders: ${p}`);
      return;
    }
    const err = await shell.openPath(p);
    if (err) cfg.sendError(err);
  });

  // Open the project in VS Code (`code <path>`).
  invoke('project:openEditor', allow('spawn'), (p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside allowed folders: ${p}`);
      return;
    }
    openInEditor(p, { onError: cfg.sendError });
  });

  // Create a new project folder under an allowed scan root and `git init` it
  // (git init is what lets the scanner discover the new folder).
  invoke('project:create', allow('write'), (parent: string, name: string) => {
    return createProject(effFolders(), String(parent), String(name));
  });

  // Open the project's GitHub page. The renderer passes only the path (never a URL);
  // main re-reads the repo URL from git and validates it, so a compromised renderer
  // can't open an arbitrary external URL.
  /**
   * The repository's browsable URL, WITHOUT opening it.
   *
   * `project:openRepo` reads the URL and opens it in one step, which cannot work across machines:
   * the git remote has to be read where the repository is, and the browser that should open it is the
   * one in front of the person. Splitting the read out is what lets the viewer do both halves in the
   * right places. Still validated here, so a compromised caller cannot turn this into "open any URL".
   */
  invoke('project:repoUrl', allow('observe'), async (p: string) => {
    if (!isAllowedPath(effFolders(), String(p))) return null;
    const url = await getRepoUrl(String(p));
    return url && isSafeRepoUrl(url) ? url : null;
  });
  // Read there, open here.
  invoke('link:openRepo', localOnly, async (machineId: string, projectPath: string) => {
    const url = await linkOrThrow().call(String(machineId), 'project:repoUrl', [String(projectPath)]);
    if (typeof url !== 'string' || !isSafeRepoUrl(url)) { cfg.sendError(`No GitHub remote found for: ${projectPath}`); return; }
    await shell.openExternal(url);
  });
  invoke('project:openRepo', localOnly, async (p: string) => {
    if (!isAllowedPath(effFolders(), p)) {
      cfg.sendError(`Path outside allowed folders: ${p}`);
      return;
    }
    const url = await getRepoUrl(p);
    if (url && isSafeRepoUrl(url)) await shell.openExternal(url);
    else cfg.sendError(`No GitHub remote found for: ${p}`);
  });

  // Embedded cockpit: open a pty session running the agent; output streams to the renderer's xterm.
  let cockpitSeq = 0;
  // Unsolicited output (pty bytes, session exits) goes to the event hub rather than to a window, so
  // the same stream can also reach a viewer on another machine. Delivery guards — a renderer torn down
  // mid-send, a half-closed socket — belong to each transport, not here.
  const emit = (channel: string, payload: unknown): void => events.publish(channel, payload);
  // Coalesce pty output (~one frame) before it crosses IPC so many streaming sessions don't flood the
  // renderer's single UI thread; input is never batched, and a big burst flushes immediately via the cap.
  const ptyBatch = new PtyBatcher((id, chunk) => emit('cockpit:data', { id, chunk }), (flush) => { setTimeout(flush, 16); });
  // Visible, interactive OAuth setup inside DevDeck. This is intentionally NOT a general command
  // runner: the renderer chooses only a provider id and main owns the two fixed login commands.
  invoke('usage:login', blocked('an interactive credential login belongs in front of the machine that stores the credentials'), (rawProviderId: unknown, cols: number, rows: number) => {
    const providerId = rawProviderId === 'claude' || rawProviderId === 'codex' ? rawProviderId : null;
    if (!providerId || !cfg.ptyAvailable) return null;
    const id = `usage-login:${providerId}:${++cockpitSeq}`;
    try {
      cfg.ptyHost.create(
        id, resolveShellPath(), ['-NoExit', '-Command', loginPowerShellCommand(providerId)], homedir(),
        Math.max(20, Number(cols) | 0), Math.max(5, Number(rows) | 0),
        (chunk) => ptyBatch.push(id, chunk),
        (exit) => { ptyBatch.flush(); emit('cockpit:exit', { id, exitCode: exit.exitCode }); },
        // Not a session on a project: it must never appear in what this machine says it is running,
        // or a deck reconciling against that list builds a project tile for an OAuth prompt.
        { internal: true },
      );
      return { id, providerId };
    } catch (err) {
      cfg.sendError(`Could not open ${providerId} login: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  });
  invoke('cockpit:open', allow('spawn'), async (req: { projectPath: string; sessionId: string | null; cols: number; rows: number; mode?: OpenMode; agentId?: AgentId }) => {
    const folders = effFolders();
    if (!isAllowedPath(folders, req.projectPath)) {
      cfg.sendError(`Path outside allowed folders: ${req.projectPath}`);
      return { id: '', agentId: agentFor(req?.agentId).id, sessionId: null };
    }
    const a = agentFor(req.agentId);
    const forceNew = req.mode === 'new';
    // A failed open must come back as the same refusal shape the allowlist path returns (id: '') —
    // node-pty's spawn throws synchronously (e.g. the project folder was deleted since the session
    // was saved), and an unguarded throw here rejects the invoke, leaking the renderer's
    // already-mounted terminal and aborting a restore-all loop mid-way.
    try {
      // Resolve BOTH the launch command and the concrete session id to persist (so each session
      // restores to its OWN conversation — required once a project can hold several sessions).
      const history = forceNew ? [] : await providerHistory(a, req.projectPath);
      const resolved = resolveOpenSession(a, {
        fresh: forceNew,
        // count/latestId are consulted only on the automatic new/continue path.
        sessionCount: forceNew ? 1 : history.length,
        sessionId: req.sessionId,
        latestId: forceNew ? null : history[0]?.id ?? null,
        genId: () => randomUUID(),
      });
      warnIfCliMissing(resolved.command);
      const shellPath = resolveShellPath();
      const id = `${req.projectPath}#${++cockpitSeq}`;
      cfg.ptyHost.create(
        id, shellPath, ['-NoExit', '-Command', resolved.command], req.projectPath,
        Math.max(20, req.cols | 0), Math.max(5, req.rows | 0),
        (chunk) => { cfg.shutdown?.noteBusy(); ptyBatch.push(id, chunk); },
        (e) => {
          ptyBatch.flush(); // flush buffered output before the exit notice
          emit('cockpit:exit', { id, exitCode: e.exitCode });
          publishSessions();
        },
        { projectPath: req.projectPath, sessionId: resolved.sessionId, agentId: a.id },
      );
      publishSessions();
      cfg.store.setLastOpened(req.projectPath, new Date().toISOString());
      return { id, agentId: a.id, sessionId: resolved.sessionId };
    } catch (err) {
      cfg.sendError(`Could not open session in ${req.projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      return { id: '', agentId: a.id, sessionId: null };
    }
  });
  // A tile's id says which machine owns it (shared/link/machine.ts), so the hot terminal path needs
  // no separate remote channels and no renderer branching: the same three calls reach a local pty or
  // a paired machine's pty depending only on the id they were given.
  send('cockpit:input', allow('control'), (id: string, data: string) => {
    cfg.shutdown?.noteBusy();
    const target = String(id);
    if (isRemoteId(target)) { remote(target, (link, machineId, hostId) => link.notify(machineId, 'cockpit:input', [hostId, String(data)])); return; }
    cfg.ptyHost.write(target, String(data));
  });
  send('cockpit:resize', allow('control'), (id: string, cols: number, rows: number) => {
    const target = String(id);
    const c = Math.max(1, cols | 0);
    const r = Math.max(1, rows | 0);
    if (isRemoteId(target)) {
      // attach() carries the size, and re-sending it is also what re-establishes the stream after a
      // reconnect — so a resize doubles as the "still watching, this big" heartbeat.
      cfg.link?.()?.attach(target, c, r);
      remote(target, (link, machineId, hostId) => link.notify(machineId, 'cockpit:resize', [hostId, c, r]));
      return;
    }
    cfg.ptyHost.resize(target, c, r);
    // Announced, because a pty has ONE size and any number of terminals can be attached to it —
    // this machine's tile and a tile on every machine watching the same session. Without this the
    // views that did not ask keep drawing at a width the pty no longer has, and ConPTY's repaint
    // lands on top of the older, wider one.
    emit('cockpit:resized', { id: target, cols: c, rows: r });
  });
  send('cockpit:close', allow('control'), (id: string) => {
    const target = String(id);
    if (isRemoteId(target)) {
      cfg.link?.()?.detach(target);
      remote(target, (link, machineId, hostId) => link.notify(machineId, 'cockpit:close', [hostId]));
      return;
    }
    ptyBatch.drop(target);
    cfg.ptyHost.kill(target);
    publishSessions();
  });

  // Cockpit session persistence: remember the open sessions so a quit/crash doesn't lose them.
  // The store sanitizes on read & write, so a corrupted state.json can't inject bad data.
  invoke('cockpit:loadSessions', localOnly, () => cfg.store.getCockpitSessions());
  send('cockpit:saveSessions', localOnly, (list: PersistedSession[]) => cfg.store.setCockpitSessions(Array.isArray(list) ? list : []));

  // Seamless update: the renderer records the live sessions right before quitAndInstall; the next
  // launch consumes (reads + clears) them to auto-restore. store.* sanitize, so untrusted input is safe.
  invoke('update:setPendingAutoRestore', localOnly, (list: PersistedSession[]) => cfg.store.setPendingAutoRestore(Array.isArray(list) ? list : []));
  invoke('update:consumeAutoRestore', localOnly, () => cfg.store.consumePendingAutoRestore());

  // Per-session model + active working time (read from the Claude session log) for the cockpit header/list.
  // Allowlist-guarded like cockpit:gitInfo below — don't read session model/time/context (or ids) for
  // projects outside a scanned folder if a compromised renderer asks. Return each handler's neutral shape.
  // `wantAi` is the renderer's "this session just finished a turn" signal: asking while it is still
  // working would spend a haiku call on every 30s tick and summarize a half-done turn.
  invoke('cockpit:sessionMeta', allow('observe'), (projectPath: string, sessionId: string, agentId?: AgentId, wantAi?: boolean) => {
    const blank = { model: null, activeMs: 0, contextTokens: 0, contextWindow: 0, summary: null, summarySource: null };
    const path = String(projectPath);
    if (!isAllowedPath(effFolders(), path)) return blank;
    const provider = agentFor(agentId).id;
    if (typeof sessionId !== 'string' || !sessionId) return blank;
    // Model / active time / context % are still Claude-only (they come from its usage records); the
    // SUMMARY works for Codex too, off a bounded tail read of its rollout.
    if (provider !== 'claude' && provider !== 'codex') return blank;
    const meta = provider === 'claude'
      ? { ...readClaudeSessionMeta(path, sessionId, CLAUDE_PROJECTS), contextWindow: 0 }
      // Codex records its own model + real context window per turn, so those come from the rollout
      // rather than the global 1M/200K setting. Active time has no Codex equivalent.
      : { ...readCodexSessionMeta(path, sessionId, CODEX_SESSIONS), activeMs: 0 };
    // The summary is assembled HERE, not in the renderer: the raw sources (a 400-char assistant turn,
    // the user's last prompt) stay in main and only the finished one-liner crosses IPC.
    const source = buildAiSourceText(meta);
    const summary = cfg.store.getSessionSummary()
      ? pickSessionSummary({
        // Always read the cache (so the line doesn't flicker back to a heuristic mid-turn); only queue
        // a new generation once the turn has finished. A session is summarized by ITS OWN provider's
        // CLI — never Claude's on a Codex session.
        ai: source ? aiSummarizer.get(sessionId, meta.mtimeMs, source, { queue: wantAi === true, provider }) : null,
        // Claude Code keeps a task list per session; Codex has no plan/task events to read.
        activeForm: provider === 'claude' ? readActiveTaskForm(sessionId, CLAUDE_TASKS, meta.mtimeMs) : null,
        assistantText: meta.assistantText,
        editedFiles: meta.editedFiles,
        userText: meta.userText,
      })
      : null;
    return {
      model: meta.model, activeMs: meta.activeMs, contextTokens: meta.contextTokens,
      // 0 = "no per-session window known" → the renderer falls back to the global setting (Claude).
      contextWindow: meta.contextWindow,
      summary: summary?.text ?? null, summarySource: summary?.source ?? null,
    };
  });
  /**
   * What is running on THIS machine right now.
   *
   * Announced rather than polled, and to local and remote consumers through the same channel, because
   * they have the same problem: a terminal can be started by the person sitting here OR by a paired
   * machine, and whoever is not looking at the one that started it would otherwise never learn it
   * exists. The pty table is the single source of truth for "what is running here"; both sides
   * reconcile against it.
   */
  function publishSessions(): void { emit('cockpit:sessions', cfg.ptyHost.list()); }
  invoke('cockpit:liveSessions', allow('observe'), () => cfg.ptyHost.list());
  /**
   * Recent output of a running session, for repainting a terminal being attached to mid-flight.
   *
   * Without it, attaching to work already in progress shows a blank rectangle until the agent next
   * says something — which, while it thinks, can be minutes. Needs the permission that covers driving
   * a session, not mere observation: this is the session's actual content.
   */
  // Two shapes on purpose. `sessionBuffer` still answers with the bytes alone because a machine on an
  // older build calls it and would write an object into its terminal; `sessionScreen` adds the size
  // those bytes were drawn for, which is what makes replaying them safe. A viewer asks for the screen
  // and falls back to the buffer, so either build can pair with either.
  invoke('cockpit:sessionBuffer', allow('control'), (id: string) => cfg.ptyHost.buffer(String(id)).data);
  invoke('cockpit:sessionScreen', allow('control'), (id: string) => cfg.ptyHost.buffer(String(id)));
  /**
   * Record the name the user gave a session, on the machine that RUNS it.
   *
   * A rename lives in the deck that made it, which is enough while one deck is the only one looking.
   * Over a link it is not: the viewer would show every session on a repository under that repository's
   * folder name, so two sessions the user deliberately named apart become indistinguishable rows.
   * Routed by tile id like input/resize/close, so renaming a remote session reaches its own machine.
   */
  send('cockpit:noteLabel', allow('control'), (id: string, label: unknown) => {
    const target = String(id);
    // A label is shown verbatim in another machine's session list; bound it there rather than trusting
    // the sender, and normalize "cleared" to null so it does not travel as an empty string.
    const text = typeof label === 'string' ? label.trim().slice(0, 60) : '';
    const next = text || null;
    if (isRemoteId(target)) { remote(target, (link, machineId, hostId) => link.notify(machineId, 'cockpit:noteLabel', [hostId, next])); return; }
    if (cfg.ptyHost.note(target, { label: next })) publishSessions();
  });

  // ALL of the project's on-disk session ids (mtime-desc) — the restore resolver needs the full set so
  // an older-but-valid saved id is still recognized as existing (listSessions caps at 5, which would
  // hide it and wrongly fall the tile back to the newest conversation).
  invoke('cockpit:sessionIds', allow('observe'), (projectPath: string, agentId?: AgentId) => {
    if (!isAllowedPath(effFolders(), String(projectPath))) return [];
    return agentFor(agentId).listSessionIds(String(projectPath));
  });
  /**
   * Which of the saved cockpit entries' conversations still exist on disk, answered as a parallel
   * boolean array. Lets the "Previous" list mark an entry as gone BEFORE the user clicks it: restoring
   * one opens a fresh session under the same name, and learning that only afterwards reads as data loss.
   *
   * Batched deliberately. Asking per entry would rescan the FLAT Codex rollout store once per project
   * (~100 bounded head reads each); here one pass builds its cwd index, and each Claude project dir is
   * read once and memoized for the call. Anything unverifiable — a denied path, an id-less Antigravity
   * entry, a malformed item — answers `true`: this may only report what it is sure is missing.
   */
  invoke('cockpit:sessionsExist', allow('observe'), (items: unknown) => {
    const list = (Array.isArray(items) ? items : []).slice(0, 200);
    const folders = effFolders();
    const claudeIds = new Map<string, Set<string>>();
    let codexByCwd: Map<string, SessionMeta[]> | null = null;
    return list.map((raw) => {
      const it = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const projectPath = typeof it.projectPath === 'string' ? it.projectPath : '';
      const sessionId = typeof it.sessionId === 'string' ? it.sessionId : '';
      if (!sessionId || !projectPath || !isAllowedPath(folders, projectPath)) return true;
      const owner = agentFor(it.agentId).id;
      if (owner === 'antigravity') return true; // records no per-tile id — nothing to verify
      if (owner === 'codex') {
        codexByCwd ??= indexCodexSessionsByCwd(CODEX_SESSIONS);
        return (codexByCwd.get(cwdKey(projectPath)) ?? []).some((s) => s.id === sessionId);
      }
      let ids = claudeIds.get(projectPath);
      if (!ids) { ids = new Set(listSessionIds(projectPath, CLAUDE_PROJECTS)); claudeIds.set(projectPath, ids); }
      return ids.has(sessionId);
    });
  });
  // Live session-id drift check (/clear starts a brand-new session id in the same terminal — the
  // open-time id then goes stale and a restart would restore the PAST conversation). The renderer
  // sends the tile's timing evidence; this stats the project's session files and adopts a new id only
  // when unambiguous (pickDriftedSessionId). Claude and Codex have per-file session stores;
  // Antigravity does not.
  invoke('cockpit:liveSessionId', allow('observe'), (projectPath: string, opts: { currentId: string | null; claimedIds: string[]; openedAtMs: number; sinceMs: number; lastDataAtMs: number; agentId?: AgentId; ptyId?: string }) => {
    if (!isAllowedPath(effFolders(), String(projectPath))) return null;
    if (!opts || typeof opts !== 'object') return null;
    const a = agentFor(opts.agentId).id;
    const stats = a === 'claude' ? listSessionStats(String(projectPath), CLAUDE_PROJECTS)
      : a === 'codex' ? listCodexSessionStats(String(projectPath), CODEX_SESSIONS)
        : null;
    if (!stats) return null;
    const currentId = typeof opts.currentId === 'string' && opts.currentId ? opts.currentId : null;
    const claimedIds = Array.isArray(opts.claimedIds) ? opts.claimedIds.filter((x): x is string => typeof x === 'string') : [];
    const sinceMs = Number(opts.sinceMs) || 0;
    const lastDataAtMs = Number(opts.lastDataAtMs) || 0;
    // No id at all (the tile's provider was just re-detected, so its old id went with the old
    // provider): nothing to drift FROM, and a `-c` resume writes a file born before the tile opened.
    if (!currentId) return pickAdoptedSessionId(stats, { claimedIds, sinceMs, lastDataAtMs });
    const drifted = pickDriftedSessionId(stats, {
      currentId,
      claimedIds,
      openedAtMs: Number(opts.openedAtMs) || 0,
      sinceMs,
      lastDataAtMs,
    });
    // Recorded on the pty as well, so a machine listing what is running here reports the conversation
    // a tile actually MOVED to (after /clear) rather than the one it happened to open on.
    if (drifted && typeof opts.ptyId === 'string' && opts.ptyId) {
      if (cfg.ptyHost.note(opts.ptyId, { sessionId: drifted })) publishSessions();
    }
    return drifted;
  });

  // WHICH agent is actually running in a tile right now, read from the pty's process tree. The tile's
  // provider was previously fixed at launch, but its shell outlives the agent (`-NoExit`): running a
  // different agent at the leftover prompt (`codex resume …` ends → the user types `claude`) left the
  // tile — its mark, its session-store reads and the usage footer — attributing the new conversation
  // to the OLD provider. Null when the shell is at a bare prompt or the probe fails: the caller then
  // keeps what it has (an absent answer must never be read as "the provider changed").
  const probeAgent = makeAgentProbe();
  invoke('cockpit:liveAgent', allow('observe'), async (id: string) => {
    const pid = cfg.ptyHost.pid(String(id));
    if (!pid) return null;
    try { return await probeAgent(pid); } catch { return null; }
  });

  // Live git branch + dirty count for a cockpit session's project. Re-read on a slow tick so a
  // RESTORED session (re-created with no branch) and in-terminal branch switches both show the real
  // branch instead of a stale snapshot or "-". Uses the 2-call branch+dirty reader (not the deck's
  // 5-call getGitInfo) since the cockpit refreshes this per session.
  invoke('cockpit:gitInfo', allow('observe'), (projectPath: string) => {
    // Same allowlist as every other path-taking handler — a compromised renderer must not be able
    // to point git at arbitrary filesystem locations.
    if (!isAllowedPath(effFolders(), String(projectPath))) return null;
    return getGitBranchDirty(String(projectPath));
  });

  // Tray attention indicator (Discord-style): the renderer supplies the red-dotted icon once + live needs-you counts.
  send('tray:alertImage', localOnly, (dataUrl: string) => cfg.tray.setAlertImage(String(dataUrl)));
  // Partial merge: the cockpit sends {attention, turn} and the deck sends {overdue} independently —
  // each sender updates only the fields it owns, so one can't zero the other's counts.
  send('tray:counts', localOnly, (counts: { attention?: number; turn?: number; overdue?: number }) => {
    const norm = (v: unknown): number => Math.max(0, Number(v) | 0);
    lastTrayCounts = {
      attention: counts?.attention === undefined ? lastTrayCounts.attention : norm(counts.attention),
      turn: counts?.turn === undefined ? lastTrayCounts.turn : norm(counts.turn),
      overdue: counts?.overdue === undefined ? lastTrayCounts.overdue : norm(counts.overdue),
    };
    cfg.tray.applyCounts(lastTrayCounts, cfg.store.getTrayAlert());
  });

  // Live subscription limits for every INSTALLED provider. Credentials are read and used only inside
  // the main-process adapters (Claude's OAuth token; Codex's own app-server owns its auth) — nothing
  // but normalized plan/percent/reset/credit/state values crosses IPC.
  const usageCachePath = () => join(app.getPath('userData'), 'usage-cache.json');
  const usage = new UsageCoordinator({
    now: () => Date.now(),
    load: () => { try { return JSON.parse(readFileSync(usageCachePath(), 'utf8')); } catch { return null; } },
    save: (values) => { try { writeFileSync(usageCachePath(), JSON.stringify(values), 'utf8'); } catch { /* ignore */ } },
    providers: {
      claude: () => getClaudeUsage({ now: () => Date.now(), env: process.env, readCredentials: () => readClaudeCredentials(), fetchUsage: (token) => fetchUsageApi(token) }),
      codex: () => getCodexUsage({ now: () => Date.now(), spawnAppServer: spawnCodexAppServer, clientVersion: app.getVersion() }),
      antigravity: async () => antigravityUsage(Date.now()), // documented CLI guidance only — no I/O
    },
  });
  // Only providers the user actually has installed are polled or rendered.
  invoke('usage:snapshot', allow('observe'), () => usage.cached(availableAgents()));
  invoke('usage:refresh', allow('observe'), (opts?: { force?: boolean }) => usage.refresh(availableAgents(), opts?.force === true));

  // Clipboard bridge for the embedded terminal (the sandboxed file:// renderer can't reach
  // navigator.clipboard reliably). Used so Ctrl+C copies a selection instead of sending SIGINT.
  send('clipboard:writeText', localOnly, (text: string) => clipboard.writeText(String(text ?? '')));
  invoke('clipboard:readText', localOnly, () => clipboard.readText());
  // Paste a CLIPBOARD IMAGE (e.g. a screenshot) into the terminal: Claude Code can't read the OS
  // clipboard (esp. native Windows), but it DOES read an image off a file path. So on Ctrl+V with an
  // image on the clipboard, write it to a temp PNG and return the path for the renderer to inject as
  // text — the one image-input method that works cross-platform. null when the clipboard has no image.
  invoke('clipboard:readImage', localOnly, () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const file = join(tmpdir(), `${PASTE_IMAGE_PREFIX}${randomUUID()}.png`);
    try { writeFileSync(file, img.toPNG()); } catch { return null; }
    return file;
  });
  /** The same clipboard image, as bytes, so it can be sent to the machine running the session. */
  invoke('clipboard:readImageBytes', localOnly, () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const png = img.toPNG();
    // Bounded well under the protocol's frame ceiling, base64 expansion included. A screenshot is
    // ~1MB; anything past this is not a paste, and refusing beats a dropped connection.
    if (png.length > MAX_PASTE_IMAGE_BYTES) return { tooLarge: true, bytes: null };
    return { tooLarge: false, bytes: png.toString('base64') };
  });
  /**
   * Land a pasted image on THIS machine and hand back its path.
   *
   * The local paste trick writes a temp file and injects its path, because an agent reads an image
   * off a path even where it cannot reach the OS clipboard. Across machines that path means nothing,
   * so the bytes travel and the file is written where the agent can actually read it.
   *
   * Deliberately narrow: it accepts a PNG and nothing else, writes only into the OS temp directory
   * under the name the existing sweeper already cleans up, and never takes a caller-supplied path.
   */
  invoke('cockpit:receiveImage', allow('control'), (base64: unknown) => {
    if (typeof base64 !== 'string' || base64.length > MAX_PASTE_IMAGE_BYTES * 2) return null;
    let png: Buffer;
    try { png = Buffer.from(base64, 'base64'); } catch { return null; }
    // PNG magic. Without this the method would write arbitrary attacker-chosen bytes to a
    // predictable location on a machine that merely granted "type in sessions".
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (png.length < PNG_MAGIC.length || !png.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
    if (png.length > MAX_PASTE_IMAGE_BYTES) return null;
    const file = join(tmpdir(), `${PASTE_IMAGE_PREFIX}${randomUUID()}.png`);
    try { writeFileSync(file, png); } catch { return null; }
    return file;
  });

  // Open a clicked terminal link. Terminal output is arbitrary, so (unlike shell:openExternal, which is
  // locked to DevDeck's own repo) any host is allowed — but only the http/https scheme, never file:/etc.
  invoke('cockpit:openLink', localOnly, async (url: string) => {
    const u = String(url);
    if (isOpenableTerminalLink(u)) await shell.openExternal(u);
    else cfg.sendError(`Blocked terminal link: ${u}`);
  });

  // Open a local IMAGE the agent printed (e.g. "> [image] assets\a.png") in the OS default viewer.
  // Relative paths resolve against the session's project dir; a leading `~` (home-dir shorthand some
  // tools print, e.g. a scratchpad path) resolves against the home dir instead. Guards, in order: the
  // resolved target must carry an inert-content extension (shell.openPath runs the default handler —
  // never executables/scripts), sit under an allowed folder OR the OS temp dir (where agent tooling writes
  // cross-project scratch files — a click-to-open convenience, not project-file access), and exist.
  // Returns a status string so failures can toast + be tested.
  invoke('cockpit:openFile', allow('spawn'), async (projectPath: string, filePath: string) => {
    const resolved = resolveAgentFilePath(String(projectPath), String(filePath), homedir());
    // Inert-content only (AGENT_OPEN_EXT) — executables/scripts/.svg/.html are refused so a click can never run code.
    if (!AGENT_OPEN_EXT.test(resolved)) { cfg.sendError(`Not an openable file type: ${resolved}`); return 'denied'; }
    if (!isAllowedFilePath(effFolders(), resolved, [tmpdir()])) { cfg.sendError(`Path outside allowed folders: ${resolved}`); return 'denied'; }
    if (!existsSync(resolved)) { cfg.sendError(`File not found: ${resolved}`); return 'missing'; }
    const err = await shell.openPath(resolved);
    if (err) { cfg.sendError(`Could not open file: ${err}`); return 'error'; }
    return 'ok';
  });

  // One-shot idle shutdown (win32 only — cfg.shutdown is null elsewhere so none of this registers).
  // Lifecycle invokes return the fresh status so the renderer can update without a round-trip race.
  if (cfg.shutdown && cfg.shutdownLog) {
    const sd = cfg.shutdown;
    const sdLog = cfg.shutdownLog;
    invoke('shutdown:arm', allow('power'), () => { sd.arm(); return sd.status(); });
    invoke('shutdown:disarm', allow('power'), () => { sd.disarm(); return sd.status(); });
    invoke('shutdown:now', allow('power'), () => { sd.shutdownNow(); return sd.status(); });
    invoke('shutdown:cancel', allow('power'), () => { sd.cancel(); return sd.status(); });
    invoke('shutdown:status', allow('observe'), () => sd.status());
    invoke('shutdown:history', allow('observe'), () => sdLog.read().slice().reverse()); // newest first for the settings list
    invoke('shutdown:clearHistory', allow('power'), () => sdLog.clear());
    invoke('shutdown:bootBanner', allow('observe'), () => pendingBootBanner(sdLog.read(), cfg.bootTimeMs()));
    invoke('shutdown:ackBanner', allow('power'), () => sdLog.updateLast({ acknowledged: true }));
    invoke('shutdown:setIdleMinutes', allow('power'), (m: number) => cfg.store.setShutdownIdleMinutes(Number(m)));
    // The renderer's activity report: working count (busy signal) + session summary (recorded at issue
    // time so tomorrow's banner can say what was on the deck). Sanitized — renderer input is untrusted.
    send('shutdown:report', localOnly, (p: { working?: unknown; sessions?: unknown }) => {
      const working = Math.max(0, Number(p && typeof p === 'object' ? p.working : 0) | 0);
      const sessions: ShutdownSessionSummary[] = Array.isArray(p && typeof p === 'object' ? p.sessions : null)
        ? (p.sessions as unknown[]).flatMap((s) => {
            if (!s || typeof s !== 'object') return [];
            const o = s as Record<string, unknown>;
            return typeof o.project === 'string' && typeof o.activity === 'string'
              ? [{ project: o.project.slice(0, 500), activity: o.activity.slice(0, 20) }] : [];
          }).slice(0, 50)
        : [];
      sd.noteReport(working, sessions);
    });
  }

  // Frameless-window controls (the title bar draws its own buttons).
  invoke('win:minimize', localOnly, () => cfg.win.minimize());
  // Raise the window from a renderer-side notification click (the window may be hidden to tray).
  invoke('win:show', localOnly, () => { cfg.win.show(); cfg.win.focus(); });
  invoke('win:toggleMaximize', localOnly, () => {
    cfg.win.isMaximized() ? cfg.win.unmaximize() : cfg.win.maximize();
  });
  invoke('win:close', localOnly, () => cfg.win.close());
  invoke('win:isMaximized', localOnly, () => cfg.win.isMaximized());

  /** Run `fn` against the machine that owns a qualified id, silently when it is offline. */
  function remote(qualifiedId: string, fn: (link: LinkService, machineId: string, hostId: string) => void): void {
    const link = cfg.link?.();
    if (!link) return;
    const { machineId, hostId } = parseRemoteId(qualifiedId);
    // A keystroke aimed at a machine that just went offline has nowhere to go; the tile's own state
    // is what tells the user, not an exception thrown from a fire-and-forget send.
    try { fn(link, machineId, hostId); } catch { /* offline */ }
  }

  const linkOrThrow = (): LinkService => {
    const link = cfg.link?.();
    if (!link) throw new Error('DevDeck Link is not available on this machine');
    return link;
  };

  // ---- DevDeck Link ----
  // Every one of these is local-only. They configure THIS machine's pairings and connections, and a
  // paired machine reconfiguring another machine's pairings through the link itself would make the
  // permission model circular.
  invoke('link:hostStatus', localOnly, () => linkOrThrow().hostStatus());
  invoke('link:setHostMode', localOnly, (on: boolean) => linkOrThrow().setHostMode(on === true));
  invoke('link:setPort', localOnly, (port: number) => linkOrThrow().setPort(Number(port)));
  invoke('link:createInvite', localOnly, (permissions?: unknown) => linkOrThrow().createInvite(Array.isArray(permissions) ? permissions as never : undefined));
  invoke('link:revokeInvite', localOnly, () => linkOrThrow().revokeInvite());
  invoke('link:machines', localOnly, () => cfg.link?.()?.machines() ?? []);
  invoke('link:addMachine', localOnly, (code: string) => linkOrThrow().addMachine(String(code)));
  invoke('link:removeMachine', localOnly, (machineId: string) => { linkOrThrow().removeMachine(String(machineId)); });
  invoke('link:setDevicePermissions', localOnly, (fingerprint: string, permissions: unknown) => {
    linkOrThrow().setDevicePermissions(String(fingerprint), Array.isArray(permissions) ? permissions as never : []);
  });
  invoke('link:revokeDevice', localOnly, (fingerprint: string) => { linkOrThrow().revokeDevice(String(fingerprint)); });
  invoke('link:disconnectDevice', localOnly, (fingerprint: string) => { linkOrThrow().disconnectDevice(String(fingerprint)); });
  // Read at the moment the screen asks and never stored — the clipboard is a shared surface.
  invoke('link:clipboardInvite', localOnly, () => cfg.link?.()?.clipboardInvite() ?? null);
  invoke('link:log', localOnly, (limit?: number) => cfg.link?.()?.auditLog(Number(limit) || undefined) ?? []);
  invoke('link:clearLog', localOnly, () => { cfg.link?.()?.clearAuditLog(); });

  // The generic routes behind `window.devdeck.machine(id)`: one channel for every remote read, so
  // adding a deck method does not mean adding an IPC channel to reach it on another machine.
  invoke('link:call', localOnly, async (machineId: string, method: string, args: unknown[]) => {
    const value = await linkOrThrow().call(String(machineId), String(method), Array.isArray(args) ? args : []);
    // A remote `cockpit:open` answers with an id minted on THAT machine. Qualifying it here is what
    // lets every id-taking call above route itself, and the renderer keep one flat id space.
    if (method === 'cockpit:open' && value && typeof value === 'object') {
      const opened = value as { id?: unknown };
      if (typeof opened.id === 'string' && opened.id) {
        const qualified = qualifyRemoteId(String(machineId), opened.id);
        // ATTACH RIGHT HERE, not on the tile's first resize. A host streams a session's bytes only to
        // viewers attached to it, so leaving the attach to a later call meant a freshly opened remote
        // terminal produced nothing at all until something happened to resize it — and if nothing
        // did, it stayed silent forever while looking perfectly healthy.
        const req = (Array.isArray(args) ? args[0] : null) as { cols?: unknown; rows?: unknown } | null;
        // A missing size must fall back to a real terminal, not to 1x1. The host sizes a shared
        // session to the SMALLEST attached viewer, so a bogus 1x1 attach would collapse the remote
        // terminal for everyone looking at it — including the person sitting in front of it.
        const asked = (value: unknown, fallback: number): number => {
          const n = Number(value) | 0;
          return n > 0 ? n : fallback;
        };
        cfg.link?.()?.attach(qualified, asked(req?.cols, 80), asked(req?.rows, 24));
        return { ...opened, id: qualified };
      }
    }
    // Same reason, for the path that ASKS a machine what it is running rather than being told. The
    // announcement is qualified as it is forwarded (linkService), so leaving this one bare meant a
    // session picked up on connect — the reconnect case, and every already-busy machine — got a tile
    // whose id named no machine: its keystrokes went to this machine's pty table, where nothing has
    // that id, and its output never arrived. A dead tile that looked perfectly normal.
    if (method === 'cockpit:liveSessions' && Array.isArray(value)) {
      return value.map((row) => (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
        ? { ...(row as object), id: qualifyRemoteId(String(machineId), (row as { id: string }).id) }
        : row));
    }
    return value;
  });
  send('link:notify', localOnly, (machineId: string, method: string, args: unknown[]) => {
    cfg.link?.()?.notify(String(machineId), String(method), Array.isArray(args) ? args : []);
  });

  return { methods: table, events };
}
