// WebBridge Background Service Worker
// Maintains WebSocket to local bridge + routes messages between content scripts and bridge

const DEFAULT_URL = 'ws://127.0.0.1:9800';
const TOOL_CATALOGUE_URL = chrome.runtime.getURL('tool-catalogue.json');
let ws = null;
let connected = false;
let bridgeInfo = { version: null, workspace: null };
let toolList = [];
let reconnectDelay = 1000;
let reconnectTimer = null;
let heartbeatTimer = null;
const pending = new Map();

function msgId() {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getServerUrl() {
  const data = await chrome.storage.local.get('serverUrl');
  return data.serverUrl || DEFAULT_URL;
}

chrome.storage.local.get('workspacePath', (data) => {
  if (data.workspacePath && !bridgeInfo.workspace) {
    bridgeInfo.workspace = data.workspacePath;
  }
});

// ── WebSocket Connection ──

async function ensureConnected(timeoutMs = 8000) {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (ws && ws.readyState === WebSocket.OPEN) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return ws && ws.readyState === WebSocket.OPEN;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const url = await getServerUrl();
  try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }

  ws.onopen = () => {
    console.log('[WB] Connected to bridge');
    connected = true;
    reconnectDelay = 1000;
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) sendBridge({ type: 'ping' }).catch(() => {});
    }, 15000);
    sendBridge({ type: 'get_info' }).then(r => {
      bridgeInfo = r.payload || r;
      toolList = bridgeInfo.tools || [];
      if (bridgeInfo.workspace) {
        chrome.storage.local.set({ workspacePath: bridgeInfo.workspace });
      }
      broadcastStatus();
    }).catch(() => {});
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'welcome') {
      bridgeInfo = msg.payload || {};
      if (bridgeInfo.workspace) {
        chrome.storage.local.set({ workspacePath: bridgeInfo.workspace });
      }
      broadcastStatus();
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timeout } = pending.get(msg.id);
      clearTimeout(timeout);
      pending.delete(msg.id);
      msg.type === 'error' ? reject(msg.payload) : resolve(msg);
    }
  };

  ws.onclose = () => {
    connected = false;
    clearInterval(heartbeatTimer);
    for (const [id, { reject, timeout }] of pending) { clearTimeout(timeout); reject({ message: 'Disconnected' }); }
    pending.clear();
    broadcastStatus();
    scheduleReconnect();
  };

  ws.onerror = () => {};
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 10000); connect(); }, reconnectDelay);
}

async function sendBridge(msg) {
  await ensureConnected();
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject({ message: 'Not connected' }); return; }
    const id = msg.id || msgId();
    msg.id = id;
    const timeout = setTimeout(() => { pending.delete(id); reject({ message: 'Timeout' }); }, 30000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify(msg));
  });
}

function broadcastStatus() {
  chrome.tabs.query({}, (tabs) => {
    const status = { type: 'wb_status', connected, workspace: bridgeInfo.workspace, unrestricted: Boolean(bridgeInfo.unrestricted), tools: toolList };
    for (const tab of tabs) {
      if (tab.id && tab.id > 0) {
        try { chrome.tabs.sendMessage(tab.id, status).catch(() => {}); } catch (_) {}
      }
    }
  });
}

// ── Message handler from content scripts ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'wb_getStatus') {
    sendResponse({ connected, workspace: bridgeInfo.workspace, unrestricted: Boolean(bridgeInfo.unrestricted), version: bridgeInfo.version, tools: toolList });
    return false;
  }
  if (msg.type === 'wb_reconnect') {
    reconnectDelay = 1000; connect(); sendResponse({ ok: true }); return false;
  }
  if (msg.type === 'wb_call') {
    const { command, params } = msg;
    if (command === 'list_tools') {
      getToolCatalogue()
        .then(catalogue => sendResponse({ success: true, result: catalogue }))
        .catch(e => sendResponse({ success: false, error: e.message || String(e) }));
      return true;
    }

    sendBridge({ type: command, payload: params || {} })
      .then(r => {
        const result = r.payload || r;
        if (command === 'set_unrestricted') {
          bridgeInfo.unrestricted = result.unrestricted;
          broadcastStatus();
        } else if ((command === 'set_workspace' || command === 'vscode_workspace') && result.workspace) {
          bridgeInfo.workspace = result.workspace;
          broadcastStatus();
        }
        sendResponse({ success: true, result });
      })
      .catch(e => sendResponse({ success: false, error: e.message || String(e) }));
    return true;
  }
  return false;
});

const FALLBACK_CATALOGUE = [
  { name: 'list_tree', description: 'Recursively list workspace files', params: { path: 'optional relative directory', max_depth: '0-5, default 3' } },
  { name: 'read_file', description: 'Read text file content with line numbers (supports offset/limit for large files)', params: { path: 'relative file path', offset: 'optional start line (1-based)', limit: 'optional max lines (default 300)' } },
  { name: 'read_file_lines', description: 'Read selected lines from a file', params: { path: 'relative file path', start_line: 'line number', end_line: 'line number' } },
  { name: 'read_files', description: 'Read multiple relevant source/config files', params: { paths: 'array of relative file paths, max 50' } },
  { name: 'search_files', description: 'Search filenames and file contents', params: { pattern: 'glob pattern', query: 'optional literal text', content_pattern: 'optional regex', path: 'optional relative directory' } },
  { name: 'write_file', description: 'Create or overwrite a text file', params: { path: 'relative file path', content: 'complete file content' } },
  { name: 'create_file', description: 'Create a new text file; fails if it exists (pass overwrite: true to force)', params: { path: 'relative file path', content: 'file content', overwrite: 'optional boolean' } },
  { name: 'edit_file', description: 'Replace exact text in a file (supports multi-line and Windows CRLF)', params: { path: 'relative file path', old_text: 'exact existing text', new_text: 'replacement text', replace_all: 'optional boolean' } },
  { name: 'apply_patch', description: 'Apply exact-match edits to one file atomically', params: { path: 'relative file path', edits: 'array of {old_text,new_text}' } },
  { name: 'create_dir', description: 'Create a directory', params: { path: 'relative directory path' } },
  { name: 'delete_file', description: 'Delete a file or directory (supports recursive: true)', params: { path: 'relative path', recursive: 'optional boolean for directories' } },
  { name: 'get_file_info', description: 'Get file metadata', params: { path: 'relative path' } },
  { name: 'open_app', description: 'Launch/open a Windows application, document, file, or URL (e.g. notepad, calc, code, output.mp3)', params: { app: 'app name, executable, or file path' } },
  { name: 'close_app', description: 'Close/terminate a running Windows application by process name (e.g. notepad, calc)', params: { app: 'process name' } },
  { name: 'list_apps', description: 'List currently running Windows applications and active windows', params: {} },
  { name: 'run_command', description: 'Execute a shell/terminal command or script in Windows and get stdout/stderr', params: { command: 'shell command to run (e.g. python script.py, pip install x)' } }
];

let cataloguePromise;
function getToolCatalogue() {
  if (toolList && toolList.length > 0) return Promise.resolve(toolList);
  if (!cataloguePromise) {
    cataloguePromise = fetch(TOOL_CATALOGUE_URL)
      .then(r => r.json())
      .catch(() => FALLBACK_CATALOGUE);
  }
  return cataloguePromise;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl) { if (ws) ws.close(); reconnectDelay = 1000; connect(); }
});

connect();
