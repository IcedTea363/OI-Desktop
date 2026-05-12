'use strict';
/**
 * Local MCP server — exposes terminal tools to Open WebUI's backend.
 * Listens only on 127.0.0.1. Add http://127.0.0.1:<port>/mcp to
 * Open WebUI → Settings → Tools → MCP Servers.
 */

const http            = require('http');
const { spawn, execSync } = require('child_process');
const crypto          = require('crypto');
const fs              = require('fs');
const path            = require('path');
const os              = require('os');
const config          = require('./config');

const DEFAULT_PORT = 27124;

// ── AppleScript helper ─────────────────────────────────────────────────────────
function runAppleScript(script) {
  const tmp = path.join(os.tmpdir(), `oidesktop_as_${crypto.randomBytes(8).toString('hex')}.applescript`);
  fs.writeFileSync(tmp, script);
  try {
    return execSync(`osascript "${tmp}"`, { encoding: 'utf8', timeout: 12000 }).trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ── iTerm2 / Terminal.app integration ─────────────────────────────────────────
function runInITerm2(command, newTab = false) {
  // Escape for AppleScript double-quoted string
  const esc = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const openNewTab = newTab ? 'true' : 'false';

  const script = `
on run
  set cmd to "${esc}"
  set useNewTab to ${openNewTab}
  try
    tell application "System Events"
      set itermRunning to (exists process "iTerm2")
    end tell
    if itermRunning then
      tell application "iTerm2"
        activate
        if (count of windows) is 0 then
          create window with default profile
          tell current session of current window to write text cmd
        else if useNewTab then
          tell current window
            create tab with default profile
            tell current session to write text cmd
          end tell
        else
          tell current session of current window to write text cmd
        end if
      end tell
    else
      tell application "Terminal"
        activate
        if (count of windows) is 0 then
          do script cmd
        else
          do script cmd in front window
        end if
      end tell
    end if
  on error errMsg
    tell application "Terminal"
      activate
      do script cmd
    end tell
  end try
end run`;

  runAppleScript(script);
  return 'Command sent to terminal.';
}

// ── Shell command runner (output returned to AI) ───────────────────────────────
function runShellCommand(command, cwd, timeoutSec = 30) {
  return new Promise((resolve) => {
    const t0   = Date.now();
    const proc = spawn('bash', ['-c', command], {
      cwd: (cwd || os.homedir()).replace(/^~/, os.homedir()),
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    let stdout = '', stderr = '';
    const MAX = 100_000;
    proc.stdout.on('data', d => { if (stdout.length < MAX) stdout += d; });
    proc.stderr.on('data', d => { if (stderr.length < MAX) stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + `\n[killed after ${timeoutSec}s]`, exit_code: -1, ms: Date.now() - t0 });
    }, timeoutSec * 1000);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exit_code: code ?? -1, ms: Date.now() - t0 });
    });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: e.message, exit_code: -1, ms: Date.now() - t0 });
    });
  });
}

