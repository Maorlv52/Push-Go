// src/extension.ts
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';

/* =============== Git bootstrap =============== */

let gitApi: any | undefined;
let ctxGlobal: vscode.ExtensionContext | undefined;

async function ensureGitApi(): Promise<any | undefined> {
  if (gitApi) return gitApi;
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return undefined;
  if (!ext.isActive) {
    try { await ext.activate(); } catch { /* ignore */ }
  }
  gitApi = ext.exports?.getAPI?.(1);
  return gitApi;
}

async function getUpstream(cwd: string): Promise<{ remote: string; branch: string } | null> {
  try {
    const s = await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd);
    const [remote, ...rest] = s.split('/');
    const branch = rest.join('/');
    if (!remote || !branch) return null;
    return { remote, branch };
  } catch { return null; }
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
async function hasHead(cwd: string): Promise<boolean> {
  try { await runGit(['rev-parse', '--verify', 'HEAD'], cwd); return true; }
  catch { return false; }
}
async function ensureGitAvailable(): Promise<boolean> {
  try { await runGit(['--version'], process.cwd()); return true; }
  catch {
    vscode.window.showErrorMessage('Push&Go: לא נמצא Git במערכת. התקן Git ודא שהוא זמין ב-PATH.');
    return false;
  }
}

const rel = (root: string, fsPath: string) => path.relative(root, fsPath).replace(/\\/g, '/');
const toPaths = (root: string, uri?: vscode.Uri, uris?: vscode.Uri[]) => {
  const arr = (uris && uris.length ? uris : uri ? [uri] : [])
    .filter(Boolean)
    .map(u => rel(root, u!.fsPath));
  return Array.from(new Set(arr));
};

/* ===== small helpers ===== */
class Debouncer {
  private t: any = null;
  schedule(fn: () => void, ms: number) {
    if (this.t) clearTimeout(this.t);
    this.t = setTimeout(() => { this.t = null; fn(); }, ms);
  }
  cancel() { if (this.t) { clearTimeout(this.t); this.t = null; } }
}

/* ===== Ignored (local) helpers ===== */
function ignoredKey(cwd: string) { return `pushGo.ignored:${cwd}`; }
async function getIgnoredSet(cwd: string): Promise<Set<string>> {
  const arr = ctxGlobal?.workspaceState.get<string[]>(ignoredKey(cwd)) ?? [];
  return new Set(arr);
}
async function saveIgnoredSet(cwd: string, set: Set<string>) {
  await ctxGlobal?.workspaceState.update(ignoredKey(cwd), Array.from(set).sort());
}
async function addIgnored(cwd: string, paths: string[]) {
  const set = await getIgnoredSet(cwd);
  for (const p of paths) set.add(p);
  await saveIgnoredSet(cwd, set);
}
async function removeIgnored(cwd: string, paths: string[]) {
  const set = await getIgnoredSet(cwd);
  for (const p of paths) set.delete(p);
  await saveIgnoredSet(cwd, set);
}

/* remotes helpers */
async function listRemotes(cwd: string): Promise<string[]> {
  try {
    const s = await runGit(['remote'], cwd);
    return s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch { return []; }
}
async function addRemote(cwd: string, name: string, url: string): Promise<void> {
  await runGit(['remote', 'add', name, url], cwd);
}
async function pickOrCreateRemote(cwd: string): Promise<string | undefined> {
  const remotes = await listRemotes(cwd);
  if (remotes.length === 1) return remotes[0];

  const items = [
    ...remotes.map(r => ({ label: r, description: 'Use existing remote' })),
    { label: '+ Add remote…', description: 'Add and push to a new remote' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'בחר remote ל־upstream (git push -u)',
    ignoreFocusOut: true,
  });
  if (!pick) return;

  if (pick.label.startsWith('+')) {
    const defaultName = remotes.includes('origin') ? '' : 'origin';
    const name = await vscode.window.showInputBox({
      prompt: 'Remote name',
      value: defaultName,
      validateInput: v => v.trim() ? undefined : 'Required',
      ignoreFocusOut: true,
    });
    if (!name) return;

    const url = await vscode.window.showInputBox({
      prompt: 'Remote URL (https:// או ssh://)',
      placeHolder: 'https://github.com/you/repo.git או git@github.com:you/repo.git',
      validateInput: v => v.trim() ? undefined : 'Required',
      ignoreFocusOut: true,
    });
    if (!url) return;

    await addRemote(cwd, name.trim(), url.trim());
    return name.trim();
  }
  return pick.label.trim();
}

/* =============== Types for UI =============== */

type UiChange = {
  path: string; full: string;
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '??';
  staged: boolean;
};
type UiState = { staged: UiChange[]; unstaged: UiChange[]; ignored: UiChange[] };

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
  const r = full ? rel(repo.rootUri.fsPath, full) : '';
  return { path: r || full || '(unknown)', full, status: mapStatus(change?.status, change), staged };
}

function dedupeByFull<T extends UiChange>(arr: T[]) {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of arr) {
    const key = `${i.full}|${i.staged}`;
    if (!seen.has(key)) { seen.add(key); out.push(i); }
  }
  return out;
}

async function collectState(): Promise<UiState> {
  const api = await ensureGitApi();
  const repo = bestRepo(api) ?? await waitForRepo();
  if (!repo) {
    log('collectState: no repo yet');
    return { staged: [], unstaged: [], ignored: [] };
  }

  const staged = (repo.state?.indexChanges ?? []).map((c: any) => toUiChange(repo, c, true));
  const unstagedWT = (repo.state?.workingTreeChanges ?? []).map((c: any) => toUiChange(repo, c, false));
  const unstagedMerge = (repo.state?.mergeChanges ?? []).map((c: any) => toUiChange(repo, c, false));
  let unstaged = dedupeByFull([...unstagedWT, ...unstagedMerge]);

  const cwd = repo.rootUri.fsPath;
  const ignoredSet = await getIgnoredSet(cwd);

  const all = [...staged, ...unstaged];
  const ignored = all.filter(i => ignoredSet.has(i.path)).map(i => ({ ...i, staged: false }));
  const ignoredPaths = new Set(ignored.map(i => i.path));

  const stagedF = staged.filter((i: any) => !ignoredPaths.has(i.path));
  const unstagedF = unstaged.filter(i => !ignoredPaths.has(i.path));

  log(`collectState: staged=${stagedF.length}, unstaged=${unstagedF.length}, ignored=${ignored.length}, root=${cwd}`);
  return { staged: stagedF, unstaged: unstagedF, ignored };
}

