# codex-rpc

Discord Rich Presence for the **OpenAI Codex CLI / Desktop** — like
[claude-rpc](https://claude-rpc.com) but for Codex. Your Discord profile shows
**"Gaming on Codex"** with a cute animated Codex mascot that changes based on
what Codex is actually doing right now.

Zero dependencies, single file, Node ≥ 18. It tails Codex's session logs
(`~/.codex/sessions/**/rollout-*.jsonl`) — no hooks, no wrappers, works with
both the CLI and the desktop app.

## States

| state | shown as | triggered by |
|---|---|---|
| `thinking` | 🧠 Thinking… | reasoning events, new prompts, task start, planning |
| `coding` | ⌨️ Writing code | `apply_patch` file edits |
| `reading` | 📖 Reading files | `cat`, `head`, `tail`, `sed -n`, … |
| `searching` | 🔍 Searching | `rg`/`grep`/`find`, web search, browsing tools |
| `building` | ⚙️ Running commands | builds, installs, generic shell commands |
| `debugging` | 🐛 Debugging | test runners, commands exiting non-zero |
| `success` | ✅ Task complete! | `task_complete` (lingers ~3 min) |
| `error` | ⚠️ Hit a snag | failed patches, stream errors, aborted turns |
| `sleeping` | 😴 Idle | no activity for 5 min |
| `deploying` | 🚀 Shipping it | `git push`, `rsync`/`scp`, publish/deploy commands |

## Setup

**None, out of the box.** A shared "Gaming on Codex" Discord application id is
baked in (app ids are public identifiers, not secrets — same model as
claude-rpc), and the animations are served from this repo's raw GitHub URLs —
Discord only animates presence images that come from external URLs (it
flattens uploaded art assets to static PNGs). Just run it.

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

Optionally `npm link` in this folder to get a global `codex-rpc` command.

## Use

```sh
codex-rpc doctor      # sanity-check: node, sessions dir, Discord socket, config
codex-rpc demo        # cycle all 10 states every 12s — check your profile!
codex-rpc             # go live: mirrors whatever Codex is doing
codex-rpc set success # hold one state manually
codex-rpc status      # print the detected state (add --follow to stream)
codex-rpc clear       # wipe the presence
```

The Discord **desktop app** must be running on the same machine (presence goes
over Discord's local IPC socket). If Discord restarts, codex-rpc reconnects on
its own.

### Options / config

Flags: `--client-id`, `--details "Gaming on Codex"`, `--codex-home`,
`--sleep-after <sec>`, `--dry` (no Discord, log states only).
Persistent config lives in `~/.codex-rpc.json`:

```json
{
  "clientId": "123456789012345678",
  "details": "Gaming on Codex",
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
