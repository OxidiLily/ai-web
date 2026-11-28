// ── WebSocket Connection ──

const DEFAULT_URL = 'ws://127.0.0.1:9800';
const TOOL_CATALOGUE_URL = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('tool-catalogue.json') : '';

let ws = null;
let connected = false;
let reconnectDelay = 1000;
let reconnectTimer = null;
let heartbeatTimer = null;
const pending = new Map();
let bridgeInfo = {};
let toolList = [];
let msgCounter = 0;

function msgId() {
  return `msg_${Date.now()}_${++msgCounter}`;
}

async function getServerUrl() {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const data = await chrome.storage.local.get('serverUrl');
      return data.serverUrl || DEFAULT_URL;
    }
  } catch (e) {}
  return DEFAULT_URL;
}

async function ensureConnected(timeoutMs = 8000) {
  if (ws && ws.readyState === WebSocket.OPEN) return true;
  
  // Check if we need to reconnect due to context issues
  try {
    const data = await chrome.storage.local.get('contextValid');
    if (!data.contextValid || !connected) {
      console.warn('[WB] Context may be invalid, forcing reconnection');
      connected = false;
    }
  } catch (e) {}
  
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
  
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Tunggu sebentar agar connection stabil
        await new Promise(r => setTimeout(r, 100));
        
        // Verify connection is still valid
        const status = await getServerUrl();
        if (status) return true;
      }
    } catch (e) {}
    
    await new Promise(r => setTimeout(r, 200)); // Increase delay untuk lebih stabil
  }
  
  console.error('[WB] Failed to connect to bridge after timeout');
  return ws && ws.readyState === WebSocket.OPEN;
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  
  const url = await getServerUrl();
  console.log(`[WB] Connecting to ${url}`);
  
  try { 
    ws = new WebSocket(url); 
  } catch (e) { 
    console.error('[WB] Failed to create WebSocket:', e.message);
    scheduleReconnect(); 
    return; 
  }

  ws.onopen = () => {
    console.log('[WB] Connected to bridge');
    connected = true;
    
    // Clear all old timers first
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    
    reconnectDelay = 1000;
    
    // Set heartbeat timer baru
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendBridge({ type: 'ping' })
          .then(r => console.log('[WB] Ping OK'))
          .catch(err => console.error('[WB] Ping failed:', err));
      }
    }, 15000);
    
    // Send initial info request with error handling
    sendBridge({ type: 'get_info' })
      .then(r => {
        if (r && r.payload) {
          bridgeInfo = r.payload || r;
          toolList = bridgeInfo.tools || [];
          console.log('[WB] Received server info:', bridgeInfo.version, bridgeInfo.workspace);
          
          if (bridgeInfo.workspace) {
            chrome.storage.local.set({ workspacePath: bridgeInfo.workspace });
          }
          broadcastStatus();
        }
      })
      .catch(err => console.error('[WB] Failed to get_info:', err));
  };

  ws.onmessage = (event) => {
    try { 
      const msg = JSON.parse(event.data); 
      
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
        
        console.log(`[WB] Response for ${msg.id}:`, msg.type);
        
        if (msg.type === 'error') {
          console.warn('[WB] Error response:', msg.payload.message);
          reject({ message: msg.payload.message, code: msg.payload.code });
        } else {
          resolve(msg);
        }
      }
    } catch (e) {
      console.error('[WB] Failed to parse message:', e.message, 'data:', event.data.substring(0, 200));
    }
  };

  ws.onclose = (event) => {
    console.warn(`[WB] Connection closed: ${event.code} - ${event.reason || ''}`);
    
    // Check if close was due to context invalidation
    const reasonLower = String(event.reason || '').toLowerCase();
    const isContextError = reasonLower.includes('context') || 
                          reasonLower.includes('unloaded') || 
                          reasonLower.includes('script');
    
    connected = false;
    
    // Clear all timers
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    
    // Cancel and reject all pending requests
    for (const [id, { reject, timeout }] of pending) { 
      clearTimeout(timeout);
      reject({ message: 'Disconnected', code: event.code, reason: event.reason }); 
    }
    pending.clear();
    
    broadcastStatus();
    
    if (!isContextError) {
      scheduleReconnect();
    } else {
      console.warn('[WB] Context may be invalid, showing reload prompt');
      // Show reload prompt in all tabs
      chrome.tabs.query({}, (tabs) => {
        for (const tab of tabs) {
          if (tab.id && tab.id > 0) {
            try {
              chrome.tabs.sendMessage(tab.id, { type: 'wb_reconnect' }).catch(() => {});
            } catch (_) {}
          }
        }
      });
    }
  };

  ws.onerror = (error) => {
    console.error('[WB] WebSocket error:', error.message || error);
    
    connected = false;
    
    // Clear all timers
    clearInterval(heartbeatTimer);
    clearTimeout(reconnectTimer);
    
    // Cancel pending requests
    for (const [id, { reject, timeout }] of pending) { 
      clearTimeout(timeout);
      reject({ message: 'WebSocket error', code: error?.code }); 
    }
    pending.clear();
    
    broadcastStatus();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  
  clearTimeout(reconnectTimer);
  const delay = Math.min(reconnectDelay, 10000);
  console.log(`[WB] Scheduling reconnect in ${delay}ms`);
  reconnectTimer = setTimeout(() => { 
    reconnectDelay = Math.min(reconnectDelay * 2, 10000); 
    connect(); 
  }, delay);
}