/* =============== Global UI messaging =============== */

let postToViewGlobal: ((msg: any) => void) | undefined;
function optimistic(msg: any) { postToViewGlobal?.({ type: 'optimistic', ...msg }); }

/* =============== Batch state: prevents flicker =============== */
let _beginBatch: () => void = () => { };
let _endBatch: () => Promise<void> = async () => { };

/* =============== Extension entry =============== */

export function activate(context: vscode.ExtensionContext) {
  ctxGlobal = context; // store for workspaceState
  out.show(true);
  const provider = new PushGoViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PushGoViewProvider.VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('pushGo.open', () => vscode.commands.executeCommand('workbench.view.extension.pushGo')),

    // palette/webview helpers
    vscode.commands.registerCommand('pushGo.commit', () => handlers.commitCommand()),
    vscode.commands.registerCommand('pushGo.commitPush', () => handlers.commitPushCommand()),

    // Explorer commands (work without the webview)
    vscode.commands.registerCommand('pushGo.stageFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => stageFromExplorer(uri, uris)),
    vscode.commands.registerCommand('pushGo.unstageFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => unstageFromExplorer(uri, uris)),
    vscode.commands.registerCommand('pushGo.discardFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => discardFromExplorer(uri, uris)),
    vscode.commands.registerCommand('pushGo.openDiffFile', (uri?: vscode.Uri) => openDiffFromExplorer(uri)),
    vscode.commands.registerCommand('pushGo.commitThisFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => commitThisFromExplorer(uri, uris)),
  );
  void ensureGitAvailable();
}

export function deactivate() { }

class PushGoViewProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_ID = 'pushGo.sidebar';
  private webview?: vscode.Webview;
  private seq = 0;

  constructor(private readonly ctx: vscode.ExtensionContext) { }

  postToView(msg: any) { this.webview?.postMessage(msg); }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    const { webview } = webviewView;
    this.webview = webview;
    webview.options = { enableScripts: true };
    webview.html = getHtml();

    const post = (e: any) => webview.postMessage(e);
    postToViewGlobal = post;

    const pushStateNow = async () => {
      const state = await collectState();
      this.seq++;
      post({ type: 'state', seq: this.seq, state });
    };
    const deb = new Debouncer();

    // batching control
    let suspendCount = 0;
    let pending = false;

    const maybePush = () => {
      if (suspendCount > 0) { pending = true; deb.cancel(); return; }
      deb.schedule(() => void pushStateNow(), 80);
    };

    _beginBatch = () => { suspendCount++; deb.cancel(); };
    _endBatch = async () => {
      suspendCount = Math.max(0, suspendCount - 1);
      if (suspendCount === 0) {
        if (pending) { pending = false; await pushStateNow(); }
      }
    };

    // messages from webview
    webview.onDidReceiveMessage(async (m: any) => {
      try {
        await (handlers[m?.type] ?? (async () => { }))(m);
        post({ type: 'ok', action: m?.type });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        vscode.window.showErrorMessage(`Push&Go: ${msg}`);
        post({ type: 'error', action: m?.type, message: msg });
        await pushStateNow();
      }
    }, undefined, this.ctx.subscriptions);

    // Git events → refresh only if not batching
    (async () => {
      const api = await ensureGitApi();
      const repo = bestRepo(api) ?? await waitForRepo();

      const subs: vscode.Disposable[] = [];
      if (repo?.state?.onDidChange) subs.push(repo.state.onDidChange(() => void maybePush()));
      if ((repo as any)?.onDidRunOperation) subs.push((repo as any).onDidRunOperation(() => void maybePush()));
      if (api?.onDidOpenRepository) subs.push(api.onDidOpenRepository(() => void maybePush()));
      if (api?.onDidCloseRepository) subs.push(api.onDidCloseRepository(() => void maybePush()));
      subs.push(vscode.window.onDidChangeActiveTextEditor(() => void maybePush()));
      subs.push(vscode.workspace.onDidSaveTextDocument(() => void maybePush()));
      subs.push(vscode.workspace.onDidCreateFiles(() => void maybePush()));
      subs.push(vscode.workspace.onDidDeleteFiles(() => void maybePush()));
      subs.push(vscode.workspace.onDidRenameFiles(() => void maybePush()));
      this.ctx.subscriptions.push(...subs);

      setTimeout(() => void pushStateNow(), 0);
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
.countsRow{ padding:8px 10px 4px; border-bottom:1px solid var(--border); color:var(--muted); }
.actions{
  padding:6px 10px 8px;
  border-bottom:1px solid var(--border);
  display:flex;
  gap:6px;
  flex-wrap:wrap;
  align-items:center;
}
.link{ text-decoration:none; color:var(--fg); opacity:.9; font-size:var(--fs-11); }
.link:hover{ text-decoration:underline; }
.main{ overflow:auto; padding:10px; }
.group{ margin-top: 6px; }
.ttl{ margin:6px 0; font-weight:600; font-size:12px; display:flex; gap:8px; align-items:center; }
/* collapsible group header */
.ttl.toggle{
  display:flex; align-items:center; gap:8px;
  padding:0; margin:6px 0; background:transparent; border:0; color:var(--fg);
  font-weight:600; font-size:12px; cursor:pointer;
}
.ttl .chev { 
  margin-right: 6px; 
  transition: transform .15s ease; 
}
.group.collapsed .list{ display:none; }
.group.collapsed .chev{ transform: rotate(-90deg); }

.empty{ color:var(--muted); font-style:italic; padding:6px 0 8px; }
.list{ display:flex; flex-direction:column; gap:2px; }
.row{
  display:grid; grid-template-columns:18px 1fr auto auto auto;
  align-items:center;
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
.btn:hover {
  background: color-mix(in oklab, var(--panel) 88%, transparent);
  border-color: color-mix(in oklab, var(--border) 60%, var(--fg) 40%);
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.05s ease;
}
.btn.primary{ background:var(--accent); color:var(--accent-ctrl); border-color:transparent; font-weight:600; }
.btn.sm{ height:20px; padding:0 6px; font-size:var(--fs-11); color:var(--muted); }
.btn.xs{ height:20px; padding:0 8px; font-size:var(--fs-11); }
.btn.ghost{ background:transparent; color: var(--vscode-foreground); border-color: var(--border); }

/* Clicked/pressed effect */
.btn:active {
  background: color-mix(in oklab, var(--panel) 75%, transparent);
  border-color: var(--accent);
  color: var(--accent-ctrl);
  transform: translateY(1px) scale(0.98);
  transition: none;
}

/* tiny icon buttons */
.iconbtn{
  width:18px; height:18px; border-radius:4px;
  border:1px solid transparent; background:transparent; color:var(--muted);
  display:inline-grid; place-items:center; padding:0; cursor:pointer;
  opacity:.75; transition:opacity .15s, background .15s, border-color .15s, color .15s;
}
.iconbtn svg{ width:13px; height:13px; stroke:currentColor; fill:none; stroke-width:1.6; }
.row:hover .iconbtn{ opacity:.95; border-color:var(--border); background: color-mix(in oklab, var(--panel) 85%, transparent); color:var(--fg); }
.iconbtn:hover{ opacity:1; }

/* footer */
.ftr{ position:sticky; bottom:0; border-top:1px solid var(--border); padding:8px 10px; background:var(--bg); }
.status{ font-size:var(--fs-11); min-height:14px; margin-bottom:6px; color:var(--muted); }
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

    <div class="actions" role="toolbar" aria-label="Changes actions">
      <button class="btn xs ghost" data-action="stageAll">Stage All</button>
      <button class="btn xs ghost" data-action="unstageAll">Unstage All</button>
      <button class="btn xs ghost" data-action="discardAll">Discard All</button>
    </div>

<div class="main">
  <!-- Staged -->
  <div class="group" id="grp-staged" data-group="staged">
    <button class="ttl toggle" type="button" data-action="toggleGroup" data-group="staged" aria-expanded="true">
      <span class="chev" aria-hidden="true">▾</span>
      Staged <span id="stagedCount" style="color:var(--muted)"></span>
    </button>
    <div id="stagedList" class="list"><div class="empty">No files</div></div>
  </div>

  <!-- Unstaged -->
  <div class="group" id="grp-unstaged" data-group="unstaged">
    <button class="ttl toggle" type="button" data-action="toggleGroup" data-group="unstaged" aria-expanded="true">
      <span class="chev" aria-hidden="true">▾</span>
      Unstaged <span id="unstagedCount" style="color:var(--muted)"></span>
    </button>
    <div id="unstagedList" class="list"><div class="empty">No files</div></div>
  </div>

  <!-- Ignored (local) -->
  <div class="group" id="grp-ignored" data-group="ignored">
    <button class="ttl toggle" type="button" data-action="toggleGroup" data-group="ignored" aria-expanded="true">
      <span class="chev" aria-hidden="true">▾</span>
      Ignored (local) <span id="ignoredCount" style="color:var(--muted)"></span>
    </button>
    <div id="ignoredList" class="list"><div class="empty">No files</div></div>
  </div>
</div>



    <div class="ftr">
      <div id="status" class="status" aria-live="polite"></div>
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
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const post = (type, payload={}) => vscode.postMessage({ type, ...payload });
const short = (s) => String(s||'').split('\\n')[0].slice(0, 180);

let state = { staged: [], unstaged: [], ignored: [] };
let lastSeq = 0;

/* ===== overlay for in-flight ops (prevents vanish) ===== */
const overlay = new Map(); // path -> { dest: 'staged'|'unstaged'|'ignored'|'none', item?: any }
const pendingByAction = new Map(); // action -> Array<Array<path>>
const opToDest = (op) =>
  op.startsWith('stage') ? 'staged'
  : op.startsWith('unstage') ? 'unstaged'
  : op.startsWith('ignore') ? 'ignored'
  : op.startsWith('unignore') ? 'unstaged'
  : 'none';
const pushPending = (action, paths) => {
  const arr = pendingByAction.get(action) || [];
  arr.push(paths);
  pendingByAction.set(action, arr);
};
const popPending = (action) => {
  const arr = pendingByAction.get(action) || [];
  const item = arr.pop() || [];
  if (arr.length) pendingByAction.set(action, arr); else pendingByAction.delete(action);
  return item;
};

/* keep last-seen item snapshot by path so we can synthesize rows */
const snapshot = new Map(); // path -> item
function updateSnapshot(s){
  for(const i of (s.staged||[]))   snapshot.set(i.path, i);
  for(const i of (s.unstaged||[])) snapshot.set(i.path, i);
  for(const i of (s.ignored||[]))  snapshot.set(i.path, i);
}

/* === equality check === */
const _norm = (arr=[]) => arr.map(i=>({full:i.full, path:i.path, status:i.status, staged:!!i.staged}))
  .sort((a,b)=> a.full.localeCompare(b.full) || (a.staged===b.staged?0:(a.staged?1:-1)) || a.status.localeCompare(b.status));
function equalState(a, b){
  if(!a||!b) return false;
  const as=_norm(a.staged), au=_norm(a.unstaged), ai=_norm(a.ignored||[]);
  const bs=_norm(b.staged), bu=_norm(b.unstaged), bi=_norm((b.ignored)||[]);
  if(as.length!==bs.length || au.length!==bu.length || ai.length!==bi.length) return false;
  for(let i=0;i<as.length;i++){ const x=as[i], y=bs[i]; if(x.full!==y.full||x.staged!==y.staged||x.status!==y.status) return false; }
  for(let i=0;i<au.length;i++){ const x=au[i], y=bu[i]; if(x.full!==y.full||x.staged!==y.staged||x.status!==y.status) return false; }
  for(let i=0;i<ai.length;i++){ const x=ai[i], y=bi[i]; if(x.full!==y.full||x.staged!==y.staged||x.status!==y.status) return false; }
  return true;
}

const makeRow = (item, inIgnored = false) => {
  const el = document.createElement('div');
  el.className = 'row';
  el.innerHTML = \`
    <input class="chk" type="checkbox" \${item.staged ? 'checked' : ''}
           data-path="\${item.path}" aria-label="stage-toggle" />
    <div class="name" title="\${item.full}" data-action="openDiff"
         data-path="\${item.path}">\${item.path}</div>
    <span class="badge">\${item.status}</span>

    <button class="iconbtn" title="\${inIgnored ? 'Unignore' : 'Ignore'}"
            aria-label="\${inIgnored ? 'Unignore' : 'Ignore'}"
            data-action="\${inIgnored ? 'unignore' : 'ignore'}"
            data-path="\${item.path}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3 21 12 12 21 3 12Z"></path>
        <path d="M8.2 8.2 12 12 15.8 8.2"></path>
        <path d="M12 7V4"></path>
        <path d="M10.8 5.2 12 4l1.2 1.2"></path>
        <circle cx="8.2" cy="8.2" r="1.4" fill="currentColor" stroke="none"></circle>
        <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"></circle>
        <circle cx="15.8" cy="8.2" r="1.4" fill="currentColor" stroke="none"></circle>
      </svg>
    </button>

    <button class="iconbtn" title="Discard changes" aria-label="Discard"
            data-action="discard" data-path="\${item.path}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M9 7v-2a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12"></path>
        <path d="M10 11v6M14 11v6"></path>
      </svg>
    </button>
  \`;
  return el;
};


/* remove duplicates (prefer staged), then apply overlay so item stays visible where user put it */
function applyOverlay(s){
  const stagedSet = new Set((s.staged||[]).map(i=>i.path));
  s.unstaged = (s.unstaged||[]).filter(i => !stagedSet.has(i.path));

  const removeFromAll = (p) => {
    s.staged   = (s.staged||[]).filter(i => i.path !== p);
    s.unstaged = (s.unstaged||[]).filter(i => i.path !== p);
    s.ignored  = (s.ignored||[]).filter(i => i.path !== p);
  };

  for(const [p, {dest, item}] of overlay.entries()){
    if (dest === 'none') { removeFromAll(p); continue; }

    const found = (s.staged||[]).find(i=>i.path===p)
      || (s.unstaged||[]).find(i=>i.path===p)
      || (s.ignored||[]).find(i=>i.path===p)
      || item || snapshot.get(p) || { path:p, full:p, status:'M', staged: dest==='staged' };

    const normalized = { ...found, staged: dest==='staged' };
    removeFromAll(p);

    if (dest === 'staged') s.staged   = [...(s.staged||[]), normalized];
    else if (dest === 'unstaged') s.unstaged = [...(s.unstaged||[]), { ...normalized, staged:false }];
    else if (dest === 'ignored') s.ignored  = [...(s.ignored||[]), { ...normalized, staged:false }];
  }
  return s;
}

function render(nextState){
  state = nextState || state;
  const staged = state?.staged ?? [];
  const unstaged = state?.unstaged ?? [];
  const ignored = state?.ignored ?? [];
  const stageList = $('#stagedList'), unList = $('#unstagedList'), ignList = $('#ignoredList');
  const sc = $('#stagedCount'), uc = $('#unstagedCount'), ic = $('#ignoredCount'), counts = $('#counts');

  const paint = (node, items, inIgnored=false) => {
    node.innerHTML = '';
    if(!items.length){ node.innerHTML = '<div class="empty">No files</div>'; return; }
    items.forEach(i => node.appendChild(makeRow(i, inIgnored)));
  };

  paint(stageList, staged, false);
  paint(unList, unstaged, false);
  paint(ignList, ignored, true);
  sc.textContent = staged.length;
  uc.textContent = unstaged.length;
  ic.textContent = ignored.length;
  counts.textContent = \`\${staged.length} staged · \${unstaged.length} unstaged\`;

  updateSnapshot(state);

  applyCollapseUI();
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  ({
    state: () => {
      if (m.seq && m.seq < lastSeq) return;
      lastSeq = m.seq || lastSeq;

      const incoming = JSON.parse(JSON.stringify(m.state || {staged:[],unstaged:[],ignored:[]}));
      const merged = applyOverlay(incoming);

      if (equalState(state, merged)) return;
      render(merged);
    },
    ok:    () => {
      const paths = popPending(m.action || '');
      for(const p of paths){ overlay.delete(p); }
      const s = $('#status'); s.textContent = '✔ ' + (m.action || 'Done'); clearTimeout(s._t); s._t = setTimeout(()=>s.textContent='', 800);
      post('requestState');
    },
    error: () => {
      const paths = popPending(m.action || '');
      for(const p of paths){ overlay.delete(p); }
      const s = $('#status'); s.textContent = '✖ ' + short(m.message); clearTimeout(s._t); s._t = setTimeout(()=>s.textContent='', 3000);
      post('requestState');
    },
    optimistic: () => {
      const { op, path, paths=[] } = m;
      let list = paths.length ? paths : (path ? [path] : []);

      if (!list.length && op === 'stageAll') {
        const ignored = new Set((state.ignored||[]).map(i=>i.path));
        list = (state.unstaged||[]).map(i=>i.path).filter(p => !ignored.has(p));
      }
      if (!list.length && op === 'unstageAll') {
        const ignored = new Set((state.ignored||[]).map(i=>i.path));
        list = (state.staged||[]).map(i=>i.path).filter(p => !ignored.has(p));
      }
      if (!list.length && op === 'discardAll') {
        const ignored = new Set((state.ignored||[]).map(i=>i.path));
        list = [...(state.staged||[]), ...(state.unstaged||[])]
          .map(i=>i.path).filter(p => !ignored.has(p));
      }

      if (list.length) {
        pushPending(op, list);
        const dest = opToDest(op);
        for (const p of list) {
          const it = (state.staged||[]).find(i=>i.path===p)
                 || (state.unstaged||[]).find(i=>i.path===p)
                 || (state.ignored||[]).find(i=>i.path===p)
                 || snapshot.get(p);
          overlay.set(p, { dest, item: it });
        }
      }

      const move = (ps, fromKey, toKey) => {
        const from = state[fromKey] || []; const to = state[toKey] || [];
        const set = new Set(ps); const moved = []; const remain = [];
        for(const it of from){ if(set.has(it.path)){ moved.push({ ...it, staged: toKey==='staged' }); } else remain.push(it); }
        state[fromKey] = remain; state[toKey] = [...to, ...moved.map(i => toKey==='ignored'? {...i, staged:false }: i)];
      };
      const remove = (ps) => {
        const set = new Set(ps);
        state.staged = (state.staged||[]).filter(i => !set.has(i.path));
        state.unstaged = (state.unstaged||[]).filter(i => !set.has(i.path));
        state.ignored = (state.ignored||[]).filter(i => !set.has(i.path));
      };

      ({
        stageFile:     () => { move(list, 'unstaged', 'staged'); render(state); },
        unstageFile:   () => { move(list, 'staged', 'unstaged'); render(state); },
        discard:       () => { remove(list); render(state); },
        stageMany:     () => { move(list, 'unstaged', 'staged'); render(state); },
        unstageMany:   () => { move(list, 'staged', 'unstaged'); render(state); },
        discardMany:   () => { remove(list); render(state); },
        stageAll:      () => { const ignored = new Set((state.ignored||[]).map(i=>i.path)); const all = state.unstaged.filter(i=>!ignored.has(i.path)).map(i=>i.path); move(all, 'unstaged', 'staged'); render(state); },
        unstageAll:    () => { const ignored = new Set((state.ignored||[]).map(i=>i.path)); const all = state.staged.filter(i=>!ignored.has(i.path)).map(i=>i.path); move(all, 'staged', 'unstaged'); render(state); },
        discardAll:    () => { const ignored = new Set((state.ignored||[]).map(i=>i.path)); const keep = (arr)=>arr.filter(i=>ignored.has(i.path)); state = { staged: keep(state.staged), unstaged: keep(state.unstaged), ignored: state.ignored }; render(state); },
        ignore:        () => { // move from staged/unstaged to ignored
          for (const p of list) {
            state.staged = state.staged.filter(i=>i.path!==p);
            const hit = state.unstaged.find(i=>i.path===p) || state.staged.find(i=>i.path===p) || snapshot.get(p) || { path:p, full:p, status:'M', staged:false };
            state.unstaged = state.unstaged.filter(i=>i.path!==p);
            if (!state.ignored.some(i=>i.path===p)) state.ignored.push({ ...hit, staged:false });
          }
          render(state);
        },
        unignore:      () => { // move from ignored to unstaged
          for (const p of list) {
            state.ignored = state.ignored.filter(i=>i.path!==p);
            const hit = snapshot.get(p) || { path:p, full:p, status:'M', staged:false };
            if (!state.unstaged.some(i=>i.path===p)) state.unstaged.push({ ...hit, staged:false });
          }
          render(state);
        },
      }[op] || (()=>{}))();
    },
    clearMsg: () => {
      $msg.value = '';
      const next = { ...(vscode.getState?.() || {}), msg: '' };
      vscode.setState?.(next);
      setCommitButtons();
    }
  }[m.type] || (()=>{}))();
});

const $msg = $('#msg');
const restore = vscode.getState?.() || {};
if (restore.msg) $msg.value = restore.msg;

// --- Collapsible sections state (versioned so we can change defaults) ---
const UI_VER = 2; // bump when changing defaults
const defaultCollapse = { staged: false, unstaged: false, ignored: true };

// Use saved collapse only if it matches our current UI version
const savedCollapse = restore.uiVer === UI_VER ? (restore.collapse || {}) : {};

let collapse = {
  staged:  savedCollapse.staged  ?? defaultCollapse.staged,
  unstaged:savedCollapse.unstaged?? defaultCollapse.unstaged,
  ignored: savedCollapse.ignored ?? defaultCollapse.ignored,
};

// If version changed, persist fresh defaults immediately
if (restore.uiVer !== UI_VER) {
  vscode.setState?.({ ...restore, uiVer: UI_VER, collapse });
}

const applyCollapseUI = () => {
  const groups = [
    ['staged',   '#grp-staged'],
    ['unstaged', '#grp-unstaged'],
    ['ignored',  '#grp-ignored'],
  ];
  for (const [name, sel] of groups) {
    const wrap = $(sel);
    if (!wrap) continue;
    const isCollapsed = !!collapse[name];
    wrap.classList.toggle('collapsed', isCollapsed);
    const btn = wrap.querySelector('button.ttl.toggle');
    if (btn) btn.setAttribute('aria-expanded', String(!isCollapsed));
  }
};

// initial paint
applyCollapseUI();


const setCommitButtons = () => {
  const enabled = !!$msg.value.trim();
  $$('.btn[data-action="commit"], .btn[data-action="commitPush"]').forEach(b => b.disabled = !enabled);
};
setCommitButtons();

$msg.addEventListener('input', () => {
  const next = { ...(vscode.getState?.() || {}), msg: $msg.value };
  vscode.setState?.(next);
  setCommitButtons();
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  if (a.hasAttribute('disabled')) return;
  e.preventDefault();

  const act = a.getAttribute('data-action');
  ({
    stageAll:    () => post('stageAll'),
    unstageAll:  () => post('unstageAll'),
    discardAll:  () => post('discardAll'),
    commit:      () => post('commit', { message: $msg.value }),
    push:        () => post('push'),
    commitPush:  () => post('commitPush', { message: $msg.value }),
    discard:     () => post('discard', { path: a.getAttribute('data-path') }),
    openDiff:    () => post('openDiff', { path: a.getAttribute('data-path') }),
    ignore:      () => post('ignoreFile', { path: a.getAttribute('data-path') }),
    unignore:    () => post('unignoreFile', { path: a.getAttribute('data-path') }),

    // collapse/expand group + persist
    toggleGroup: () => {
  const group = a.getAttribute('data-group'); // "staged" | "unstaged" | "ignored"
  if (!group) return;
  collapse = { ...collapse, [group]: !collapse[group] };
  const next = { ...(vscode.getState?.() || {}), uiVer: UI_VER, collapse };
  vscode.setState?.(next);
  applyCollapseUI();
},

  }[act] || (() => {}))();
});


document.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-path]');
  if(!cb) return;
  const path = cb.getAttribute('data-path');
  post(cb.checked ? 'stageFile' : 'unstageFile', { path });
});

post('requestState');
</script>
</body>
</html>
`;
}

/* =============== Handlers =============== */

const handlers: Record<string, (m?: any) => Promise<void>> = {
  requestState: async () => { /* handled per-view */ },

  /* ===== List actions ===== */
  stageAll: () => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    optimistic({ op: 'stageAll' });
    try {
      const cwd = repo.rootUri.fsPath;
      const ignored = await getIgnoredSet(cwd);
      const paths = [
        ...(repo.state?.workingTreeChanges ?? []).map((c: any) => rel(cwd, c.uri.fsPath)),
        ...(repo.state?.mergeChanges ?? []).map((c: any) => rel(cwd, c.uri.fsPath)),
      ].filter(p => !ignored.has(p));
      if (paths.length) await repo.add(paths); else await repo.add([]);
    } catch {
      const api2 = await ensureGitApi(); const repo2 = bestRepo(api2) ?? await waitForRepo(); if (!repo2) return;
      const cwd = repo2.rootUri.fsPath;
      const ignored = await getIgnoredSet(cwd);
      const out = await runGit(['ls-files', '--modified', '--others', '--exclude-standard'], cwd).catch(() => '');
      const all = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => !ignored.has(p));
      if (all.length) await runGit(['add', '--', ...all], cwd); else await runGit(['add', '-A'], cwd);
    }
  }),

  unstageAll: () => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    optimistic({ op: 'unstageAll' });
    const cwd = repo.rootUri.fsPath;
    const ignored = await getIgnoredSet(cwd);
    const stagedPaths = (repo.state?.indexChanges ?? [])
      .map((c: any) => rel(cwd, c.uri.fsPath))
      .filter((p: string) => !ignored.has(p));
    if (!stagedPaths.length) return;
    if (await hasHead(cwd)) await runGit(['reset', '-q', 'HEAD', '--', ...stagedPaths], cwd);
    else await runGit(['rm', '--cached', '--', ...stagedPaths], cwd);
  }),

  discardAll: () => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const cwd = repo.rootUri.fsPath;
    const has = await hasHead(cwd);
    const confirmMsg = has
      ? 'Discard ALL local changes (ignored files will be preserved)? This cannot be undone.'
      : 'No commits yet. Discard All will remove ALL untracked files from disk (ignored files will be preserved). Continue?';
    const confirm = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, 'Discard');
    if (confirm !== 'Discard') return;

    optimistic({ op: 'discardAll' });
    try {
      const ignored = await getIgnoredSet(cwd);
      if (has) {
        const wt = repo.state?.workingTreeChanges ?? [];
        const tracked: string[] = [];
        const untracked: string[] = [];
        for (const ch of wt) {
          const p = rel(cwd, ch.uri.fsPath);
          if (ignored.has(p)) continue;
          const isUntracked = !!(await runGit(['ls-files', '--others', '--exclude-standard', '--', p], cwd)).trim();
          (isUntracked ? untracked : tracked).push(p);
        }
        if (tracked.length) await repo.revert(tracked);
        if (untracked.length) await repo.clean(untracked);
      } else {
        const out = await runGit(['ls-files', '--others', '--exclude-standard'], cwd).catch(() => '');
        const untracked = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const ignoredSet = await getIgnoredSet(cwd);
        const filtered = untracked.filter((p: string) => !ignoredSet.has(p));
        for (const p of filtered) { try { await runGit(['clean', '-f', '--', p], cwd); } catch { } }
      }
    } catch {
      try {
        const ignored = await getIgnoredSet(cwd);
        const outTracked = await runGit(['diff', '--name-only'], cwd).catch(() => '');
        const tracked = outTracked.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => !ignored.has(p));
        if (tracked.length) {
          try { await runGit(['restore', '--worktree', '--staged', '--source=HEAD', '--', ...tracked], cwd); }
          catch { await runGit(['checkout', '--', ...tracked], cwd); }
        }
        const outUntracked = await runGit(['ls-files', '--others', '--exclude-standard'], cwd).catch(() => '');
        const untracked = outUntracked.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(p => !ignored.has(p));
        if (untracked.length) await runGit(['clean', '-f', '--', ...untracked], cwd);
      } catch { /* swallow */ }
    }
  }),

  /* ===== Per file ===== */
  stageFile: (m) => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    optimistic({ op: 'stageFile', path: m?.path });
    try { await repo.add([m.path]); } catch { await runGit(['add', '--', m.path], repo.rootUri.fsPath); }
  }),

  unstageFile: (m) => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    optimistic({ op: 'unstageFile', path: m?.path });
    const cwd = repo.rootUri.fsPath;
    if (await hasHead(cwd)) await runGit(['reset', '-q', 'HEAD', '--', m.path], cwd);
    else await runGit(['rm', '--cached', '--', m.path], cwd);
  }),

  discard: (m) => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const cwd = repo.rootUri.fsPath;
    optimistic({ op: 'discard', path: m?.path });
    try {
      const isUntracked = !!(await runGit(['ls-files', '--others', '--exclude-standard', '--', m.path], cwd)).trim();
      if (isUntracked) await repo.clean([m.path]); else await repo.revert([m.path]);
    } catch {
      try { await runGit(['restore', '--worktree', '--staged', '--source=HEAD', '--', m.path], cwd); }
      catch { await runGit(['checkout', '--', m.path], cwd); }
    }
  }),

  // NEW: toggle ignored
  ignoreFile: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const cwd = repo.rootUri.fsPath;
    optimistic({ op: 'ignore', path: m?.path });
    await addIgnored(cwd, [m.path]);
    // If it was staged, unstage so it won't commit
    if (await hasHead(cwd)) { try { await runGit(['reset', '-q', 'HEAD', '--', m.path], cwd); } catch { } }
    else { try { await runGit(['rm', '--cached', '--', m.path], cwd); } catch { } }
  },

  unignoreFile: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const cwd = repo.rootUri.fsPath;
    optimistic({ op: 'unignore', path: m?.path });
    await removeIgnored(cwd, [m.path]);
  },

  openDiff: async (m) => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const abs = path.join(repo.rootUri.fsPath, m.path);
    const fileUri = vscode.Uri.file(abs);
    if (!(await hasHead(repo.rootUri.fsPath))) { await vscode.commands.executeCommand('vscode.open', fileUri); return; }
    const left = (gitApi as any).toGitUri(fileUri, 'HEAD');
    await vscode.commands.executeCommand('vscode.diff', left, fileUri, m.path);
  },

  /* ===== Commit / Push ===== */
  commit: (m) => runBatch(async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const cwd = repo.rootUri.fsPath;
    const message = String(m?.message ?? '').trim();
    if (!message) throw new Error('Commit message is required.');

    const stagedListRaw = await runGit(['diff', '--cached', '--name-only'], cwd).catch(() => '');
    const stagedAll = stagedListRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!stagedAll.length) throw new Error('No staged changes. Stage files first.');

    const ignored = await getIgnoredSet(cwd);
    const blocked = stagedAll.filter(p => ignored.has(p));
    const allowed = stagedAll.filter(p => !ignored.has(p));
    if (!allowed.length) throw new Error('All staged changes are ignored. Unignore files or stage non-ignored files.');

    // ensure ignored files aren't accidentally committed
    if (blocked.length) {
      if (await hasHead(cwd)) await runGit(['reset', '-q', 'HEAD', '--', ...blocked], cwd);
      else await runGit(['rm', '--cached', '--', ...blocked], cwd);
    }

    const cfg = vscode.workspace.getConfiguration();
    if (cfg.get<boolean>(SETTINGS.wipGuard) && /(^|\s)wip(\s|$)/i.test(message)) {
      throw new Error(`WIP is blocked by settings (${SETTINGS.wipGuard}).`);
    }
    if (cfg.get<boolean>(SETTINGS.blockOnMain)) {
      const b = await getBranch(cwd);
      if (['main', 'master'].includes(b)) {
        const ok = await vscode.window.showWarningMessage(`Commit on "${b}"?`, { modal: true }, 'Commit');
        if (ok !== 'Commit') return;
      }
    }

    try { await repo.commit(message, {}); }
    catch { await runGit(['commit', '-m', message, '--no-gpg-sign'], cwd); }

    postToViewGlobal?.({ type: 'clearMsg' });
  }),

  push: async () => {
    const api = await ensureGitApi(); const repo = bestRepo(api) ?? await waitForRepo(); if (!repo) return;
    const cwd = repo.rootUri.fsPath;
    if (!(await hasHead(cwd))) {
      vscode.window.showInformationMessage('Push&Go: No commits yet. Create a commit first.');
      return;
    }

    const branch = repo.state?.HEAD?.name || (await getBranch(cwd)) || 'HEAD';
    const ahead = repo.state?.HEAD?.ahead ?? null;
    const upstream = await getUpstream(cwd);

    if (upstream && ahead !== null && ahead === 0) {
      vscode.window.showInformationMessage('Push&Go: Nothing to push — already up to date.');
      return;
    }

    const runWithProgress = <T>(title: string, task: () => Promise<T>) =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);

    const resolveRemote = async (): Promise<string | undefined> => {
      const remotes = await listRemotes(cwd);
      if (remotes.includes('origin')) return 'origin';
      return remotes[0];
    };

    const pushCli = async (remote: string, br: string, setUpstream: boolean) => {
      const args = setUpstream ? ['push', '-u', remote, br] : ['push', remote, br];
      await runGit(args, cwd);
      vscode.window.showInformationMessage(`Push&Go: Pushed to ${remote}/${br}.`);
    };

    try {
      await runWithProgress('Push&Go: Pushing…', async () => {
        if (upstream) { await pushCli(upstream.remote, branch, false); return; }
        let remote = await resolveRemote();
        if (!remote) {
          remote = await pickOrCreateRemote(cwd);
          if (!remote) { vscode.window.showInformationMessage('Push&Go: Push canceled.'); return; }
        }
        await pushCli(remote, branch, true);
      });
    } catch (e: any) {
      const msg = (e?.message ?? 'Unknown error').toString().split('\n').slice(0, 6).join('\n');
      vscode.window.showErrorMessage(`Push&Go: Push failed.\n${msg}`); log('push error:', msg);
    }
  },

  commitPush: async (m) => { await handlers.commit(m); await handlers.push(m); },

  // Command palette helpers
  commitCommand: async () => {
    const msg = await vscode.window.showInputBox({ prompt: 'Commit message', placeHolder: 'Required…', validateInput: v => v.trim() ? undefined : 'Message required' });
    if (msg) await handlers.commit({ message: msg });
  },
  commitPushCommand: async () => {
    const msg = await vscode.window.showInputBox({ prompt: 'Commit message', placeHolder: 'Required…', validateInput: v => v.trim() ? undefined : 'Message required' });
    if (msg) await handlers.commitPush({ message: msg });
  },
};

