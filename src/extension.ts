import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

/* =============== Git bootstrap =============== */

let gitApi: any | undefined;

async function ensureGitApi(): Promise<any | undefined> {
  if (gitApi) return gitApi;
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return undefined;
  if (!ext.isActive) {
    try { await ext.activate(); } catch { /* ignore */ }
  }
  // VS Code Git API v1
  gitApi = ext.exports?.getAPI?.(1);
  return gitApi;
}

async function waitForRepo(timeoutMs = 2500): Promise<any | undefined> {
  const api = await ensureGitApi();
  if (!api) return undefined;
  if (api.repositories.length) return api.repositories[0];

  return new Promise(resolve => {
    const to = setTimeout(() => {
      openSub.dispose();
      resolve(api.repositories[0]);
    }, timeoutMs);
    const openSub = api.onDidOpenRepository(() => {
      clearTimeout(to);
      openSub.dispose();
      resolve(api.repositories[0]);
    });
  });
}

function bestRepo(api: any): any | undefined {
  const repos: any[] = api?.repositories ?? [];
  if (!repos.length) return undefined;

  const file = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (file) {
    // בוחר את הרפו שהשורש שלו הכי "עמוק" בקובץ הפעיל
    const ranked = repos
      .filter(r => file.startsWith(r.rootUri.fsPath))
      .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
    if (ranked[0]) return ranked[0];
  }
  return repos[0];
}

/* =============== Utils =============== */

const SETTINGS = {
  wipGuard: 'pushGo.enableWipGuard',
  blockOnMain: 'pushGo.blockCommitOnMain',
} as const;

const out = vscode.window.createOutputChannel('Push&Go');

function log(...a: any[]) { out.appendLine(a.map(String).join(' ')); }

function runGit(args: string[], cwd: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ps = spawn('git', args, { cwd });
    let out = '', err = '';
    ps.stdout.on('data', d => (out += d.toString()));
    ps.stderr.on('data', d => (err += d.toString()));
    if (input) { ps.stdin.write(input); ps.stdin.end(); }
    ps.on('error', reject);
    ps.on('close', code => code === 0 ? resolve(out.trim())
      : reject(new Error(err.trim() || `git ${args.join(' ')} exited ${code}`)));
  });
}

async function getBranch(cwd: string) {
  try { return await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd); }
  catch { return ''; }
}

type UiChange = {
  path: string; full: string;
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '??';
  staged: boolean;
};
type UiState = { staged: UiChange[]; unstaged: UiChange[] };

const mapStatus = (s: any, c: any): UiChange['status'] => {
  const t = String(s ?? '');
  if (c?.renameUri || /RENAMED/i.test(t)) return 'R';
  if (/UNTRACKED|INTENT_TO_ADD/i.test(t)) return '??';
  if (/(^|_)ADDED($|_)/i.test(t) || /(^| )ADDED( |$)/i.test(t)) return 'A';
  if (/(^|_)DELETED($|_)/i.test(t) || /(^| )DELETED( |$)/i.test(t)) return 'D';
  if (/BOTH_|ADDED_BY_|DELETED_BY_/i.test(t)) return 'U';
  return 'M';
};

function toUiChange(repo: any, change: any, staged: boolean): UiChange {
  const full = change?.uri?.fsPath ?? '';
  const rel = full ? path.relative(repo.rootUri.fsPath, full).replace(/\\/g, '/') : '';
  return { path: rel || full || '(unknown)', full, status: mapStatus(change?.status, change), staged };
}

async function collectState(): Promise<UiState> {
  const api = await ensureGitApi();
  const repo = bestRepo(api) ?? await waitForRepo();
  if (!repo) {
    log('collectState: no repo yet');
    return { staged: [], unstaged: [] };
  }
  const staged = (repo.state?.indexChanges ?? []).map((c: any) => toUiChange(repo, c, true));
  const unstaged = (repo.state?.workingTreeChanges ?? []).map((c: any) => toUiChange(repo, c, false));
  log(`collectState: staged=${staged.length}, unstaged=${unstaged.length}, root=${repo.rootUri.fsPath}`);
  return { staged, unstaged };
}

/* =============== Extension entry =============== */

export function activate(context: vscode.ExtensionContext) {
  out.show(true); // תיעוד זמין
  const provider = new PushGoViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PushGoViewProvider.VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('pushGo.open', () => vscode.commands.executeCommand('workbench.view.extension.pushGo')),
    vscode.commands.registerCommand('pushGo.commit', () => handlers.commitCommand()),
    vscode.commands.registerCommand('pushGo.commitPush', () => handlers.commitPushCommand()),
  );
}

