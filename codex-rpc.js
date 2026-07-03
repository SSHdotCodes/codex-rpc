#!/usr/bin/env node
/**
 * codex-rpc — Discord Rich Presence for the OpenAI Codex CLI / Desktop.
 *
 * Tails ~/.codex/sessions rollout logs, classifies what Codex is doing,
 * and shows "Gaming on Codex" + a cute animation per state, claude-rpc style.
 *
 * Zero dependencies. Node >= 18.
 *
 *   codex-rpc                start watching + updating presence
 *   codex-rpc demo           cycle through all 10 states (great for testing)
 *   codex-rpc set <state>    hold one state
 *   codex-rpc status         print detected state (add --follow to stream)
 *   codex-rpc doctor         check Discord socket / sessions / config
 *   codex-rpc setup --client-id <id>   save your Discord application id
 *   codex-rpc clear          clear presence and exit
 */

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- states
const STATES = {
  thinking:  { text: '🧠 Thinking…',        blurb: 'Codex is pondering' },
  coding:    { text: '⌨️ Writing code',      blurb: 'Codex is writing code' },
  reading:   { text: '📖 Reading files',    blurb: 'Codex is reading the codebase' },
  searching: { text: '🔍 Searching',        blurb: 'Codex is hunting for answers' },
  building:  { text: '⚙️ Working…',         blurb: 'Codex is running commands' },
  debugging: { text: '🐛 Debugging',        blurb: 'Codex is squashing bugs' },
  success:   { text: '✅ Task complete!',   blurb: 'Codex finished the task' },
  error:     { text: '⚠️ Hit a snag',       blurb: 'Codex hit an error' },
  sleeping:  { text: '😴 Sleeping',         blurb: 'Codex is napping' },
  deploying: { text: '🚀 Shipping it',      blurb: 'Codex is shipping' },
};

// The three hero animations cover all states:
//   thinking = reasoning/thinking · coding = editing files/working ·
//   sleeping = idle / Codex not running (and post-task rest)
// Override per-state via the `assets` config map.
const STATE_IMAGE = {
  thinking: 'thinking',
  coding: 'coding', reading: 'coding', searching: 'coding', building: 'coding',
  debugging: 'coding', deploying: 'coding', error: 'coding',
  sleeping: 'sleeping', success: 'sleeping',
};

// Default shared "Gaming on Codex" Discord application (public identifier,
// not a secret — same model as claude-rpc). Override with --client-id,
// CODEX_RPC_CLIENT_ID, or ~/.codex-rpc.json.
const DEFAULT_APP_ID = '1522026697908813864';

const DEFAULTS = {
  clientId: process.env.CODEX_RPC_CLIENT_ID || DEFAULT_APP_ID,
  details: 'Gaming on Codex',
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  sleepAfterSec: 300,     // no activity -> sleeping
  successHoldSec: 180,    // how long "task complete" lingers
  updateEverySec: 5,      // min seconds between presence pushes
  assets: {},             // per-state override: asset key or https URL
  smallImage: 'codex',    // set to '' to disable
  showTokens: true,       // append lifetime Codex token usage to the state line
  showModel: true,        // append the active model to the details line
  clearWhenQuit: false,   // true = hide presence when Codex isn't running
                          // (default shows 😴 Sleeping instead)
  buttons: [              // up to 2 presence buttons (label ≤ 32 chars)
    { label: 'Get Codex RPC', url: 'https://codex-rpc.ssh.codes' },
    { label: 'GitHub', url: 'https://github.com/SSHdotCodes/codex-rpc' },
  ],
  // Where the animated GIFs are hosted. Discord flattens *uploaded* art
  // assets to static PNGs; presence only animates via external image URLs
  // (same trick claude-rpc uses). Set to '' to fall back to uploaded assets.
  assetBase: 'https://raw.githubusercontent.com/SSHdotCodes/codex-rpc/main/assets',
  // Discord's media proxy caches external URLs forever — bump this whenever
  // the GIFs change so clients fetch the new frames.
  assetVersion: 2,
};

const CONFIG_PATH = path.join(os.homedir(), '.codex-rpc.json');

