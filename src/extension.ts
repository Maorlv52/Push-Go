import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

/* ================ UI types ================ */
type UiMsg =
  | { type: 'commit'; message: string }
  | { type: 'push' }
  | { type: 'commitPush'; message: string }
  | { type: 'stageAll' }
  | { type: 'unstageAll' }
  | { type: 'discardAll' }
  | { type: 'toggleStageFile'; uri: string; toStage: boolean }
  | { type: 'discardFile'; uri: string }
  | { type: 'openDiff'; uri: string }
  | { type: 'requestState' };

type UiChange = {
  uri: string;
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '??';
  staged: boolean;
};

type UiState = {
  repoPath: string;
  branch: string;
  upstream?: string | null;
  changes: UiChange[];
  canCommit: boolean;
  lastStatus?: string;
};

type UiEvent =
  | { type: 'state'; state: UiState }
  | { type: 'status'; text: string }
  | { type: 'ok'; action: UiMsg['type'] }
  | { type: 'error'; action: UiMsg['type']; message: string };

/* ================ Settings ================ */
const SETTINGS = {
  wipGuard: 'pushGo.enableWipGuard',
  blockOnMain: 'pushGo.blockCommitOnMain',
} as const;

const getSettings = () => {
  const cfg = vscode.workspace.getConfiguration();
  return {
    wipGuard: !!cfg.get<boolean>(SETTINGS.wipGuard),
blockOnMain: !!cfg.get<boolean>(SETTINGS.blockOnMain),
  };
};

/* ================ Git API (async) ================ */
type GitAPI = {
  getAPI(version: number): {
    repositories: Array<{
      rootUri: vscode.Uri;
      state: {
        HEAD?: { name?: string; upstream?: { name?: string } };
        indexChanges?: any[];
        workingTreeChanges?: any[];
        onDidChange: vscode.Event<void>;
      };
      add(paths: string[]): Promise<void>;
      revert(paths: string[]): Promise<void>;
      clean(paths: string[]): Promise<void>;
      commit?(message: string, opts?: { all?: boolean; amend?: boolean; signoff?: boolean; noVerify?: boolean }): Promise<void>;
      push?(remote?: string, name?: string, setUpstream?: boolean): Promise<void>;
    }>;
    toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
    git: { path: string };
    onDidOpenRepository?: vscode.Event<any>;
  };
};
type GitApiReturn = ReturnType<GitAPI['getAPI']>;
type Repository = NonNullable<GitApiReturn>['repositories'][number];

let gitApi: GitApiReturn | null = null;

async function ensureGitActivated(): Promise<void> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) throw new Error("The built-in 'Git' extension (vscode.git) is required.");
  if (!ext.isActive) await ext.activate();
}

async function getGitApi(): Promise<GitApiReturn | null> {
  await ensureGitActivated();
  if (!gitApi) gitApi = (vscode.extensions.getExtension('vscode.git')!.exports as GitAPI).getAPI(1);
  return gitApi;
}

async function getRepo(): Promise<Repository | null> {
  const api = await getGitApi();
  return api?.repositories?.[0] ?? null;
}

async function waitForRepo(timeoutMs = 8000): Promise<Repository> {
  const api = await getGitApi();
  if (!api) throw new Error('Git API unavailable');
  if (api.repositories?.[0]) return api.repositories[0];

  const openEvt: vscode.Event<any> | undefined = (api as any).onDidOpenRepository;
  if (openEvt) {
    return await new Promise<Repository>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub?.dispose();
        if (api.repositories?.[0]) resolve(api.repositories[0]);
        else reject(new Error('No Git repository detected (timeout)'));
      }, timeoutMs);
      const sub = openEvt((repo: Repository) => {
        clearTimeout(timer); sub?.dispose(); resolve(repo);
      });
    });
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (api.repositories?.[0]) return api.repositories[0];
    await delay(200);
  }
  throw new Error('No Git repository detected (timeout)');
}