export function deactivate() {}

class PushGoViewProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'pushGo.sidebar';
  private webview?: vscode.Webview;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  postToView(msg: any) { this.webview?.postMessage(msg); }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    this.webview = webview;
    webview.options = { enableScripts: true };
    webview.html = getHtml();

    const post = (e: any) => webview.postMessage(e);
    const pushState = async () => post({ type: 'state', state: await collectState() });

    // מסרים מה־UI
    webview.onDidReceiveMessage(async (m: any) => {
      try {
        await (handlers[m?.type] ?? (async () => {}))(m);
        if (m?.type !== 'requestState') { await pushState(); post({ type: 'ok', action: m?.type }); }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        vscode.window.showErrorMessage(`Push&Go: ${msg}`);
        post({ type: 'error', action: m?.type, message: msg });
      }
    }, undefined, this.ctx.subscriptions);

    // רענון ע״פ אירועים
    (async () => {
      const api = await ensureGitApi();
      const repo = bestRepo(api) ?? await waitForRepo();

      const subs: vscode.Disposable[] = [];
      if (repo?.state?.onDidChange) subs.push(repo.state.onDidChange(() => void pushState()));
      if (api?.onDidOpenRepository) subs.push(api.onDidOpenRepository(() => void pushState()));
      if (api?.onDidCloseRepository) subs.push(api.onDidCloseRepository(() => void pushState()));
      subs.push(vscode.window.onDidChangeActiveTextEditor(() => void pushState()));
      subs.push(vscode.workspace.onDidSaveTextDocument(() => void pushState()));
      this.ctx.subscriptions.push(...subs);

      // שליחה ראשונית + עדכון ידני
      setTimeout(() => void pushState(), 0);
    })();
  }
}

/* =============== Webview (compact UI) =============== */