function loadConfig(argv) {
  let cfg = { ...DEFAULTS };
  try {
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch { /* no config yet */ }
  const take = (flag) => {
    const i = argv.indexOf(flag);
    if (i !== -1 && argv[i + 1] !== undefined) {
      const v = argv[i + 1];
      argv.splice(i, 2);
      return v;
    }
    return undefined;
  };
  const cid = take('--client-id');
  if (cid) cfg.clientId = cid;
  const det = take('--details');
  if (det) cfg.details = det;
  const home = take('--codex-home');
  if (home) cfg.codexHome = home;
  const sleep = take('--sleep-after');
  if (sleep) cfg.sleepAfterSec = Number(sleep);
  return cfg;
}

// ---------------------------------------------------------------- classifier
const RX = {
  deploy: /\b(git\s+push|rsync|scp\s|vercel|netlify|fly\s+deploy|gh\s+(release|pr\s+create)|npm\s+publish|twine\s+upload|cargo\s+publish|wrangler\s+(deploy|publish))\b/,
  test:   /\b(pytest|jest|vitest|mocha|playwright\s+test|cargo\s+test|go\s+test|ctest|tox|php\s?unit|rspec)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  build:  /\b(cargo\s+build|go\s+build|xcodebuild|swift\s+build|docker\s+build|mvn|gradle|make|cmake|ninja|tsc|vite\s+build|webpack|rollup|esbuild|emcc|gcc|g\+\+|clang)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\b(npm|pnpm)\s+(i|install)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+add\b/,
  search: /\b(rg|grep|egrep|fgrep|ag|ack|fd|fzf)\b|^\s*(find|ls|tree)\b|\b(curl|wget)\b/,
  read:   /\b(cat|bat|head|tail|less|more|nl)\b|\bsed\s+-n\b|\bwc\s+-l\b/,
};

function classifyCmd(cmd) {
  if (RX.deploy.test(cmd)) return 'deploying';
  if (RX.test.test(cmd)) return 'debugging';
  if (RX.build.test(cmd)) return 'building';
  if (RX.search.test(cmd)) return 'searching';
  if (RX.read.test(cmd)) return 'reading';
  return 'building'; // generic command execution
}

const BROWSER_TOOLS = new Set(['click', 'type_text', 'js', 'get_app_state', 'list_apps', 'scroll', 'screenshot']);
const THINKY_TOOLS = new Set(['update_plan', 'create_goal', 'update_goal', 'get_goal']);

/**
 * Classify one rollout line.
 *
 * Codex logs items on COMPLETION, so "what is Codex doing right now" is
 * really "what comes after the last logged item":
 *   - a function_call with no output yet  → that command is running NOW (kind 'call')
 *   - an output landed, log went quiet    → Codex is chewing on the result (kind
 *     'result'; the Presence machine flips to 'thinking' after a short gap)
 *
 * Returns {state, kind, keepAlive} — state=null means "no state change".
 * callStates correlates call_id → state so exit codes can be judged in context
 * (rg/grep exit 1 just means "no match"; a failing test runner is a real bug).
 */
function classifyLine(json, callStates) {
  const p = json.payload || {};
  const t = json.type;
  const pt = p.type;

  if (t === 'response_item') {
    if (pt === 'reasoning') return { state: 'thinking' };
    if (pt === 'web_search_call') return { state: 'searching', kind: 'call' };
    if (pt === 'tool_search_call') return { state: 'searching', kind: 'call' };
    if (pt === 'tool_search_output') return { state: null, kind: 'result', keepAlive: true };
    if (pt === 'image_generation_call') return { state: 'building', kind: 'call' };
    if (pt === 'function_call' || pt === 'custom_tool_call') {
      const name = p.name || '';
      if (name === 'write_stdin') return { state: null, keepAlive: true };
      let state = 'building';
      if (name === 'apply_patch') state = 'coding';
      else if (name === 'exec_command' || name === 'shell' || name === 'local_shell') {
        try {
          const args = JSON.parse(p.arguments || p.input || '{}');
          const cmd = Array.isArray(args.command) ? args.command.join(' ') : (args.cmd || args.command || '');
          if (cmd) state = classifyCmd(String(cmd));
        } catch { /* keep 'building' */ }
      } else if (BROWSER_TOOLS.has(name)) state = 'searching';
      else if (THINKY_TOOLS.has(name)) state = 'thinking';
      if (p.call_id && callStates) {
        callStates.set(p.call_id, state);
        if (callStates.size > 300) callStates.delete(callStates.keys().next().value);
      }
      return { state, kind: 'call' };
    }
    if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
      const m = /Exit code:\s*(\d+)/.exec(p.output || '');
      if (m) {
        const code = Number(m[1]);
        const prev = p.call_id && callStates ? callStates.get(p.call_id) : undefined;
        if (code !== 0 && (prev === 'debugging' || code > 1)) {
          return { state: 'debugging', kind: 'result' };
        }
      }
      return { state: null, kind: 'result', keepAlive: true };
    }
    if (pt === 'message') return { state: null, keepAlive: true };
  }

  if (t === 'event_msg') {
    if (pt === 'task_started') return { state: 'thinking' };
    if (pt === 'task_complete') return { state: 'success' };
    if (pt === 'user_message') return { state: 'thinking' };
    if (pt === 'web_search_begin') return { state: 'searching', kind: 'call' };
    if (pt === 'web_search_end') return { state: 'searching', kind: 'result' };
    if (pt === 'patch_apply_begin') return { state: 'coding', kind: 'call' };
    if (pt === 'patch_apply_end') {
      return p.success === false
        ? { state: 'error', kind: 'result' }
        : { state: 'coding', kind: 'result' };
    }
    if (pt === 'error' || pt === 'stream_error' || pt === 'turn_aborted') return { state: 'error' };
    if (pt === 'mcp_tool_call_begin') return { state: 'building', kind: 'call' };
    if (pt === 'mcp_tool_call_end') return { state: null, kind: 'result', keepAlive: true };
    if (pt === 'image_generation_end') return { state: null, kind: 'result', keepAlive: true };
    if (pt === 'agent_message' || pt === 'token_count' || pt === 'agent_reasoning' ||
        pt === 'context_compacted' || pt === 'thread_rolled_back') {
      return { state: null, keepAlive: true };
    }
  }
  return { state: null };
}

