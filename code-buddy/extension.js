// Code Buddy - a VS Code companion that notices when you're stuck and gives you the logic.
// Plain JavaScript, no build step. Requires VS Code >= 1.85 (Node 18+ fetch).

const vscode = require('vscode');

const SECRET_KEY = 'codeBuddy.anthropicApiKey';
const API_URL = 'https://api.anthropic.com/v1/messages';

const LEVELS = {
  nudge: {
    label: 'Nudge',
    instruction:
      'Give a NUDGE only: 1-3 short sentences. Point at where to look and ask one guiding question. No code, no pseudocode, do not state the fix.',
  },
  logic: {
    label: 'Logic',
    instruction:
      'Explain the LOGIC: the idea or algorithm in plain language, the key insight, and the steps in order (a short numbered list). Mention likely pitfalls. No code beyond tiny inline snippets.',
  },
  pseudocode: {
    label: 'Pseudocode',
    instruction:
      'Give clear PSEUDOCODE for the approach, plus one or two sentences on why it works. Do not write the final language-specific code.',
  },
  solution: {
    label: 'Solution',
    instruction:
      'The user explicitly asked for the full solution. Provide corrected/complete code for the relevant part in the file\'s language, then briefly explain what changed and why.',
  },
};

const SYSTEM_PROMPT = `You are Code Buddy, a friendly pair-programming companion living in the user's VS Code sidebar.
You can see the user's current file, their cursor/selection, and the editor's diagnostics (errors and warnings).
The user is probably stuck. Your job is to help them THINK, not to take over:
- Teach the logic behind the problem so they can write the code themselves.
- Be warm, concise and concrete. Refer to specific lines ("line 42") and identifiers from their code.
- Follow the requested help level exactly. Never jump to a full solution unless the level says so.
- If the code is fine and you can't tell what they're stuck on, ask one short clarifying question.
- Use Markdown. Use fenced code blocks only when the level allows code.`;

/** @type {vscode.ExtensionContext} */
let ctx;
let provider;
let statusItem;

const state = {
  paused: false,
  lastEditAt: Date.now(),
  lastActivityAt: Date.now(),
  lastHintAt: 0,
  hintedSinceEdit: false,
  nudgedSinceEdit: false,
  diagSig: '',
  diagSince: Date.now(),
  recentEdits: [], // {t, added, removed}
  history: [], // chat turns {role, content}
  busy: false,
};

// ---------------------------------------------------------------- activation