/* ================ Utils ================ */
const debounce = <T extends (...a: any[]) => any>(fn: T, ms: number) => {
  let t: NodeJS.Timeout | undefined;
  return (...args: Parameters<T>) => { if (t) clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runGit(args: string[], cwd: string): Promise<void> {
  const api = await getGitApi();
  const gitPath = api?.git?.path || 'git';
  await new Promise<void>((resolve, reject) => {
    const ps = spawn(gitPath, args, { cwd, stdio: 'ignore' });
    ps.on('error', reject);
    ps.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')} exited ${code}`))
    );
  });
}

const relPath = (root: vscode.Uri | undefined, u: vscode.Uri) =>
  root ? path.relative(root.fsPath, u.fsPath) || path.basename(u.fsPath) : u.fsPath;

const toUri = (c: any): vscode.Uri | null => {
  if (c?.resourceUri instanceof vscode.Uri) return c.resourceUri;
  if (c?.uri instanceof vscode.Uri) return c.uri;
  if (typeof c?.uri === 'string') return vscode.Uri.parse(c.uri);
  return null;
};

const isRenamed = (s: any, c: any) =>
  Boolean(c?.renameUri) || /RENAMED/i.test(String(s ?? ''));

const statusRules: Array<{ test: (s: any, c: any) => boolean; code: UiChange['status'] }> = [
  { test: isRenamed, code: 'R' },
  { test: (s) => /UNTRACKED|INTENT_TO_ADD/i.test(String(s ?? '')), code: '??' },
  { test: (s) => /(^|_)ADDED($|_)/i.test(String(s ?? '')) || /(^| )ADDED( |$)/i.test(String(s ?? '')), code: 'A' },
  { test: (s) => /(^|_)DELETED($|_)/i.test(String(s ?? '')) || /(^| )DELETED( |$)/i.test(String(s ?? '')), code: 'D' },
  { test: (s) => /BOTH_|ADDED_BY_|DELETED_BY_/i.test(String(s ?? '')), code: 'U' },
  { test: () => true, code: 'M' },
];

const mapStatus = (change: any): UiChange['status'] =>
  (statusRules.find(r => r.test(change?.status, change))?.code) ?? 'M';

async function getCurrentBranch(): Promise<string> {
  try { return (await getRepo())?.state?.HEAD?.name ?? ''; } catch { return ''; }
}

/* ================ State ================= */
async function collectState(): Promise<UiState> {
  try {
    const repo = await getRepo();
    const root = repo?.rootUri;
    const head = repo?.state?.HEAD;
    const branch = head?.name ?? '';
    const upstream = head?.upstream?.name ?? null;

    const idx = Array.isArray(repo?.state?.indexChanges) ? repo!.state!.indexChanges : [];
    const work = Array.isArray(repo?.state?.workingTreeChanges) ? repo!.state!.workingTreeChanges : [];

    const byUri = new Map<string, { change: any; staged: boolean }>();
    for (const c of work) {
      const u = toUri(c);
      if (u) byUri.set(u.toString(), { change: c, staged: false });
    }
    for (const c of idx) {
      const u = toUri(c);
      if (u) byUri.set(u.toString(), { change: c, staged: true });
    }

    const changes: UiChange[] = [...byUri.entries()].map(([u, { change, staged }]) => {
      const uri = vscode.Uri.parse(u);
      return { uri: u, path: relPath(root, uri), staged, status: mapStatus(change) };
    });

    return {
      repoPath: root?.fsPath ?? '',
      branch,
      upstream,
      changes,
      canCommit: true,
      lastStatus: 'Ready',
    };
  } catch (e) {
    return {
      repoPath: '',
      branch: '',
      upstream: null,
      changes: [],
      canCommit: false,
      lastStatus: (e as any)?.message ?? 'Error',
    };
  }
}

async function collectStateStable(totalTimeoutMs = 8000, settleMs = 350): Promise<UiState> {
  const repo = await waitForRepo(totalTimeoutMs);
  const once = new Promise<void>(resolve => {
    const d = repo.state.onDidChange(() => { d.dispose(); resolve(); });
  });
  await vscode.commands.executeCommand('git.refresh');
  await Promise.race([once, delay(settleMs)]);
  return collectState();
}

/* ================ Guards ================ */
const guards = {
  async validateCommitMessage(msg: string) {
    const message = (msg ?? '').trim();
    if (!message) throw new Error('Message is required');
    const { wipGuard, blockOnMain } = getSettings();
    if (wipGuard && /(^|\s)wip(\s|$)/i.test(message)) throw new Error('WIP is blocked by settings');
    if (blockOnMain) {
      const branch = await getCurrentBranch();
      if (/^(main|master)$/.test(branch)) {
        const ok = await vscode.window.showInformationMessage(
          `Commit on ${branch}?`,
          { modal: true },
          'Yes', 'No'
        );
        if (ok !== 'Yes') throw new Error('Commit cancelled');
      }
    }
    return message;
  },

  async ensureHasStaged(): Promise<void> {
    const st = await collectState();
    const has = st.changes.some(c => c.staged);
    if (!has) throw new Error('No staged changes. Stage files (checkbox) or click "Stage All".');
  },
};

/* ================ Handlers ================ */
type Handler = (m: any, post: (e: UiEvent) => void) => Thenable<any> | void;

function createHandlers(): Record<UiMsg['type'], Handler> {
  const doCommit = async (message: string) => {
    await guards.ensureHasStaged();
    const repo = await waitForRepo();
    if (typeof (repo as any).commit === 'function') {
      await (repo as any).commit(message, { all: false, amend: false });
    } else {
      await vscode.commands.executeCommand('git.commit', message);
    }
  };

  const doPush = async () => {
    const repo = await getRepo();
    const head = repo?.state?.HEAD;
    const hasUpstream = !!head?.upstream?.name;
    if (!repo || typeof (repo as any).push !== 'function' || !hasUpstream) {
      await vscode.commands.executeCommand('git.push');
      return;
    }
    await (repo as any).push();
  };

  return {
    commit: async (m: { message: string }) => {
      const msg = await guards.validateCommitMessage(m.message);
      await doCommit(msg);
    },

    push: async () => {
      await doPush();
    },

    commitPush: async (m: { message: string }) => {
      const msg = await guards.validateCommitMessage(m.message);
      await doCommit(msg);
      await doPush();
    },

    stageAll: async () => {
      const repo = await waitForRepo().catch<Repository | null>(() => null);
      if (!repo) return;
      const st = await collectState();
      const allPaths = st.changes.filter(c => !c.staged).map(c => path.join(st.repoPath, c.path));
      if (allPaths.length) await repo.add(allPaths);
    },

    unstageAll: async () => {
      const repo = await waitForRepo().catch<Repository | null>(() => null);
      if (!repo) return;
      await runGit(['reset', '-q', 'HEAD', '--', '.'], repo.rootUri.fsPath);
    },

    discardAll: async () => {
      const ok = await vscode.window.showInformationMessage(
        'Discard ALL working changes?', { modal: true }, 'Yes', 'No'
      );
      if (ok !== 'Yes') return;
      const repo = await waitForRepo().catch<Repository | null>(() => null);
      if (!repo) return;
      const st = await collectState();
      const untracked = st.changes.filter(c => c.status === '??').map(c => path.join(st.repoPath, c.path));
      const tracked = st.changes.filter(c => c.status !== '??').map(c => path.join(st.repoPath, c.path));
      if (untracked.length) await repo.clean(untracked);
      if (tracked.length) await repo.revert(tracked);
    },

    toggleStageFile: async (m: { uri: string; toStage: boolean }) => {
      const repo = await waitForRepo().catch<Repository | null>(() => null);
      if (!repo) return;
      const file = vscode.Uri.parse(m.uri);
      const table: Record<string, () => Promise<void>> = {
        true: () => repo.add([file.fsPath]),
        false: () =>
          runGit(
            ['reset', '-q', 'HEAD', '--', path.relative(repo.rootUri.fsPath, file.fsPath)],
            repo.rootUri.fsPath
          ),
      };
      await table[String(!!m.toStage)]();
    },

    discardFile: async (m: { uri: string }) => {
      const repo = await waitForRepo().catch<Repository | null>(() => null);
      if (!repo) return;
      const st = await collectState();
      const row = st.changes.find(c => c.uri === m.uri);
      if (!row) return;
      const filePath = path.join(st.repoPath, row.path);
      const ok = await vscode.window.showInformationMessage(
        `Discard changes in ${row.path}?`, { modal: true }, 'Yes', 'No'
      );
      if (ok !== 'Yes') return;
      if (row.status === '??') await repo.clean([filePath]); else await repo.revert([filePath]);
    },

    openDiff: async (m: { uri: string }) => {
      const api = await getGitApi(); if (!api) return;
      const st = await collectState();
      const row = st.changes.find(c => c.uri === m.uri);
      const u = vscode.Uri.parse(m.uri);
      if (row?.status === '??') { await vscode.commands.executeCommand('vscode.open', u); return; }
      const left = api.toGitUri(u, 'HEAD');
      const title = `${path.basename(u.fsPath)} (HEAD ↔ Working Tree)`;
      await vscode.commands.executeCommand('vscode.diff', left, u, title);
    },

    requestState: async (_m, post) => {
      try {
        const state = await collectStateStable(8000, 350);
        post({ type: 'state', state });
        post({ type: 'status', text: 'Ready' });
      } catch {
        post({ type: 'state', state: { repoPath: '', branch: '', upstream: null, changes: [], canCommit: false, lastStatus: 'No repository' } });
        post({ type: 'status', text: 'No repository' });
      }
    },
  };
}

/* ================ Webview Provider ================ */
class PushGoViewProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'pushGo.sidebar';
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    try {
      const { webview } = webviewView;
      webview.options = { enableScripts: true };
      webview.html = getHtml(webview);

      const handlers = createHandlers();
      const post = (e: UiEvent) => webview.postMessage(e);

      post({ type: 'status', text: 'Loading…' });

      webview.onDidReceiveMessage(
        async (m: UiMsg) => {
          try {
            await handlers[m.type]?.(m as any, post);
            if (m.type !== 'requestState') {
              post({ type: 'state', state: await collectStateStable(8000, 200) });
              post({ type: 'ok', action: m.type });
            }
          } catch (e: any) {
            const msg = e?.message ?? String(e);
            console.error('[Push&Go] onDidReceiveMessage error:', e);
            vscode.window.showErrorMessage(`Push&Go: ${msg}`);
            post({ type: 'error', action: (m as any).type, message: msg });
          }
        },
        undefined,
        this.context.subscriptions
      );

      (async () => {
        try {
          const api = await getGitApi();
          const repoNow = api?.repositories?.[0];
          const emitState = debounce(async () => {
            try { post({ type: 'state', state: await collectState() }); }
            catch (e: any) { post({ type: 'status', text: e?.message ?? 'Update error' }); }
          }, 250);

          if (repoNow) {
            const sub = repoNow.state.onDidChange(() => emitState());
            this.context.subscriptions.push(sub);
          }

          const openEvt: vscode.Event<any> | undefined = (api as any)?.onDidOpenRepository;
          if (openEvt) {
            const disp = openEvt(async () => { await emitState(); });
            this.context.subscriptions.push(disp as any);
          }
        } catch (e: any) {
          console.error('[Push&Go] subscribe error:', e);
        }
      })();

      (async () => {
        try {
          const state = await collectStateStable(8000, 350);
          post({ type: 'state', state });
          post({ type: 'status', text: 'Ready' });
        } catch {
          post({ type: 'status', text: 'No repository' });
        }
      })();

      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) handlers.requestState?.({ type: 'requestState' }, post);
      });

    } catch (e: any) {
      const { webview } = webviewView;
      const msg = e?.message ?? String(e);
      console.error('[Push&Go] resolveWebviewView fatal:', e);
      webview.options = { enableScripts: true };
      webview.html = `<!doctype html>
        <meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none';">
        <style>body{font:13px/1.4 ui-sans-serif,system-ui;-webkit-font-smoothing:antialiased;margin:0;padding:16px;background:#1e1e1e;color:#eee}</style>
        <h3>Push&Go</h3>
        <p>❌ Init error: <code>${escapeHtml(msg)}</code></p>`;
      function escapeHtml(s: string) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
      }
    }
  }
}