// ---------------------------------------------------------------- session watcher
function listDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}

function topRollouts(sessionsRoot, k) {
  const all = [];
  for (const y of listDirs(sessionsRoot)) {
    for (const m of listDirs(path.join(sessionsRoot, y))) {
      for (const d of listDirs(path.join(sessionsRoot, y, m))) {
        const dir = path.join(sessionsRoot, y, m, d);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const fp = path.join(dir, f);
          let st;
          try { st = fs.statSync(fp); } catch { continue; }
          all.push({ path: fp, mtimeMs: st.mtimeMs });
        }
      }
    }
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all.slice(0, k);
}

function newestRollout(sessionsRoot) {
  return topRollouts(sessionsRoot, 1)[0] || null;
}

/** Last cumulative token total recorded in a rollout file (reads the tail). */
function lastSessionTokens(fp) {
  try {
    const st = fs.statSync(fp);
    const len = Math.min(st.size, 64 * 1024);
    if (!len) return 0;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(fp, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    let idx = text.lastIndexOf('"token_count"');
    while (idx !== -1) {
      const lineStart = text.lastIndexOf('\n', idx) + 1;
      const lineEnd = text.indexOf('\n', idx);
      try {
        const j = JSON.parse(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd));
        const tot = j.payload?.info?.total_token_usage?.total_tokens;
        if (typeof tot === 'number') return tot;
      } catch { /* partial line, keep looking */ }
      idx = idx > 0 ? text.lastIndexOf('"token_count"', idx - 1) : -1;
    }
  } catch { /* unreadable */ }
  return 0;
}

/** Sum lifetime token usage across every rollout file. */
function scanAllTokens(sessionsRoot) {
  const perFile = new Map();
  let sum = 0;
  for (const y of listDirs(sessionsRoot)) {
    for (const m of listDirs(path.join(sessionsRoot, y))) {
      for (const d of listDirs(path.join(sessionsRoot, y, m))) {
        const dir = path.join(sessionsRoot, y, m, d);
        let files;
        try { files = fs.readdirSync(dir); } catch { continue; }
        for (const f of files) {
          if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
          const fp = path.join(dir, f);
          const n = lastSessionTokens(fp);
          perFile.set(fp, n);
          sum += n;
        }
      }
    }
  }
  return { sum, perFile };
}

function fmtTokens(n) {
  const unit = (v, s) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))) + s;
  if (n >= 1e9) return unit(n / 1e9, 'B');
  if (n >= 1e6) return unit(n / 1e6, 'M');
  if (n >= 1e3) return unit(n / 1e3, 'k');
  return String(n);
}