// ── Tool definitions ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'run_shell_command',
    description:
      'Execute a shell command on the local Mac. Returns stdout, stderr, and exit code. ' +
      'Use this when you need command output to reason about (git status, file listings, logs, etc.). ' +
      'For interactive or long-running commands use run_in_iterm2 instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Bash command to run' },
        cwd:     { type: 'string', description: 'Working directory (default: home dir)' },
        timeout: { type: 'number', description: 'Timeout seconds (default 30, max 120)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'run_in_iterm2',
    description:
      'Send a command to the user\'s iTerm2 terminal (falls back to Terminal.app). ' +
      'The command is visible and interactive. Use for installs, servers, editors, interactive REPLs.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string',  description: 'Command to send to the terminal' },
        new_tab: { type: 'boolean', description: 'Open in a new iTerm2 tab (default false)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file on the local machine.',
    inputSchema: {
      type: 'object',
      properties: {
        path:     { type: 'string', description: 'File path (~/ supported)' },
        encoding: { type: 'string', description: 'Encoding (default utf8)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write text content to a file on the local machine. Creates parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path (~/ supported)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default: home dir)' },
      },
    },
  },
  {
    name: 'get_system_info',
    description: 'Return basic info about the local machine: user, home dir, OS version, hostname, date/time.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool executor ──────────────────────────────────────────────────────────────
async function callTool(name, args = {}) {
  switch (name) {

    case 'run_shell_command': {
      const timeout = Math.min(Number(args.timeout) || 30, 120);
      const r = await runShellCommand(args.command, args.cwd, timeout);
      const parts = [];
      if (r.stdout) parts.push(`stdout:\n${r.stdout.trim()}`);
      if (r.stderr) parts.push(`stderr:\n${r.stderr.trim()}`);
      parts.push(`exit_code: ${r.exit_code}  (${r.ms}ms)`);
      return [{ type: 'text', text: parts.join('\n\n') || '(no output)' }];
    }

    case 'run_in_iterm2': {
      const msg = runInITerm2(args.command, !!args.new_tab);
      return [{ type: 'text', text: msg }];
    }

    case 'read_file': {
      const fp = args.path.replace(/^~/, os.homedir());
      const content = fs.readFileSync(fp, args.encoding || 'utf8');
      return [{ type: 'text', text: content }];
    }

    case 'write_file': {
      const fp = args.path.replace(/^~/, os.homedir());
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, args.content, 'utf8');
      return [{ type: 'text', text: `Written: ${fp}` }];
    }

    case 'list_directory': {
      const dp = (args.path || os.homedir()).replace(/^~/, os.homedir());
      const entries = fs.readdirSync(dp, { withFileTypes: true });
      const lines = entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
      return [{ type: 'text', text: lines.join('\n') || '(empty)' }];
    }

    case 'get_system_info': {
      let osVer = 'unknown';
      try { osVer = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim(); } catch {}
      const info = {
        username: os.userInfo().username,
        home:     os.homedir(),
        hostname: os.hostname(),
        platform: `macOS ${osVer}`,
        datetime: new Date().toISOString(),
      };
      return [{ type: 'text', text: JSON.stringify(info, null, 2) }];
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP JSON-RPC dispatcher ────────────────────────────────────────────────────
async function dispatch(msg) {
  const { id, method, params } = msg;
  const ok  = r => ({ jsonrpc: '2.0', id, result: r });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'open-webui-desktop-terminal', version: '1.0.0' },
      });

    case 'notifications/initialized':
    case 'ping':
      return id != null ? ok({}) : null;

    case 'tools/list':
      return ok({ tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: toolArgs = {} } = params || {};
      try {
        const content = await callTool(name, toolArgs);
        return ok({ content });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }

    default:
      return id != null ? err(-32601, `Method not found: ${method}`) : null;
  }
}

