// =================================================================
// Mobile Build Drop — frontend controller (vanilla ES modules)
// =================================================================

const state = {
  authenticated: false,
  driveFolderStack: [],          // [{ id, name }]
  driveFiles: [],
  driveSelection: new Set(),     // file ids
  driveSelectionDetails: new Map(),
  driveSearchTimer: null,
  driveDefaultFolderId: '',
  s3Bucket: '',                  // current target bucket (user-editable)
  s3Region: '',                  // active region (dropdown OR @region override)
  s3DefaultRegion: '',           // env default region
  s3AvailableRegions: [],
  s3Partition: 'aws',
  s3DefaultBucket: '',
  s3DefaultPrefix: '',
  s3FolderStack: [],             // [{ name, prefix }]
  s3Selection: new Set(),        // selected object keys (for bulk delete)
  s3SelectionDetails: new Map(), // key -> { key, size, lastModified, name }
};

// ---------- Location parsers ----------
function parseDriveLocation(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  // /folders/<id>  in any URL form
  const folderMatch = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) return folderMatch[1];
  // ?id=<id>  or  &id=<id>
  const queryMatch = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (queryMatch) return queryMatch[1];
  // plain ID
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

function parseS3Location(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/^s3a?:\/\//i, '');
  s = s.replace(/^\/+/, '');
  if (!s) return null;

  // Extract optional @region hint:  bucket@region/path/  or bucket@region
  const atMatch = s.match(/^([^/@]+)@([a-z0-9-]+)(?:\/(.*))?$/i);
  if (atMatch) {
    return {
      bucket: atMatch[1],
      region: atMatch[2],
      prefix: atMatch[3] || '',
    };
  }

  const slash = s.indexOf('/');
  if (slash === -1) return { bucket: s, prefix: '', region: '' };
  return {
    bucket: s.slice(0, slash),
    prefix: s.slice(slash + 1),
    region: '',
  };
}

function buildDriveLocationString(folderStack) {
  const top = folderStack[folderStack.length - 1];
  if (!top?.id) return '';
  return `https://drive.google.com/drive/folders/${top.id}`;
}

function buildS3LocationString(bucket, prefix) {
  if (!bucket) return '';
  return `${bucket}/${prefix || ''}`;
}

// ---------- Tiny DOM helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );

const formatSize = (bytes) => {
  if (bytes == null || bytes === '') return '';
  const n = Number(bytes);
  if (Number.isNaN(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};

const isFolder = (file) => file.mimeType === 'application/vnd.google-apps.folder';

const iconFor = (file) => {
  if (isFolder(file)) return '📁';
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.apk') || name.endsWith('.aab')) return '🤖';
  if (name.endsWith('.ipa')) return '📱';
  if (name.endsWith('.zip') || name.endsWith('.tar.gz')) return '🗜️';
  if (name.endsWith('.dmg') || name.endsWith('.pkg')) return '💿';
  if (file.mimeType?.startsWith('image/')) return '🖼️';
  if (file.mimeType?.startsWith('video/')) return '🎬';
  if (file.mimeType?.includes('pdf')) return '📄';
  return '📦';
};

const apiFetch = async (url, opts = {}) => {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

// ---------- Status helpers ----------
const setChip = (id, state, label) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.state = state;
  if (label !== undefined) {
    const lab = el.querySelector('.chip-label');
    if (lab) lab.textContent = label;
  }
};

// ---------- Config status ----------
async function loadConfigStatus() {
  try {
    const data = await apiFetch('/api/config-status');
    state.s3DefaultBucket = data.bucket || '';
    state.s3DefaultPrefix = data.defaultPrefix || '';
    if (!state.s3Bucket) state.s3Bucket = data.bucket || '';

    if (data.ok) {
      setChip('status-env', 'ok', 'env ok');
    } else {
      setChip('status-env', 'warn', `env missing: ${data.missing.length}`);
      const envChip = document.getElementById('status-env');
      if (envChip) envChip.title = `Missing in .env: ${data.missing.join(', ')}`;
    }

    refreshS3Chip();
  } catch (err) {
    setChip('status-env', 'error', 'env error');
    console.error(err);
  }
}

function refreshS3Chip() {
  if (state.s3Bucket) {
    setChip('status-s3', 'ok', state.s3Region ? `s3 · ${state.s3Region}` : 's3');
    const chip = document.getElementById('status-s3');
    if (chip) {
      chip.title = state.s3Region
        ? `s3://${state.s3Bucket}/  (${state.s3Region})`
        : `s3://${state.s3Bucket}/`;
    }
  } else {
    setChip('status-s3', 'off', 's3');
  }
}

// ---------- Auth ----------
async function loadAuthStatus() {
  try {
    const data = await apiFetch('/auth/me');
    state.authenticated = data.authenticated;
    const btn = $('#auth-btn');
    const info = $('#user-info');
    if (data.authenticated) {
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
        Disconnect
      `;
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-ghost');
      info.textContent = data.google?.email || '';
      setChip('status-drive', 'ok');
      await loadDriveDefault();
    } else {
      btn.innerHTML = `
        Link Google Drive
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>
      `;
      btn.classList.add('btn-primary');
      btn.classList.remove('btn-ghost');
      info.textContent = '';
      setChip('status-drive', 'off');
      renderDriveList([], { empty: 'Link Google Drive to load source files.' });
    }
  } catch (err) {
    setChip('status-drive', 'error');
    console.error('auth status error', err);
  }
}

async function toggleAuth() {
  if (state.authenticated) {
    await apiFetch('/auth/logout', { method: 'POST' });
    state.authenticated = false;
    state.driveFolderStack = [];
    state.driveSelection.clear();
    state.driveSelectionDetails.clear();
    await loadAuthStatus();
  } else {
    window.location.href = '/auth/google';
  }
}

// ---------- Drive ----------
async function loadDriveDefault() {
  try {
    const { folderId } = await apiFetch('/api/drive/default-folder');
    if (folderId) {
      state.driveDefaultFolderId = folderId;
      if (state.driveFolderStack.length === 0) {
        state.driveFolderStack = [{ id: folderId, name: 'Source folder' }];
      }
    }
  } catch (err) {
    console.warn('default folder fetch failed', err);
  }
  syncDriveLocationInput();
  await loadDriveList();
}

function syncDriveLocationInput() {
  const input = $('#drive-location-input');
  if (!input) return;
  // Only update if not focused so we don't fight the user.
  if (document.activeElement === input) return;
  input.value = buildDriveLocationString(state.driveFolderStack);
}

async function loadDriveList({ query } = {}) {
  const top = state.driveFolderStack[state.driveFolderStack.length - 1];
  const params = new URLSearchParams();
  if (top?.id) params.set('folderId', top.id);
  if (query) params.set('q', query);
  $('#drive-list').innerHTML = '<div class="loading">Loading</div>';
  syncDriveLocationInput();
  try {
    const data = await apiFetch(`/api/drive/files?${params.toString()}`);
    state.driveFiles = data.files || [];
    renderDriveList(state.driveFiles);
  } catch (err) {
    if (err.status === 401) {
      state.authenticated = false;
      renderDriveList([], { empty: 'Session expired — please reconnect Google Drive.' });
      setChip('status-drive', 'off');
      $('#user-info').textContent = '';
      $('#auth-btn').innerHTML = `
        Link Google Drive
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>
      `;
      $('#auth-btn').classList.add('btn-primary');
      $('#auth-btn').classList.remove('btn-ghost');
    } else {
      renderDriveList([], { empty: `Error: ${err.message}` });
    }
  }
  renderDriveBreadcrumbs();
}

function renderDriveBreadcrumbs() {
  const wrap = $('#drive-breadcrumbs');
  wrap.innerHTML = '';
  if (state.driveFolderStack.length === 0) return;
  state.driveFolderStack.forEach((folder, idx) => {
    const isLast = idx === state.driveFolderStack.length - 1;
    const crumb = document.createElement('span');
    crumb.className = 'crumb' + (isLast ? ' current' : '');
    crumb.textContent = folder.name;
    if (!isLast) {
      crumb.addEventListener('click', () => {
        state.driveFolderStack = state.driveFolderStack.slice(0, idx + 1);
        loadDriveList();
      });
    }
    wrap.appendChild(crumb);
    if (!isLast) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      wrap.appendChild(sep);
    }
  });
}

function renderDriveList(files, opts = {}) {
  const list = $('#drive-list');
  list.innerHTML = '';
  if (!files || files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = opts.empty || 'No files in this folder.';
    list.appendChild(empty);
    updateSelectionCount();
    return;
  }
  files.forEach((file) => {
    const folder = isFolder(file);
    const row = document.createElement('div');
    row.className =
      'fileitem' +
      (folder ? ' folder' : '') +
      (state.driveSelection.has(file.id) ? ' selected' : '');
    row.innerHTML = `
      <div class="check"></div>
      <div class="icon">${iconFor(file)}</div>
      <div class="meta">
        <span class="name"></span>
        <span class="sub"></span>
      </div>
    `;
    row.querySelector('.name').textContent = file.name;
    const subParts = [];
    if (folder) {
      subParts.push('Folder');
    } else {
      const sz = formatSize(file.size);
      if (sz) subParts.push(sz);
    }
    if (file.modifiedTime) {
      subParts.push(new Date(file.modifiedTime).toLocaleDateString());
    }
    row.querySelector('.sub').textContent = subParts.join(' · ');

    row.addEventListener('click', () => {
      if (folder) {
        state.driveFolderStack.push({ id: file.id, name: file.name });
        loadDriveList();
      } else {
        toggleDriveSelection(file);
      }
    });
    list.appendChild(row);
  });
  updateSelectionCount();
}

function toggleDriveSelection(file) {
  if (state.driveSelection.has(file.id)) {
    state.driveSelection.delete(file.id);
    state.driveSelectionDetails.delete(file.id);
  } else {
    state.driveSelection.add(file.id);
    state.driveSelectionDetails.set(file.id, {
      id: file.id,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
    });
  }
  renderDriveList(state.driveFiles);
}

function updateSelectionCount() {
  const n = state.driveSelection.size;
  const label = $('#drive-selection-count');
  const wrap = label?.closest('.queue-meta');
  let totalBytes = 0;
  for (const d of state.driveSelectionDetails.values()) {
    totalBytes += Number(d.size) || 0;
  }
  if (n === 0) {
    label.textContent = 'queue empty';
    wrap?.classList.remove('armed');
  } else {
    const size = totalBytes ? ` · ${formatSize(totalBytes)}` : '';
    label.textContent = `${n} file${n > 1 ? 's' : ''} queued${size}`;
    wrap?.classList.add('armed');
  }
  $('#upload-btn').disabled = n === 0;
}

// ---------- S3 ----------
async function loadS3Config() {
  try {
    const [cfg, regionsResp] = await Promise.all([
      apiFetch('/api/s3/config'),
      apiFetch('/api/s3/regions').catch(() => null),
    ]);

    state.s3DefaultPrefix = cfg.defaultPrefix || '';
    state.s3DefaultBucket = cfg.bucket || '';
    state.s3DefaultRegion = cfg.region || '';
    if (!state.s3Bucket) state.s3Bucket = cfg.bucket || '';
    if (!state.s3Region) state.s3Region = cfg.region || '';

    if (regionsResp) {
      state.s3AvailableRegions = regionsResp.regions || [];
      state.s3Partition = regionsResp.partition || 'aws';
    }
    populateRegionSelect();

    if (state.s3FolderStack.length === 0 && cfg.defaultPrefix) {
      state.s3FolderStack = buildS3FolderStack(cfg.defaultPrefix);
    }
    refreshS3Chip();
    syncS3LocationInput();
    if (state.s3Bucket) {
      await loadS3List();
    } else {
      $('#s3-list').innerHTML =
        '<div class="empty"><div class="empty-glyph">◇</div><p>Paste a bucket path above to load objects.</p></div>';
    }
  } catch (err) {
    $('#s3-list').innerHTML = `<div class="empty">Cannot load S3 config: ${escapeHtml(err.message)}</div>`;
  }
}

function populateRegionSelect() {
  const sel = $('#s3-region-select');
  if (!sel) return;
  sel.innerHTML = '';
  const opts = [...state.s3AvailableRegions];
  if (state.s3Region && !opts.includes(state.s3Region)) opts.unshift(state.s3Region);
  opts.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    if (r === state.s3Region) opt.selected = true;
    sel.appendChild(opt);
  });
}

function buildS3FolderStack(prefix) {
  const parts = String(prefix || '').replace(/\/$/, '').split('/').filter(Boolean);
  return parts.map((name, i) => ({
    name,
    prefix: parts.slice(0, i + 1).join('/') + '/',
  }));
}

function syncS3LocationInput() {
  const input = $('#s3-location-input');
  if (!input) return;
  if (document.activeElement === input) return;
  const top = state.s3FolderStack[state.s3FolderStack.length - 1];
  input.value = buildS3LocationString(state.s3Bucket, top?.prefix || '');
}

async function loadS3List() {
  if (!state.s3Bucket) {
    $('#s3-list').innerHTML =
      '<div class="empty"><div class="empty-glyph">◇</div><p>No bucket selected.</p></div>';
    syncS3LocationInput();
    renderS3Breadcrumbs();
    return;
  }
  const top = state.s3FolderStack[state.s3FolderStack.length - 1];
  const prefix = top?.prefix || '';
  $('#s3-list').innerHTML = '<div class="loading">Loading</div>';
  $('#s3-path-display').textContent = `s3://${state.s3Bucket}/${prefix}`;
  syncS3LocationInput();
  try {
    const params = new URLSearchParams();
    params.set('bucket', state.s3Bucket);
    params.set('prefix', prefix);
    if (state.s3Region) params.set('region', state.s3Region);
    const data = await apiFetch(`/api/s3/objects?${params.toString()}`);
    renderS3List(data, prefix);
  } catch (err) {
    $('#s3-list').innerHTML = `<div class="empty">Error: ${escapeHtml(err.message)}</div>`;
  }
  renderS3Breadcrumbs();
}

function renderS3Breadcrumbs() {
  const wrap = $('#s3-breadcrumbs');
  wrap.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb' + (state.s3FolderStack.length === 0 ? ' current' : '');
  root.textContent = state.s3Bucket || 'bucket';
  if (state.s3FolderStack.length > 0) {
    root.addEventListener('click', () => {
      clearS3Selection();
      state.s3FolderStack = [];
      loadS3List();
    });
  }
  wrap.appendChild(root);
  state.s3FolderStack.forEach((folder, idx) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    wrap.appendChild(sep);
    const isLast = idx === state.s3FolderStack.length - 1;
    const crumb = document.createElement('span');
    crumb.className = 'crumb' + (isLast ? ' current' : '');
    crumb.textContent = folder.name;
    if (!isLast) {
      crumb.addEventListener('click', () => {
        clearS3Selection();
        state.s3FolderStack = state.s3FolderStack.slice(0, idx + 1);
        loadS3List();
      });
    }
    wrap.appendChild(crumb);
  });
}

function renderS3List(data, currentPrefix) {
  const list = $('#s3-list');
  list.innerHTML = '';
  const items = [];
  (data.folders || []).forEach((p) => items.push({ type: 'folder', prefix: p }));
  (data.files || []).forEach((f) => items.push({ type: 'file', ...f }));
  if (items.length === 0) {
    list.innerHTML = '<div class="empty">No objects under this prefix yet.</div>';
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    if (item.type === 'folder') {
      const name = item.prefix.replace(currentPrefix || '', '').replace(/\/$/, '');
      row.className = 'fileitem folder';
      row.innerHTML = `
        <div class="check"></div>
        <div class="icon">📁</div>
        <div class="meta">
          <span class="name"></span>
          <span class="sub">Folder</span>
        </div>
      `;
      row.querySelector('.name').textContent = name;
      row.addEventListener('click', () => {
        clearS3Selection();
        state.s3FolderStack.push({ name, prefix: item.prefix });
        loadS3List();
      });
    } else {
      const name = item.key.replace(currentPrefix || '', '');
      const isSelected = state.s3Selection.has(item.key);
      row.className = 'fileitem' + (isSelected ? ' selected' : '');
      row.innerHTML = `
        <div class="check"></div>
        <div class="icon">📄</div>
        <div class="meta">
          <span class="name"></span>
          <span class="sub"></span>
        </div>
        <button
          class="row-action delete-btn"
          type="button"
          title="Delete object"
          aria-label="Delete object"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <path d="M10 11v6"/>
            <path d="M14 11v6"/>
          </svg>
        </button>
      `;
      row.querySelector('.name').textContent = name;
      const subParts = [];
      const sz = formatSize(item.size);
      if (sz) subParts.push(sz);
      if (item.lastModified)
        subParts.push(new Date(item.lastModified).toLocaleString());
      row.querySelector('.sub').textContent = subParts.join(' · ');

      row.addEventListener('click', () => {
        toggleS3Selection({
          key: item.key,
          name,
          size: item.size,
          lastModified: item.lastModified,
        });
      });
      row.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openDeleteModal({
          single: {
            key: item.key,
            displayName: name,
            size: item.size,
            lastModified: item.lastModified,
          },
        });
      });
    }
    list.appendChild(row);
  });
  updateS3SelectionUi();
}