function getHtml() {
  return /* html */ `
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
:root{
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --bg: var(--vscode-sideBar-background);
  --panel: var(--vscode-editor-background);
  --border: var(--vscode-panel-border, #2a2a2a);
  --accent: var(--vscode-button-background);
  --accent-ctrl: var(--vscode-button-foreground);
  --font: var(--vscode-font-family, ui-sans-serif, system-ui);
  --fs-12: 12px; --fs-11: 11px;
  --radius: 6px; --gap: 8px;
  --row-h: 26px; --btn-h: 24px;
}
*{ box-sizing:border-box; } html,body{ height:100%; }
body{ margin:0; color:var(--fg); background:var(--bg); font: normal var(--fs-12)/1.4 var(--font); }
.wrap{ display:grid; grid-template-rows:auto auto 1fr auto; height:100%; }

/* counts row */
.countsRow{ padding:8px 10px 4px; border-bottom:1px solid var(--border); color:var(--muted); }
/* actions row (each link בשורה משלה) */
.actions{ padding:4px 10px 8px; border-bottom:1px solid var(--border); display:flex; flex-direction:column; gap:6px; }
.link{ text-decoration:none; color:var(--fg); opacity:.9; font-size:var(--fs-11); }
.link:hover{ text-decoration:underline; }

/* list area */
.main{ overflow:auto; padding:10px; }
.group{ margin-top: 6px; }
.ttl{ margin:6px 0; font-weight:600; font-size:12px; display:flex; gap:8px; align-items:center; }
.empty{ color:var(--muted); font-style:italic; padding:6px 0 8px; }

.list{ display:flex; flex-direction:column; gap:2px; }
.row{
  display:grid; grid-template-columns:18px 1fr auto auto; align-items:center;
  min-height:var(--row-h); border-radius:var(--radius); padding:0 6px; border:1px solid transparent;
}
.row:hover{ background: color-mix(in oklab, var(--panel) 70%, transparent); border-color:var(--border); }
.chk{ width:14px; height:14px; }
.name{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; padding-right:6px; }
.badge{ font-size:var(--fs-11); color:var(--muted); padding:0 6px; }

/* buttons */
.btn{
  height:var(--btn-h); padding:0 10px; border-radius:var(--radius);
  border:1px solid var(--border); background:transparent; color:var(--fg);
  font-size:var(--fs-12); cursor:pointer;
}
.btn:hover{ filter:brightness(1.05); }
.btn.primary{ background:var(--accent); color:var(--accent-ctrl); border-color:transparent; font-weight:600; }
.btn.sm{ height:20px; padding:0 6px; font-size:var(--fs-11); color:var(--muted); }

/* footer */
.ftr{ position:sticky; bottom:0; border-top:1px solid var(--border); padding:8px 10px; background:var(--bg); }
.btns{ display:flex; gap:8px; flex-wrap:wrap; }
textarea{
  width:100%; min-height:64px; max-height:140px; resize:vertical;
  border-radius:var(--radius); border:1px solid var(--border);
  background:var(--panel); color:var(--fg); padding:8px;
  font: normal var(--fs-12)/1.4 var(--font);
}
</style>
</head>
<body>
  <div class="wrap">
    <div class="countsRow"><span id="counts">0 staged · 0 unstaged</span></div>
    <div class="actions">
      <a class="link" href="#" data-action="stageAll">Stage All</a>
      <a class="link" href="#" data-action="unstageAll">Unstage All</a>
      <a class="link" href="#" data-action="discardAll">Discard All</a>
      <a class="link" href="#" data-action="refresh">Refresh</a>
    </div>

    <div class="main">
      <div class="group">
        <div class="ttl">Staged <span id="stagedCount" style="color:var(--muted)"></span></div>
        <div id="stagedList" class="list"><div class="empty">No files</div></div>
      </div>
      <div class="group">
        <div class="ttl">Unstaged <span id="unstagedCount" style="color:var(--muted)"></span></div>
        <div id="unstagedList" class="list"><div class="empty">No files</div></div>
      </div>
    </div>

    <div class="ftr">
      <div class="btns">
        <button class="btn" data-action="commit">Commit</button>
        <button class="btn" data-action="push">Push</button>
        <button class="btn primary" data-action="commitPush">Commit &amp; Push</button>
      </div>
      <label style="color:var(--muted); font-size:11px; display:block; margin-top:6px;">Commit message *</label>
      <textarea id="msg" placeholder="Required…"></textarea>
    </div>
  </div>

<script>
const vscode = acquireVsCodeApi();
const $ = (s, r=document) => r.querySelector(s);
const post = (type, payload={}) => vscode.postMessage({ type, ...payload });

const makeRow = (item) => {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = \`
    <input class="chk" type="checkbox" \${item.staged ? 'checked' : ''} data-path="\${item.path}" aria-label="stage-toggle" />
    <div class="name" title="\${item.full}" data-action="openDiff" data-path="\${item.path}">\${item.path}</div>
    <span class="badge">\${item.status}</span>
    <button class="btn sm" data-action="discard" data-path="\${item.path}">Discard</button>
  \`;
  return el;
};

function render(state){
  const staged = state?.staged ?? [];
  const unstaged = state?.unstaged ?? [];
  const stageList = $('#stagedList'), unList = $('#unstagedList');
  const sc = $('#stagedCount'), uc = $('#unstagedCount'), counts = $('#counts');

  const paint = (node, items) => {
    node.innerHTML = '';
    if(!items.length){ node.innerHTML = '<div class="empty">No files</div>'; return; }
    items.forEach(i => node.appendChild(makeRow(i)));
  };

  paint(stageList, staged);
  paint(unList, unstaged);
  sc.textContent = staged.length;
  uc.textContent = unstaged.length;
  counts.textContent = \`\${staged.length} staged · \${unstaged.length} unstaged\`;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if(!a) return;
  e.preventDefault();
  const act = a.getAttribute('data-action');
  ({
    refresh:    () => post('requestState'),
    stageAll:   () => post('stageAll'),
    unstageAll: () => post('unstageAll'),
    discardAll: () => post('discardAll'),
    commit:     () => post('commit', { message: $('#msg').value }),
    push:       () => post('push'),
    commitPush: () => post('commitPush', { message: $('#msg').value }),
    discard:    () => post('discard', { path: a.getAttribute('data-path') }),
    openDiff:   () => post('openDiff', { path: a.getAttribute('data-path') }),
  }[act] || (()=>{}))();
});

document.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-path]');
  if(!cb) return;
  const path = cb.getAttribute('data-path');
  post(cb.checked ? 'stageFile' : 'unstageFile', { path });
});

window.addEventListener('message', (ev) => {
  const m = ev.data;
  ({ state: () => render(m.state) }[m.type] || (()=>{}))();
});

post('requestState');
</script>
</body>
</html>
`;
}

/* =============== Handlers =============== */