/* ===== Batch helper ===== */
async function runBatch<T>(fn: () => Promise<T>): Promise<T> {
  _beginBatch();
  try { return await fn(); }
  finally { await _endBatch(); }
}

/* ===== Explorer commands ===== */

async function withRepo(): Promise<{ api: any, repo: any } | undefined> {
  const api = await ensureGitApi();
  const repo = bestRepo(api) ?? await waitForRepo();
  if (!repo) { vscode.window.showErrorMessage('Push&Go: No Git repository found.'); return; }
  return { api, repo };
}

async function stageFromExplorer(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  await runBatch(async () => {
    const ctx = await withRepo(); if (!ctx) return;
    const { repo } = ctx;
    const cwd = repo.rootUri.fsPath;
    const ignored = await getIgnoredSet(cwd);
    const paths = toPaths(cwd, uri, uris).filter(p => !ignored.has(p));
    if (!paths.length) return;
    optimistic({ op: 'stageMany', paths });
    try { await repo.add(paths); } catch { await runGit(['add', '--', ...paths], cwd); }
    vscode.window.showInformationMessage(`Push&Go: Staged ${paths.length} file(s).`);
  });
}

async function unstageFromExplorer(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  await runBatch(async () => {
    const ctx = await withRepo(); if (!ctx) return;
    const { repo } = ctx; const cwd = repo.rootUri.fsPath;
    const ignored = await getIgnoredSet(cwd);
    const paths = toPaths(cwd, uri, uris).filter(p => !ignored.has(p));
    if (!paths.length) return;
    optimistic({ op: 'unstageMany', paths });
    if (await hasHead(cwd)) await runGit(['reset', '-q', 'HEAD', '--', ...paths], cwd);
    else await runGit(['rm', '--cached', '--', ...paths], cwd);
    vscode.window.showInformationMessage(`Push&Go: Unstaged ${paths.length} file(s).`);
  });
}

