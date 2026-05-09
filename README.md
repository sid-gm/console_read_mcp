# browser-mcp

An MCP server that connects Claude Code directly to a running Chrome instance via the Chrome DevTools Protocol (CDP). Lets Claude inspect network requests, console logs, and JS exceptions in real time — no copy-pasting from DevTools.

## Tools

| Tool | What it does |
|------|-------------|
| `browser_launch` | Launch Chrome with remote debugging, clear buffers, and attach CDP — all in one step. Primary entry point for any debugging session. |
| `browser_connect` | Attach to an already-running Chrome instance (fallback if Chrome is already open) |
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

Add this to your project's `.mcp.json` or `~/.claude/settings.json`:

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

## Usage

### Single-prompt workflow

Tell Claude: _"launch Chrome and investigate the network requests on [URL]"_

Claude calls `browser_launch` → Chrome opens automatically → you trigger the behavior → Claude queries network and console. No manual Chrome setup needed.

### Typical debugging flow

1. Deploy your change
2. Tell Claude: _"launch Chrome and check [URL]"_
3. Claude calls `browser_launch` (Chrome opens, buffers cleared, CDP attached)
4. You trigger the behavior (scroll, click, submit a form, etc.)
5. Claude queries `browser_get_network_requests` and `browser_get_console_logs`

### If Chrome fails to bind port 9222

```bash
pkill -x "Google Chrome" && rm -rf /tmp/chrome-debug
```

Then tell Claude to call `browser_launch` again.

### Filtering network requests

```
# Only show 4xx/5xx errors
filter_status_min: 400

# Only show requests to a specific path
filter_url: "/api/vast"

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
You:    Launch Chrome and investigate the ad tracking on https://scrollforme.com
Claude: [calls browser_launch url="https://scrollforme.com"] → Chrome launched, attached, buffers cleared
        <you scroll through the page, let ads play>
You:    Check now
Claude: [calls browser_get_network_requests filter_url="ping"]
        → GET 204 /api/ping?u=https%3A%2F%2Flive.applzr.com%2F... ✓
        [calls browser_get_console_logs level=error]
        → No errors
```

## Troubleshooting

**`ECONNREFUSED` on port 9222**
Chrome is running but hasn't bound the debug port. Run the reset command above and call `browser_launch` again.

**`Chrome is running but has no page tabs open`**
The debug port is up but no tab is attached. Open a tab in Chrome and call `browser_connect`.

**`No page tabs found`**
Chrome process exists but CDP returned no tabs. Run the reset command and call `browser_launch` again.

**macOS Local Network permission**
On macOS 14+, Chrome may need explicit Local Network permission. Check **System Settings → Privacy & Security → Local Network** and make sure Google Chrome is enabled.

**Port 9222 not showing in `lsof -i :9222`**
Chrome never started a DevTools server. Check `~/Library/Application Support/Google/Chrome/DevToolsActivePort`. If the file doesn't exist, relaunch via `browser_launch`.
