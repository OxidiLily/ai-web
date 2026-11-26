const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { exec, spawn } = require('child_process');

const PORT = parseInt(process.env.WTL_PORT || '9800');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_DEPTH = 5;
const VERSION = '1.1.0';

// ── Error Kustom ──
class BridgeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BridgeError';
    this.code = code || 'BRIDGE_ERROR';
  }
}

// ── Workspace ──
const cliWorkspace = process.argv[2];
const WORKSPACE_FILE = path.join(__dirname, 'workspace.json');
const TOOL_CATALOGUE = JSON.parse(fs.readFileSync(path.join(__dirname, 'tool-catalogue.json'), 'utf-8'));
const IGNORE = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'dist', 'build',
  '.next', '.cache', '.DS_Store', 'Thumbs.db'
]);

let workspace = null;
let unrestricted = process.argv.includes('--unrestricted') || process.env.WTL_UNRESTRICTED === 'true';

const SYSTEM_BLACKLIST = [
  /^[a-zA-Z]:[/\\]Windows[/\\](?:System32|WinSxS|SystemResources)/i,
  /^\/(?:etc|sys|proc|boot)/i
];

function isBlacklisted(p) {
  const norm = path.resolve(p);
  return SYSTEM_BLACKLIST.some(rx => rx.test(norm));
}

function detectVSCodeWorkspace() {
  try {
    const appData = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
    const storagePath = path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(storagePath)) return null;

    const storage = JSON.parse(fs.readFileSync(storagePath, 'utf-8'));
    const candidates = [];

    const folders = storage.backupWorkspaces?.folders || [];
    for (const entry of folders) {
      const uri = entry.folderUri || '';
      if (uri.startsWith('file:///')) candidates.push(uri);
    }

    const assocWs = storage.profileAssociations?.workspaces || {};
    for (const uri of Object.keys(assocWs)) {
      if (uri.startsWith('file:///')) candidates.push(uri);
    }

    for (const uri of candidates) {
      try {
        const p = fileURLToPath(uri);
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
      } catch (_) {}
    }
  } catch (e) {
    console.log('[bridge] VS Code workspace detection failed:', e.message);
  }
  return null;
}

function cleanPathStr(p) {
  if (!p) return '';
  return String(p).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
}

function initWorkspace() {
  try {
    const saved = JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf-8'));
    if (saved.unrestricted !== undefined && !process.argv.includes('--unrestricted')) {
      unrestricted = Boolean(saved.unrestricted);
    }
    const savedPath = cleanPathStr(saved.path);
    if (!cliWorkspace && savedPath && fs.existsSync(savedPath) && fs.statSync(savedPath).isDirectory()) {
      workspace = fs.realpathSync(savedPath);
      console.log(`[bridge] Workspace (saved): ${workspace} (Global Access: ${unrestricted ? 'ON' : 'OFF'})`);
      return;
    }
  } catch (_) {}
  if (cliWorkspace) {
    const cleanCli = cleanPathStr(cliWorkspace);
    const resolved = path.resolve(cleanCli);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      workspace = resolved;
      console.log(`[bridge] Workspace (CLI): ${workspace}`);
      return;
    }
    console.error(`[bridge] WARNING: CLI workspace path not valid: ${cliWorkspace}`);
  }
  const detected = detectVSCodeWorkspace();
  if (detected) {
    workspace = detected;
    console.log(`[bridge] Workspace (VS Code auto-detect): ${workspace}`);
  } else {
    console.log('[bridge] No workspace detected. Use set_workspace or restart with a path argument.');
  }
}

initWorkspace();