function activate(context) {
  ctx = context;
  provider = new CompanionViewProvider();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'codeBuddy.askForHelp';
  setStatus('ready');
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider('codeBuddy.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('codeBuddy.setApiKey', setApiKey),
    vscode.commands.registerCommand('codeBuddy.askForHelp', () => askForHelp('nudge', '', true)),
    vscode.commands.registerCommand('codeBuddy.clearChat', () => {
      state.history = [];
      provider.post({ type: 'clear' });
    }),
    vscode.commands.registerCommand('codeBuddy.togglePause', () => {
      state.paused = !state.paused;
      setStatus(state.paused ? 'paused' : 'ready');
      provider.post({ type: 'status', mood: state.paused ? 'sleep' : 'happy', text: state.paused ? 'Paused - not watching.' : 'Watching your code.' });
    }),

    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document)) return;
      if (e.document.uri.scheme !== 'file' && e.document.uri.scheme !== 'untitled') return;
      const now = Date.now();
      state.lastEditAt = now;
      state.lastActivityAt = now;
      state.hintedSinceEdit = false;
      state.nudgedSinceEdit = false;
      let added = 0;
      let removed = 0;
      for (const c of e.contentChanges) {
        added += c.text.length;
        removed += c.rangeLength;
      }
      state.recentEdits.push({ t: now, added, removed });
      state.recentEdits = state.recentEdits.filter((x) => now - x.t < 90000);
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      state.lastActivityAt = Date.now();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      state.lastEditAt = Date.now();
      state.lastActivityAt = Date.now();
      state.hintedSinceEdit = false;
      state.nudgedSinceEdit = false;
      state.recentEdits = [];
    }),
    vscode.languages.onDidChangeDiagnostics(() => updateDiagnosticsTracking())
  );

  const timer = setInterval(tick, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

// ---------------------------------------------------------------- stuck detection

function currentErrors(editor) {
  if (!editor) return [];
  return vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
}

function updateDiagnosticsTracking() {
  const editor = vscode.window.activeTextEditor;
  const sig = currentErrors(editor)
    .map((d) => `${d.range.start.line}:${d.message}`)
    .sort()
    .join('|');
  if (sig !== state.diagSig) {
    state.diagSig = sig;
    state.diagSince = Date.now();
  }
}

function churnRatio() {
  const added = state.recentEdits.reduce((a, b) => a + b.added, 0);
  const removed = state.recentEdits.reduce((a, b) => a + b.removed, 0);
  return { added, removed, count: state.recentEdits.length };
}

/** Returns a reason string if the user looks stuck, else null. */
function detectStuck() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.lineCount < 2) return null;
  if (isIgnored(editor.document)) return null;
  const cfg = vscode.workspace.getConfiguration('codeBuddy');
  const now = Date.now();
  const errors = currentErrors(editor);

  // 1) Same errors sitting there while the user keeps editing.
  if (errors.length > 0 && now - state.diagSince > cfg.get('persistentErrorSeconds') * 1000 && state.recentEdits.length >= 3) {
    return `the same ${errors.length} error(s) have been there for a while`;
  }
  // 2) Idle for a long time with errors on screen.
  const idleMs = now - state.lastActivityAt;
  if (idleMs > cfg.get('stuckSeconds') * 1000 && errors.length > 0) {
    return 'you paused with errors on screen';
  }
  // 3) Idle for a long time on a line that looks unfinished (TODO / empty body / trailing operator).
  if (idleMs > cfg.get('stuckSeconds') * 1000) {
    const line = editor.document.lineAt(editor.selection.active.line).text;
    if (/TODO|FIXME|pass\s*$|\.\.\.\s*$|[+\-*/=,(&|]\s*$/.test(line) || line.trim() === '') {
      return 'you paused on an unfinished line';
    }
  }
  // 4) Write-delete churn: lots of text typed and deleted.
  const c = churnRatio();
  if (c.count >= 8 && c.removed > 80 && c.removed > c.added * 0.7) {
    return 'you keep writing and deleting the same area';
  }
  return null;
}

function tick() {
  if (state.paused || state.busy) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  updateDiagnosticsTracking();

  const now = Date.now();
  const errors = currentErrors(editor);
  provider.post({
    type: 'status',
    mood: errors.length ? 'worried' : 'happy',
    text: errors.length ? `Watching ${shortName(editor)} - ${errors.length} error(s) spotted.` : `Watching ${shortName(editor)}.`,
  });

  if (state.nudgedSinceEdit || now - state.lastHintAt < 120000) return;
  const reason = detectStuck();
  if (!reason) return;

  state.nudgedSinceEdit = true;
  setStatus('stuck');
  if (vscode.workspace.getConfiguration('codeBuddy').get('autoHint')) {
    askForHelp('nudge', '', false, `I noticed ${reason}.`);
  } else {
    provider.post({ type: 'stuck', text: `Hey, looks like ${reason}. Want a hand?` });
    vscode.window
      .showInformationMessage(`Code Buddy: looks like ${reason}. Want a hint?`, 'Nudge me', 'Not now')
      .then((pick) => {
        if (pick === 'Nudge me') askForHelp('nudge', '', true, `I noticed ${reason}.`);
      });
  }
}

// ---------------------------------------------------------------- context capture