/** Follows one rollout file: seeded from its tail, then appended lines. */
class Tailer {
  constructor(file, onLine) {
    this.file = file;
    this.onLine = onLine;
    this.partial = '';
    this.meta = {};           // {cwd, startedAt, sessionTokens, limitPct}
    this.callStates = new Map();
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* gone already */ }
    this.offset = Math.max(0, size - 256 * 1024);
    this.readAppended(true);
  }

  poll() {
    let st;
    try { st = fs.statSync(this.file); } catch { return; }
    if (st.size > this.offset) this.readAppended(false);
  }

  readAppended(seeding) {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); } catch { return; }
    try {
      const st = fs.fstatSync(fd);
      if (st.size <= this.offset) return;
      const len = st.size - this.offset;
      const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += buf.length;
      const chunk = this.partial + buf.toString('utf8');
      const lines = chunk.split('\n');
      this.partial = lines.pop() || '';
      for (const line of lines) this.handleLine(line, seeding);
    } finally { fs.closeSync(fd); }
  }

  handleLine(line, seeding) {
    if (!line.trim()) return;
    let j;
    try { j = JSON.parse(line); } catch { return; }
    if (j.type === 'session_meta' && j.payload) {
      this.meta.cwd = j.payload.cwd;
      this.meta.startedAt = Date.parse(j.payload.timestamp || j.timestamp) || Date.now();
    }
    if (j.type === 'turn_context' && j.payload) {
      if (j.payload.cwd) this.meta.cwd = j.payload.cwd;
      if (j.payload.model) this.meta.model = j.payload.model;
    }
    if (j.type === 'event_msg' && j.payload && j.payload.type === 'token_count') {
      const tot = j.payload.info?.total_token_usage?.total_tokens;
      if (typeof tot === 'number') this.meta.sessionTokens = tot;
      const pct = j.payload.rate_limits?.primary?.used_percent;
      if (typeof pct === 'number') this.meta.limitPct = pct;
    }
    const ts = Date.parse(j.timestamp) || Date.now();
    const res = classifyLine(j, this.callStates);
    this.onLine(res, { ts, seeding, meta: this.meta, file: this.file });
  }
}

/**
 * Tails the K most recently modified rollout files at once. Codex Desktop
 * keeps several threads alive simultaneously; following just the newest file
 * flaps between them. With every live session feeding one Presence machine,
 * the latest event across all of them wins.
 */
class SessionWatcher {
  constructor(cfg, onEvent, maxTails = 4) {
    this.cfg = cfg;
    this.onEvent = onEvent;   // ({state, kind, keepAlive}, {ts, meta, file})
    this.root = path.join(cfg.codexHome, 'sessions');
    this.maxTails = maxTails;
    this.tails = new Map();   // file -> Tailer
  }

  start() {
    this.rescan(true);
    this.pollTimer = setInterval(() => { for (const t of this.tails.values()) t.poll(); }, 900);
    this.scanTimer = setInterval(() => this.rescan(false), 5000);
  }
  stop() { clearInterval(this.pollTimer); clearInterval(this.scanTimer); }

  rescan(initial) {
    const top = topRollouts(this.root, this.maxTails);
    const keep = new Set(top.map(f => f.path));
    for (const file of this.tails.keys()) {
      if (!keep.has(file)) this.tails.delete(file);
    }
    for (const f of top) {
      if (!this.tails.has(f.path)) {
        this.tails.set(f.path, new Tailer(f.path, this.onEvent));
        if (!initial) log(`session → ${path.basename(f.path)}`);
      }
    }
  }

  tailedFiles() { return [...this.tails.keys()]; }
  liveTokens() {
    let sum = 0;
    for (const t of this.tails.values()) sum += t.meta.sessionTokens || 0;
    return sum;
  }
}

// ---------------------------------------------------------------- state machine
class Presence {
  constructor(cfg) {
    this.cfg = cfg;
    this.lastState = 'sleeping';
    this.lastKind = null;      // 'call' = a command is running right now
    this.lastActivityTs = 0;
    this.successTs = 0;
    this.errorTs = 0;
    this.meta = {};
  }
  onEvent({ state, kind, keepAlive }, { ts, meta }) {
    // Events from several tailed sessions interleave (and seeding replays
    // history), so only newer-or-equal events may move the state.
    if (state && ts >= (this.lastStateTs || 0)) {
      this.lastState = state;
      this.lastStateTs = ts;
      this.lastActivityTs = Math.max(this.lastActivityTs, ts);
      if (meta) this.meta = meta;   // display follows the session doing the work
      if (state === 'success') this.successTs = ts;
      if (state === 'error') this.errorTs = ts;
      if (kind) this.lastKind = kind;
    } else if (state || keepAlive) {
      this.lastActivityTs = Math.max(this.lastActivityTs, ts);
      if (kind && ts >= (this.lastStateTs || 0)) this.lastKind = kind;
    }
  }
  current(now = Date.now()) {
    const age = (now - this.lastActivityTs) / 1000;
    if (this.lastState === 'success') {
      if ((now - this.successTs) / 1000 < this.cfg.successHoldSec) return 'success';
      return 'sleeping';
    }
    if (age > this.cfg.sleepAfterSec) return 'sleeping';
    if (this.lastState === 'error' && (now - this.errorTs) / 1000 < 25) return 'error';
    // The log records items when they FINISH. Quiet after a result means the
    // model is reading/reasoning about it → thinking. Quiet after a call means
    // that command is still running → keep showing its state.
    if (this.lastKind === 'result' && age > 4) return 'thinking';
    return this.lastState;
  }
}

