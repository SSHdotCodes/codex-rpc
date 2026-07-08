# codex-rpc

**[codex-rpc.ssh.codes](https://codex-rpc.ssh.codes)** · Discord Rich Presence
for the **OpenAI Codex CLI / Desktop** — like
[claude-rpc](https://claude-rpc.com) but for Codex. Your Discord profile shows
**"Playing Codex"** with a cute animated Codex mascot that changes based on
what Codex is actually doing right now, your active model, lifetime token
count, and "Get Codex RPC" / "GitHub" buttons.

```sh
npx -y codex-rpc
```

That one line installs it and starts it **in the background** — no terminal
window, starts at login, restarts if it crashes. Re-run it any time to update.

Zero dependencies, single file, Node ≥ 18. It tails Codex's session logs
(`~/.codex/sessions/**/rollout-*.jsonl`) — no hooks, no wrappers, works with
both the CLI and the desktop app, and nothing ever leaves your machine.

## States

| state | shown as | animation | triggered by |
|---|---|---|---|
| `thinking` | 🧠 Thinking… | thinking | reasoning, new prompts, task start, chewing on command results |
| `coding` | ⌨️ Writing code | typing | `apply_patch` file edits |
| `reading` | 📖 Reading files | typing | `cat`, `head`, `tail`, `sed -n`, … |
| `searching` | 🔍 Searching | typing | `rg`/`grep`/`find`, web search, browsing tools |
| `building` | ⚙️ Working… | typing | builds, installs, running commands (held while a command runs) |
| `debugging` | 🐛 Debugging | typing | failing test runners / real command errors |
| `success` | ✅ Task complete! | sleeping | `task_complete` (lingers ~3 min, then sleeps) |
| `error` | ⚠️ Hit a snag | typing | failed patches, stream errors, aborted turns |
| `sleeping` | 😴 Sleeping | sleeping | no activity for 5 min, or Codex not running |
| `deploying` | 🚀 Shipping it | typing | `git push`, `rsync`/`scp`, publish/deploy commands |

Three seamless ~19s loops cover everything — **thinking** while Codex
reasons, **typing** while it edits files and runs commands, **sleeping** when
it's idle or not running — so a long build or think just keeps looping
cleanly. The state line also shows your **lifetime Codex token usage**
(summed across every session in `~/.codex/sessions`, updated live), and
hovering the art shows your 5-hour rate-limit usage. Set
`clearWhenQuit: true` to hide the presence entirely when Codex is closed
instead of showing 😴, and `showTokens: false` to hide the token counter.

## Setup

**None, out of the box.** A shared "Codex" Discord application id is baked in
(app ids are public identifiers, not secrets — same model as claude-rpc), and
the animations are served from this repo's raw GitHub URLs — Discord only
animates presence images that come from external URLs (it flattens uploaded
art assets to static PNGs). Just run it. The **"Playing X" headline is the
Discord application's name** — so it reads "Playing Codex".

<details>
<summary>Using your own Discord application instead</summary>

1. **Create a Discord application** at
   <https://discord.com/developers/applications> → *New Application*.
   The application **name is the "Playing …" headline** on your profile.
2. **Upload the animations**: in your app → *Rich Presence* → *Art Assets* →
   upload everything in [`assets/`](assets/) (10 GIFs + `codex.png`).
   Keep the file names as the asset keys: `thinking`, `coding`, `reading`,
   `searching`, `building`, `debugging`, `success`, `error`, `sleeping`,
   `deploying`, `codex`. Assets can take a few minutes to propagate.
3. **Save your client id** (the *Application ID* on the app's General page):

   ```sh
   codex-rpc setup --client-id 123456789012345678
   ```
</details>

Run `npx -y codex-rpc` to install/update and start the background agent.

## Use

```sh
codex-rpc             # start in the background (auto-starts at login)
codex-rpc stop        # stop it            codex-rpc uninstall  # remove agent
codex-rpc logs        # tail the daemon log
codex-rpc run         # run in the foreground instead (--dry: no Discord)
codex-rpc demo        # cycle all states every 12s — check your profile!
codex-rpc set success # hold one state manually
codex-rpc status      # print the detected state (add --follow to stream)
codex-rpc doctor      # sanity-check: node, sessions dir, Discord socket, config
codex-rpc clear       # wipe the presence
```

The details line shows the **active model** (from the live session), and the
presence carries two **buttons** — "Get Codex RPC" and "GitHub" (Discord
never shows you your own buttons; ask a friend or use a second account).
Both are configurable (`showModel`, `buttons` in `~/.codex-rpc.json`).

The Discord **desktop app** must be running on the same machine (presence goes
over Discord's local IPC socket). If Discord restarts, codex-rpc reconnects on
its own.

### Options / config

Flags: `--client-id`, `--details "<second line>"`, `--codex-home`,
`--sleep-after <sec>`, `--dry` (no Discord, log states only).
The card's second line is `details · project · model` (details empty by
default). The "Playing X" headline is the Discord app name, not `details`.
Persistent config lives in `~/.codex-rpc.json`:

```json
{
  "clientId": "123456789012345678",
  "details": "",
  "sleepAfterSec": 300,
  "successHoldSec": 180,
  "smallImage": "codex",
  "assets": { "thinking": "https://example.com/custom-thinking.gif" }
}
```

`assets` entries may be uploaded asset keys **or** https URLs (Discord proxies
external images).

### Run it in the background (macOS)

```sh
cat > ~/Library/LaunchAgents/codes.ssh.codex-rpc.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>codes.ssh.codex-rpc</string>
  <key>ProgramArguments</key>
  <array><string>/usr/local/bin/node</string><string>/Users/YOU/codex-rpc/codex-rpc.js</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl load ~/Library/LaunchAgents/codes.ssh.codex-rpc.plist
```

(Adjust the node path — `which node` — and your username.)

## How detection works

Codex appends every session event to a rollout JSONL file. codex-rpc finds the
newest one (rescanning every 5s, so new sessions are picked up automatically),
tails it, and classifies each event — reasoning → thinking, `apply_patch` →
coding, `exec_command` by its command string, `task_complete` → success, etc.
Heartbeat events (token counts, streamed messages) keep the current state
alive; silence rolls over to 😴 after `sleepAfterSec`.

The animation sources (1024×1024 15s loop MP4s + the renderer that made them)
live in `~/codex-animations/` — re-render with `python3 render.py all`, then
regenerate the GIFs with the ffmpeg one-liner in that folder's history.