function toggleS3Selection(item) {
  if (state.s3Selection.has(item.key)) {
    state.s3Selection.delete(item.key);
    state.s3SelectionDetails.delete(item.key);
  } else {
    state.s3Selection.add(item.key);
    state.s3SelectionDetails.set(item.key, item);
  }
  // Re-toggle the row's class without re-rendering the whole list.
  const row = Array.from(document.querySelectorAll('#s3-list .fileitem'))
    .find((el) => el.querySelector('.name')?.textContent === item.name);
  if (row) row.classList.toggle('selected', state.s3Selection.has(item.key));
  updateS3SelectionUi();
}

function clearS3Selection() {
  if (state.s3Selection.size === 0) return;
  state.s3Selection.clear();
  state.s3SelectionDetails.clear();
  document.querySelectorAll('#s3-list .fileitem.selected')
    .forEach((el) => el.classList.remove('selected'));
  updateS3SelectionUi();
}

function updateS3SelectionUi() {
  const n = state.s3Selection.size;
  const actions = $('#s3-selection-actions');
  const count = $('#s3-selection-count');
  if (!actions || !count) return;
  if (n === 0) {
    actions.classList.add('hidden');
  } else {
    actions.classList.remove('hidden');
    count.textContent = `${n} selected`;
  }
}