// המיפוי נשאר עם פרמטר אופציונלי כדי לאפשר קריאות בלי ארגומנט
const handlers: Record<string, (m?: any) => Promise<void>> = {
  requestState: async () => { /* handled per-view */ },

  /* List actions: all */
  stageAll: async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    await runGit(['add', '-A'], repo.rootUri.fsPath);
  },
  unstageAll: async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    await runGit(['reset', '-q', 'HEAD', '--', '.'], repo.rootUri.fsPath);
  },
  discardAll: async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const confirm = await vscode.window.showWarningMessage('Discard ALL local changes? This cannot be undone.', { modal: true }, 'Discard');
    if (confirm !== 'Discard') return;
    try { await runGit(['restore', '--worktree', '--staged', '--source=HEAD', '.'], repo.rootUri.fsPath); }
    catch { await runGit(['checkout', '--', '.'], repo.rootUri.fsPath); }
    await runGit(['clean', '-fd'], repo.rootUri.fsPath);
  },

  /* Per file */
  stageFile: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    await runGit(['add', '--', m.path], repo.rootUri.fsPath);
  },
  unstageFile: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    await runGit(['reset', '-q', 'HEAD', '--', m.path], repo.rootUri.fsPath);
  },
  discard: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const isUntracked = !!(await runGit(['ls-files', '--others', '--exclude-standard', '--', m.path], repo.rootUri.fsPath)).trim();
    if (isUntracked) await runGit(['clean', '-f', '--', m.path], repo.rootUri.fsPath);
    else {
      try { await runGit(['restore', '--worktree', '--staged', '--source=HEAD', '--', m.path], repo.rootUri.fsPath); }
      catch { await runGit(['checkout', '--', m.path], repo.rootUri.fsPath); }
    }
  },

  openDiff: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;

    // בונים את ה-URI של הקובץ הנוכחי
    const abs = path.join(repo.rootUri.fsPath, m.path);
    const fileUri = vscode.Uri.file(abs);

    // מחפשים את ה-change כדי לזהות rename (אם יש)
    const all = [
      ...(repo.state?.indexChanges ?? []),
      ...(repo.state?.workingTreeChanges ?? []),
      ...(repo.state?.mergeChanges ?? []),
    ];
    const changeForFile = all.find((c: any) => c?.uri?.fsPath === fileUri.fsPath);
    const leftFsPath = changeForFile?.renameUri?.fsPath ?? fileUri.fsPath; // אם rename – נשתמש בישן

    // git:URI תקין לפי הפורמט של Git provider (query כ-JSON עם path+ref)
    const left = vscode.Uri.from({
      scheme: 'git',
      path: vscode.Uri.file(leftFsPath).path, // לשם/תצוגה
      query: JSON.stringify({ path: leftFsPath, ref: 'HEAD' }), // לשחזור התוכן מ-HEAD
    });

    const title =
      changeForFile?.renameUri
        ? `${m.path} (from ${path.relative(repo.rootUri.fsPath, changeForFile.renameUri.fsPath)})`
        : m.path;

    await vscode.commands.executeCommand('vscode.diff', left, fileUri, title);
  },

  /* Commit / Push */
  commit: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const message = String(m?.message ?? '').trim();
    if (!message) throw new Error('Commit message is required.');

    const cfg = vscode.workspace.getConfiguration();
    if (cfg.get<boolean>(SETTINGS.wipGuard) && /(^|\s)wip(\s|$)/i.test(message)) {
      throw new Error(`WIP is blocked by settings (${SETTINGS.wipGuard}).`);
    }
    if (cfg.get<boolean>(SETTINGS.blockOnMain)) {
      const b = await getBranch(repo.rootUri.fsPath);
      if (['main', 'master'].includes(b)) {
        const ok = await vscode.window.showWarningMessage(`Commit on "${b}"?`, { modal: true }, 'Commit');
        if (ok !== 'Commit') return;
      }
    }
    await runGit(['commit', '-m', message, '--no-gpg-sign'], repo.rootUri.fsPath);
  },

  push: async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    try { await runGit(['push'], repo.rootUri.fsPath); }
    catch (e: any) {
      if (/no upstream branch/i.test(String(e?.message ?? ''))) {
        const branch = await getBranch(repo.rootUri.fsPath);
        await runGit(['push', '-u', 'origin', branch], repo.rootUri.fsPath);
      } else { throw e; }
    }
  },

  commitPush: async (m) => { await handlers.commit(m); await handlers.push(m); },

  // Command palette helpers (open input box)
  commitCommand: async () => {
    const msg = await vscode.window.showInputBox({
      prompt: 'Commit message', placeHolder: 'Required…',
      validateInput: v => v.trim() ? undefined : 'Message required'
    });
    if (msg) await handlers.commit({ message: msg });
  },
  commitPushCommand: async () => {
    const msg = await vscode.window.showInputBox({
      prompt: 'Commit message', placeHolder: 'Required…',
      validateInput: v => v.trim() ? undefined : 'Message required'
    });
    if (msg) await handlers.commitPush({ message: msg });
  },
};
