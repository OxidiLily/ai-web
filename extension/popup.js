const dot = document.getElementById('dot');
const status = document.getElementById('status');
const wsInput = document.getElementById('ws');
const urlInput = document.getElementById('url');
const msg = document.getElementById('msg');
const unresChk = document.getElementById('unrestricted-chk');

function check() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    dot.className = 'dot off';
    status.textContent = 'Disconnected (no extension)';
    return;
  }
  chrome.runtime.sendMessage({ type: 'wb_getStatus' }, (r) => {
    if (chrome.runtime.lastError || !r) {
      dot.className = 'dot off';
      status.textContent = 'Disconnected';
      return;
    }
    dot.className = r.connected ? 'dot on' : 'dot off';
    const wsLabel = r.unrestricted ? '🌐 Global Access' : (r.workspace ? r.workspace.split(/[\\/]/).pop() : '(no workspace)');
    status.textContent = r.connected
      ? `Connected • ${wsLabel}`
      : 'Disconnected';
    if (r.connected && r.workspace && !wsInput.value) {
      wsInput.value = r.workspace;
    }
    if (unresChk && r.unrestricted !== undefined) {
      unresChk.checked = Boolean(r.unrestricted);
    }
  });
}
check();
setInterval(check, 1000);

if (unresChk) {
  unresChk.onchange = () => {
    const enabled = unresChk.checked;
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'wb_call', command: 'set_unrestricted', params: { enabled } }, (r) => {
      if (chrome.runtime.lastError || !r?.success) {
        msg.textContent = '❌ Gagal ubah mode: ' + (chrome.runtime.lastError?.message || r?.error);
        msg.style.color = '#ef9a9a';
        return;
      }
      msg.textContent = enabled ? '🌐 Global Access Aktif!' : '🔒 Mode Terkunci Workspace Aktif!';
      msg.style.color = enabled ? '#ffb74d' : '#81c784';
      check();
    });
  };
}

if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  chrome.storage.local.get(['serverUrl', 'workspacePath'], (d) => {
    urlInput.value = d.serverUrl || 'ws://127.0.0.1:9800';
    if (d.workspacePath) wsInput.value = d.workspacePath;
    check();
  });
} else {
  urlInput.value = 'ws://127.0.0.1:9800';
}

document.getElementById('setws').onclick = () => {
  const p = wsInput.value.trim().replace(/^["']+|["']+$/g, '').trim();
  if (!p) return;
  wsInput.value = p;
  chrome.storage.local.set({ workspacePath: p });
  chrome.runtime.sendMessage({ type: 'wb_call', command: 'set_workspace', params: { path: p } }, (r) => {
    if (chrome.runtime.lastError) {
      msg.textContent = '❌ ' + chrome.runtime.lastError.message;
      msg.style.color = '#ef9a9a';
      return;
    }
    msg.textContent = r?.success ? '✅ Workspace set!' : `❌ ${r?.error || 'Failed'}`;
    msg.style.color = r?.success ? '#81c784' : '#ef9a9a';
    check();
  });
};

document.getElementById('conn').onclick = () => {
  const u = urlInput.value.trim();
  if (u) chrome.storage.local.set({ serverUrl: u });
  chrome.runtime.sendMessage({ type: 'wb_reconnect' });
  msg.textContent = 'Reconnecting...';
  msg.style.color = '#81d4fa';
};