// ---------- Rename modal & upload ----------
async function openRenameModal() {
  const selected = Array.from(state.driveSelectionDetails.values());
  if (selected.length === 0) return;
  if (!state.s3Bucket) {
    alert('Set a target S3 bucket first (paste a path in the right panel).');
    return;
  }
  const top = state.s3FolderStack[state.s3FolderStack.length - 1];
  const prefix = top?.prefix || '';

  $('#modal-target-path').textContent = `s3://${state.s3Bucket}/${prefix}`;
  $('#confirm-count').textContent = `${selected.length}`;

  const list = $('#rename-list');
  list.innerHTML = '<div class="muted">Checking target for name collisions…</div>';
  $('#rename-modal').classList.remove('hidden');

  let existingNames = new Set();
  try {
    const data = await apiFetch('/api/s3/check-existing', {
      method: 'POST',
      body: JSON.stringify({
        bucket: state.s3Bucket,
        region: state.s3Region || undefined,
        prefix,
        names: selected.map((f) => f.name),
      }),
    });
    existingNames = new Set(
      data.results.filter((r) => r.exists).map((r) => r.name),
    );
  } catch (err) {
    console.warn('check-existing failed', err);
  }

  list.innerHTML = '';
  selected.forEach((file, idx) => {
    const exists = existingNames.has(file.name);
    const row = document.createElement('div');
    row.className = 'rename-row' + (exists ? ' exists' : '');
    row.dataset.fileId = file.id;
    row.dataset.original = file.name;
    row.innerHTML = `
      <div class="index">${idx + 1}</div>
      <div class="original"></div>
      <span class="arrow">→</span>
      <input type="text" spellcheck="false" data-target-name aria-label="Target file name" />
    `;
    row.querySelector('.original').textContent = file.name;
    row.querySelector('.original').title = file.name;
    const input = row.querySelector('input[data-target-name]');
    input.value = file.name;
    input.addEventListener('input', () => {
      if (input.value !== row.dataset.original) {
        row.classList.add('dirty');
      } else {
        row.classList.remove('dirty');
      }
    });
    if (exists) {
      const warn = document.createElement('div');
      warn.className = 'warn-label';
      warn.textContent = '⚠ Will overwrite the existing object with this name';
      row.appendChild(warn);
    }
    list.appendChild(row);
  });
}