// ---------------------------------------------------------------- discord ipc
class DiscordRPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.sock = null;
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.backoff = 2000;
    this.pending = null;      // last activity we want visible
    this.onready = null;
  }

  socketCandidates() {
    const dirs = [];
    if (process.env.XDG_RUNTIME_DIR) {
      dirs.push(process.env.XDG_RUNTIME_DIR);
      dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'app/com.discordapp.Discord'));
      dirs.push(path.join(process.env.XDG_RUNTIME_DIR, 'snap.discord'));
    }
    if (process.env.TMPDIR) dirs.push(process.env.TMPDIR);
    dirs.push('/tmp');
    const out = [];
    for (const d of dirs) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
    return out;
  }

  connect() {
    const candidates = this.socketCandidates().filter(p => {
      try { return fs.statSync(p).isSocket?.() ?? true; } catch { return false; }
    });
    if (!candidates.length) return this.retry('Discord IPC socket not found (is Discord running?)');
    this.tryNext(candidates, 0);
  }

  tryNext(cands, i) {
    if (i >= cands.length) return this.retry('could not connect to any Discord IPC socket');
    const sock = net.createConnection({ path: cands[i] });
    let settled = false;
    sock.once('connect', () => {
      settled = true;
      this.sock = sock;
      this.buf = Buffer.alloc(0);
      sock.on('data', (d) => this.onData(d));
      sock.on('close', () => this.onClose());
      sock.on('error', () => { /* close handles it */ });
      this.send(0, { v: 1, client_id: this.clientId });
    });
    sock.once('error', () => { if (!settled) this.tryNext(cands, i + 1); });
  }

  retry(msg) {
    if (msg) log(`discord: ${msg} — retrying in ${Math.round(this.backoff / 1000)}s`);
    setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.6, 60000);
  }

  onClose() {
    this.ready = false;
    this.sock = null;
    this.retry('connection closed');
  }

  send(op, obj) {
    if (!this.sock) return;
    const data = Buffer.from(JSON.stringify(obj));
    const head = Buffer.alloc(8);
    head.writeInt32LE(op, 0);
    head.writeInt32LE(data.length, 4);
    this.sock.write(Buffer.concat([head, data]));
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      const body = this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
      let j = {};
      try { j = JSON.parse(body); } catch { /* ignore */ }
      if (op === 3) { this.send(4, j); continue; }             // PING → PONG
      if (op === 2) {                                          // CLOSE
        const why = j.message || JSON.stringify(j);
        log(`discord closed the connection: ${why}`);
        if (/client_id|Invalid Client ID/i.test(why)) {
          log('check your --client-id / ~/.codex-rpc.json clientId');
        }
        continue;
      }
      if (j.evt === 'READY') {
        this.ready = true;
        this.backoff = 2000;
        const u = j.data && j.data.user ? `${j.data.user.username}` : 'ok';
        log(`discord connected (${u})`);
        if (this.pending) this.setActivity(this.pending);
        if (this.onready) this.onready();
      }
      if (j.evt === 'ERROR') log(`discord error: ${j.data && j.data.message}`);
    }
  }

  setActivity(activity) {
    this.pending = activity;
    if (!this.ready) return;
    this.send(1, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: String(Date.now()) + Math.random().toString(36).slice(2),
    });
  }

  clearActivity() {
    this.pending = null;
    if (!this.ready) return;
    this.send(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: String(Date.now()) });
  }
}

// ---------------------------------------------------------------- glue
function log(...a) { console.log(new Date().toTimeString().slice(0, 8), ...a); }