async function sendBridge(msg) {
  await ensureConnected();
  
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { 
      console.warn('[WB] Not connected, rejecting');
      reject({ message: 'Not connected' }); 
      return; 
    }
    
    const id = msg.id || msgId();
    msg.id = id;
    
    // Set timeout untuk pending request
    const timeout = setTimeout(() => { 
      console.warn(`[WB] Request ${id} timed out`);
      pending.delete(id);
      reject({ message: 'Timeout', id }); 
    }, 30000);
    
    pending.set(id, { resolve, reject, timeout });
    
    try {
      ws.send(JSON.stringify(msg));
      console.log(`[WB] Sent request ${id}`);
    } catch (e) {
      clearTimeout(timeout);
      pending.delete(id);
      reject({ message: 'Failed to send', error: e.message });
    }
  });
}

function broadcastStatus() {
  chrome.tabs.query({}, (tabs) => {
    const status = { 
      type: 'wb_status', 
      connected, 
      workspace: bridgeInfo.workspace, 
      unrestricted: Boolean(bridgeInfo.unrestricted), 
      tools: toolList 
    };
    
    for (const tab of tabs) {
      if (tab.id && tab.id > 0) {
        try { 
          chrome.tabs.sendMessage(tab.id, status).catch(err => console.error('[WB] Failed to broadcast:', err)); 
        } catch (_) {} 
      }
    }
  });
}

// ── Message handler from content scripts ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg.type === 'wb_getStatus') {
      // Check context validity before responding
      const isValid = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
      
      sendResponse({ 
        connected, 
        workspace: bridgeInfo.workspace, 
        unrestricted: Boolean(bridgeInfo.unrestricted), 
        version: bridgeInfo.version, 
        tools: toolList,
        contextValid: isValid
      });
      return false;
    }
    
    if (msg.type === 'wb_reconnect') {
      reconnectDelay = 1000;
      connect();
      sendResponse({ ok: true });
      return false;
    }
    
    if (msg.type === 'wb_call') {
      const { command, params } = msg;
      
      try {
        if (command === 'list_tools') {
          getToolCatalogue()
            .then(catalogue => sendResponse({ success: true, result: catalogue }))
            .catch(e => sendResponse({ success: false, error: e.message || String(e) }));
          return true;
        }

        console.log(`[WB] Calling ${command} with params`, params);
        
        sendBridge({ type: command, payload: params || {} })
          .then(r => {
            const result = r.payload || r;
            
            // Update bridge info if relevant
            if (command === 'set_unrestricted') {
              bridgeInfo.unrestricted = result.unrestricted;
              broadcastStatus();
            } else if ((command === 'set_workspace' || command === 'vscode_workspace') && result.workspace) {
              bridgeInfo.workspace = result.workspace;
              broadcastStatus();
            }
            
            sendResponse({ success: true, result });
          })
          .catch(e => {
            console.error(`[WB] ${command} failed:`, e.message);
            sendResponse({ success: false, error: e.message || String(e) });
          });
        return true;
      } catch (e) {
        console.error('[WB] Error processing message:', e);
        sendResponse({ success: false, error: e.message || String(e) });
        return true;
      }
    }
  } catch (e) {
    console.error('[WB] Unexpected error in onMessage:', e);
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
  if (changes.serverUrl) { 
    console.log('[WB] Server URL changed, reconnecting...');
    if (ws) ws.close();
    reconnectDelay = 1000;
    connect(); 
  }
  
  // Also check for context validity changes
  if (changes.contextValid && !changes.contextValid.newValue) {
    console.warn('[WB] Context invalidated, forcing reconnection');
    connected = false;
    scheduleReconnect();
  }
});

// Initial connection with logging
connect();