function isIgnored(doc) {
  const globs = vscode.workspace.getConfiguration('codeBuddy').get('ignoreGlobs') || [];
  const name = doc.fileName.split(/[\\/]/).pop() || '';
  return globs.some((g) => {
    const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
    return re.test(name);
  });
}

function shortName(editor) {
  return editor.document.fileName.split(/[\\/]/).pop() || 'untitled';
}

function captureContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  const doc = editor.document;
  if (isIgnored(doc)) return { ignored: true, file: shortName(editor) };

  const maxLines = vscode.workspace.getConfiguration('codeBuddy').get('maxContextLines') || 300;
  const cursorLine = editor.selection.active.line;
  let start = 0;
  let end = doc.lineCount - 1;
  if (doc.lineCount > maxLines) {
    start = Math.max(0, cursorLine - Math.floor(maxLines / 2));
    end = Math.min(doc.lineCount - 1, start + maxLines - 1);
    start = Math.max(0, end - maxLines + 1);
  }
  const lines = [];
  for (let i = start; i <= end; i++) {
    lines.push(`${String(i + 1).padStart(4, ' ')} | ${doc.lineAt(i).text}`);
  }

  const selection = editor.selection.isEmpty ? '' : doc.getText(editor.selection).slice(0, 4000);
  const diags = vscode.languages
    .getDiagnostics(doc.uri)
    .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
    .slice(0, 15)
    .map((d) => `- line ${d.range.start.line + 1} [${d.severity === 0 ? 'error' : 'warning'}] ${d.message}`);

  return {
    file: shortName(editor),
    language: doc.languageId,
    totalLines: doc.lineCount,
    shownRange: [start + 1, end + 1],
    cursorLine: cursorLine + 1,
    selection,
    diagnostics: diags,
    code: lines.join('\n'),
  };
}

function formatContext(c) {
  if (!c) return '(No file is open in the editor.)';
  if (c.ignored) return `(The open file "${c.file}" is on the ignore list, so its contents are not shared.)`;
  const churn = churnRatio();
  return [
    `File: ${c.file} (${c.language}), ${c.totalLines} lines. Showing lines ${c.shownRange[0]}-${c.shownRange[1]}.`,
    `Cursor is on line ${c.cursorLine}.`,
    c.selection ? `Selected text:\n\`\`\`\n${c.selection}\n\`\`\`` : 'No selection.',
    c.diagnostics.length ? `Diagnostics:\n${c.diagnostics.join('\n')}` : 'Diagnostics: none.',
    `Recent activity: ${Math.round((Date.now() - state.lastActivityAt) / 1000)}s since last activity; ${churn.count} edits in the last 90s (+${churn.added}/-${churn.removed} chars).`,
    `Code:\n${c.code}`,
  ].join('\n\n');
}

// ---------------------------------------------------------------- Anthropic call

async function getApiKey() {
  let key = await ctx.secrets.get(SECRET_KEY);
  if (!key) {
    key = await setApiKey();
  }
  return key;
}

async function setApiKey() {
  const key = await vscode.window.showInputBox({
    title: 'Code Buddy - Anthropic API key',
    prompt: 'Paste your Anthropic API key. It is stored in VS Code SecretStorage on this machine.',
    password: true,
    ignoreFocusOut: true,
  });
  if (key && key.trim()) {
    await ctx.secrets.store(SECRET_KEY, key.trim());
    vscode.window.showInformationMessage('Code Buddy: API key saved.');
    return key.trim();
  }
  return undefined;
}