function activityFor(cfg, state, meta, startedAt, totalTokens) {
  const s = STATES[state];
  const project = meta && meta.cwd ? path.basename(meta.cwd) : null;
  const img = STATE_IMAGE[state] || state;
  const large = cfg.assets[state] ||
    (cfg.assetBase ? `${cfg.assetBase}/${img}.gif?v=${cfg.assetVersion}` : img);
  let stateText = s.text;
  if (cfg.showTokens && totalTokens > 0) stateText += ` · ${fmtTokens(totalTokens)} tokens`;
  let details = cfg.details;
  if (cfg.showModel && meta && meta.model) details += ` · ${meta.model}`;
  let hover = project ? `${s.blurb} • ${project}` : s.blurb;
  if (meta && typeof meta.limitPct === 'number') {
    hover += ` • ${Math.round(meta.limitPct)}% of 5h limit used`;
  }
  const act = {
    type: 0,
    details,
    state: stateText,
    assets: {
      large_image: large,
      large_text: hover,
    },
  };
  const btns = (cfg.buttons || []).filter(b => b && b.label && b.url).slice(0, 2);
  if (btns.length) act.buttons = btns;
  if (cfg.smallImage) {
    act.assets.small_image = /^https?:/.test(cfg.smallImage) || !cfg.assetBase
      ? cfg.smallImage
      : `${cfg.assetBase}/${cfg.smallImage}.png?v=${cfg.assetVersion}`;
    act.assets.small_text = 'Codex CLI';
  }
  if (startedAt) act.timestamps = { start: Math.floor(startedAt / 1000) * 1000 };
  return act;
}

/** True if the Codex CLI or desktop app is running (matched by basename so
 *  paths that merely contain "Codex" — like project folders — don't count). */
function checkCodexRunning(cb) {
  execFile('ps', ['-Axo', 'comm='], { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    if (err) return cb(true); // fail open: never hide presence on a ps hiccup
    cb(out.split('\n').some((l) => {
      const c = l.trim();
      const base = c.split('/').pop();
      if (base === 'codex') return true;                       // CLI binary
      return base === 'Codex' && c.includes('Codex.app');      // desktop app
    }));
  });
}

function runStart(cfg, dry) {
  if (!cfg.clientId && !dry) {
    console.error('No Discord client id set. Run:  codex-rpc setup --client-id <your app id>');
    console.error('(create an app at https://discord.com/developers/applications — see README)');
    process.exit(1);
  }
  const sessionsRoot = path.join(cfg.codexHome, 'sessions');
  const presence = new Presence(cfg);
  const watcher = new SessionWatcher(cfg, (res, m) => presence.onEvent(res, m));
  watcher.start();

  // Lifetime token usage: baseline scan of every past session, plus live
  // counts from the tailed sessions (rebased whenever the tailed set changes).
  let tokens = scanAllTokens(sessionsRoot);
  let scannedKey = watcher.tailedFiles().sort().join('|');
  log(`lifetime tokens across ${tokens.perFile.size} sessions: ${fmtTokens(tokens.sum)}`);
  const totalTokens = () => {
    const key = watcher.tailedFiles().sort().join('|');
    if (key !== scannedKey) {                    // sessions appeared/rotated
      tokens = scanAllTokens(sessionsRoot);
      scannedKey = key;
    }
    let total = tokens.sum;
    for (const f of watcher.tailedFiles()) {
      const baseline = tokens.perFile.get(f) || 0;
      const live = watcher.tails.get(f).meta.sessionTokens ?? baseline;
      total += live - baseline;
    }
    return total;
  };

  let rpc = null;
  if (!dry) {
    rpc = new DiscordRPC(cfg.clientId);
    rpc.connect();
  }

  let codexRunning = true;
  checkCodexRunning((r) => { codexRunning = r; });
  setInterval(() => checkCodexRunning((r) => { codexRunning = r; }), 30000);

  let lastSent = '';
  let hidden = false;
  let startedShownAt = Date.now();
  const tick = () => {
    const state = presence.current();
    if (cfg.clearWhenQuit && !codexRunning && state === 'sleeping') {
      if (!hidden) {
        hidden = true;
        lastSent = '';
        log('codex is not running — hiding presence');
        if (rpc) rpc.clearActivity();
      }
      return;
    }
    if (hidden) { hidden = false; log('codex is back — showing presence'); }
    const startedAt = presence.meta.startedAt || startedShownAt;
    const act = activityFor(cfg, state, presence.meta, startedAt, totalTokens());
    const key = JSON.stringify(act);
    if (key !== lastSent) {
      lastSent = key;
      log(`state → ${state}  ${act.state}${presence.meta.cwd ? '  (' + path.basename(presence.meta.cwd) + ')' : ''}`);
      if (rpc) rpc.setActivity(act);
    }
  };
  tick();
  setInterval(tick, cfg.updateEverySec * 1000);

  const bye = () => {
    if (rpc) rpc.clearActivity();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);   // launchd stops us with SIGTERM
  log(`watching ${sessionsRoot}${dry ? '  (dry run, no Discord)' : ''}`);
}

