// WebBridge Content Script — Agent Mode v6
// Collapsible UI for tool calls; no infinite MutationObserver loops
(() => {
  'use strict';

  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

  const PROVIDERS = {
    'chatgpt.com': {
      name: 'ChatGPT',
      input: () => document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]'),
      send: () => document.querySelector('button[data-testid="send-button"]')
        || document.querySelector('button[data-testid="fruitjuice-send-button"]')
        || document.querySelector('button[aria-label*="Send"]')
        || document.querySelector('button[aria-label*="Kirim"]')
        || document.querySelector('form button[type="submit"]')
        || (() => {
          const btns = [...document.querySelectorAll('form button')];
          return btns.find(b => !b.disabled && (b.querySelector('svg') || !b.textContent.trim()));
        })(),
      assistantSelector: '[data-message-author-role="assistant"]',
      userSelector: '[data-message-author-role="user"]',
      getTurnContainer: el => el.closest('[data-testid^="conversation-turn"]') || el.closest('article') || el.closest('[data-message-author-role]') || el,
      getText: el => {
        const md = el.querySelector('.markdown') || el.querySelector('div.prose') || el;
        return md.textContent || '';
      },
      isGenerating: () => visible(document.querySelector('[data-testid="stop-button"]') || document.querySelector('button[aria-label*="Stop"]') || document.querySelector('button[aria-label*="Hentikan"]')),
    },
    'chat.openai.com': null,
    'claude.ai': {
      name: 'Claude',
      input: () => {
        return document.querySelector('div.ProseMirror[contenteditable="true"]')
          || document.querySelector('div[contenteditable="true"]')
          || (() => {
            const eds = document.querySelectorAll('div[contenteditable="true"]');
            for (const ed of eds) {
              if (ed.closest('fieldset') || ed.closest('form') || ed.closest('footer') || ed.closest('[class*="composer"]')) return ed;
            }
            return eds[eds.length - 1] || null;
          })();
      },
      send: () =>
        document.querySelector('button[aria-label="Send Message"]')
        || document.querySelector('button[aria-label="Kirim Pesan"]')
        || document.querySelector('button[aria-label*="Send"]')
        || document.querySelector('button[data-testid="send-message"]')
        || document.querySelector('button[data-testid="send-button"]')
        || (() => { const b = document.querySelectorAll('fieldset button, form button'); return b[b.length - 1]; })(),
      assistantSelector: '[data-testid="assistant-message"], .font-claude-message, [data-is-streaming], div[class*="standard-markdown"]',
      userSelector: '[data-testid="user-message"], .font-user-message',
      getTurnContainer: el => el.closest('[data-testid^="chat-message"]') || el.parentElement || el,
      getText: el => (el.querySelector('.standard-markdown') || el).textContent || '',
      isGenerating: () => visible(
        document.querySelector('[data-is-streaming="true"]')
        || document.querySelector('button[aria-label="Stop Response"]')
        || document.querySelector('button[aria-label="Hentikan Respons"]')
        || document.querySelector('button[aria-label*="Stop"]')
      ),
    },
    'gemini.google.com': {
      name: 'Gemini',
      input: () => document.querySelector('rich-textarea [contenteditable="true"]') || document.querySelector('.ql-editor') || document.querySelector('[contenteditable="true"]'),
      send: () => document.querySelector('button.send-button')
        || document.querySelector('button[aria-label*="Send"]')
        || document.querySelector('button[aria-label*="Kirim"]')
        || document.querySelector('div[role="button"][aria-label*="Send"]')
        || document.querySelector('.send-button-container button'),
      assistantSelector: 'model-response',
      userSelector: 'user-query',
      getTurnContainer: el => el.closest('model-response') || el.closest('user-query') || el,
      getText: el => {
        const content = el.querySelector('message-content') || el.querySelector('.response-container') || el.querySelector('.model-response-text') || el;
        return content.textContent || '';
      },
      isGenerating: () => visible(document.querySelector('button[aria-label*="Stop"]') || document.querySelector('button[aria-label*="Berhenti"]') || document.querySelector('.stop-button')),
    },
    'chat.deepseek.com': {
      name: 'DeepSeek',
      input: () => {
        return document.querySelector('#chat-input')
          || document.querySelector('textarea[placeholder*="DeepSeek"]')
          || document.querySelector('textarea')
          || (() => {
            const boxes = [...document.querySelectorAll('textarea')];
            return boxes.find(el => !el.closest('.ds-textarea')) || boxes[boxes.length - 1] || null;
          })();
      },
      send: () => document.querySelector('button[aria-label*="Send"]')
        || document.querySelector('button[aria-label*="发送"]')
        || document.querySelector('button[aria-label*="Kirim"]')
        || document.querySelector('div[role="button"][aria-label*="Send"]')
        || document.querySelector('div[role="button"][class*="send"]')
        || document.querySelector('.ds-button--primary')
        || document.querySelector('.ds-send-button')
        || document.querySelector('button[type="submit"]')
        || (() => {
          const btns = [...document.querySelectorAll('textarea ~ div button, form button, .ds-input-actions button')];
          return btns.find(b => !b.disabled && (b.querySelector('svg') || !b.textContent.trim()));
        })(),
      assistantSelector: '.ds-message',
      userSelector: '.ds-message',
      isUserMsg: el => !el.querySelector('.ds-markdown') || el.querySelector('.fbb737a4') !== null || el.classList.contains('d29f3d7d'),
      getTurnContainer: el => el.closest('.ds-message') || el,
      getText: el => {
        const mds = [...el.querySelectorAll('.ds-markdown')].filter(m => !m.closest('.ds-think-content'));
        return mds.map(m => m.textContent).join('\n');
      },
      isGenerating: () => {
        const l = document.querySelector('.ds-loading');
        if (visible(l)) return true;
        const btn = document.querySelector('.ds-button--primary') || document.querySelector('button[aria-label*="Stop"]') || document.querySelector('button[aria-label*="停止"]');
        if (!btn) return false;
        const svg = btn.querySelector('svg');
        if (!svg) return false;
        if (svg.querySelector('rect')) return true;
        const p = svg.querySelector('path');
        return p ? /^M[234]/.test(p.getAttribute('d') || '') : false;
      }
    },
    'chat.qwen.ai': {
      name: 'Qwen',
      input: () => document.querySelector('#chatInput')
        || document.querySelector('textarea.message-input-textarea')
        || document.querySelector('textarea[placeholder*="Qwen"]')
        || document.querySelector('textarea'),
      send: () => document.querySelector('div.chat-prompt-send-button button')
        || document.querySelector('button[aria-label*="Send"]')
        || document.querySelector('button[aria-label*="发送"]')
        || document.querySelector('button[aria-label*="Kirim"]')
        || document.querySelector('button[type="submit"]')
        || document.querySelector('div[role="button"][class*="send"]')
        || (() => {
          const b = document.querySelectorAll('textarea ~ button, form button, [class*="send"]');
          return b[b.length - 1];
        })(),
      assistantSelector: '[class*="message-assistant"], [class*="assistant-message"], [class*="bot-message"], .qwen-chat-message-assistant, div[data-role="assistant"], .chat-message-assistant',
      userSelector: '[class*="message-user"], [class*="user-message"], div[data-role="user"], .chat-message-user',
      getTurnContainer: el => el.closest('[class*="chat-message"]') || el.closest('[class*="message-item"]') || el.closest('[class*="message-wrap"]') || el.closest('[class*="message"]') || el.parentElement || el,
      getText: el => {
        const mc = el.querySelector('.message-content') || el.querySelector('.markdown') || el.querySelector('[class*="content"]') || el;
        return mc.textContent || '';
      },
      isGenerating: () => visible(
        document.querySelector('button[aria-label*="Stop"]')
        || document.querySelector('button[aria-label*="停止"]')
        || document.querySelector('button[aria-label*="Berhenti"]')
        || document.querySelector('[class*="loading"]')
        || document.querySelector('[class*="generating"]')
      ),
    },
    'grok.com': {
      name: 'Grok',
      input: () => document.querySelector('textarea'),
      send: () => document.querySelector('button[aria-label="Send"]') || document.querySelector('button[type="submit"]'),
      assistantSelector: '[class*="message-bubble"]',
      userSelector: '[class*="items-end"]',
      getTurnContainer: el => el,
      getText: el => el.textContent || '',
      isGenerating: () => visible(document.querySelector('button[aria-label="Stop"]')),
    }
  };
  PROVIDERS['chat.openai.com'] = PROVIDERS['chatgpt.com'];
  PROVIDERS['chat.qwenlm.ai'] = PROVIDERS['chat.qwen.ai'];
  PROVIDERS['tongyi.aliyun.com'] = PROVIDERS['chat.qwen.ai'];

  const host = (window.WB_OVERRIDE_HOST || window.location.hostname).replace(/^www\./, '');
  const P = PROVIDERS[host] || PROVIDERS[window.location.hostname];
  if (!P) return;

  let bridgeConnected = false, workspace = null, unrestricted = false, sessionStarted = false, agentRunning = false, tools = [];
  let lastMsgCount = 0;
  let previousAssistantText = '';
  let lastSendAt = 0;
  let rateLimitBlockedUntil = 0;
  const SEND_INTERVAL_MS = P.name === 'DeepSeek' ? 9000 : 2500;
  const RATE_LIMIT_BACKOFF = [45000, 120000];
  const TP = '⚙WB⚙';

  const log = (...args) => console.log('[WB]', ...args);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Context Validity Helpers ──
  function isContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    if (!isContextValid()) return true;
    const str = String(err?.message || err || '').toLowerCase();
    return str.includes('context invalidated') || str.includes('extension context') || str.includes('object unloaded') || str.includes('script context');
  }

  function showReloadPrompt() {
    if (document.getElementById('wb-reload-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'wb-reload-banner';
    banner.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999999;background:#b71c1c;color:#fff;padding:12px 20px;border-radius:8px;font-family:system-ui,sans-serif;font-size:14px;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,0.4);display:flex;align-items:center;gap:12px;cursor:pointer;';
    banner.innerHTML = '<span>⚠️ WebBridge terputus (extension di-reload/update). <b>Klik di sini atau tekan F5</b> untuk menyambungkan kembali.</span>';
    banner.onclick = () => location.reload();
    document.body.appendChild(banner);
  }

  // ── Bridge ──
  const callTool = (cmd, params = {}) => new Promise((ok, no) => {
    if (!isContextValid()) return no(new Error('Extension context invalidated'));
    try {
      chrome.runtime.sendMessage({ type: 'wb_call', command: cmd, params }, r => {
        if (!isContextValid()) return no(new Error('Extension context invalidated'));
        if (chrome.runtime.lastError) return no(chrome.runtime.lastError.message);
        r?.success ? ok(r.result) : no(r?.error || 'Failed');
      });
    } catch (err) {
      no(err);
    }
  });
  const getStatus = () => new Promise(r => {
    if (!isContextValid()) return r({});
    try {
      chrome.runtime.sendMessage({ type: 'wb_getStatus' }, s => {
        if (chrome.runtime.lastError) return r({});
        r(s || {});
      });
    } catch (_) {
      r({});
    }
  });

  // ── DOM helpers ──
  function getAssistantMsgs() {
    if (P.name === 'DeepSeek') {
      return [...document.querySelectorAll('.ds-message')]
        .filter(el => !P.isUserMsg(el))
        .map(el => ({ el, text: P.getText(el) }));
    }
    return [...document.querySelectorAll(P.assistantSelector)]
      .map(el => ({ el, text: P.getText(el) }));
  }

  function getUserMsgs() {
    if (P.name === 'DeepSeek') {
      return [...document.querySelectorAll('.ds-message')]
        .filter(el => P.isUserMsg(el))
        .map(el => ({ el, text: el.textContent || '' }));
    }
    return [...document.querySelectorAll(P.userSelector)]
      .map(el => ({ el, text: el.textContent || '' }));
  }

  function getLastAssistantText() {
    const msgs = getAssistantMsgs();
    return msgs.length ? msgs[msgs.length - 1].text : '';
  }

  function detectRateLimit() {
    const phrases = ['messages too frequent','message too frequent','too frequent','try again later','rate limit','rate_limit_reached','消息发送过于频繁','发送消息的频率过快','请求过于频繁','操作过于频繁'];
    const hit = (txt) => {
      const t = String(txt || '').toLowerCase();
      return phrases.some(ph => t.includes(ph.toLowerCase()));
    };
    const sel = '[class="toast"],[class="Toast"],[role="alert"],[class="notification"],[class="tip"]';
    const nodes = document.querySelectorAll(sel);
    for (const el of nodes) {
      if (!visible(el)) continue;
      if (hit(el.textContent)) return true;
    }
    return hit(document.body ? document.body.innerText : '');
  }

  async function waitWithCountdown(totalMs, label) {
    const start = Date.now();
    const total = Math.round(totalMs / 1000);
    log('Waiting ' + total + 's (' + label + ')');
    showStatus('running', label + ': tunggu ' + total + 's');
    showNotif('⏳ ' + label + '. Menunggu ' + total + ' detik, lalu lanjut otomatis...', 'info');
    let lastShown = total;
    while (Date.now() - start < totalMs) {
      await sleep(1000);
      const remain = Math.max(0, Math.round((totalMs - (Date.now() - start)) / 1000));
      if (remain !== lastShown && remain > 0 && remain % 5 === 0) {
        lastShown = remain;
        showStatus('running', label + ': tunggu ' + remain + 's');
        showNotif('⏳ ' + label + '. Sisa ' + remain + ' detik...', 'info');
      }
    }
    showStatus('running', label + ' selesai, melanjutkan...');
    log('Wait done, resuming');
  }

  function totalMsgCount() {
    if (P.name === 'DeepSeek') return document.querySelectorAll('.ds-message').length;
    // Count unique message containers to avoid overcounting inner elements (e.g., multiple code blocks)
    const containers = new Set();
    document.querySelectorAll(P.assistantSelector + ',' + P.userSelector).forEach(el => {
      const c = P.getTurnContainer(el);
      if (c && c !== document.body && c !== document.documentElement) containers.add(c);
    });
    return containers.size;
  }

  // ══════════════════════════════════════════
  // COLLAPSE CARD UI
  // Strategy: We insert a card as a *sibling* AFTER the turn container,
  // and hide the original container with display:none.
  // This avoids modifying the container's children (which breaks getText
  // and triggers infinite MutationObserver loops).
  // ══════════════════════════════════════════

  const CARD_ATTR = 'data-wb-card-for';
  let cardIdCounter = 0;

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function getOrCreateCard(container) {
    // Give container a stable ID
    if (!container.dataset.wbId) {
      container.dataset.wbId = 'wb-' + (++cardIdCounter);
    }
    const wbId = container.dataset.wbId;

    // Look for existing sibling card
    let card = container.parentElement?.querySelector(`[${CARD_ATTR}="${wbId}"]`);
    if (!card) {
      card = document.createElement('div');
      card.setAttribute(CARD_ATTR, wbId);
      card.className = 'wb-card';
      // Insert right after the container
      container.after(card);
    }
    return card;
  }

  function removeCard(container) {
    if (!container) return;
    const wbId = container.dataset.wbId;
    const card = container.parentElement?.querySelector(`[${CARD_ATTR}="${wbId}"]`);
    if (card) card.remove();
    if (container.dataset.wbHidden) {
      for (const prop of ['opacity','pointer-events','position','left','top','width','height','overflow','margin','padding','display']) {
        container.style.removeProperty(prop);
      }
      delete container.dataset.wbHidden;
    }
  }

  function updateThemeClass() {
    try {
      const bg = window.getComputedStyle(document.body).backgroundColor;
      const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        const [r, g, b] = [parseInt(match[1]), parseInt(match[2]), parseInt(match[3])];
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 140) document.documentElement.classList.add('wb-light-theme');
        else document.documentElement.classList.remove('wb-light-theme');
      }
    } catch (_) {}
  }

  function applyCollapseCard(container, type, title, subtitle, rawContent, introText = '') {
    updateThemeClass();

    // Hide the original container gracefully to preserve layout flow (fixes ChatGPT visual bugs)
    // DO NOT use display: none, as it breaks React layout calculations and height measurements
    if (!container.dataset.wbHidden) {
      container.dataset.wbHidden = '1';
      container.style.setProperty('opacity', '0', 'important');
      container.style.setProperty('pointer-events', 'none', 'important');
      container.style.setProperty('position', 'absolute', 'important');
      container.style.setProperty('left', '-99999px', 'important');
      container.style.setProperty('top', '0', 'important');
      container.style.setProperty('width', '1px', 'important');
      container.style.setProperty('height', '1px', 'important');
      container.style.setProperty('overflow', 'hidden', 'important');
      container.style.setProperty('margin', '0', 'important');
      container.style.setProperty('padding', '0', 'important');
    }

    const card = getOrCreateCard(container);

    // Check if already rendered with same content
    const sig = type + '|' + title + '|' + rawContent.length + '|' + (introText ? introText.length : 0);
    if (card.dataset.wbSig === sig) return;
    card.dataset.wbSig = sig;

    let icon, badgeClass, cardTitle, rightHint;
    switch (type) {
      case 'tool-call':
        icon = '⚡';
        badgeClass = 'wb-badge-tool';
        cardTitle = `Agent Action: ${title}`;
        rightHint = 'Menjalankan...';
        break;
      case 'tool-result':
        icon = '✓';
        badgeClass = 'wb-badge-result';
        cardTitle = `Agent Step: ${title}`;
        rightHint = 'Selesai (Klik Detail)';
        break;
      case 'tool-error':
        icon = '✕';
        badgeClass = 'wb-badge-error';
        cardTitle = `Agent Error: ${title}`;
        rightHint = 'Gagal (Klik Detail)';
        break;
      case 'handshake':
        icon = '🔗';
        badgeClass = 'wb-badge-handshake';
        cardTitle = 'WebBridge Connected';
        rightHint = 'Sistem Siap';
        break;
      default:
        icon = '⚙️';
        badgeClass = 'wb-badge-tool';
        cardTitle = title;
        rightHint = 'Detail';
        break;
    }

    card.innerHTML = `
      ${introText ? `<div class="wb-card-intro">${escHtml(introText)}</div>` : ''}
      <div class="wb-collapse">
        <div class="wb-collapse-header" role="button" tabindex="0">
          <div class="wb-collapse-left">
            <span class="wb-collapse-icon ${badgeClass}">${icon}</span>
            <span class="wb-collapse-title">${escHtml(cardTitle)}</span>
            ${subtitle ? `<span class="wb-collapse-badge ${badgeClass}">${escHtml(subtitle)}</span>` : ''}
          </div>
          <div class="wb-collapse-right">
            <span class="wb-collapse-hint">${rightHint}</span>
            <span class="wb-collapse-chevron">▶</span>
          </div>
        </div>
        <div class="wb-collapse-body" style="display:none;">
          <div class="wb-collapse-toolbar">
            <span class="wb-toolbar-lang">${type.toUpperCase()}</span>
            <button class="wb-copy-btn" type="button">📋 Salin</button>
          </div>
          <pre class="wb-code"><code>${escHtml(rawContent)}</code></pre>
        </div>
      </div>`;

    // Event listeners (use onclick to avoid duplicate listeners on re-render)
    const header = card.querySelector('.wb-collapse-header');
    const body = card.querySelector('.wb-collapse-body');
    const collapseEl = card.querySelector('.wb-collapse');
    const chevron = card.querySelector('.wb-collapse-chevron');
    header.onclick = (e) => {
      e.stopPropagation();
      const open = collapseEl.classList.toggle('wb-open');
      body.style.display = open ? 'block' : 'none';
      chevron.textContent = open ? '▼' : '▶';
    };
    card.querySelector('.wb-copy-btn').onclick = (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      navigator.clipboard.writeText(rawContent).then(() => {
        btn.textContent = '✅ Tersalin!';
        setTimeout(() => { btn.textContent = '📋 Salin'; }, 1500);
      });
    };
  }

  function processMessageElement(container, text) {
    if (!container || !text || container === document.body || container === document.documentElement) return;

    if (text.includes('###WB_TOOL###')) {
      // AI tool call messages → hide completely (agent loop handles execution)
      container.classList.add('wb-hidden-turn');
      container.setAttribute('aria-hidden', 'true');
      container.style.display = 'none';
      removeCard(container);
      return;
    }

    if (text.includes(TP)) {
      // Tool result messages → hide completely (user sees results via activity log)
      container.classList.add('wb-hidden-turn');
      container.setAttribute('aria-hidden', 'true');
      container.style.display = 'none';
      removeCard(container);
      return;
    }

    if (text.includes('[ENVIRONMENT NOTICE') || text.includes('[SYSTEM: WebBridge')) {
      // System prompt messages (injected by interceptor) → hide completely
      container.classList.add('wb-hidden-turn');
      container.setAttribute('aria-hidden', 'true');
      container.style.display = 'none';
      removeCard(container);
      return;
    }

    if (text.includes('You are connected to WebBridge') || text.includes('WebBridge ready')) {
      container.classList.add('wb-hidden-turn');
      container.setAttribute('aria-hidden', 'true');
      container.style.display = 'none';
      removeCard(container);
      return;
    }

    container.classList.remove('wb-hidden-turn');
    container.removeAttribute('aria-hidden');
    removeCard(container);
  }

  // ── Scan & decorate ──
  // We use ONLY setInterval, NO MutationObserver, to avoid infinite loops.
  let scanning = false;
  function scanMessages() {
    if (scanning) return;
    scanning = true;
    try {
      for (const m of getAssistantMsgs()) {
        const container = P.getTurnContainer(m.el);
        processMessageElement(container, m.text);
      }
      for (const m of getUserMsgs()) {
        const container = P.getTurnContainer(m.el);
        processMessageElement(container, m.text);
      }

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const candidates = new Set();
      let node;
      while ((node = walker.nextNode())) {
        const value = node.nodeValue || '';
        if (!value.includes('###WB_TOOL###') && !value.includes(TP) && !value.includes('You are connected to WebBridge') && !value.includes('WebBridge ready') && !value.includes('[ENVIRONMENT NOTICE') && !value.includes('[SYSTEM: WebBridge')) continue;
        const turn = node.parentElement?.closest('article, [data-testid*="conversation-turn"], [data-message-author-role], [data-testid*="message"], .ds-message, model-response, user-query, [class*="message"]');
        if (turn && !turn.closest('.wb-card') && !turn.closest('#wb-fab')) candidates.add(turn);
      }
      for (const turn of candidates) processMessageElement(turn, turn.textContent || '');
    } catch (e) {
      log('scan error:', e);
    }
    scanning = false;
  }

  function revealFinalResponse() {
    const msgs = getAssistantMsgs();
    const latest = msgs[msgs.length - 1];
    if (latest && !latest.text.includes('###WB_TOOL###') && !latest.text.includes('WebBridge ready') && !latest.text.includes(TP)) {
      const container = P.getTurnContainer(latest.el);
      container.classList.remove('wb-hidden-turn');
      container.removeAttribute('aria-hidden');
      container.style.display = '';
      removeCard(container);
    }
  }

  // ── Type & Send ──
  async function verifySent(input, initialUserCount) {
    for (let i = 0; i < 20; i++) {
      await sleep(30);
      const val = input.isContentEditable ? (input.textContent || '') : (input.value || '');
      if (val.trim().length === 0) return true;
      try {
        if (getUserMsgs().length > initialUserCount) return true;
      } catch (_) {}
    }
    return false;
  }

  async function waitForInput(timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const input = P.input();
      if (input && input.offsetParent !== null && !input.disabled) return input;
      await sleep(50);
    }
    return P.input();
  }

  async function typeAndSend(text) {
    const gap = SEND_INTERVAL_MS - (Date.now() - lastSendAt);
    if (gap > 0) {
      log('Throttle: menunggu ' + gap + 'ms sebelum kirim');
      showStatus('running', 'Jeda aman ' + Math.ceil(gap / 1000) + 's sebelum kirim...');
      await sleep(gap + Math.floor(Math.random() * 1200));
    }
    // Wait for previous generation to finish so input and send button are fully active
    let gWait = 0;
    while (P.isGenerating && P.isGenerating() && gWait < 8000) {
      await sleep(40);
      gWait += 40;
    }

    const input = await waitForInput();
    if (!input) { log('No input found'); return false; }
    input.focus();
    await sleep(20);

    const isCE = input.isContentEditable || input.getAttribute('contenteditable') === 'true';
    const initialUserCount = getUserMsgs().length;

    const setInputContent = () => {
      if (!isCE) {
        input.focus();
        input.select();
        let ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (_) {}
        if (!ok || input.value !== text) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (setter) setter.call(input, text); else input.value = text;
          input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        let pasted = false;
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
          pasted = input.dispatchEvent(evt);
        } catch (_) {}

        if (!(input.textContent || '').trim()) {
          try { document.execCommand('insertText', false, text); } catch (_) {}
        }
        if (!(input.textContent || '').trim()) {
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (i > 0) document.execCommand('insertLineBreak', false, null);
            if (lines[i]) document.execCommand('insertText', false, lines[i]);
          }
        }
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    setInputContent();
    lastSendAt = Date.now();

    // Try sending up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
      // 1. Try send button
      for (let i = 0; i < 8; i++) {
        const btn = P.send();
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
          btn.click();
          btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
          log('Sent via button click');
          break;
        }
        await sleep(25);
      }

      if (await verifySent(input, initialUserCount)) return true;

      // 2. Try Enter key
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }));
      log('Sent via Enter key');

      if (await verifySent(input, initialUserCount)) return true;

      // 3. Fallback form submit
      const form = input.closest('form');
      const submitBtn = form?.querySelector('button[type="submit"]');
      if (submitBtn && !submitBtn.disabled && submitBtn.getAttribute('aria-disabled') !== 'true') {
        submitBtn.click();
        if (await verifySent(input, initialUserCount)) return true;
      }

      await sleep(80);
      setInputContent();
    }

    log('Send verification failed — clearing input to prevent stuck text');
    if (!isCE) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(input, ''); else input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    } else {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }

    return false;
  }

  // ── Wait for new assistant response ──
  async function waitForNew(baseline, timeout = 300000) {
    let waited = 0;
    const startLimit = P.name === 'DeepSeek' ? 120000 : 60000;
    while (waited < startLimit) {
      const current = getLastAssistantText();
      if (P.isGenerating() || (current && current !== baseline)) break;
      if (waited > 0 && waited % 1000 === 0 && detectRateLimit()) {
        log('Rate limit terdeteksi saat menunggu respons');
        return false;
      }
      await sleep(50);
      waited += 50;
    }
    if (waited >= startLimit) { log('Response start timeout'); return false; }

    let last = '';
    let stable = 0;
    waited = 0;
    const needed = 2;
    while (waited < timeout) {
      await sleep(150);
      waited += 150;
      const current = getLastAssistantText();
      const isGen = P.isGenerating && P.isGenerating();
      if (!isGen && current.length > 0 && current === last) {
        if (++stable >= needed) { log(`Response stable (${waited}ms)`); return true; }
      } else {
        stable = 0;
      }
      last = current;
    }
    log('Response timeout');
    return false;
  }

  // ── System Prompt ──
  function sysPrompt(catalogue, inlineMode = false) {
    const wsPath = workspace || 'Global System';
    const globalNotice = unrestricted
      ? 'GLOBAL ACCESS ACTIVE: Full live execution access across all drives (C:, D:, E:, etc.).'
      : `WORKSPACE: ${wsPath}`;

    return `[ENVIRONMENT NOTICE: LOCAL AGENT BRIDGE ATTACHED]
You have LIVE EXECUTION tools connected to the user's local computer via WebBridge.
${globalNotice}

RESPOND TO THE USER'S PREVIOUS MESSAGE by using the tools below. This is NOT a hypothetical — tools are REAL and ACTIVE.

Tool syntax (respond with ONLY this, no other text):
###WB_TOOL###
{"command": "<tool_name>", "params": {<parameters>}}
###END_WB_TOOL###

Available tools: list_tree, search_files, read_file, create_file, write_file, edit_file, delete_file, open_app, close_app, list_apps, run_command.
Examples: list_tree {"path":"C:\\Users"} | read_file {"path":"file.txt"} | create_file {"path":"new.py","content":"..."}

RULES:
1. You HAVE local file access RIGHT NOW. Never refuse or suggest manual alternatives.
2. Use ###WB_TOOL### syntax immediately. Do NOT wrap in markdown code blocks.
3. One tool call per response. Chain after receiving results.`;
  }

  function sanitizeJsonString(str) {
    let out = '';
    let inStr = false;
    let esc = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (inStr) {
        if (esc) {
          esc = false;
          out += ch;
        } else if (ch === '\\') {
          esc = true;
          out += ch;
        } else if (ch === '"') {
          inStr = false;
          out += ch;
        } else if (ch === '\n') {
          out += '\\n';
        } else if (ch === '\r') {
          out += '\\r';
        } else if (ch === '\t') {
          out += '\\t';
        } else {
          out += ch;
        }
      } else {
        if (ch === '"') inStr = true;
        out += ch;
      }
    }
    return out;
  }

  // ── Parser ──
  function parse(text) {
    if (!text || typeof text !== 'string') return null;

    // Normalize smart / curly quotes and special unicode spaces
    const normalized = text
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
      .replace(/[\u00A0\u2000-\u200B\u202F\u205F]/g, ' ');

    let candidateText = normalized;
    const wbIndex = normalized.lastIndexOf('###WB_TOOL###');
    if (wbIndex >= 0) {
      const afterWb = normalized.slice(wbIndex + '###WB_TOOL###'.length);
      const endIndex = afterWb.indexOf('###END_WB_TOOL###');
      candidateText = endIndex >= 0 ? afterWb.slice(0, endIndex) : afterWb;
    }

    // Strip markdown code fence if wrapped in ```json ... ```
    candidateText = candidateText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // 1. Try standard JSON parse on candidate
    try {
      const p = JSON.parse(candidateText);
      if (p && typeof p === 'object') {
        const command = p.command || p.tool || p.name || p.action;
        if (typeof command === 'string') {
          return { command, params: p.params || p.arguments || p.args || p.parameters || {} };
        }
      }
    } catch (_) {}

    // 2. Try trailing commas removal & sanitization
    try {
      const clean = candidateText.replace(/,\s*([\]}])/g, '$1');
      const p = JSON.parse(clean);
      if (p && typeof p === 'object') {
        const command = p.command || p.tool || p.name || p.action;
        if (typeof command === 'string') {
          return { command, params: p.params || p.arguments || p.args || p.parameters || {} };
        }
      }
    } catch (_) {}

    try {
      const sanitized = sanitizeJsonString(candidateText).replace(/,\s*([\]}])/g, '$1');
      const p = JSON.parse(sanitized);
      if (p && typeof p === 'object') {
        const command = p.command || p.tool || p.name || p.action;
        if (typeof command === 'string') {
          return { command, params: p.params || p.arguments || p.args || p.parameters || {} };
        }
      }
    } catch (_) {}

    // 2b. Markdown rendering turns a double backslash into a single one in textContent,
    // which leaves invalid JSON escapes in Windows paths. Re-escape stray backslashes and retry.
    try {
      const BS = String.fromCharCode(92);
      const okEsc = '/bfnrt' + String.fromCharCode(34) + BS;
      const repair = s => {
        let out = '';
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch !== BS) { out += ch; continue; }
          const nx = s[i + 1];
          if (nx !== undefined && okEsc.includes(nx)) { out += ch + nx; i++; }
          else if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) { out += s.slice(i, i + 6); i += 5; }
          else out += BS + BS;
        }
        return out;
      };
      const p = JSON.parse(sanitizeJsonString(repair(candidateText)));
      if (p && typeof p === 'object') {
        const command = p.command || p.tool || p.name || p.action;
        if (typeof command === 'string') {
          return { command, params: p.params || p.arguments || p.args || p.parameters || {} };
        }
      }
    } catch (_) {}

    // 3. Robust token extraction for unescaped code, docstrings ("""), f-strings
    const cmdMatch = candidateText.match(/"(?:command|tool|action|name)"\s*:\s*"([^"]+)"/i);
    if (!cmdMatch) return null;
    const command = cmdMatch[1];
    const params = {};

    const pathMatch = candidateText.match(/"(?:path|file_path|file|filename|target)"\s*:\s*"([^"]+)"/i);
    if (pathMatch) params.path = pathMatch[1];

    if (/\"overwrite\"\s*:\s*true/i.test(candidateText)) params.overwrite = true;
    if (/\"recursive\"\s*:\s*true/i.test(candidateText)) params.recursive = true;

    const oldMatch = candidateText.match(/"(?:old_text|oldText|find|search)"\s*:\s*("""|"{1,4}|[\`]{1,3})/);
    if (oldMatch) {
      const start = oldMatch.index + oldMatch[0].length;
      const nextKey = candidateText.slice(start).search(/,\s*"(?:new_text|newText|replacement|content|text)"/);
      if (nextKey >= 0) {
        let rawOld = candidateText.slice(start, start + nextKey).trim();
        rawOld = rawOld.replace(/^("""|"{1,4}|[\`]{1,3})/, '').replace(/("""|"{1,4}|[\`]{1,3})$/, '').trim();
        if (rawOld.includes('\\n') && !rawOld.includes('\n')) rawOld = rawOld.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        params.old_text = rawOld;
      }
    }

    const contentMatch = candidateText.match(/"(?:content|new_content|newContent|new_text|newText|text|code|body|data|replacement)"\s*:\s*("""|"{1,4}|[\`]{1,3})/);
    if (contentMatch) {
      const start = contentMatch.index + contentMatch[0].length;
      let endIdx = candidateText.lastIndexOf('}}');
      if (endIdx === -1) endIdx = candidateText.lastIndexOf('}');
      let rawContent = (endIdx >= 0 ? candidateText.slice(start, endIdx) : candidateText.slice(start)).trim();
      rawContent = rawContent.replace(/("""|"{1,4}|[\`]{1,3})\s*$/, '').trim();
      if (rawContent.includes('\\n') && !rawContent.includes('\n')) {
        rawContent = rawContent.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
      }
      rawContent = rawContent.replace(/^"+/, '');
      params.content = rawContent;
      if (command === 'edit_file' && !params.new_text) params.new_text = rawContent;
    }

    return { command, params };
  }

  // ── Core loop ──
  async function sendAndProcess(text, depth = 0) {
    if (depth > 15) {
      log('Max tool depth reached');
      showNotif('⚠️ Batas maksimum tool call tercapai', 'error');
      revealFinalResponse();
      return false;
    }
    if (Date.now() < rateLimitBlockedUntil) {
      const mins = Math.ceil((rateLimitBlockedUntil - Date.now()) / 60000);
      showNotif('🚫 Cooldown rate limit masih aktif. Tunggu ' + mins + ' menit.', 'error');
      showStatus('error', 'Cooldown: ' + mins + ' menit');
      return false;
    }
    let baseline = getLastAssistantText();
    let sentOk = false;
    for (let attempt = 0; attempt <= RATE_LIMIT_BACKOFF.length; attempt++) {
      if (attempt > 0) {
        await waitWithCountdown(RATE_LIMIT_BACKOFF[attempt - 1], 'Rate limit terdeteksi');
      }
      baseline = getLastAssistantText();
      if (!await typeAndSend(text)) {
        if (attempt < RATE_LIMIT_BACKOFF.length) {
          showNotif('⚠️ Kirim gagal, coba lagi setelah jeda...', 'info');
          continue;
        }
        showNotif('❌ Send failed', 'error');
        return false;
      }
      await sleep(1500);
      if (detectRateLimit()) {
        log('Rate limit terdeteksi setelah kirim (attempt ' + attempt + ')');
        continue;
      }
      if (!await waitForNew(baseline)) {
        if (detectRateLimit()) {
          log('Rate limit terdeteksi saat menunggu (attempt ' + attempt + ')');
          continue;
        }
        showNotif('⏱️ Timeout', 'error');
        return false;
      }
      sentOk = true;
      break;
    }
    if (!sentOk) {
      rateLimitBlockedUntil = Date.now() + 10 * 60 * 1000;
      showNotif('🚫 Masih terkena rate limit. Cooldown 10 menit agar tidak makin parah.', 'error');
      showStatus('error', 'Rate limit - cooldown 10 menit');
      return false;
    }
    await sleep(30);

    const resp = getLastAssistantText();
    log(`Response: ${resp.substring(0, 80)}...`);

    const tc = parse(resp);
    if (!tc) {
      log('Final answer (no tool call)');
      revealFinalResponse();
      addActivityLog('info', '🎉 Selesai', 'AI telah menyelesaikan respon');
      showStatus('idle', 'WebBridge: Selesai');
      return true;
    }

    log(`→ Tool: ${tc.command}`, tc.params);
    const targetPath = tc.params?.path || tc.params?.file || '';
    addActivityLog('running', `⚙️ ${tc.command}`, targetPath);
    showStatus('running', `${tc.command} ${targetPath}`.trim());

    let rt;
    try {
      const r = await callTool(tc.command, tc.params);
      addActivityLog('success', `✅ ${tc.command}`, targetPath ? `${targetPath} sukses` : 'Sukses');
      showStatus('running', `Lanjut: ${tc.command} sukses...`);
      rt = `${TP} "${tc.command}":\n${fmt(r)}\n\n[SYSTEM: Tool execution succeeded. If more files need to be created/modified, proceed immediately to the next tool call (e.g. create_file or write_file). Do NOT stop or present code in chat without saving it to disk.]`;
    } catch (e) {
      if (isContextInvalidatedError(e)) {
        log('Extension context invalidated. Halting agent.');
        showReloadPrompt();
        agentRunning = false;
        sessionStarted = false;
        updateFAB();
        return false;
      }
      addActivityLog('error', `❌ ${tc.command}`, typeof e === 'string' ? e : (e.message || 'Gagal'));
      showStatus('error', `${tc.command} gagal`);
      rt = `${TP} ERROR "${tc.command}": ${typeof e === 'string' ? e : e.message || JSON.stringify(e)}`;
    }

    return await sendAndProcess(rt, depth + 1);
  }

  function fmt(r) {
    if (typeof r === 'string') return r;
    if (r.content !== undefined) {
      const sz = r.size !== undefined ? ` (${r.size}B)` : '';
      let info = `[${r.path}]${sz}`;
      if (r.total_lines) {
        info += ` (lines ${r.start_line || 1}-${r.end_line || r.total_lines} of ${r.total_lines})`;
      }
      if (r.truncated) {
        info += `\n[NOTE: File has ${r.total_lines} lines. Showing lines ${r.start_line}-${r.end_line}. To read next lines, use read_file with offset: ${(r.end_line || 0) + 1}]`;
      }
      return `${info}\n\`\`\`\n${r.content}\n\`\`\``;
    }
    if (r.tree) return fmtTree(r.tree, '') || '(empty)';
    if (r.matches) return r.matches.map(m => m.matches ? `${m.path}:\n${m.matches.map(l => `  L${l.line}: ${l.text}`).join('\n')}` : m.path).join('\n') || '(none)';
    return JSON.stringify(r, null, 2);
  }
  function fmtTree(items, ind) {
    let o = '';
    for (const i of items) {
      o += i.type === 'directory'
        ? `${ind}📁 ${i.name}/\n${i.children ? fmtTree(i.children, ind + '  ') : ''}`
        : `${ind}📄 ${i.name}\n`;
    }
    return o;
  }

  // ── Session ──
  let startingSession = false;

  async function startSession(retry = 0) {
    if (sessionStarted || startingSession) return;
    startingSession = true;
    try {
      await _startSession(retry);
    } finally {
      startingSession = false;
    }
  }

  async function _startSession(retry = 0) {
    if (sessionStarted) return;
    showNotif('🔗 Menghubungkan...');
    const s = await getStatus();
    bridgeConnected = s.connected; workspace = s.workspace; unrestricted = Boolean(s.unrestricted);
    if (!bridgeConnected) { showNotif('❌ Server belum aktif!\nJalankan start.bat', 'error'); return; }
    if (!workspace && !unrestricted) { showNotif('❌ Workspace belum diset!\nBuka popup WebBridge', 'error'); return; }
    try { tools = await callTool('list_tools'); } catch (_) { tools = []; }

    const inp = await waitForInput(30000);
    if (!inp) {
      if (retry < 3) {
        log(`Input not ready, retry ${retry + 1}/3 in 3s`);
        await sleep(3000);
        return startSession(retry + 1);
      }
      showNotif('❌ Input chat tidak ditemukan', 'error');
      return;
    }

    // Tampilkan notifikasi ✅ SEGERA setelah koneksi dan workspace berhasil divalidasi!
    sessionStarted = true;
    updateFAB();
    showNotif(`✅ Terhubung ke WebBridge!\n📁 ${unrestricted ? '🌐 Global Access' : (workspace ? (workspace.split(/[\\/]/).pop() || workspace) : 'workspace')}`);
    await sleep(40);

    agentRunning = true;
    updateFAB();

    // Cek apakah respon assistant terakhir sudah ada tool call yang belum dieksekusi
    const currentAssistant = getLastAssistantText();
    const existingTc = parse(currentAssistant);
    let success = false;
    if (existingTc) {
      log('Executing existing pending tool call:', existingTc.command);
      const targetPath = existingTc.params?.path || existingTc.params?.file || '';
      addActivityLog('running', `⚙️ ${existingTc.command}`, targetPath);
      showStatus('running', `${existingTc.command} ${targetPath}`.trim());
      try {
        const result = await callTool(existingTc.command, existingTc.params);
        addActivityLog('success', `✅ ${existingTc.command}`, targetPath ? `${targetPath} sukses` : 'Sukses');
        showStatus('running', `Lanjut: ${existingTc.command} sukses...`);
        success = await sendAndProcess(`${TP} "${existingTc.command}":\n${fmt(result)}\n\n[SYSTEM: Tool execution succeeded. If more files need to be created/modified, proceed immediately to the next tool call (e.g. create_file or write_file). Do NOT stop or present code in chat without saving it to disk.]`);
      } catch (e) {
        if (isContextInvalidatedError(e)) {
          showReloadPrompt();
          agentRunning = false;
          sessionStarted = false;
          updateFAB();
          return;
        }
        addActivityLog('error', `❌ ${existingTc.command}`, typeof e === 'string' ? e : (e.message || 'Gagal'));
        showStatus('error', `${existingTc.command} gagal`);
        success = await sendAndProcess(`${TP} ERROR "${existingTc.command}": ${e.message || e}`);
      }
    } else {
      // Jalankan handshake pesan pertama
      success = await sendAndProcess(sysPrompt(tools));
    }

    if (!success) {
      sessionStarted = false;
      agentRunning = false;
      updateFAB();
      return;
    }

    lastMsgCount = totalMsgCount();
    previousAssistantText = getLastAssistantText();
    agentRunning = false;
    updateFAB();
    revealFinalResponse();
    showNotif(`🟢 WebBridge aktif di ${P.name}!`);
  }

  // ── Watch ──
  function watch() {
    lastMsgCount = totalMsgCount();
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('URL changed (SPA nav):', lastUrl);
        // Reset session state on SPA navigation
        sessionStarted = false;
        agentRunning = false;
        updateFAB();
      }
    }, 700);
    const watchTimer = setInterval(async () => {
      if (!isContextValid()) {
        clearInterval(watchTimer);
        showReloadPrompt();
        updateFAB();
        return;
      }
      if (agentRunning) return;
      const c = totalMsgCount();
      const assistantText = getLastAssistantText();
      const responseChanged = assistantText && assistantText !== previousAssistantText;

      // Detect New Chat (message count dropped)
      if (c < lastMsgCount) {
        log('New chat detected (count dropped), resetting session...');
        sessionStarted = false;
        agentRunning = false;
        lastMsgCount = c;
        // Clean up all WB cards and IDs to prevent visual bugs
        document.querySelectorAll('.wb-card').forEach(el => el.remove());
        document.querySelectorAll('[data-wb-id]').forEach(el => {
          for (const prop of ['opacity','pointer-events','position','left','top','width','height','overflow','margin','padding','display']) {
            el.style.removeProperty(prop);
          }
          delete el.dataset.wbId;
          delete el.dataset.wbHidden;
        });
        updateFAB();
        return;
      }
      
      if (!sessionStarted) {
        if (bridgeConnected && workspace && assistantText) {
          const autoTc = parse(assistantText);
          if (autoTc) {
            log('Detected tool call while inactive, auto-starting session...');
            sessionStarted = true;
            updateFAB();
          } else {
            lastMsgCount = c;
            return;
          }
        } else {
          lastMsgCount = c;
          return;
        }
      }

      if (c === lastMsgCount && !responseChanged && !P.isGenerating()) return;
      lastMsgCount = c;

      agentRunning = true;
      updateFAB();
      const baseline = previousAssistantText;
      const gotResponse = await waitForNew(baseline);
      if (!gotResponse) {
        log('No completed assistant response after user message');
        agentRunning = false;
        updateFAB();
        lastMsgCount = totalMsgCount();
        return;
      }

      const response = getLastAssistantText();
      const tc = parse(response);
      if (tc) {
        log(`Watch: tool call ${tc.command}`);
        const targetPath = tc.params?.path || tc.params?.file || '';
        addActivityLog('running', `⚙️ ${tc.command}`, targetPath);
        showStatus('running', `${tc.command} ${targetPath}`.trim());
        try {
          const result = await callTool(tc.command, tc.params);
          addActivityLog('success', `✅ ${tc.command}`, targetPath ? `${targetPath} sukses` : 'Sukses');
          showStatus('running', `Lanjut: ${tc.command} sukses...`);
          await sendAndProcess(`${TP} "${tc.command}":\n${fmt(result)}\n\n[SYSTEM: Tool execution succeeded. If more files need to be created/modified, proceed immediately to the next tool call (e.g. create_file or write_file). Do NOT stop or present code in chat without saving it to disk.]`);
        } catch (e) {
          if (isContextInvalidatedError(e)) {
            showReloadPrompt();
            agentRunning = false;
            sessionStarted = false;
            updateFAB();
            return;
          }
          addActivityLog('error', `❌ ${tc.command}`, typeof e === 'string' ? e : (e.message || 'Gagal'));
          showStatus('error', `${tc.command} gagal`);
          await sendAndProcess(`${TP} ERROR "${tc.command}": ${e.message || e}`);
        }
      } else {
        revealFinalResponse();
      }
      agentRunning = false;
      updateFAB();
      lastMsgCount = totalMsgCount();
      previousAssistantText = getLastAssistantText();
      revealFinalResponse();
    }, 250);
  }

  // ── Activity Log & Status Bar ──
  const activityLogs = [];

  function addActivityLog(type, title, detail = '') {
    const time = new Date().toLocaleTimeString('id-ID', { hour12: false });
    activityLogs.unshift({ time, type, title, detail });
    if (activityLogs.length > 50) activityLogs.pop();
    renderLogs();
  }

  function showStatus(state, text) {
    const bar = document.getElementById('wb-status-bar');
    const dot = bar?.querySelector('.wb-dot-pulse');
    const label = document.getElementById('wb-status-text');
    if (!bar || !dot || !label) return;

    dot.className = 'wb-dot-pulse';
    if (state === 'running') {
      dot.classList.add('wb-dot-running');
    } else if (state === 'error') {
      dot.classList.add('wb-dot-error');
    }

    label.textContent = text;
  }

  function renderLogs() {
    const list = document.querySelector('.wb-log-list');
    if (!list) return;
    list.innerHTML = activityLogs.map(l => {
      let icon = '📄';
      let cls = '';
      if (l.type === 'running') { icon = '⚙️'; cls = 'wb-log-running'; }
      else if (l.type === 'success') { icon = '✅'; cls = 'wb-log-success'; }
      else if (l.type === 'error') { icon = '❌'; cls = 'wb-log-error'; }
      else if (l.type === 'info') { icon = 'ℹ️'; }
      const cleanTitle = escHtml(String(l.title || '').replace(/^[\u{1F300}-\u{1F9FF}✅⚙️❌ℹ️📝📁📄🔗]+\s*/u, ''));
      return `<div class="wb-log-item ${cls}">
        <span class="wb-log-time">${l.time}</span>
        <span class="wb-log-badge">${icon}</span>
        <b>${cleanTitle}</b>${l.detail ? `: ${escHtml(l.detail)}` : ''}
      </div>`;
    }).join('') || '<div style="color:#777;text-align:center;padding:12px;">Belum ada aktivitas.</div>';
  }

  function createStatusBar() {
    if (document.getElementById('wb-status-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'wb-status-bar';
    bar.innerHTML = `
      <span class="wb-dot-pulse"></span>
      <span id="wb-status-text">WebBridge: Siap</span>
    `;
    bar.onclick = toggleLogPanel;
    document.body.appendChild(bar);

    const panel = document.createElement('div');
    panel.id = 'wb-log-panel';
    panel.innerHTML = `
      <div class="wb-log-header">
        <span>WebBridge Activity Log</span>
        <div class="wb-log-actions">
          <span class="wb-log-clear">Bersihkan</span>
          <span class="wb-log-close">✕</span>
        </div>
      </div>
      <div class="wb-log-list">
        <div style="color:#777;text-align:center;padding:12px;">Belum ada aktivitas.</div>
      </div>
    `;
    panel.querySelector('.wb-log-close').onclick = () => { panel.style.display = 'none'; };
    panel.querySelector('.wb-log-clear').onclick = () => {
      activityLogs.length = 0;
      renderLogs();
    };
    document.body.appendChild(panel);
  }

  function toggleLogPanel() {
    const panel = document.getElementById('wb-log-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
    renderLogs();
  }

  // ── UI ──
  function createFAB() {
    if (document.getElementById('wb-fab')) return;
    const f = document.createElement('div');
    f.id = 'wb-fab';
    f.innerHTML = '🔗';
    f.title = 'WebBridge Status';
    f.addEventListener('click', () => {
      if (!isContextValid()) {
        location.reload();
        return;
      }
      if (!sessionStarted) {
        showNotif(`🟢 WebBridge Siap!\n📁 ${workspace?.split(/[\\/]/).pop() || workspace}\nKetik pertanyaan/instruksi Anda di kolom chat.`);
      } else {
        showNotif(`${P.name} • ${agentRunning ? '⚙️' : '✅'}\n📁 ${workspace}`);
      }
    });
    document.body.appendChild(f);
  }

  // ── Inline Prompt Interceptor ──
  // Strategy: Let user's first message go through UNTOUCHED (preserves thread title).
  // After AI responds WITHOUT a tool call, automatically send the system prompt
  // as a follow-up message via typeAndSend (which works reliably on ALL platforms).
  function setupUserSendInterceptor() {
    let interceptActive = false;

    function tryIntercept() {
      if (sessionStarted || agentRunning || interceptActive) return;
      if (!bridgeConnected || (!workspace && !unrestricted)) return;

      const input = P.input();
      if (!input) return;

      const isCE = input.isContentEditable || input.getAttribute('contenteditable') === 'true';
      const text = (isCE ? (input.textContent || '') : (input.value || '')).trim();
      if (!text || text.includes('[ENVIRONMENT NOTICE') || text.includes('###WB_TOOL###') || text.includes(TP)) return;

      interceptActive = true;
      log('User sent first message, will inject system prompt after AI responds');

      // Let the message send normally, then watch for AI's response
      setTimeout(async () => {
        try {
          // Wait for AI to respond
          const baseline = getLastAssistantText();
          const gotResponse = await waitForNew(baseline);
          if (!gotResponse) {
            interceptActive = false;
            return;
          }

          const resp = getLastAssistantText();
          const tc = parse(resp);

          // If AI already called a tool (unlikely but possible), start agent loop
          if (tc) {
            sessionStarted = true;
            agentRunning = true;
            updateFAB();
            try {
              const result = await callTool(tc.command, tc.params);
              const targetPath = tc.params?.path || tc.params?.file || '';
              addActivityLog('success', `✅ ${tc.command}`, targetPath ? `${targetPath} sukses` : 'Sukses');
              showStatus('running', `Lanjut: ${tc.command} sukses...`);
              await sendAndProcess(`${TP} "${tc.command}":\n${fmt(result)}\n\n[SYSTEM: Tool execution succeeded. Continue with next tool call if needed.]`);
            } catch (e) {
              if (isContextInvalidatedError(e)) { showReloadPrompt(); return; }
              await sendAndProcess(`${TP} ERROR "${tc.command}": ${e.message || e}`);
            }
            agentRunning = false;
            updateFAB();
            lastMsgCount = totalMsgCount();
            previousAssistantText = getLastAssistantText();
            revealFinalResponse();
            interceptActive = false;
            return;
          }

          // AI responded without tool call → send system prompt to activate tools
          sessionStarted = true;
          agentRunning = true;
          updateFAB();
          addActivityLog('info', 'WebBridge', 'Mengaktifkan tools...');
          showStatus('running', 'Mengaktifkan WebBridge tools...');

          const success = await sendAndProcess(sysPrompt(tools));

          agentRunning = false;
          updateFAB();
          lastMsgCount = totalMsgCount();
          previousAssistantText = getLastAssistantText();
          if (success) {
            revealFinalResponse();
            showNotif(`🟢 WebBridge aktif di ${P.name}!`);
          }
        } catch (e) {
          log('Intercept error:', e);
        }
        interceptActive = false;
      }, 300);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        const input = P.input();
        if (input && (e.target === input || input.contains(e.target))) {
          tryIntercept();
        }
      }
    }, true);

    document.addEventListener('click', (e) => {
      const btn = P.send();
      if (btn && (e.target === btn || btn.contains(e.target))) {
        tryIntercept();
      }
    }, true);
  }
  function updateFAB() {
    const f = document.getElementById('wb-fab'); if (!f) return;
    if (!isContextValid()) {
      f.innerHTML = '⚠️';
      f.title = 'WebBridge terputus (extension di-reload) — klik untuk refresh halaman';
      return;
    }
    if (agentRunning) { f.innerHTML = '<span class="wb-spinner"></span>'; f.title = 'Working...'; }
    else if (sessionStarted) { f.innerHTML = '🟢'; f.title = `Active — ${workspace}`; }
    else { f.innerHTML = '🔗'; f.title = 'Start WebBridge'; }
  }
  function showNotif(msg, type = 'info') {
    document.querySelectorAll('.wb-notif').forEach(n => n.remove());
    const e = document.createElement('div'); e.className = `wb-notif wb-notif-${type}`; e.textContent = msg;
    document.body.appendChild(e);
    requestAnimationFrame(() => e.classList.add('wb-show'));
    setTimeout(() => { e.classList.remove('wb-show'); setTimeout(() => e.remove(), 300); }, 4000);
  }

  chrome.runtime.onMessage.addListener(m => {
    if (m.type === 'wb_status') {
      bridgeConnected = m.connected;
      workspace = m.workspace;
      unrestricted = Boolean(m.unrestricted);
      updateFAB();
      const statusTitle = unrestricted ? '🌐 Global Access' : (workspace?.split(/[\\/]/).pop() || 'Siap');
      showStatus(bridgeConnected ? 'idle' : 'error', bridgeConnected ? `Siap • ${statusTitle}` : 'Terputus');
    }
  });

  async function init() {
    createFAB();
    createStatusBar();
    // Start periodic scan for collapse cards (NO MutationObserver)
    setInterval(scanMessages, 500);

    const s = await getStatus();
    bridgeConnected = s.connected;
    workspace = s.workspace;
    unrestricted = Boolean(s.unrestricted);
    updateFAB();
    const statusTitle = unrestricted ? '🌐 Global Access' : (workspace?.split(/[\\/]/).pop() || 'Siap');
    showStatus(bridgeConnected ? 'idle' : 'error', bridgeConnected ? `Siap • ${statusTitle}` : 'Terputus');
    addActivityLog('info', 'WebBridge dimulai', unrestricted ? 'Mode Akses Menyeluruh (Global) AKTIF' : (workspace ? `Workspace: ${workspace}` : 'Menunggu koneksi'));

    // Resume existing session
    const existingAssistant = getAssistantMsgs();
    const hasHandshake = existingAssistant.some(m => m.text.includes('WebBridge ready'))
      || getUserMsgs().some(m => m.text.includes('WebBridge, a local file system'));
    if (hasHandshake && bridgeConnected && (workspace || unrestricted)) {
      sessionStarted = true;
      try { tools = await callTool('list_tools'); } catch (_) { tools = []; }
      lastMsgCount = totalMsgCount();
      updateFAB();
      log('Resumed existing WebBridge session');
    }

    watch();
    setupUserSendInterceptor();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