// ── Keamanan Path ──
function isPathInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (process.platform === 'win32') {
    const rel = path.relative(p.toLowerCase(), c.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isWorkspaceRoot(p) {
  if (!workspace) return false;
  return path.relative(workspace, p) === '';
}

function safePath(p) {
  const resolved = path.resolve(p);

  if (isBlacklisted(resolved)) {
    throw new BridgeError(`Access denied to protected system path: ${p}`, 'PROTECTED_SYSTEM_PATH');
  }

  if (unrestricted) {
    return resolved;
  }

  if (!workspace) throw new BridgeError('No workspace set. Use set_workspace first.', 'NO_WORKSPACE');
  const wsResolved = path.resolve(workspace);

  if (!isPathInside(wsResolved, resolved)) {
    throw new BridgeError(`Path outside workspace: ${p}`, 'OUTSIDE_WORKSPACE');
  }

  // Cek symlink: path nyata harus tetap di dalam workspace
  try {
    const realPath = fs.realpathSync(resolved);
    const realWsPath = fs.realpathSync(wsResolved);
    if (!isPathInside(realWsPath, realPath)) {
      throw new BridgeError(`Path resolves outside workspace via symlink: ${p}`, 'SYMLINK_OUTSIDE');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // ENOENT: file belum ada (create). Periksa direktori induknya.
    try {
      const parentReal = fs.realpathSync(path.dirname(resolved));
      const realWsPath = fs.realpathSync(wsResolved);
      if (!isPathInside(realWsPath, parentReal)) {
        throw new BridgeError(`Parent resolves outside workspace: ${p}`, 'SYMLINK_OUTSIDE');
      }
    } catch (parentErr) {
      if (parentErr.code !== 'ENOENT') throw parentErr;
    }
  }

  return resolved;
}

function normalizeRelPath(p) {
  if (!p) return '.';
  let s = cleanPathStr(p);
  // Strip leading / or \ on Windows unless absolute with drive letter (e.g. /server/server.js -> server/server.js)
  if (/^[/\\](?![a-zA-Z]:)/.test(s)) {
    s = s.replace(/^[/\\]+/, '');
  }
  return s || '.';
}

function resolveIn(p) {
  const norm = normalizeRelPath(p);
  if (path.isAbsolute(norm) || /^[a-zA-Z]:[/\\]/.test(norm)) {
    return safePath(norm);
  }
  return safePath(path.resolve(workspace || '', norm));
}

function rel(p) {
  if (workspace && isPathInside(workspace, p)) {
    return path.relative(workspace, p).replace(/\\/g, '/') || '.';
  }
  return p.replace(/\\/g, '/');
}

function readText(p) {
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    throw new BridgeError(`Cannot read directory as file: ${p}`, 'IS_DIRECTORY');
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new BridgeError(`File too large (${stat.size} bytes, max ${MAX_FILE_SIZE})`, 'FILE_TOO_LARGE');
  }
  return fs.readFileSync(p, 'utf-8');
}

function treeTo(dirPath, depth, maxDepth) {
  const out = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (IGNORE.has(entry.name)) continue;
    const full = path.join(dirPath, entry.name);
    const item = { name: entry.name, path: rel(full), type: entry.isDirectory() ? 'directory' : 'file' };
    if (entry.isDirectory() && depth < maxDepth) item.children = treeTo(full, depth + 1, maxDepth);
    out.push(item);
  }
  return out.sort((a, b) => a.type !== b.type ? (a.type === 'directory' ? -1 : 1) : a.name.localeCompare(b.name));
}

function matchGlob(pattern, name, relPath) {
  const normPat = (pattern || '*').replace(/\\/g, '/');
  // Simple basename pattern (e.g. *.js, README.md, *.bat)
  const cleanBasename = normPat.replace(/^(\*\*\/)+/, '');
  const esc = String(cleanBasename).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const baseRegex = new RegExp('^' + esc.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  if (baseRegex.test(name)) return true;

  // Path pattern (e.g. **/README.md, server/*.js)
  const escRel = String(normPat).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const relRegex = new RegExp('^' + escRel.replace(/\*\*\//g, '(?:.+/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$', 'i');
  return relRegex.test(relPath.replace(/\\/g, '/'));
}

function searchFiles(dirPath, pattern, contentPattern, depth = 0, matches = []) {
  if (depth > MAX_DEPTH) return matches;
  if (matches.length >= 200) return matches;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return matches;
  }
  let contentRegex = null;
  if (contentPattern) {
    try {
      contentRegex = new RegExp(contentPattern, 'i');
    } catch (err) {
      throw new BridgeError(`Invalid content pattern: ${err.message}`, 'INVALID_PATTERN');
    }
  }

  for (const entry of entries) {
    if (IGNORE.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      searchFiles(fullPath, pattern, contentPattern, depth + 1, matches);
    } else {
      const relPath = rel(fullPath);
      if (matchGlob(pattern, entry.name, relPath)) {
        if (contentRegex) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (contentRegex.test(content)) {
              const lines = content.split('\n');
              const matchingLines = [];
              lines.forEach((line, i) => {
                if (contentRegex.test(line)) matchingLines.push({ line: i + 1, text: line.trim() });
              });
              matches.push({ path: relPath, matches: matchingLines.slice(0, 20) });
            }
          } catch (_) {}
        } else {
          matches.push({ path: relPath });
        }
      }
    }
    if (matches.length >= 200) break;
  }
  return matches;
}

function getPath(payload) {
  if (typeof payload === 'string') return cleanPathStr(payload);
  if (!payload || typeof payload !== 'object') return '';
  const val = payload.path ?? payload.file_path ?? payload.filePath ?? payload.file ?? payload.filename ?? payload.filepath ?? payload.target ?? payload.target_file ?? payload.targetFile ?? payload.name;
  return cleanPathStr(val);
}

function getContent(payload) {
  const val = payload.content ?? payload.new_content ?? payload.newContent ?? payload.text ?? payload.code ?? payload.body ?? payload.data ?? payload.file_content;
  if (val === undefined || val === null) {
    const keys = payload && typeof payload === 'object' ? Object.keys(payload).join(', ') : typeof payload;
    throw new BridgeError(`content is required but missing from payload (got keys: ${keys})`, 'INVALID_PARAM');
  }
  return String(val);
}

function cleanLineNumberPrefix(text) {
  if (typeof text !== 'string') return text;
  const lines = text.split('\n');
  const hasPrefix = lines.length > 0 && lines.every(l => l.trim() === '' || /^\s*\d+:\s?/.test(l));
  if (hasPrefix) {
    return lines.map(l => l.replace(/^\s*\d+:\s?/, '')).join('\n');
  }
  return text;
}

function replaceText(content, oldText, newText, replaceAll = false) {
  if (!oldText) throw new BridgeError('old_text is required and cannot be empty', 'INVALID_PARAM');

  // 1. Direct exact match
  let count = content.split(oldText).length - 1;
  if (count === 1 || (count > 1 && replaceAll)) {
    return {
      content: content.split(oldText).join(newText),
      count
    };
  }

  // 2. Strip line numbers if AI copied lines with line numbers
  const cleanedOld = cleanLineNumberPrefix(oldText);
  if (cleanedOld !== oldText) {
    count = content.split(cleanedOld).length - 1;
    if (count === 1 || (count > 1 && replaceAll)) {
      return {
        content: content.split(cleanedOld).join(newText),
        count
      };
    }
  }

  // 3. Line ending normalization (Windows CRLF \r\n vs LF \n)
  const origEol = content.includes('\r\n') ? '\r\n' : '\n';
  const normContent = content.replace(/\r\n/g, '\n');
  const targetOld = cleanedOld !== oldText ? cleanedOld : oldText;
  const normOld = targetOld.replace(/\r\n/g, '\n');
  const normNew = (newText || '').replace(/\r\n/g, '\n');

  count = normContent.split(normOld).length - 1;
  if (count === 1 || (count > 1 && replaceAll)) {
    const replaced = normContent.split(normOld).join(normNew);
    return {
      content: origEol === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced,
      count
    };
  }

  // 4. Trailing whitespace tolerance per line
  const stripTrailing = s => s.split('\n').map(l => l.trimEnd()).join('\n');
  const strippedContent = stripTrailing(normContent);
  const strippedOld = stripTrailing(normOld);
  const strippedCount = strippedContent.split(strippedOld).length - 1;

  if (strippedCount === 1 || (strippedCount > 1 && replaceAll)) {
    const lines = normContent.split('\n');
    const oldLines = normOld.split('\n').map(l => l.trimEnd());
    for (let i = 0; i <= lines.length - oldLines.length; i++) {
      let match = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (lines[i + j].trimEnd() !== oldLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        lines.splice(i, oldLines.length, ...normNew.split('\n'));
        const replaced = lines.join('\n');
        return {
          content: origEol === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced,
          count: 1
        };
      }
    }
  }

  if (count > 1 || strippedCount > 1) {
    throw new BridgeError(`old_text found multiple times, must be unique (or pass replace_all)`, 'AMBIGUOUS');
  }

  throw new BridgeError('old_text not found in file', 'NOT_FOUND');
}



// ── Handlers ──
const handlers = {
  ping: (payload, id) => ({ id, type: 'result', payload: { pong: true, time: Date.now() } }),

  get_info: (payload, id) => ({
    id, type: 'result',
    payload: { version: VERSION, platform: process.platform, workspace, unrestricted, tools: TOOL_CATALOGUE }
  }),

  set_unrestricted: (payload, id) => {
    unrestricted = Boolean(payload.enabled ?? payload.unrestricted ?? true);
    try {
      const saved = fs.existsSync(WORKSPACE_FILE) ? JSON.parse(fs.readFileSync(WORKSPACE_FILE, 'utf-8')) : {};
      saved.unrestricted = unrestricted;
      fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(saved, null, 2));
    } catch (_) {}
    console.log(`[bridge] Global Access (Unrestricted): ${unrestricted ? 'ENABLED' : 'DISABLED'}`);
    return { id, type: 'result', payload: { unrestricted, set: true } };
  },

  set_workspace: (payload, id) => {
    const raw = cleanPathStr(payload.path);
    const p = path.resolve(raw);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      throw new BridgeError(`Not a valid directory: ${payload.path}`, 'INVALID_PATH');
    }
    workspace = fs.realpathSync(p);
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify({ path: workspace, updated: new Date().toISOString() }, null, 2));
    console.log(`[workspace] Set to: ${workspace}`);
    return { id, type: 'result', payload: { workspace, set: true } };
  },

  vscode_workspace: (payload, id) => {
    const raw = cleanPathStr(payload.path);
    const p = path.resolve(raw);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      throw new BridgeError(`Not a valid VS Code workspace: ${payload.path}`, 'INVALID_PATH');
    }
    workspace = fs.realpathSync(p);
    fs.writeFileSync(WORKSPACE_FILE, JSON.stringify({ path: workspace, updated: new Date().toISOString(), source: 'vscode' }, null, 2));
    console.log(`[workspace] VS Code active folder: ${workspace}`);
    return { id, type: 'result', payload: { workspace, set: true } };
  },

  list_files: (payload, id) => {
    const p = payload.path ? resolveIn(payload.path) : safePath(workspace || process.cwd());
    const tree = treeTo(p, 0, 0);
    return { id, type: 'result', payload: { path: rel(p), tree } };
  },

  list_tree: (payload, id) => {
    const p = resolveIn(payload.path);
    const depth = Math.min(Math.max(parseInt(payload.max_depth) || 2, 0), MAX_DEPTH);
    return { id, type: 'result', payload: { path: rel(p), tree: treeTo(p, 0, depth) } };
  },

  read_file: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      throw new BridgeError(`Cannot read directory as file: ${filePath}`, 'IS_DIRECTORY');
    }
    if (stat.size > MAX_FILE_SIZE) {
      throw new BridgeError(`File too large (${stat.size} bytes, max ${MAX_FILE_SIZE})`, 'FILE_TOO_LARGE');
    }
    const raw = fs.readFileSync(p, 'utf-8');
    const lines = raw.split('\n');
    const totalLines = lines.length;

    const startLine = Math.max(1, parseInt(payload.start_line || payload.startLine || payload.offset || payload.start) || 1);
    const MAX_CHUNK_LINES = 300;
    let endLine;
    if (payload.end_line || payload.endLine) {
      endLine = Math.min(totalLines, parseInt(payload.end_line || payload.endLine));
    } else if (payload.limit || payload.max_lines) {
      endLine = Math.min(totalLines, startLine + parseInt(payload.limit || payload.max_lines) - 1);
    } else if (totalLines > MAX_CHUNK_LINES) {
      endLine = Math.min(totalLines, startLine + MAX_CHUNK_LINES - 1);
    } else {
      endLine = totalLines;
    }

    const clampedStart = Math.min(startLine, totalLines || 1);
    const clampedEnd = Math.max(clampedStart, Math.min(endLine, totalLines));
    const selected = totalLines > 0 ? lines.slice(clampedStart - 1, clampedEnd) : [];
    const withNumbers = Boolean(payload.numbered || payload.line_numbers);
    const content = withNumbers
      ? selected.map((l, i) => `${clampedStart + i}: ${l}`).join('\n')
      : selected.join('\n');
    const isTruncated = clampedEnd < totalLines;

    return {
      id, type: 'result',
      payload: {
        path: filePath,
        start_line: clampedStart,
        end_line: clampedEnd,
        total_lines: totalLines,
        truncated: isTruncated,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        content
      }
    };
  },

  read_file_lines: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const lines = readText(resolveIn(filePath)).split('\n');
    const totalLines = lines.length;
    const start = Math.max(parseInt(payload.start_line || payload.startLine || payload.offset) || 1, 1);
    const limit = parseInt(payload.limit || payload.max_lines);
    const defaultEnd = limit ? start + limit - 1 : totalLines;
    const end = Math.min(parseInt(payload.end_line || payload.endLine) || defaultEnd, totalLines);
    const clampedStart = Math.min(start, totalLines || 1);
    const clampedEnd = Math.max(clampedStart, end);
    const selected = totalLines > 0 ? lines.slice(clampedStart - 1, clampedEnd) : [];
    const numbered = selected.map((l, i) => `${clampedStart + i}: ${l}`).join('\n');
    return {
      id, type: 'result',
      payload: {
        path: filePath,
        start_line: clampedStart,
        end_line: clampedEnd,
        total_lines: totalLines,
        content: numbered
      }
    };
  },

  read_files: (payload, id) => {
    const files = (payload.paths || payload.files || []).slice(0, 50).map(f => {
      try { return { path: f, content: readText(resolveIn(f)) }; }
      catch (e) { return { path: f, error: e.message || String(e) }; }
    });
    return { id, type: 'result', payload: { files } };
  },

  write_file: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    if (isWorkspaceRoot(p)) {
      throw new BridgeError('Cannot write to workspace root as a file', 'INVALID_PATH');
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, getContent(payload), 'utf-8');
    const stat = fs.statSync(p);
    return { id, type: 'result', payload: { path: filePath, size: stat.size, written: true } };
  },

  create_file: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    if (isWorkspaceRoot(p)) {
      throw new BridgeError('Cannot create workspace root as a file', 'INVALID_PATH');
    }
    const overwrite = Boolean(payload.overwrite || payload.force);
    if (fs.existsSync(p) && !overwrite) {
      throw new BridgeError(`File already exists: ${filePath}. Use write_file to overwrite or pass overwrite: true.`, 'EXISTS');
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, getContent(payload), 'utf-8');
    return { id, type: 'result', payload: { path: filePath, created: true } };
  },

  edit_file: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    const oldText = payload.old_text ?? payload.oldText ?? payload.find ?? payload.search ?? payload.search_text ?? payload.searchText;
    if (!oldText) {
      throw new BridgeError('old_text is required and cannot be empty', 'INVALID_PARAM');
    }
    const newText = String(payload.new_text ?? payload.newText ?? payload.new_content ?? payload.newContent ?? payload.replace ?? payload.replace_text ?? payload.replacement ?? payload.content ?? payload.text ?? '');
    const replaceAll = Boolean(payload.replace_all || payload.replaceAll);
    let content = fs.readFileSync(p, 'utf-8');
    const res = replaceText(content, oldText, newText, replaceAll);
    fs.writeFileSync(p, res.content, 'utf-8');
    return { id, type: 'result', payload: { path: filePath, edited: true, replaced: res.count } };
  },

  apply_patch: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    let content = readText(p);
    const edits = Array.isArray(payload.edits) ? payload.edits : [];
    if (edits.length === 0) {
      throw new BridgeError('edits array is required and cannot be empty', 'INVALID_PARAM');
    }
    edits.forEach((e, i) => {
      const oldText = e.old_text ?? e.oldText ?? e.find ?? e.search;
      if (!oldText) {
        throw new BridgeError(`Edit #${i + 1}: old_text is required and cannot be empty`, 'INVALID_PARAM');
      }
      const newText = String(e.new_text !== undefined ? e.new_text : (e.newText !== undefined ? e.newText : (e.replace !== undefined ? e.replace : (e.content !== undefined ? e.content : (e.text !== undefined ? e.text : '')))));
      const res = replaceText(content, oldText, newText, false);
      content = res.content;
    });
    fs.writeFileSync(p, content, 'utf-8');
    return { id, type: 'result', payload: { path: filePath, edits: edits.length, patched: true } };
  },

  create_dir: (payload, id) => {
    const dirPath = payload.path || payload.dir || payload.directory || payload.folder;
    if (!dirPath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(dirPath);
    fs.mkdirSync(p, { recursive: true });
    return { id, type: 'result', payload: { path: dirPath, created: true } };
  },

  create_directory: (payload, id) => handlers.create_dir(payload, id),

  delete_file: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    if (isWorkspaceRoot(p)) {
      throw new BridgeError('Cannot delete workspace root', 'FORBIDDEN');
    }
    if (!fs.existsSync(p)) {
      return { id, type: 'result', payload: { path: filePath, deleted: true, note: 'Target already does not exist' } };
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      const recursive = Boolean(payload.recursive ?? payload.force ?? true);
      if (recursive) {
        fs.rmSync(p, { recursive: true, force: true });
      } else {
        const entries = fs.readdirSync(p);
        if (entries.length > 0) throw new BridgeError('Directory not empty (use recursive: true)', 'NOT_EMPTY');
        fs.rmdirSync(p);
      }
    } else {
      fs.unlinkSync(p);
    }
    return { id, type: 'result', payload: { path: filePath, deleted: true } };
  },

  // Aliases for create
  new_file: (payload, id) => handlers.create_file(payload, id),
  touch: (payload, id) => handlers.create_file(payload, id),

  // Aliases for write
  save_file: (payload, id) => handlers.write_file(payload, id),
  overwrite_file: (payload, id) => handlers.write_file(payload, id),

  // Aliases for edit
  modify_file: (payload, id) => handlers.edit_file(payload, id),
  update_file: (payload, id) => handlers.edit_file(payload, id),
  replace_file_content: (payload, id) => handlers.edit_file(payload, id),
  patch: (payload, id) => handlers.apply_patch(payload, id),

  // Aliases for delete
  delete: (payload, id) => handlers.delete_file(payload, id),
  remove: (payload, id) => handlers.delete_file(payload, id),
  remove_file: (payload, id) => handlers.delete_file(payload, id),
  unlink: (payload, id) => handlers.delete_file(payload, id),
  rm: (payload, id) => handlers.delete_file(payload, id),
  delete_dir: (payload, id) => handlers.delete_file({ ...payload, recursive: true }, id),
  delete_directory: (payload, id) => handlers.delete_file({ ...payload, recursive: true }, id),
  remove_dir: (payload, id) => handlers.delete_file({ ...payload, recursive: true }, id),
  remove_directory: (payload, id) => handlers.delete_file({ ...payload, recursive: true }, id),
  rmdir: (payload, id) => handlers.delete_file(payload, id),

  move_file: (payload, id) => {
    const srcPath = payload.source || payload.src || payload.from;
    const dstPath = payload.destination || payload.dst || payload.to;
    if (!srcPath || !dstPath) throw new BridgeError('source and destination are required', 'INVALID_PARAM');
    const src = resolveIn(srcPath);
    if (isWorkspaceRoot(src)) {
      throw new BridgeError('Cannot move workspace root', 'FORBIDDEN');
    }
    const dst = resolveIn(dstPath);
    if (isWorkspaceRoot(dst)) {
      throw new BridgeError('Cannot overwrite workspace root', 'FORBIDDEN');
    }
    if (fs.existsSync(dst)) throw new BridgeError(`Destination exists: ${dstPath}`, 'EXISTS');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { id, type: 'result', payload: { source: srcPath, destination: dstPath, moved: true } };
  },

  copy_file: (payload, id) => {
    const srcPath = payload.source || payload.src || payload.from;
    const dstPath = payload.destination || payload.dst || payload.to;
    if (!srcPath || !dstPath) throw new BridgeError('source and destination are required', 'INVALID_PARAM');
    const src = resolveIn(srcPath);
    if (isWorkspaceRoot(src)) {
      throw new BridgeError('Cannot copy workspace root', 'FORBIDDEN');
    }
    const dst = resolveIn(dstPath);
    if (isWorkspaceRoot(dst)) {
      throw new BridgeError('Cannot overwrite workspace root', 'FORBIDDEN');
    }
    if (fs.existsSync(dst)) throw new BridgeError(`Destination exists: ${dstPath}`, 'EXISTS');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return { id, type: 'result', payload: { source: srcPath, destination: dstPath, copied: true } };
  },

  get_file_info: (payload, id) => {
    const filePath = getPath(payload);
    if (!filePath) throw new BridgeError('path is required', 'INVALID_PARAM');
    const p = resolveIn(filePath);
    const stat = fs.statSync(p);
    return { id, type: 'result', payload: { path: filePath, type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, extension: path.extname(p), modified: stat.mtime.toISOString() } };
  },

  find_files: (payload, id) => {
    const p = resolveIn(payload.path);
    return { id, type: 'result', payload: { pattern: payload.pattern || '*', matches: searchFiles(p, payload.pattern || '*') } };
  },

  search_files: (payload, id) => {
    const p = payload.path ? resolveIn(payload.path) : safePath(workspace || process.cwd());
    const namePattern = payload.file_pattern || payload.pattern || '*';
    const content = payload.query !== undefined
      ? String(payload.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : payload.content_pattern;
    const matches = searchFiles(p, namePattern, content);
    return { id, type: 'result', payload: { pattern: namePattern, matches } };
  },

  // ── Windows App & Process Interaction ──
  open_app: (payload, id) => {
    const target = cleanPathStr(payload.app || payload.name || payload.target || payload.path || payload.command);
    if (!target) throw new BridgeError('app name, file path, or target is required', 'INVALID_PARAM');
    const child = spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' });
    child.unref();
    return { id, type: 'result', payload: { launched: true, target } };
  },

  close_app: (payload, id) => {
    let proc = cleanPathStr(payload.app || payload.name || payload.process || payload.process_name);
    if (!proc) throw new BridgeError('app or process name is required', 'INVALID_PARAM');
    if (!proc.toLowerCase().endsWith('.exe')) proc += '.exe';
    return new Promise((resolve) => {
      exec(`taskkill /IM "${proc}" /F`, (err, stdout, stderr) => {
        if (err) {
          resolve({ id, type: 'result', payload: { success: false, process: proc, error: (stderr || err.message).trim() } });
        } else {
          resolve({ id, type: 'result', payload: { success: true, process: proc, message: stdout.trim() } });
        }
      });
    });
  },

  list_apps: (payload, id) => {
    return new Promise((resolve) => {
      const psCmd = `Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object ProcessName, Id, MainWindowTitle | ConvertTo-Json`;
      exec(`powershell -NoProfile -Command "${psCmd}"`, { timeout: 10000 }, (err, stdout) => {
        if (err || !stdout.trim()) {
          exec('tasklist /FO CSV /NH', { timeout: 10000 }, (tErr, tOut) => {
            if (tErr) return resolve({ id, type: 'result', payload: { apps: [] } });
            const lines = tOut.trim().split('\n').map(l => l.replace(/"/g, '').split(',')[0].trim());
            const unique = [...new Set(lines)].filter(Boolean).slice(0, 50);
            resolve({ id, type: 'result', payload: { apps: unique } });
          });
        } else {
          try {
            const data = JSON.parse(stdout);
            const list = Array.isArray(data) ? data : [data];
            resolve({ id, type: 'result', payload: { apps: list } });
          } catch (_) {
            resolve({ id, type: 'result', payload: { raw: stdout.trim() } });
          }
        }
      });
    });
  },

  run_command: (payload, id) => {
    const cmd = payload.command || payload.cmd;
    if (!cmd) throw new BridgeError('command is required', 'INVALID_PARAM');
    const cwd = payload.cwd ? resolveIn(payload.cwd) : (workspace || process.cwd());
    const timeout = Math.min(parseInt(payload.timeout) || 30000, 120000);
    return new Promise((resolve) => {
      exec(cmd, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({
          id, type: 'result',
          payload: {
            command: cmd,
            exit_code: err ? (err.code || 1) : 0,
            stdout: stdout.trim(),
            stderr: stderr.trim()
          }
        });
      });
    });
  }
};

// ── WebSocket Server ──
const wss = new WebSocketServer({
  port: PORT,
  host: '127.0.0.1',
  maxPayload: 128 * 1024 * 1024,
  verifyClient: (info, cb) => {
    const origin = info.origin || '';
    if (!origin || origin === 'null' || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://') || origin.startsWith('safari-web-extension://') || origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost')) {
      cb(true);
    } else {
      console.log(`[bridge] Rejected WebSocket origin: ${origin}`);
      cb(false, 403, 'Forbidden');
    }
  }
});

wss.on('listening', () => {
  console.log(`[bridge] WebBridge v${VERSION} listening on ws://127.0.0.1:${PORT}`);
  console.log(`[bridge] Workspace: ${workspace || '(not set)'}`);
});

wss.on('connection', (ws, req) => {
  console.log(`[conn] Client connected from ${req.socket.remoteAddress}`);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({ type: 'welcome', payload: { version: VERSION, workspace, unrestricted } }));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid JSON', code: 'PARSE_ERROR' } }));
      return;
    }

    const { id, type, payload } = msg;
    const handler = handlers[type];
    if (!handler) {
      ws.send(JSON.stringify({ id, type: 'error', payload: { message: `Unknown type: ${type}`, code: 'UNKNOWN_TYPE' } }));
      return;
    }

    (async () => {
      try {
        const result = await handler(payload || {}, id);
        ws.send(JSON.stringify(result));
      } catch (err) {
        ws.send(JSON.stringify({
          id, type: 'error',
          payload: { message: err.message || String(err), code: err.code || 'HANDLER_ERROR' }
        }));
      }
    })();
  });

  ws.on('close', () => console.log('[conn] Client disconnected'));
  ws.on('error', (err) => console.error('[conn] Error:', err.message));
});

// Heartbeat
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

wss.on('close', () => clearInterval(heartbeat));

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[bridge] ERROR: Port ${PORT} already in use!`);
    console.error('[bridge] Kill the other process or set WTL_PORT env var.');
    process.exit(1);
  }
  console.error('[bridge] Server error:', err.message);
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n[bridge] Shutting down...');
    wss.close();
    process.exit(0);
  });
}

console.log('[bridge] Starting WebBridge server...');