// ---------------------------------------------------------------- daemon
const AGENT_LABEL = 'codes.ssh.codex-rpc';
const LOG_PATH = path.join(os.homedir(), '.codex-rpc.log');
const INSTALL_DIR = path.join(os.homedir(), '.codex-rpc');
const INSTALLED_SCRIPT = path.join(INSTALL_DIR, 'codex-rpc.js');

function agentPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

function stableScriptPath() {
  const self = fs.realpathSync(__filename);
  if (path.resolve(self) === path.resolve(INSTALLED_SCRIPT)) return self;
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.copyFileSync(self, INSTALLED_SCRIPT);
  fs.chmodSync(INSTALLED_SCRIPT, 0o755);
  return INSTALLED_SCRIPT;
}

function launchctl(args) {
  try {
    require('child_process').execFileSync('launchctl', args, { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

/** Default command: run in the background with no terminal, starting at login. */
function runDaemonStart() {
  const self = stableScriptPath();
  if (process.platform === 'darwin') {
    const uid = process.getuid();
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${process.execPath}</string><string>${self}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(agentPlistPath()), { recursive: true });
    fs.writeFileSync(agentPlistPath(), plist);
    launchctl(['bootout', `gui/${uid}/${AGENT_LABEL}`]);   // restart if already loaded
    // bootout is async; retry bootstrap while the old instance drains
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      ok = launchctl(['bootstrap', `gui/${uid}`, agentPlistPath()]);
      if (!ok) require('child_process').execSync('sleep 0.5');
    }
    if (!ok) {
      console.error('failed to start the launchd agent — try: codex-rpc run   (foreground)');
      process.exit(1);
    }
    console.log('✅ codex-rpc is running in the background (and will start at login).');
  } else {
    // Non-macOS fallback: detached background process (no auto-start at boot).
    const out = fs.openSync(LOG_PATH, 'a');
    const child = require('child_process').spawn(process.execPath, [self, 'run'],
      { detached: true, stdio: ['ignore', out, out] });
    child.unref();
    console.log(`✅ codex-rpc is running in the background (pid ${child.pid}).`);
  }
  console.log(`   logs:  codex-rpc logs   (${LOG_PATH})`);
  console.log('   stop:  codex-rpc stop      remove: codex-rpc uninstall');
}

function runDaemonStop(remove) {
  if (process.platform === 'darwin') {
    const ok = launchctl(['bootout', `gui/${process.getuid()}/${AGENT_LABEL}`]);
    console.log(ok ? 'stopped.' : 'was not running.');
    if (remove) {
      try { fs.unlinkSync(agentPlistPath()); console.log('launch agent removed.'); } catch { /* absent */ }
    }
  } else {
    console.log('on this platform, find the pid in the log and kill it manually.');
  }
}

function runLogs() {
  try {
    const text = fs.readFileSync(LOG_PATH, 'utf8').trimEnd().split('\n');
    console.log(text.slice(-30).join('\n'));
  } catch { console.log(`no logs yet at ${LOG_PATH}`); }
}

function runDemo(cfg, argv) {
  const dry = argv.includes('--dry');
  const pi = argv.indexOf('--period');
  const period = pi !== -1 ? Number(argv[pi + 1]) : 12;
  const order = Object.keys(STATES);
  let i = 0;
  let rpc = null;
  if (!dry) {
    if (!cfg.clientId) { console.error('No client id — run codex-rpc setup, or use --dry'); process.exit(1); }
    rpc = new DiscordRPC(cfg.clientId);
    rpc.connect();
  }
  const started = Date.now();
  const show = () => {
    const state = order[i % order.length];
    i++;
    log(`demo → ${state}  ${STATES[state].text}`);
    if (rpc) {
      rpc.setActivity(activityFor(cfg, state,
        { cwd: 'demo-project', limitPct: 25, model: 'gpt-5.5' },
        started, 1234567 + i * 98765));
    }
  };
  show();
  setInterval(show, period * 1000);
}

function runSet(cfg, argv) {
  const state = argv.find(a => STATES[a]);
  if (!state) { console.error(`usage: codex-rpc set <${Object.keys(STATES).join('|')}>`); process.exit(1); }
  if (!cfg.clientId) { console.error('No client id — run codex-rpc setup first'); process.exit(1); }
  const rpc = new DiscordRPC(cfg.clientId);
  rpc.onready = () => log(`holding "${STATES[state].text}" — ctrl-c to stop`);
  rpc.connect();
  rpc.setActivity(activityFor(cfg, state, null, Date.now()));
  process.on('SIGINT', () => { rpc.clearActivity(); setTimeout(() => process.exit(0), 300); });
}

function runStatus(cfg, argv) {
  const follow = argv.includes('--follow');
  const presence = new Presence(cfg);
  const watcher = new SessionWatcher(cfg, (res, m) => presence.onEvent(res, m));
  watcher.rescan(true);
  const report = () => {
    const state = presence.current();
    const files = watcher.tailedFiles();
    console.log(`${state}  ${STATES[state].text}` +
      (presence.meta.cwd ? `  project=${path.basename(presence.meta.cwd)}` : '') +
      `  live-session-tokens=${fmtTokens(watcher.liveTokens())}` +
      (files.length ? `  tailing=${files.map(f => path.basename(f)).join(', ')}` : '  (no sessions found)'));
  };
  if (!follow) { report(); process.exit(0); }
  watcher.start();
  report();
  setInterval(report, 5000);
}

function runDoctor(cfg) {
  const ok = (b, label, extra = '') => console.log(`${b ? ' ✅' : ' ❌'} ${label}${extra ? ' — ' + extra : ''}`);
  console.log('codex-rpc doctor\n');
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `node ${process.versions.node}`);
  const sessions = path.join(cfg.codexHome, 'sessions');
  const hasSessions = fs.existsSync(sessions);
  ok(hasSessions, `codex sessions dir`, sessions);
  if (hasSessions) {
    const best = newestRollout(sessions);
    ok(!!best, 'newest rollout log', best ? `${path.basename(best.path)} (${Math.round((Date.now() - best.mtimeMs) / 60000)}m old)` : 'none found');
  }
  const rpc = new DiscordRPC('0');
  const socks = rpc.socketCandidates().filter(p => { try { fs.statSync(p); return true; } catch { return false; } });
  ok(socks.length > 0, 'discord ipc socket', socks[0] || 'not found — is the Discord app running?');
  ok(!!cfg.clientId, 'client id configured', cfg.clientId ? cfg.clientId : `run: codex-rpc setup --client-id <id>`);
  console.log('\nasset keys expected on your Discord app (Rich Presence → Art Assets):');
  console.log('  ' + Object.keys(STATES).join(', ') + (cfg.smallImage ? `, ${cfg.smallImage}` : ''));
}

function runSetup(cfg, argv) {
  if (!cfg.clientId) {
    console.error('usage: codex-rpc setup --client-id <your discord application id>');
    process.exit(1);
  }
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* new */ }
  existing.clientId = cfg.clientId;
  if (cfg.details !== DEFAULTS.details) existing.details = cfg.details;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`saved ${CONFIG_PATH}`);
  console.log('now run: codex-rpc demo   (to test)   or   codex-rpc   (to go live)');
}