function closeRenameModal() {
  $('#rename-modal').classList.add('hidden');
}

function collectRenamePayload() {
  const items = [];
  $$('.rename-row').forEach((row) => {
    const fileId = row.dataset.fileId;
    const targetName = row
      .querySelector('input[data-target-name]')
      .value.trim();
    if (fileId && targetName) {
      items.push({ fileId, targetName });
    }
  });
  return items;
}

async function startUpload() {
  const items = collectRenamePayload();
  if (items.length === 0) return;
  const top = state.s3FolderStack[state.s3FolderStack.length - 1];
  const prefix = top?.prefix || '';

  closeRenameModal();
  openProgressDrawer(items);

  let res;
  try {
    res = await fetch('/api/transfer/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items,
        prefix,
        bucket: state.s3Bucket,
        region: state.s3Region || undefined,
      }),
    });
  } catch (err) {
    setProgressSummary('error', `Network error: ${err.message}`);
    return;
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    setProgressSummary('error', msg);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const stats = { success: 0, error: 0, total: items.length };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed);
        handleProgressEvent(event, stats);
      } catch (err) {
        console.warn('parse error', err);
      }
    });
  }

  if (stats.error === 0) {
    setProgressSummary('done', `All ${stats.success} file(s) uploaded successfully.`);
  } else {
    setProgressSummary(
      'error',
      `${stats.success} uploaded, ${stats.error} failed.`,
    );
  }

  state.driveSelection.clear();
  state.driveSelectionDetails.clear();
  updateSelectionCount();
  renderDriveList(state.driveFiles);
  loadS3List();
}

