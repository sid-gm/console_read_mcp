'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const CDP = require('chrome-remote-interface');
const { z } = require('zod');

// ---------------------------------------------------------------------------
// Ring buffers
// ---------------------------------------------------------------------------

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.data = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }

  push(item) {
    this.data[this.head % this.capacity] = item;
    this.head++;
    if (this.size < this.capacity) this.size++;
  }

  toArray() {
    if (this.size === 0) return [];
    if (this.size < this.capacity) return this.data.slice(0, this.size);
    const start = this.head % this.capacity;
    return [...this.data.slice(start), ...this.data.slice(0, start)];
  }

  clear() {
    this.head = 0;
    this.size = 0;
  }
}

const networkBuffer = new RingBuffer(500);
const consoleBuffer = new RingBuffer(1000);

// ---------------------------------------------------------------------------
// CDP state
// ---------------------------------------------------------------------------

const state = {
  client: null,
  port: 9222,
  targetId: null,
  targetUrl: null,
  targetTitle: null,
  connected: false,
  pendingRequests: new Map(),
};

function describeArg(remoteObj) {
  if (!remoteObj) return 'undefined';
  if (remoteObj.type === 'string') return String(remoteObj.value);
  if (remoteObj.type === 'number') return String(remoteObj.value);
  if (remoteObj.type === 'boolean') return String(remoteObj.value);
  if (remoteObj.type === 'undefined') return 'undefined';
  if (remoteObj.type === 'object' && remoteObj.value === null) return 'null';
  return remoteObj.description || remoteObj.className || `[${remoteObj.type}]`;
}

async function attachToTarget(target) {
  if (state.client) {
    try { await state.client.close(); } catch (_) {}
    state.client = null;
  }

  const client = await CDP({ port: state.port, target: target.id });
  state.client = client;
  state.targetId = target.id;
  state.targetUrl = target.url;
  state.targetTitle = target.title;
  state.connected = true;
  state.pendingRequests.clear();

  const { Network, Runtime, Log, Page } = client;

  // Network
  await Network.enable({ maxPostDataSize: 65536 });

  Network.requestWillBeSent((params) => {
    state.pendingRequests.set(params.requestId, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      requestHeaders: params.request.headers,
      initiatorType: params.initiator.type,
      initiatorUrl: params.initiator.url || null,
      timestamp: params.timestamp,
      wallTime: params.wallTime,
      status: null,
      statusText: null,
      responseHeaders: null,
      mimeType: null,
      encodedDataLength: null,
      failed: false,
      failureReason: null,
    });
  });

  Network.responseReceived((params) => {
    const req = state.pendingRequests.get(params.requestId);
    if (!req) return;
    req.status = params.response.status;
    req.statusText = params.response.statusText;
    req.responseHeaders = params.response.headers;
    req.mimeType = params.response.mimeType;
  });

  Network.loadingFinished((params) => {
    const req = state.pendingRequests.get(params.requestId);
    if (!req) return;
    req.encodedDataLength = params.encodedDataLength;
    networkBuffer.push({ ...req });
    state.pendingRequests.delete(params.requestId);
  });

  Network.loadingFailed((params) => {
    const req = state.pendingRequests.get(params.requestId);
    if (!req) return;
    req.failed = true;
    req.failureReason = params.errorText;
    req.canceled = params.canceled || false;
    networkBuffer.push({ ...req });
    state.pendingRequests.delete(params.requestId);
  });

  // Console / Runtime
  await Runtime.enable();
  await Log.enable();

  Runtime.consoleAPICalled((params) => {
    consoleBuffer.push({
      source: 'console',
      level: params.type,
      args: params.args.map(describeArg),
      stackTrace: params.stackTrace || null,
      timestamp: params.timestamp,
    });
  });

  Log.entryAdded((params) => {
    const e = params.entry;
    consoleBuffer.push({
      source: 'browser',
      level: e.level,
      text: e.text,
      category: e.source,
      url: e.url || null,
      lineNumber: e.lineNumber || null,
      timestamp: e.timestamp,
    });
  });

  Runtime.exceptionThrown((params) => {
    const ex = params.exceptionDetails;
    consoleBuffer.push({
      source: 'exception',
      level: 'error',
      text: ex.text,
      exception: ex.exception ? describeArg(ex.exception) : null,
      stackTrace: ex.stackTrace || null,
      url: ex.url || null,
      lineNumber: ex.lineNumber || null,
      columnNumber: ex.columnNumber || null,
      timestamp: params.timestamp,
    });
  });

  // Track URL changes across navigations
  await Page.enable();
  Page.frameNavigated((params) => {
    if (params.frame.parentId) return; // ignore subframes
    state.targetUrl = params.frame.url;
  });

  client.on('disconnect', () => {
    state.connected = false;
    state.client = null;
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'browser-mcp',
  version: '1.0.0',
});