function runClear(cfg) {
  if (!cfg.clientId) process.exit(0);
  const rpc = new DiscordRPC(cfg.clientId);
  rpc.onready = () => { rpc.clearActivity(); setTimeout(() => process.exit(0), 300); };
  rpc.connect();
  setTimeout(() => process.exit(0), 5000);
}

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'start';
const cfg = loadConfig(argv);

switch (cmd) {
  case 'start': runDaemonStart(); break;              // background, no terminal
  case 'run': runStart(cfg, argv.includes('--dry')); break;   // foreground
  case 'stop': runDaemonStop(false); break;
  case 'uninstall': runDaemonStop(true); break;
  case 'logs': runLogs(); break;
  case 'demo': runDemo(cfg, argv); break;
  case 'set': runSet(cfg, argv); break;
  case 'status': runStatus(cfg, argv); break;
  case 'doctor': runDoctor(cfg); break;
  case 'setup': runSetup(cfg, argv); break;
  case 'clear': runClear(cfg); break;
  default:
    console.log('usage: codex-rpc [start|run|stop|uninstall|logs|demo|set <state>|status|doctor|setup|clear]');
    console.log('  codex-rpc            start in the background (auto-starts at login)');
    console.log('  codex-rpc run --dry  foreground, log states without Discord');
    process.exit(1);
}