async function discardFromExplorer(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  await runBatch(async () => {
    const ctx = await withRepo(); if (!ctx) return;
    const { repo } = ctx; const cwd = repo.rootUri.fsPath;
    const ignored = await getIgnoredSet(cwd);
    const paths = toPaths(cwd, uri, uris).filter(p => !ignored.has(p));
    if (!paths.length) return;

    optimistic({ op: 'discardMany', paths });

    for (const p of paths) {
      const isUntracked = !!(await runGit(['ls-files', '--others', '--exclude-standard', '--', p], cwd)).trim();
      try { if (isUntracked) await repo.clean([p]); else await repo.revert([p]); }
      catch {
        if (isUntracked) await runGit(['clean', '-f', '--', p], cwd);
        else {
          try { await runGit(['restore', '--worktree', '--staged', '--source=HEAD', '--', p], cwd); }
          catch { await runGit(['checkout', '--', p], cwd); }
        }
      }
    }
    vscode.window.showInformationMessage(`Push&Go: Discarded changes for ${paths.length} file(s).`);
  });
}

async function openDiffFromExplorer(uri?: vscode.Uri) {
  const ctx = await withRepo(); if (!ctx || !uri) return;
  const { api, repo } = ctx;
  const cwd = repo.rootUri.fsPath;

  if (!(await hasHead(cwd))) { await vscode.commands.executeCommand('vscode.open', uri); return; }
  const left = api.toGitUri(uri, 'HEAD');
  await vscode.commands.executeCommand('vscode.diff', left, uri, rel(cwd, uri.fsPath));
}