function openProgressDrawer(items) {
  const list = $('#progress-list');
  list.innerHTML = '';
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'progress-item pending';
    row.dataset.fileId = item.fileId;
    row.innerHTML = `
      <div class="pdot"></div>
      <div class="text">
        <div class="pname"></div>
        <div class="pstatus">Queued</div>
      </div>
      <div class="pbar" aria-hidden="true"><span class="pbar-fill"></span></div>
    `;
    row.querySelector('.pname').textContent = item.targetName;
    list.appendChild(row);
  });
  setProgressSummary(
    '',
    `Uploading ${items.length} file(s)…`,
  );
  $('#progress-drawer').classList.remove('hidden');
}

function setProgressSummary(cls, message) {
  const sum = $('#progress-summary');
  sum.className = 'progress-summary' + (cls ? ` ${cls}` : '');
  sum.textContent = message;
}

function handleProgressEvent(event, stats) {
  const row = document.querySelector(
    `.progress-item[data-file-id="${CSS.escape(event.fileId || '')}"]`,
  );
  if (!row) return;
  const status = row.querySelector('.pstatus');

  if (event.type === 'start') {
    row.classList.remove('pending', 'success', 'error');
    row.classList.add('in-progress');
    status.textContent = 'Connecting…';
    setProgressBarPct(row, 0, /*indeterminate*/ true);
  } else if (event.type === 'progress') {
    row.classList.remove('pending', 'success', 'error');
    row.classList.add('in-progress');
    const loaded = event.loaded || 0;
    const total = event.total || null;
    if (total) {
      const pct = Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
      status.textContent =
        `Uploading… ${pct}% · ${formatSize(loaded)} / ${formatSize(total)}`;
      setProgressBarPct(row, pct, false);
    } else {
      status.textContent = `Uploading… ${formatSize(loaded)}`;
      setProgressBarPct(row, 0, true);
    }
  } else if (event.type === 'success') {
    row.classList.remove('pending', 'in-progress', 'error');
    row.classList.add('success');
    setProgressBarPct(row, 100, false);
    status.textContent = event.size
      ? `Uploaded · ${formatSize(event.size)}`
      : 'Uploaded';
    stats.success += 1;
  } else if (event.type === 'error') {
    row.classList.remove('pending', 'in-progress', 'success');
    row.classList.add('error');
    setProgressBarPct(row, 0, false);
    status.textContent = event.message || 'Failed';
    stats.error += 1;
  }
}

function setProgressBarPct(row, pct, indeterminate) {
  const bar = row.querySelector('.pbar');
  const fill = row.querySelector('.pbar-fill');
  if (!bar || !fill) return;
  if (indeterminate) {
    bar.classList.add('indeterminate');
    fill.style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    fill.style.width = `${pct}%`;
  }
}

// ---------- Delete object modal (single + bulk) ----------
function openDeleteModal({ single, bulk } = {}) {
  const modal = $('#delete-modal');
  const titleEl = $('#delete-modal-title');
  const keyEl = $('#delete-modal-key');
  const metaEl = $('#delete-modal-meta');
  const confirmBtn = $('#delete-confirm');

  const tagEl = $('#delete-modal-tag');

  if (single) {
    modal.dataset.mode = 'single';
    modal.dataset.key = single.key;
    delete modal.dataset.keys;
    if (tagEl) tagEl.textContent = 'delete object';
    titleEl.textContent = 'Permanently delete this object?';
    keyEl.textContent = `s3://${state.s3Bucket}/${single.key}`;
    const parts = [];
    if (single.displayName) parts.push(single.displayName);
    const sz = formatSize(single.size);
    if (sz) parts.push(sz);
    if (single.lastModified) parts.push(new Date(single.lastModified).toLocaleString());
    metaEl.textContent = parts.join(' · ');
    confirmBtn.querySelector('span').textContent = 'Delete object';
  } else if (bulk && bulk.items?.length) {
    modal.dataset.mode = 'bulk';
    modal.dataset.keys = JSON.stringify(bulk.items.map((it) => it.key));
    delete modal.dataset.key;
    const n = bulk.items.length;
    if (tagEl) tagEl.textContent = `delete ${n} object${n > 1 ? 's' : ''}`;
    titleEl.textContent = `Permanently delete ${n} object${n > 1 ? 's' : ''}?`;
    const previewKeys = bulk.items.slice(0, 5).map((it) => it.key).join('\n');
    const moreSuffix = bulk.items.length > 5 ? `\n…and ${bulk.items.length - 5} more` : '';
    keyEl.textContent = previewKeys + moreSuffix;
    keyEl.style.whiteSpace = 'pre-line';
    const totalBytes = bulk.items.reduce((acc, it) => acc + (Number(it.size) || 0), 0);
    metaEl.textContent =
      `${n} file${n > 1 ? 's' : ''} · ${formatSize(totalBytes) || '0 B'} total in s3://${state.s3Bucket}/`;
    confirmBtn.querySelector('span').textContent = `Delete ${n} object${n > 1 ? 's' : ''}`;
  } else {
    return;
  }

  confirmBtn.disabled = false;
  modal.classList.remove('hidden');
  setTimeout(() => $('#delete-cancel')?.focus(), 0);
}

