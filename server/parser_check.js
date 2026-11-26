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
      candidateText = (endIndex >= 0 ? afterWb.slice(0, endIndex) : afterWb).trim();
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

module.exports = parse;