/* ================ Entry ================ */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PushGoViewProvider.VIEW_ID, new PushGoViewProvider(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pushGo.open', async () => {
      await ensureGitActivated();
      await vscode.commands.executeCommand('workbench.view.extension.pushGo');
    })
  );

  const handlers = createHandlers();
  const postNoop = (_: UiEvent) => {};

  context.subscriptions.push(
    vscode.commands.registerCommand('pushGo.commit', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Commit message',
        placeHolder: 'Required…',
        validateInput: v => (!v?.trim() ? 'Message is required' : undefined),
      });
      if (!message) return;
      await handlers.commit({ message }, postNoop);
    }),
    vscode.commands.registerCommand('pushGo.commitPush', async () => {
      const message = await vscode.window.showInputBox({
        prompt: 'Commit message',
        placeHolder: 'Required…',
        validateInput: v => (!v?.trim() ? 'Message is required' : undefined),
      });
      if (!message) return;
      await handlers.commitPush({ message }, postNoop);
    })
  );
}

export function deactivate() {}

/* ================ HTML (webview) ================ */
function getHtml(webview: vscode.Webview): string {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  return /* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy"
        content="
          default-src 'none';
          img-src ${webview.cspSource} https: data:;
          style-src ${webview.cspSource} 'unsafe-inline';
          script-src 'nonce-${nonce}';
          font-src ${webview.cspSource};
          connect-src ${webview.cspSource};
        ">
  <style>
    :root { --pad:12px; --bg:#0f1115; --fg:#e5e7eb; --muted:#9aa0a6; --bd:#2a2f3a; }
    html,body { height:100%; }
    body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.4 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto; display:flex; flex-direction:column; }
    header { display:flex; gap:8px; align-items:center; padding:var(--pad); border-bottom:1px solid var(--bd); }
    .muted { color:var(--muted); }
    .link { text-decoration: underline; cursor:pointer; }
    .bd { border-top:1px solid var(--bd); }
    .row { display:flex; align-items:center; gap:8px; padding:6px 0; }
    .file { flex:1; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chips { font-size:11px; opacity:.8; }
    button { padding:8px 10px; border-radius:10px; border:1px solid var(--bd); background:#151a22; color:inherit; cursor:pointer; }
    button:disabled { opacity:0.5; cursor:not-allowed; }

    /* Layout: changes first (scroll) + commit pane always visible */
    .changesWrap { padding:0 var(--pad); flex:1; overflow:auto; }
    .changesHead { display:flex; align-items:center; gap:8px; padding: var(--pad) var(--pad) 6px; }
    .actions { margin-left:auto; display:flex; gap:12px; }

    .group { margin: 8px 0 14px; }
    .groupHeader { display:flex; align-items:center; justify-content:space-between; cursor:pointer; padding:6px 4px; }
    .groupTitle { font-weight:600; }
    .groupCount { font-size:12px; color:var(--muted); }
    .groupBody { margin-top:6px; }

    .commitPane { padding: var(--pad); border-top:1px solid var(--bd); background: rgba(15,17,21,0.98); }
    .commitBar { display:flex; gap:8px; align-items:center; margin-bottom:8px; flex-wrap:wrap; }
    textarea { width:100%; min-height:68px; padding:10px; border-radius:10px; border:1px solid var(--bd); background:transparent; color:inherit; outline:none; }
    .status { font-size:12px; color:var(--muted); padding: 6px var(--pad) var(--pad); }
    .empty { padding:8px; color:var(--muted); font-style:italic; }
  </style>
</head>
<body>
  <header><strong>Push&Go</strong><span class="muted">&nbsp;– Commit / Push fast</span></header>

  <!-- CHANGES (scrolls) -->
  <div class="changesWrap">
    <div class="changesHead bd">
      <div class="muted">Changes</div>
      <div class="actions">
        <span id="stageAll" class="link">Stage All</span>
        <span id="unstageAll" class="link">Unstage All</span>
        <span id="discardAll" class="link">Discard All</span>
      </div>
    </div>

    <div id="groups">
      <div class="empty" style="padding:8px ${webview.cspSource ? '0' : '0'};">Loading…</div>
    </div>
  </div>

  <!-- COMMIT (always visible) -->
  <div class="commitPane">
    <div class="commitBar">
      <button id="commit" disabled>Commit</button>
      <button id="push">Push</button>
      <button id="commitPush" disabled>Commit & Push</button>
    </div>
    <div class="muted" style="margin-bottom:6px;">Commit message *</div>
    <textarea id="msg" placeholder="Required…"></textarea>
  </div>

  <div class="status" id="status">Loading…</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    // Persist group collapsed state in VS Code webview state
    const persisted = vscode.getState() || {};
    const collapsed = persisted.collapsed || { staged: false, unstaged: false };

    let isReady = false;
    let didInitialRefresh = false;
    let lastState = null;

    const setStatus = (t) => {
      $('status').textContent = t || '';
      if (t === 'Ready') {
        const first = !isReady;
        isReady = true;
        if (lastState) render(lastState);
        if (first && !didInitialRefresh) { didInitialRefresh = true; vscode.postMessage({ type: 'requestState' }); }
        return;
      }
      isReady = false;
      $('groups').innerHTML = '<div class="empty">Loading…</div>';
    };

    const send = (type, extra={}) => vscode.postMessage({ type, ...extra });

    const recomputeCommitButtons = () => {
      const hasMsg = !!$('msg').value.trim();
      const hasStaged = !!(lastState?.changes?.some(c => c.staged));
      $('commit').disabled = !(hasMsg && hasStaged);
      $('commitPush').disabled = !(hasMsg && hasStaged);
      if (!hasMsg) $('status').textContent = 'Message is required';
      else if (!hasStaged) $('status').textContent = 'Stage at least one file to commit';
      else $('status').textContent = 'Ready';
    };

    $('msg').addEventListener('input', () => recomputeCommitButtons());
    $('commit').onclick     = () => send('commit',     { message: $('msg').value.trim() });
    $('push').onclick       = () => send('push');
    $('commitPush').onclick = () => send('commitPush', { message: $('msg').value.trim() });

    $('stageAll').onclick   = () => send('stageAll');
    $('unstageAll').onclick = () => send('unstageAll');
    $('discardAll').onclick = () => send('discardAll');

    const makeGroup = (key, title, items) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'group';

      const head = document.createElement('div');
      head.className = 'groupHeader';
      const t = document.createElement('div');
      t.className = 'groupTitle';
      t.textContent = title;
      const count = document.createElement('div');
      count.className = 'groupCount';
      count.textContent = items.length.toString();
      head.appendChild(t); head.appendChild(count);
      wrapper.appendChild(head);

      const body = document.createElement('div');
      body.className = 'groupBody';
      wrapper.appendChild(body);

      const toggle = () => {
        collapsed[key] = !collapsed[key];
        vscode.setState({ ...vscode.getState(), collapsed });
        body.style.display = collapsed[key] ? 'none' : 'block';
      };
      head.onclick = toggle;

      body.style.display = collapsed[key] ? 'none' : 'block';

      if (!items.length) {
        body.innerHTML = '<div class="empty">No files</div>';
        return wrapper;
      }

      items.forEach(ch => {
        const row = document.createElement('div'); row.className = 'row';

        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!ch.staged;
        cb.onchange = () => send('toggleStageFile', { uri: ch.uri, toStage: cb.checked });

        const file = document.createElement('div');
        file.className = 'file';
        file.textContent = ch.path;
        file.title = ch.uri;
        file.onclick = () => send('openDiff', { uri: ch.uri });

        const chips = document.createElement('div'); chips.className = 'chips muted'; chips.textContent = ch.status;

        const discard = document.createElement('button'); discard.textContent = 'Discard';
        discard.onclick = () => send('discardFile', { uri: ch.uri });

        row.appendChild(cb); row.appendChild(file); row.appendChild(chips); row.appendChild(discard);
        body.appendChild(row);
      });

      return wrapper;
    };

    function render(state) {
      lastState = state;
      const box = $('groups');
      if (!isReady) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }

      const staged   = (state.changes || []).filter(c => c.staged);
      const unstaged = (state.changes || []).filter(c => !c.staged);

      box.innerHTML = '';
      // Staged first
      [
        { key: 'staged',   title: 'Staged',   items: staged   },
        { key: 'unstaged', title: 'Unstaged', items: unstaged },
      ].forEach(g => box.appendChild(makeGroup(g.key, g.title, g.items)));

      recomputeCommitButtons();
    }

    window.addEventListener('message', (ev) => {
      const msg = ev.data || {};
      const table = {
        state:  () => { render(msg.state); },
        status: () => { setStatus(msg.text || ''); if (msg.text === 'No repository') $('groups').innerHTML = '<div class="empty">No Git repository in workspace</div>'; },
        ok:     () => { $('status').textContent = '✓ ' + msg.action + ' done'; },
        error:  () => { $('status').textContent = '⚠ ' + (msg.message || 'Error'); }
      };
      table[msg.type]?.();
    });

    $('groups').innerHTML = '<div class="empty">Loading…</div>';
    $('status').textContent = 'Loading…';
    vscode.postMessage({ type: 'requestState' });
  </script>
</body>
</html>`;
}