function closeDeleteModal() {
  const modal = $('#delete-modal');
  modal.classList.add('hidden');
  delete modal.dataset.key;
  delete modal.dataset.keys;
  delete modal.dataset.mode;
  // restore default pre-line styling
  const keyEl = $('#delete-modal-key');
  if (keyEl) keyEl.style.whiteSpace = '';
}

async function confirmDelete() {
  const modal = $('#delete-modal');
  const mode = modal.dataset.mode;
  const confirmBtn = $('#delete-confirm');
  const labelEl = confirmBtn.querySelector('span');
  const previousLabel = labelEl.textContent;
  confirmBtn.disabled = true;
  labelEl.textContent = 'Deleting…';

  try {
    let body;
    if (mode === 'bulk') {
      const keys = JSON.parse(modal.dataset.keys || '[]');
      if (keys.length === 0) throw new Error('no keys selected');
      body = { bucket: state.s3Bucket, region: state.s3Region || undefined, keys };
    } else {
      const key = modal.dataset.key;
      if (!key) throw new Error('no key');
      body = { bucket: state.s3Bucket, region: state.s3Region || undefined, key };
    }

    const res = await fetch('/api/s3/objects', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    const data = await res.json().catch(() => ({}));
    if (mode === 'bulk' && data.errors?.length) {
      // Partial failure — show what failed
      labelEl.textContent = previousLabel;
      confirmBtn.disabled = false;
      const meta = $('#delete-modal-meta');
      meta.innerHTML = '';
      const errLine = document.createElement('span');
      errLine.style.color = 'var(--error)';
      errLine.textContent =
        `Deleted ${data.deleted?.length || 0}, ${data.errors.length} failed: ${data.errors[0].message}`;
      meta.appendChild(errLine);
      clearS3Selection();
      loadS3List();
      return;
    }
    closeDeleteModal();
    clearS3Selection();
    loadS3List();
  } catch (err) {
    confirmBtn.disabled = false;
    labelEl.textContent = 'Retry delete';
    const meta = $('#delete-modal-meta');
    meta.innerHTML = '';
    const errLine = document.createElement('span');
    errLine.style.color = 'var(--error)';
    errLine.textContent = `Failed: ${err.message}`;
    meta.appendChild(errLine);
  }
}

// ---------- Location form handlers ----------
function flashInvalid(form) {
  form.classList.add('invalid');
  setTimeout(() => form.classList.remove('invalid'), 380);
}

function handleDriveLocationSubmit(e) {
  e.preventDefault();
  const input = $('#drive-location-input');
  const form = $('#drive-location-form');
  const raw = input.value.trim();
  if (!raw) {
    if (state.driveDefaultFolderId) {
      state.driveFolderStack = [{ id: state.driveDefaultFolderId, name: 'Source folder' }];
    } else {
      state.driveFolderStack = [];
    }
    state.driveSelection.clear();
    state.driveSelectionDetails.clear();
    updateSelectionCount();
    loadDriveList();
    return;
  }
  const folderId = parseDriveLocation(raw);
  if (!folderId) {
    flashInvalid(form);
    return;
  }
  state.driveFolderStack = [{ id: folderId, name: folderId === state.driveDefaultFolderId ? 'Source folder' : folderId.slice(0, 8) + '…' }];
  state.driveSelection.clear();
  state.driveSelectionDetails.clear();
  updateSelectionCount();
  loadDriveList();
  input.blur();
}

function currentSelectedRegion() {
  return $('#s3-region-select')?.value || state.s3DefaultRegion;
}

function handleS3LocationSubmit(e) {
  e.preventDefault();
  const input = $('#s3-location-input');
  const form = $('#s3-location-form');
  const raw = input.value.trim();
  clearS3Selection();
  if (!raw) {
    state.s3Bucket = state.s3DefaultBucket;
    state.s3Region = state.s3DefaultRegion;
    state.s3FolderStack = buildS3FolderStack(state.s3DefaultPrefix);
    populateRegionSelect();
    refreshS3Chip();
    loadS3List();
    return;
  }
  const parsed = parseS3Location(raw);
  if (!parsed || !parsed.bucket) {
    flashInvalid(form);
    return;
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(parsed.bucket)) {
    flashInvalid(form);
    return;
  }
  if (parsed.region && !/^[a-z]{2}-[a-z]+-\d+$/i.test(parsed.region)) {
    flashInvalid(form);
    return;
  }
  state.s3Bucket = parsed.bucket;
  // Inline @region wins, otherwise use whatever the dropdown currently shows.
  state.s3Region = parsed.region || currentSelectedRegion();
  state.s3FolderStack = buildS3FolderStack(parsed.prefix);
  populateRegionSelect();
  refreshS3Chip();
  loadS3List();
  input.blur();
}

function handleS3RegionChange(e) {
  const next = e.target.value;
  if (!next || next === state.s3Region) return;
  clearS3Selection();
  state.s3Region = next;
  refreshS3Chip();
  syncS3LocationInput();
  loadS3List();
}

// ---------- Init ----------
function bindEvents() {
  $('#auth-btn').addEventListener('click', toggleAuth);
  $('#drive-refresh').addEventListener('click', () => loadDriveList());
  $('#s3-refresh').addEventListener('click', () => loadS3List());
  $('#drive-location-form').addEventListener('submit', handleDriveLocationSubmit);
  $('#s3-location-form').addEventListener('submit', handleS3LocationSubmit);
  $('#s3-region-select').addEventListener('change', handleS3RegionChange);

  $('#delete-modal-close').addEventListener('click', closeDeleteModal);
  $('#delete-cancel').addEventListener('click', closeDeleteModal);
  $('#delete-confirm').addEventListener('click', confirmDelete);
  $('#delete-modal').addEventListener('click', (e) => {
    if (e.target.id === 'delete-modal') closeDeleteModal();
  });

  $('#s3-selection-clear').addEventListener('click', clearS3Selection);
  $('#bulk-delete-btn').addEventListener('click', () => {
    const items = Array.from(state.s3SelectionDetails.values());
    if (items.length === 0) return;
    openDeleteModal({ bulk: { items } });
  });
  $('#drive-search').addEventListener('input', (e) => {
    clearTimeout(state.driveSearchTimer);
    state.driveSearchTimer = setTimeout(
      () => loadDriveList({ query: e.target.value }),
      300,
    );
  });
  $('#upload-btn').addEventListener('click', openRenameModal);
  $('#modal-close').addEventListener('click', closeRenameModal);
  $('#cancel-upload').addEventListener('click', closeRenameModal);
  $('#confirm-upload').addEventListener('click', startUpload);
  $('#reset-names-btn').addEventListener('click', () => {
    $$('.rename-row').forEach((row) => {
      const input = row.querySelector('input[data-target-name]');
      input.value = row.dataset.original;
      row.classList.remove('dirty');
    });
  });
  $('#progress-close').addEventListener('click', () => {
    $('#progress-drawer').classList.add('hidden');
  });

  // Close modal on overlay click
  $('#rename-modal').addEventListener('click', (e) => {
    if (e.target.id === 'rename-modal') closeRenameModal();
  });
  // Esc closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#delete-modal').classList.contains('hidden')) {
      closeDeleteModal();
    } else if (!$('#rename-modal').classList.contains('hidden')) {
      closeRenameModal();
    }
  });
}

function handleAuthRedirect() {
  if (!window.location.search) return;
  const params = new URLSearchParams(window.location.search);
  if (params.has('auth_error')) {
    alert(`Google sign-in failed: ${params.get('auth_error')}`);
  }
  if (params.has('auth') || params.has('auth_error')) {
    history.replaceState({}, '', window.location.pathname);
  }
}

async function init() {
  bindEvents();
  handleAuthRedirect();
  await Promise.all([loadConfigStatus(), loadS3Config(), loadAuthStatus()]);
}

init();