async function commitThisFromExplorer(uri?: vscode.Uri, uris?: vscode.Uri[]) {
  await runBatch(async () => {
    const ctx = await withRepo(); if (!ctx) return;
    const { repo } = ctx; const cwd = repo.rootUri.fsPath;
    const ignored = await getIgnoredSet(cwd);
    const paths = toPaths(cwd, uri, uris);
    if (!paths.length) return;

    // Stage selected (filter ignored)
    const stageable = paths.filter(p => !ignored.has(p));
    if (stageable.length) {
      try { await repo.add(stageable); } catch { await runGit(['add', '--', ...stageable], cwd); }
    }

    const msg = await vscode.window.showInputBox({
      prompt: `Commit message (for ${paths.length} file${paths.length > 1 ? 's' : ''})`,
      placeHolder: 'Required…',
      validateInput: v => v.trim() ? undefined : 'Message required'
    });
    if (!msg) return;

    const cfg = vscode.workspace.getConfiguration();
    if (cfg.get<boolean>(SETTINGS.wipGuard) && /(^|\s)wip(\s|$)/i.test(msg.trim())) {
      vscode.window.showErrorMessage(`Push&Go: WIP is blocked by settings (${SETTINGS.wipGuard}).`);
      return;
    }
    if (cfg.get<boolean>(SETTINGS.blockOnMain)) {
      const b = await getBranch(cwd);
      if (['main', 'master'].includes(b)) {
        const ok = await vscode.window.showWarningMessage(`Commit on "${b}"?`, { modal: true }, 'Commit');
        if (ok !== 'Commit') return;
      }
    }

    const s = await runGit(['diff', '--cached', '--name-only', '--', ...paths], cwd).catch(() => '');
    const stagedSubset = s.split(/\r?\n/).map(x => x.trim()).filter(Boolean);

    // Unstage any ignored that slipped in
    const blocked = stagedSubset.filter(p => ignored.has(p));
    if (blocked.length) {
      if (await hasHead(cwd)) await runGit(['reset', '-q', 'HEAD', '--', ...blocked], cwd);
      else await runGit(['rm', '--cached', '--', ...blocked], cwd);
    }

    const finalDiff = await runGit(['diff', '--cached', '--name-only'], cwd).catch(() => '');
    const finalStaged = finalDiff.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    if (!finalStaged.length) { vscode.window.showInformationMessage('Push&Go: No staged changes (ignored files were excluded).'); return; }

    try { await repo.commit(msg.trim(), {}); }
    catch { await runGit(['commit', '-m', msg.trim(), '--no-gpg-sign'], cwd); }

    postToViewGlobal?.({ type: 'clearMsg' });
    vscode.window.showInformationMessage(`Push&Go: Committed ${finalStaged.length} file(s).`);
  });
}
