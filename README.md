# browser-mcp

An MCP server that connects Claude Code directly to a running Chrome instance via the Chrome DevTools Protocol (CDP). Lets Claude inspect network requests, console logs, and JS exceptions in real time — no copy-pasting from DevTools.

## Tools

| Tool | What it does |
|------|-------------|
| `browser_connect` | Attach to Chrome; lists open tabs and connects to the most recent page tab |
| `browser_clear` | Wipe all buffered network and console data for a fresh capture |
| `browser_get_page_info` | Show current URL, title, readyState, and buffer fill counts |
| `browser_get_network_requests` | Return captured requests with status, headers, MIME type, and size |
| `browser_get_console_logs` | Return console.log/warn/error entries and uncaught JS exceptions |

## Setup

### 1. Install dependencies

```bash
cd ~/.claude/browser-mcp
npm install
```

### 2. Register with Claude Code

Add this to your Claude Code MCP config (`.claude/settings.json` or `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/Users/<you>/.claude/browser-mcp/index.js"]
    }
  }
}
```

### 3. Launch Chrome with remote debugging

On **macOS**, use `open -a` with `--user-data-dir` pointing to a temp directory. This is required — launching the Chrome binary directly from terminal often fails to bind the debug port on macOS Sequoia (15+):

```bash
pkill -x "Google Chrome"; sleep 1
open -a "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug \
  --no-first-run \
  --no-default-browser-check
```

> **Why `--user-data-dir`?** Without it, Chrome may reuse an existing profile session and silently skip binding the debug port. A temp directory forces a clean startup that always binds port 9222.

On **Linux**:

```bash
google-chrome --remote-debugging-port=9222 --no-first-run &
```

Verify Chrome is listening:

```bash
curl http://localhost:9222/json/version
```

## Usage

### Typical debugging flow

1. Deploy your change, open the page in Chrome
2. Tell Claude: _"connect to Chrome and investigate"_
3. Claude calls `browser_connect` → `browser_clear`
4. You trigger the behavior (click, scroll, submit a form, etc.)
5. Claude queries `browser_get_network_requests` and `browser_get_console_logs`

### Filtering network requests

```
# Only show 4xx/5xx errors
filter_status_min: 400

# Only show requests to a specific path
filter_url: "/api/view-batch"

# Only POST requests
filter_method: POST
```

### Filtering console logs

```
# Uncaught JS exceptions only
level: exception

# Errors and exceptions
level: error

# Everything
level: all
```

## Example session

```
You:    Connect to Chrome and check what's happening on https://example.com
Claude: [calls browser_connect] → Connected, attached to "Example Domain"
        [calls browser_clear]   → Buffers cleared
        <you interact with the page>
You:    Check now
Claude: [calls browser_get_network_requests filter_status_min=400]
        → POST 404 /api/view-batch — endpoint missing on this environment
        [calls browser_get_console_logs level=error]
        → Failed to load resource: /media/missing-file.mp4 (404)
```

## Troubleshooting

**`ECONNREFUSED` on port 9222**
Chrome is running but hasn't bound the port. This almost always means it was launched without `--user-data-dir` on macOS. Kill Chrome and use the `open -a` command above.

**`Chrome is running but has no page tabs open`**
The debug port is up but no tab is attached. Open a tab in Chrome and call `browser_connect` again.

**Port 9222 not showing in `lsof -i :9222`**
Check `~/Library/Application Support/Google/Chrome/DevToolsActivePort` — if the file doesn't exist, Chrome never started a DevTools server. Relaunch using the command above.

**macOS Local Network permission**
On macOS 14+, Chrome may need explicit Local Network permission. Check **System Settings → Privacy & Security → Local Network** and make sure Google Chrome is enabled.