async function callClaude(messages) {
  const key = await getApiKey();
  if (!key) throw new Error('No API key set. Run "Code Buddy: Set Anthropic API Key".');
  const model = vscode.workspace.getConfiguration('codeBuddy').get('model') || 'claude-sonnet-5-5';
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, max_tokens: 1200, system: SYSTEM_PROMPT, messages }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && j.error.message) || JSON.stringify(j);
    } catch (_) {}
    if (res.status === 401) await ctx.secrets.delete(SECRET_KEY);
    throw new Error(`API error ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ---------------------------------------------------------------- asking for help

async function askForHelp(level, userText, reveal, reason) {
  if (state.busy) return;
  const lvl = LEVELS[level] || LEVELS.nudge;
  if (reveal) await vscode.commands.executeCommand('codeBuddy.chat.focus');

  const c = captureContext();
  const prompt = [
    `Help level: ${lvl.label}. ${lvl.instruction}`,
    reason ? `Why I'm asking: ${reason}` : '',
    userText ? `The user says: ${userText}` : 'The user did not type a question; infer what they are stuck on from the code and diagnostics.',
    '--- CURRENT EDITOR STATE ---',
    formatContext(c),
  ]
    .filter(Boolean)
    .join('\n\n');

  const shown = userText || `(${lvl.label} please)`;
  provider.post({ type: 'message', role: 'user', text: shown });

  state.busy = true;
  state.hintedSinceEdit = true;
  state.lastHintAt = Date.now();
  setStatus('thinking');
  provider.post({ type: 'thinking', on: true });
  try {
    const messages = [...state.history.slice(-8), { role: 'user', content: prompt }];
    const reply = await callClaude(messages);
    // Keep history compact: store the short user text, not the whole code dump.
    state.history.push({ role: 'user', content: `[${lvl.label}] ${userText || reason || 'stuck'}` });
    state.history.push({ role: 'assistant', content: reply });
    provider.post({ type: 'message', role: 'assistant', text: reply, level });
  } catch (err) {
    provider.post({ type: 'message', role: 'error', text: String(err.message || err) });
  } finally {
    state.busy = false;
    provider.post({ type: 'thinking', on: false });
    setStatus('ready');
  }
}

function setStatus(mode) {
  const map = {
    ready: ['$(hubot) Buddy', 'Code Buddy is watching. Click if you are stuck.'],
    thinking: ['$(sync~spin) Buddy thinking', 'Code Buddy is thinking...'],
    stuck: ['$(lightbulb) Buddy: need a hand?', 'Looks like you might be stuck. Click for a hint.'],
    paused: ['$(debug-pause) Buddy paused', 'Code Buddy is paused.'],
  };
  const [text, tip] = map[mode] || map.ready;
  statusItem.text = text;
  statusItem.tooltip = tip;
}

// ---------------------------------------------------------------- webview

class CompanionViewProvider {
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ask') askForHelp(m.level || 'logic', (m.text || '').trim(), false);
      else if (m.type === 'setKey') setApiKey();
      else if (m.type === 'pause') vscode.commands.executeCommand('codeBuddy.togglePause');
      else if (m.type === 'clear') vscode.commands.executeCommand('codeBuddy.clearChat');
    });
  }
  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }
}