const CHROME_LAUNCH_CMD =
  '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome ' +
  '--remote-debugging-port=9222 --no-first-run --no-default-browser-check 2>/dev/null &';

function notConnected() {
  return { content: [{ type: 'text', text: 'Not connected. Call browser_connect first.' }] };
}

// ---------------------------------------------------------------------------
// Tool: browser_connect
// ---------------------------------------------------------------------------

server.tool(
  'browser_connect',
  'Connect to a running Chrome instance with remote debugging enabled. Lists open tabs and attaches to the most recently used page tab. Call this once before any other browser_* tool. Returns the tab list and confirms which tab is attached. If Chrome is not running with --remote-debugging-port, the error message includes the exact launch command.',
  {
    port: z.number().int().min(1024).max(65535).default(9222)
      .describe('Chrome remote debugging port. Defaults to 9222.'),
  },
  async ({ port }) => {
    state.port = port;
    let tabs;
    try {
      tabs = await CDP.List({ port });
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `ERROR: Cannot reach Chrome on port ${port}.\n\nStart Chrome with:\n  ${CHROME_LAUNCH_CMD}\n\nThen call browser_connect again.\n\nDetail: ${err.message}`,
        }],
      };
    }

    const pageTabs = tabs.filter(t => t.type === 'page');
    if (pageTabs.length === 0) {
      return { content: [{ type: 'text', text: 'ERROR: Chrome is running but has no page tabs open. Open a tab first.' }] };
    }

    const target = pageTabs[0];
    try {
      await attachToTarget(target);
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `ERROR: Failed to attach CDP to tab "${target.title}": ${err.message}`,
        }],
      };
    }

    const tabList = pageTabs
      .map((t, i) => `${i === 0 ? '→' : ' '} [${t.id.slice(0, 8)}] ${t.title} — ${t.url}`)
      .join('\n');

    return {
      content: [{
        type: 'text',
        text: `Connected to Chrome on port ${port}.\nAttached to: ${target.title}\nURL: ${target.url}\n\nAll open page tabs:\n${tabList}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: browser_get_network_requests
// ---------------------------------------------------------------------------

server.tool(
  'browser_get_network_requests',
  'Return buffered network requests captured since browser_connect or the last browser_clear. Each entry includes URL, method, status code, request headers, response headers, MIME type, encoded body size, and failure reason. Entries appear in chronological order. Requests in flight (not yet complete) are not included.',
  {
    filter_url: z.string().optional()
      .describe('Case-insensitive substring to match against request URL. Omit for all.'),
    filter_method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY']).default('ANY')
      .describe('HTTP method filter. ANY matches all methods.'),
    filter_status_min: z.number().int().min(100).max(599).optional()
      .describe('Minimum HTTP status code, inclusive (e.g. 400 to see errors only).'),
    filter_status_max: z.number().int().min(100).max(599).optional()
      .describe('Maximum HTTP status code, inclusive (e.g. 499 to see 4xx only).'),
    limit: z.number().int().min(1).max(500).default(50)
      .describe('Max entries to return. Returns the most recent entries when truncating.'),
  },
  async ({ filter_url, filter_method, filter_status_min, filter_status_max, limit }) => {
    if (!state.connected) return notConnected();

    let entries = networkBuffer.toArray();

    if (filter_url) {
      const lower = filter_url.toLowerCase();
      entries = entries.filter(e => e.url.toLowerCase().includes(lower));
    }
    if (filter_method !== 'ANY') {
      entries = entries.filter(e => e.method === filter_method);
    }
    if (filter_status_min !== undefined) {
      entries = entries.filter(e => e.status !== null && e.status >= filter_status_min);
    }
    if (filter_status_max !== undefined) {
      entries = entries.filter(e => e.status !== null && e.status <= filter_status_max);
    }
    if (entries.length > limit) entries = entries.slice(entries.length - limit);

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No network requests match the given filters.' }] };
    }

    const lines = entries.map(e => {
      const status = e.failed
        ? `FAILED(${e.failureReason}${e.canceled ? ', canceled' : ''})`
        : (e.status || 'pending');
      const size = e.encodedDataLength != null ? `${e.encodedDataLength}B` : '?';
      const parts = [
        `${e.method} ${status} ${e.url}`,
        `  MIME: ${e.mimeType || '?'}  Size: ${size}  Initiator: ${e.initiatorType}${e.initiatorUrl ? ' (' + e.initiatorUrl + ')' : ''}`,
      ];
      if (e.requestHeaders && Object.keys(e.requestHeaders).length > 0) {
        parts.push(`  Request Headers: ${JSON.stringify(e.requestHeaders)}`);
      }
      if (e.responseHeaders && Object.keys(e.responseHeaders).length > 0) {
        parts.push(`  Response Headers: ${JSON.stringify(e.responseHeaders)}`);
      }
      return parts.join('\n');
    });

    return {
      content: [{
        type: 'text',
        text: `${entries.length} network request(s):\n\n${lines.join('\n\n')}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: browser_get_console_logs
// ---------------------------------------------------------------------------

server.tool(
  'browser_get_console_logs',
  'Return buffered console entries: console.log/warn/error calls, browser-generated log entries (resource errors, CSP violations, etc.), and uncaught JS exceptions with stack traces. Entries appear in chronological order.',
  {
    level: z.enum(['all', 'log', 'info', 'warn', 'error', 'exception']).default('all')
      .describe('"exception" = uncaught JS exceptions only. "error" = console.error + exceptions. "all" = everything.'),
    limit: z.number().int().min(1).max(1000).default(100)
      .describe('Max entries to return. Returns the most recent entries when truncating.'),
  },
  async ({ level, limit }) => {
    if (!state.connected) return notConnected();

    let entries = consoleBuffer.toArray();

    if (level === 'exception') {
      entries = entries.filter(e => e.source === 'exception');
    } else if (level === 'error') {
      entries = entries.filter(e => e.level === 'error' || e.source === 'exception');
    } else if (level !== 'all') {
      entries = entries.filter(e => e.level === level);
    }

    if (entries.length > limit) entries = entries.slice(entries.length - limit);

    if (entries.length === 0) {
      return { content: [{ type: 'text', text: 'No console entries match the given filter.' }] };
    }

    const lines = entries.map(e => {
      const prefix = `[${e.source.toUpperCase()}/${e.level.toUpperCase()}]`;
      const loc = e.url ? ` @ ${e.url}:${e.lineNumber != null ? e.lineNumber : '?'}` : '';

      let body;
      if (e.source === 'console') {
        body = Array.isArray(e.args) ? e.args.join(' ') : (e.text || '');
      } else if (e.source === 'exception') {
        body = e.text + (e.exception ? `: ${e.exception}` : '');
      } else {
        body = e.text || '';
      }

      const stack = e.stackTrace && e.stackTrace.callFrames
        ? '\n  Stack:\n' + e.stackTrace.callFrames
            .slice(0, 5)
            .map(f => `    ${f.functionName || '(anonymous)'} @ ${f.url}:${f.lineNumber}:${f.columnNumber}`)
            .join('\n')
        : '';

      return `${prefix}${loc}\n  ${body}${stack}`;
    });

    return {
      content: [{
        type: 'text',
        text: `${entries.length} console entry/entries:\n\n${lines.join('\n\n')}`,
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: browser_get_page_info
// ---------------------------------------------------------------------------

server.tool(
  'browser_get_page_info',
  'Return the current URL, page title, document.readyState, and buffer fill counts for the attached tab. Use this first to confirm you are looking at the right page.',
  {},
  async () => {
    if (!state.connected) return notConnected();

    let readyState = 'unknown';
    try {
      const result = await state.client.Runtime.evaluate({
        expression: 'document.readyState',
        returnByValue: true,
      });
      readyState = result.result.value;
    } catch (_) {}

    return {
      content: [{
        type: 'text',
        text: [
          `URL: ${state.targetUrl}`,
          `Title: ${state.targetTitle}`,
          `readyState: ${readyState}`,
          `Network buffer: ${networkBuffer.size} request(s) (capacity 500)`,
          `Console buffer: ${consoleBuffer.size} entry/entries (capacity 1000)`,
        ].join('\n'),
      }],
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: browser_clear
// ---------------------------------------------------------------------------

server.tool(
  'browser_clear',
  'Wipe all buffered network requests and console entries. Call this before reloading a page or starting a new debugging session to get a clean capture.',
  {},
  async () => {
    networkBuffer.clear();
    consoleBuffer.clear();
    state.pendingRequests.clear();
    return { content: [{ type: 'text', text: 'Buffers cleared. All network and console data wiped.' }] };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('browser-mcp ready\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