// ── OpenAPI schema builder ─────────────────────────────────────────────────────
function buildOpenAPISchema(baseUrl) {
  const paths = {};
  for (const tool of TOOLS) {
    paths[`/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary:     tool.description.split('.')[0],
        description: tool.description,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: tool.inputSchema } },
        },
        responses: {
          '200': {
            description: 'Tool result',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title:       'Open WebUI Desktop Terminal',
      description: 'Run shell commands, read/write files, and control iTerm2 from Open WebUI.',
      version:     '1.0.0',
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}

// ── OpenAPI tool executor (returns flat JSON, not MCP content array) ───────────
async function callToolOpenAPI(name, args = {}) {
  switch (name) {
    case 'run_shell_command': {
      const r = await runShellCommand(args.command, args.cwd, Math.min(Number(args.timeout) || 30, 120));
      return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), exit_code: r.exit_code, duration_ms: r.ms };
    }
    case 'run_in_iterm2':
      return { result: runInITerm2(args.command, !!args.new_tab) };
    case 'read_file': {
      const fp = args.path.replace(/^~/, os.homedir());
      return { content: fs.readFileSync(fp, args.encoding || 'utf8') };
    }
    case 'write_file': {
      const fp = args.path.replace(/^~/, os.homedir());
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, args.content, 'utf8');
      return { result: `Written: ${fp}` };
    }
    case 'list_directory': {
      const dp = (args.path || os.homedir()).replace(/^~/, os.homedir());
      const entries = fs.readdirSync(dp, { withFileTypes: true });
      return { entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
    }
    case 'get_system_info': {
      let osVer = 'unknown';
      try { osVer = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim(); } catch {}
      return { username: os.userInfo().username, home: os.homedir(), hostname: os.hostname(),
               platform: `macOS ${osVer}`, datetime: new Date().toISOString() };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── CORS origin validation ─────────────────────────────────────────────────────
// Only echo back an origin that is either loopback or the configured Open WebUI
// URL. Echoing ANY origin with Allow-Credentials:true would let an unrelated
// page (loaded anywhere that can reach this port) invoke shell-execution tools.
function isAllowedOrigin(origin) {
  if (!origin) return false; // no Origin header → not a cross-origin browser request
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  try {
    const configured = config.get('url');
    if (configured && origin === new URL(configured).origin) return true;
  } catch {}
  return false;
}

// ── HTTP server ────────────────────────────────────────────────────────────────
let actualPort = DEFAULT_PORT;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(new Error('Too large')); });
    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

function startServer(port = DEFAULT_PORT) {
  const server = http.createServer(async (req, res) => {
    console.log(`[MCP] ${req.method} ${req.url}  from=${req.socket.remoteAddress}  origin=${req.headers.origin || '-'}`);

    // Only set CORS headers for whitelisted origins (loopback + configured URL).
    // Echoing an arbitrary origin with Allow-Credentials:true would let any page
    // that can reach this port call our shell-execution tools.
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin',       origin);
      res.setHeader('Access-Control-Allow-Credentials',  'true');
      res.setHeader('Access-Control-Allow-Methods',      'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',      req.headers['access-control-request-headers'] || 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
    }

    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = req.url.split('?')[0]; // strip query string

    // ── Health check ───────────────────────────────────────────────────────────
    if (req.method === 'GET' && url === '/health') {
      json(200, { ok: true, port: actualPort }); return;
    }

    // ── OpenAPI schema (GET to any known prefix) ───────────────────────────────
    // Open WebUI probes the URL you registered with a GET to discover tools.
    // The servers[].url must be the origin only so tool POSTs land at /<tool>.
    if (req.method === 'GET') {
      const baseUrl = `http://${req.headers.host}`;
      json(200, buildOpenAPISchema(baseUrl)); return;
    }

    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch { json(400, { error: 'Body read failed' }); return; }

      // ── OpenAPI tool call:  POST /mcp/run_shell_command  (or /<tool>) ─────────
      // Strip leading /mcp or / prefix to get tool name
      const stripped = url.replace(/^\/(mcp\/?)?/, '');
      if (stripped && !stripped.includes('/')) {
        let args = {};
        try { args = JSON.parse(body); } catch {}
        try {
          const result = await callToolOpenAPI(stripped, args);
          json(200, result);
        } catch (e) {
          json(400, { error: e.message });
        }
        return;
      }

      // ── MCP JSON-RPC:  POST /mcp  with { jsonrpc: "2.0", ... } ───────────────
      try {
        const msg = JSON.parse(body);
        if (msg.jsonrpc) {
          const resp = await dispatch(msg);
          json(200, resp ?? { jsonrpc: '2.0', result: {} });
          return;
        }
      } catch {}

      json(400, { error: 'Unknown request format' }); return;
    }

    res.writeHead(404); res.end('Not found');
  });

  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`[MCP] Port ${port} busy, trying ${port + 1}`);
      startServer(port + 1);
    } else {
      console.error('[MCP] Server error:', e.message);
    }
  });

  // Bind to loopback only. The Open WebUI frontend runs inside this Electron
  // app and always reaches the server at 127.0.0.1. Binding to 0.0.0.0 would
  // expose run_shell_command (and friends) to every device on the LAN with no
  // authentication — an unacceptable risk for a shell-execution endpoint.
  server.listen(port, '127.0.0.1', () => {
    actualPort = port;
    console.log(`[MCP] Terminal server → http://127.0.0.1:${port}/mcp`);
  });

  return server;
}

function getLocalIP() {
  const { networkInterfaces } = require('os');
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

module.exports = { startServer, DEFAULT_PORT, runInITerm2, getPort: () => actualPort, getLocalIP };