function getHtml() {
  const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join('');
  return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; margin: 0; display:flex; flex-direction:column; height:100vh; }
  #top { padding: 10px 12px; display:flex; gap:10px; align-items:center; border-bottom:1px solid var(--vscode-panel-border); }
  #robotWrap { width: 64px; height: 64px; flex: none; cursor: pointer; user-select: none; }
  #robotWrap.hop { animation: hop .6s ease-out; }
  @keyframes hop { 30% { transform: translateY(-12px) rotate(-5deg); } 60% { transform: translateY(0) rotate(4deg); } 80% { transform: translateY(-4px); } }
  #robot { width: 100%; height: 100%; overflow: visible; animation: float 3s ease-in-out infinite; }
  @keyframes float { 50% { transform: translateY(-3px); } }
  #robot .mo { display: none; }
  #robot.happy .m-happy, #robot.worried .m-worried, #robot.think .m-think, #robot.sleep .m-sleep, #robot.stuck .m-stuck { display: inline; }
  #robot .eye { transform-box: fill-box; transform-origin: center; animation: blink 4.5s infinite; }
  @keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.1); } }
  #robot .bulb { transition: fill .3s; fill: #4ade80; }
  #robot.worried .bulb { fill: #fbbf24; }
  #robot.think .bulb { fill: #60a5fa; animation: pulse .7s infinite; }
  #robot.sleep .bulb { fill: #94a3b8; }
  #robot.stuck .bulb { fill: #f87171; animation: pulse .5s infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  #robot .head { transform-box: view-box; transform-origin: 50px 76px; }
  #robot.think .head { animation: tilt 1.4s ease-in-out infinite; }
  #robot.stuck .head { animation: shake .5s ease-in-out infinite; }
  #robot.sleep .head { transform: rotate(5deg); }
  @keyframes tilt { 50% { transform: rotate(-6deg); } }
  @keyframes shake { 25% { transform: rotate(-3deg); } 75% { transform: rotate(3deg); } }
  #robot .zz { animation: zz 2.2s ease-in infinite; }
  #robot .zz2 { animation-delay: 1.1s; }
  @keyframes zz { 0% { opacity: 0; transform: translate(0, 4px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translate(4px, -8px); } }
  #status { font-size: 12px; opacity: .8; flex:1; }
  .icon-btn { background:none; border:none; color:var(--vscode-foreground); cursor:pointer; opacity:.7; font-size:13px; }
  .icon-btn:hover { opacity:1; }
  #log { flex:1; overflow-y:auto; padding: 10px 12px; }
  .msg { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; line-height: 1.45; word-wrap: break-word; }
  .assistant { background: var(--vscode-editorWidget-background); border:1px solid var(--vscode-panel-border); }
  .user { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); margin-left: 24px; }
  .error { background: var(--vscode-inputValidation-errorBackground); border:1px solid var(--vscode-inputValidation-errorBorder); }
  .stuck { background: var(--vscode-inputValidation-infoBackground); border:1px solid var(--vscode-inputValidation-infoBorder); }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 6px; overflow-x:auto; }
  code { font-family: var(--vscode-editor-font-family); }
  #levels { display:flex; gap:6px; padding: 6px 12px 0; flex-wrap:wrap; }
  .lvl { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none; border-radius: 12px; padding: 3px 10px; cursor:pointer; font-size: 12px; }
  .lvl:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .lvl.sel { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #bar { display:flex; gap:6px; padding: 8px 12px 12px; }
  #input { flex:1; resize:none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, transparent); border-radius:4px; padding:6px; font-family:inherit; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; border-radius:4px; padding:0 12px; cursor:pointer; }
  #hint { font-size: 11px; opacity:.6; padding: 0 12px 6px; }
</style></head>
<body>
  <div id="top"><div id="robotWrap" title="Beep boop!">
    <svg id="robot" class="happy" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="50" cy="96" rx="24" ry="3" fill="#000" opacity=".15"/>
      <rect x="32" y="74" width="36" height="19" rx="9" fill="#9ad7ff" stroke="#2b4a6b" stroke-width="2.5"/>
      <circle cx="50" cy="83.5" r="3.5" fill="#ff8fb1"/>
      <circle cx="26" cy="82" r="5" fill="#9ad7ff" stroke="#2b4a6b" stroke-width="2.5"/>
      <circle cx="74" cy="82" r="5" fill="#9ad7ff" stroke="#2b4a6b" stroke-width="2.5"/>
      <g class="head">
        <line x1="50" y1="22" x2="50" y2="12" stroke="#2b4a6b" stroke-width="2.5" stroke-linecap="round"/>
        <circle class="bulb" cx="50" cy="9" r="4.5" stroke="#2b4a6b" stroke-width="2"/>
        <rect x="7" y="42" width="10" height="20" rx="5" fill="#ffb86b" stroke="#2b4a6b" stroke-width="2.5"/>
        <rect x="83" y="42" width="10" height="20" rx="5" fill="#ffb86b" stroke="#2b4a6b" stroke-width="2.5"/>
        <rect x="14" y="21" width="72" height="55" rx="22" fill="#bfe6ff" stroke="#2b4a6b" stroke-width="2.5"/>
        <path d="M24 31 Q28 25 38 25" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".75"/>
        <rect x="23" y="32" width="54" height="34" rx="15" fill="#14233a"/>
        <ellipse cx="30" cy="58" rx="4" ry="2.5" fill="#ff8fb1" opacity=".75"/>
        <ellipse cx="70" cy="58" rx="4" ry="2.5" fill="#ff8fb1" opacity=".75"/>
        <g class="mo m-happy">
          <ellipse class="eye" cx="40" cy="47" rx="5.5" ry="6.5" fill="#7dffd9"/>
          <ellipse class="eye" cx="60" cy="47" rx="5.5" ry="6.5" fill="#7dffd9"/>
          <circle cx="42" cy="44.5" r="1.8" fill="#fff"/><circle cx="62" cy="44.5" r="1.8" fill="#fff"/>
          <path d="M44 57 Q50 63 56 57" stroke="#7dffd9" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        </g>
        <g class="mo m-worried">
          <ellipse class="eye" cx="40" cy="48" rx="5.5" ry="6.5" fill="#ffd27d"/>
          <ellipse class="eye" cx="60" cy="48" rx="5.5" ry="6.5" fill="#ffd27d"/>
          <circle cx="41" cy="46.5" r="1.8" fill="#fff"/><circle cx="61" cy="46.5" r="1.8" fill="#fff"/>
          <path d="M33 42 L45 38 M67 42 L55 38" stroke="#ffd27d" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M44 60 Q47 57 50 60 T56 60" stroke="#ffd27d" stroke-width="2.5" fill="none" stroke-linecap="round"/>
        </g>
        <g class="mo m-think">
          <ellipse class="eye" cx="42" cy="45" rx="5.5" ry="6.5" fill="#7db7ff"/>
          <ellipse class="eye" cx="62" cy="45" rx="5.5" ry="6.5" fill="#7db7ff"/>
          <circle cx="44" cy="42.5" r="1.8" fill="#fff"/><circle cx="64" cy="42.5" r="1.8" fill="#fff"/>
          <path d="M46 59 L56 57" stroke="#7db7ff" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="86" cy="14" r="8" fill="#fff" stroke="#2b4a6b" stroke-width="2"/>
          <text x="86" y="18.5" text-anchor="middle" font-size="12" font-weight="700" fill="#2b4a6b">?</text>
        </g>
        <g class="mo m-sleep">
          <path d="M34 48 Q40 53 46 48 M54 48 Q60 53 66 48" stroke="#7dffd9" stroke-width="2.5" fill="none" stroke-linecap="round"/>
          <circle cx="50" cy="59" r="2.2" fill="none" stroke="#7dffd9" stroke-width="2"/>
          <text class="zz" x="80" y="22" font-size="11" font-weight="700" fill="#6b8bb0">z</text>
          <text class="zz zz2" x="88" y="12" font-size="8" font-weight="700" fill="#6b8bb0">z</text>
        </g>
        <g class="mo m-stuck">
          <ellipse class="eye" cx="40" cy="47" rx="6.5" ry="7.5" fill="#ff9d9d"/>
          <ellipse class="eye" cx="60" cy="47" rx="6.5" ry="7.5" fill="#ff9d9d"/>
          <circle cx="41.5" cy="44.5" r="2" fill="#fff"/><circle cx="61.5" cy="44.5" r="2" fill="#fff"/>
          <ellipse cx="50" cy="60" rx="3" ry="3.5" fill="#ff9d9d"/>
          <circle cx="86" cy="14" r="8" fill="#f87171" stroke="#2b4a6b" stroke-width="2"/>
          <text x="86" y="18.5" text-anchor="middle" font-size="12" font-weight="800" fill="#fff">!</text>
        </g>
      </g>
    </svg></div><div id="status">Watching your code.</div>
    <button class="icon-btn" id="key" title="Set API key">🔑</button>
    <button class="icon-btn" id="pause" title="Pause / resume">⏯</button>
    <button class="icon-btn" id="clear" title="Clear chat">🗑</button></div>
  <div id="log"><div class="msg assistant">Hi! I'm your coding buddy. I keep an eye on your editor, and when you seem stuck I'll help you with the <b>logic</b> - not just the answer. Pick a help level below and press <b>Ask</b>, or just keep coding and I'll speak up.</div></div>
  <div id="levels">
    <button class="lvl" data-l="nudge">Nudge</button>
    <button class="lvl sel" data-l="logic">Logic</button>
    <button class="lvl" data-l="pseudocode">Pseudocode</button>
    <button class="lvl" data-l="solution">Solution</button>
  </div>
  <div id="hint">Level = how much help you get. Start low and climb.</div>
  <div id="bar"><textarea id="input" rows="2" placeholder="What are you stuck on? (optional)"></textarea><button id="send">Ask</button></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const robot = document.getElementById('robot');
  const robotWrap = document.getElementById('robotWrap');
  const statusEl = document.getElementById('status');
  const input = document.getElementById('input');
  let level = 'logic';
  let mood = 'happy';
  let stuckUntil = 0;
  function setMood(m){ mood = m; robot.setAttribute('class', m); }
  robotWrap.onclick = () => {
    robotWrap.classList.remove('hop'); void robotWrap.offsetWidth; robotWrap.classList.add('hop');
    statusEl.textContent = 'Beep boop! Still watching your code.';
  };

  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function md(src){
    const parts = src.split(/\`\`\`/);
    return parts.map((p,i)=>{
      if(i%2===1){ const nl=p.indexOf('\\n'); return '<pre><code>'+esc(nl>=0?p.slice(nl+1):p)+'</code></pre>'; }
      let h = esc(p);
      h = h.replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>');
      h = h.replace(/\\n/g,'<br>');
      return h;
    }).join('');
  }
  function add(cls, html){ const d=document.createElement('div'); d.className='msg '+cls; d.innerHTML=html; log.appendChild(d); log.scrollTop=log.scrollHeight; return d; }
  function send(){ vscode.postMessage({type:'ask', level, text: input.value}); input.value=''; }

  document.getElementById('send').onclick = send;
  input.addEventListener('keydown', e => { if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); }});
  document.getElementById('key').onclick = () => vscode.postMessage({type:'setKey'});
  document.getElementById('pause').onclick = () => vscode.postMessage({type:'pause'});
  document.getElementById('clear').onclick = () => vscode.postMessage({type:'clear'});
  document.querySelectorAll('.lvl').forEach(b => b.onclick = () => {
    level = b.dataset.l;
    document.querySelectorAll('.lvl').forEach(x => x.classList.toggle('sel', x===b));
  });

  let thinkingEl = null;
  window.addEventListener('message', ev => {
    const m = ev.data;
    if(m.type==='message'){ add(m.role, m.role==='user'?esc(m.text):md(m.text)); }
    else if(m.type==='stuck'){ setMood('stuck'); stuckUntil = Date.now() + 20000; add('stuck', esc(m.text)); }
    else if(m.type==='status'){ if(mood!=='think' && Date.now() > stuckUntil) setMood(m.mood||'happy'); statusEl.textContent=m.text; }
    else if(m.type==='thinking'){
      if(m.on){ setMood('think'); stuckUntil = 0; thinkingEl = add('assistant','Thinking it through...'); }
      else { setMood('happy'); if(thinkingEl){ thinkingEl.remove(); thinkingEl=null; } }
    }
    else if(m.type==='clear'){ log.innerHTML=''; }
  });
</script></body></html>`;
}

module.exports = { activate, deactivate };
