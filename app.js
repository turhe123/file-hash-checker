// app.js — File Hash and Checksum Calculator (ES module).
// Everything runs on this device: files are hashed in worker.js, nothing is sent anywhere.
import { toast, downloadBlob, formatBytes, wireDropzone } from './site.js';

const ALGOS = [
  { id: 'md5', label: 'MD5', bytes: 16 },
  { id: 'sha1', label: 'SHA-1', bytes: 20 },
  { id: 'sha256', label: 'SHA-256', bytes: 32 },
  { id: 'sha384', label: 'SHA-384', bytes: 48 },
  { id: 'sha512', label: 'SHA-512', bytes: 64 },
];
const LABEL = Object.fromEntries(ALGOS.map((a) => [a.id, a.label]));
const BY_HEX_LENGTH = new Map(ALGOS.map((a) => [a.bytes * 2, a]));

const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// 4 MB slices on computers; phones (mobile Safari in particular) get smaller slices to keep memory low.
const SLICE = MOBILE ? 1024 * 1024 : 4 * 1024 * 1024;
const MOBILE_WARN_BYTES = 1024 * 1024 * 1024;
// ?engine=js forces the hand-written code for every algorithm (used by the tests to check it on real files).
const FORCE_JS = new URLSearchParams(location.search).get('engine') === 'js';
const DIR_MESSAGE = 'This is a folder. Folders cannot be hashed; open it and drop the files inside instead.';

const $ = (id) => document.getElementById(id);
const els = {
  tabs: [$('tab-file'), $('tab-text')],
  panels: { file: $('panel-file'), text: $('panel-text') },
  zone: $('dropzone'),
  input: $('file-input'),
  text: $('text-input'),
  newline: $('text-newline'),
  hashText: $('hash-text'),
  progressWrap: $('progress-wrap'),
  progress: $('progress'),
  progressBar: $('progress').querySelector('span'),
  progressLabel: $('progress-label'),
  progressPct: $('progress-pct'),
  cancel: $('cancel'),
  format: $('format'),
  upper: $('uppercase'),
  results: $('results'),
  expected: $('expected'),
  status: $('compare-status'),
  detail: $('compare-detail'),
  downloads: $('downloads'),
  listAlgo: $('list-algo'),
  downloadList: $('download-list'),
  downloadCsv: $('download-csv'),
};
const algoBoxes = [...document.querySelectorAll('input[name="algo"]')];
const DEFAULT_DETAIL = els.detail.textContent;

// entry: { name, size, blob, digests: { md5: Uint8Array, ... } | null, error: string | null, ms }
const state = { mode: 'file', files: [], text: null, run: 0, textRun: 0 };

// ---------- Worker wrapper ----------
class Hasher {
  constructor() { this.worker = null; this.jobs = new Map(); this.seq = 0; }
  start() {
    if (this.worker) return this.worker;
    this.worker = new Worker('./worker.js');
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'selftest') { onSelfTest(data); return; }
      const job = this.jobs.get(data.id);
      if (!job) return;
      if (data.type === 'progress') job.onProgress?.(data.done, data.total);
      else {
        this.jobs.delete(data.id);
        if (data.type === 'result') job.resolve(data.digests);
        else job.reject(Object.assign(new Error(data.message), { name: data.name || 'Error' }));
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      const err = new Error(event.message || 'The hashing worker stopped unexpectedly.');
      this.stop(err);
    };
    return this.worker;
  }
  hash(blob, algos, onProgress) {
    const worker = this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onProgress });
      worker.postMessage({ type: 'hash', id, blob, algos, slice: SLICE, forceJs: FORCE_JS });
    });
  }
  stop(reason = new DOMException('Cancelled', 'AbortError')) {
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    for (const job of this.jobs.values()) job.reject(reason);
    this.jobs.clear();
  }
}
const fileHasher = new Hasher();
const textHasher = new Hasher();

let selfTestShown = false;
function onSelfTest({ ok, failures }) {
  document.documentElement.dataset.selftest = ok ? 'ok' : 'failed';
  if (!ok && !selfTestShown) {
    selfTestShown = true;
    console.warn('hash self test failed', failures);
    toast(`Self test failed for ${failures.join(', ')}. Results may be wrong in this browser.`, 6000);
  }
}
fileHasher.start();

// ---------- Formatting ----------
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function formatDigest(bytes) {
  if (els.format.value === 'base64') return toBase64(bytes);
  const hex = toHex(bytes);
  return els.upper.checked ? hex.toUpperCase() : hex;
}
const selectedAlgos = () => algoBoxes.filter((b) => b.checked).map((b) => b.value);
const formatMs = (ms) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
// Honest rounding: 99.96% shows as 99.9%, never 100% until the work is really done.
const percent = (done, total) => (total ? Math.floor((done / total) * 1000) / 10 : 100);

function readError(err) {
  if (err && (err.name === 'NotFoundError' || err.name === 'NotReadableError')) {
    return 'Could not read this file. It may have been moved or deleted, or it is a folder (folders cannot be hashed).';
  }
  if (err && /memory|allocation/i.test(err.message || '')) return 'The browser ran out of memory while reading this file. Try a computer, or close other tabs.';
  return `Could not hash this file: ${(err && err.message) || err}`;
}

// ---------- Progress ----------
function setProgress(done, total, label) {
  const pct = percent(done, total);
  els.progressWrap.hidden = false;
  els.progressBar.style.width = `${pct}%`;
  els.progress.setAttribute('aria-valuenow', String(pct));
  els.progressPct.textContent = `${pct}%`;
  els.progressLabel.textContent = label;
}
function startProgress(label) {
  els.progressWrap.classList.remove('is-done');
  els.cancel.hidden = false;
  setProgress(0, 1, label);
}
function finishProgress(label) {
  els.progressWrap.classList.add('is-done');
  els.cancel.hidden = true;
  els.progressBar.style.width = '100%';
  els.progress.setAttribute('aria-valuenow', '100');
  els.progressPct.textContent = '100%';
  els.progressLabel.textContent = label;
}

// ---------- Hashing ----------
async function hashFiles(files, dirNames = new Set()) {
  fileHasher.stop();
  setMode('file');
  state.files = files.map((f) => ({
    name: f.name,
    size: f.size,
    blob: f,
    digests: null,
    error: dirNames.has(f.name) && !f.type ? DIR_MESSAGE : null,
    ms: 0,
  }));
  const bad = state.files.filter((e) => e.error).length;
  if (bad && bad === files.length) {
    els.progressWrap.hidden = true;
    render();
    return;
  }
  await runFiles();
}

async function runFiles() {
  const run = ++state.run;
  const algos = selectedAlgos();
  const todo = state.files.filter((e) => !e.error || e.digests);
  todo.forEach((e) => { e.digests = null; e.error = null; });
  const total = todo.reduce((sum, e) => sum + e.size, 0);
  const t0 = performance.now();
  let before = 0;
  let scrolled = false;
  startProgress(`Hashing ${todo.length === 1 ? todo[0].name : `${todo.length} files`}…`);
  render();
  for (const [i, entry] of todo.entries()) {
    const start = performance.now();
    const prefix = todo.length > 1 ? `File ${i + 1} of ${todo.length}: ` : '';
    try {
      entry.digests = await fileHasher.hash(entry.blob, algos, (done) => {
        if (run === state.run) setProgress(before + done, total, `${prefix}${entry.name} · ${formatBytes(before + done)} of ${formatBytes(total)}`);
      });
      entry.ms = performance.now() - start;
    } catch (err) {
      if (err.name === 'AbortError' || run !== state.run) return;
      entry.error = readError(err);
    }
    if (run !== state.run) return;
    before += entry.size;
    render();
    if (!scrolled) { scrolled = true; els.results.querySelector('.result, .alert')?.scrollIntoView({ block: 'nearest' }); }
  }
  const ms = performance.now() - t0;
  const ok = todo.filter((e) => e.digests).length;
  const speed = ms > 50 && total > 0 ? ` (${formatBytes(total / (ms / 1000))}/s)` : '';
  finishProgress(`Done · ${ok} of ${todo.length} file${todo.length === 1 ? '' : 's'} · ${formatBytes(total)} in ${formatMs(ms)}${speed}`);
}

function textBytes() {
  let text = els.text.value.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (els.newline.checked) text += '\n';
  return new TextEncoder().encode(text);
}

async function hashText({ explicit = false } = {}) {
  const run = ++state.textRun;
  if (!els.text.value && !explicit) { state.text = null; render(); return; }
  const bytes = textBytes();
  const start = performance.now();
  try {
    const digests = await textHasher.hash(new Blob([bytes]), selectedAlgos());
    if (run !== state.textRun) return;
    const nl = els.newline.checked ? 'with a trailing newline' : 'no trailing newline';
    state.text = { name: 'Text', size: bytes.length, digests, error: null, ms: performance.now() - start, info: `${bytes.length} byte${bytes.length === 1 ? '' : 's'} UTF-8, ${nl}` };
  } catch (err) {
    if (err.name === 'AbortError' || run !== state.textRun) return;
    state.text = { name: 'Text', size: bytes.length, digests: null, error: readError(err) };
  }
  render();
  if (explicit) els.results.querySelector('.result')?.scrollIntoView({ block: 'nearest' });
}

// ---------- Rendering ----------
const currentEntries = () => (state.mode === 'text' ? (state.text ? [state.text] : []) : state.files);

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function card(entry, index) {
  if (entry.error) {
    const alert = el('div', { class: 'alert alert--error', role: 'alert' });
    alert.append(el('strong', {}, entry.name), document.createTextNode(`: ${entry.error}`));
    return alert;
  }
  const art = el('article', { class: 'result hash-card', 'data-entry': String(index) });
  const head = el('div', { class: 'hash-card__head' });
  const meta = el('div', { class: 'result__meta' });
  meta.append(el('div', { class: 'result__name', title: entry.name }, entry.name));
  const info = entry.info || formatBytes(entry.size) + (entry.size >= 1024 ? ` (${entry.size.toLocaleString('en-US')} bytes)` : '');
  meta.append(el('div', { class: 'result__info' }, entry.digests ? `${info} · ${formatMs(entry.ms)}` : `${info} · waiting…`));
  head.append(meta);
  art.append(head);
  if (!entry.digests) return art;

  const wrap = el('div', { class: 'table-wrap' });
  const table = el('table', { class: 'hash-table' });
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', { scope: 'col' }, 'Algorithm'), el('th', { scope: 'col' }, 'Value'), el('th', { scope: 'col' }));
  hr.lastChild.append(el('span', { class: 'visually-hidden' }, 'Copy'));
  thead.append(hr);
  const tbody = el('tbody');
  for (const id of selectedAlgos()) {
    const bytes = entry.digests[id];
    if (!bytes) continue;
    const value = formatDigest(bytes);
    const tr = el('tr', { 'data-algo': id });
    const valueCell = el('td');
    valueCell.append(el('code', { class: 'hash-value' }, value));
    const copyCell = el('td', { class: 'hash-table__copy' });
    copyCell.append(el('button', { type: 'button', class: 'btn btn--small', 'data-copy': value, 'aria-label': `Copy ${LABEL[id]} of ${entry.name}` }, 'Copy'));
    tr.append(el('th', { scope: 'row' }, LABEL[id]), valueCell, copyCell);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  art.append(wrap);
  return art;
}

function render() {
  const entries = currentEntries();
  const nodes = entries.map(card);
  const big = state.mode === 'file' && MOBILE && entries.some((e) => e.size > MOBILE_WARN_BYTES);
  if (big) nodes.unshift(el('div', { class: 'alert' }, 'Very large file on a phone: mobile browsers may run out of memory. If hashing stops, try it on a computer.'));
  els.results.replaceChildren(...nodes);

  const done = state.mode === 'file' && state.files.some((e) => e.digests);
  els.downloads.hidden = !done;
  if (done) {
    const keep = els.listAlgo.value || 'sha256';
    const available = selectedAlgos();
    els.listAlgo.replaceChildren(...available.map((id) => el('option', { value: id }, LABEL[id])));
    els.listAlgo.value = available.includes(keep) ? keep : available.includes('sha256') ? 'sha256' : available[0];
  }
  compare();
}

// ---------- Compare ----------
// Accepts a bare hash, "hash  filename" lines, "SHA256 (file) = hash" lines, "SHA-256: hash", hex with colons or spaces.
export function normalizeExpected(raw) {
  const line = (raw || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  let s = line;
  const bsd = s.match(/^[A-Za-z0-9-]+\s*\(.*\)\s*=\s*(\S+)$/);
  if (bsd) s = bsd[1];
  s = s.replace(/^(md5|sha-?1|sha-?256|sha-?384|sha-?512)\s*[:=]\s*/i, '');
  const first = s.split(/\s+/)[0];
  const firstHex = first.replace(/[:-]/g, '');
  if (/^[0-9a-f]+$/i.test(firstHex) && BY_HEX_LENGTH.has(firstHex.length)) return { hex: firstHex.toLowerCase(), text: firstHex };
  const compact = s.replace(/[\s:-]/g, '');
  if (/^[0-9a-f]+$/i.test(compact) && BY_HEX_LENGTH.has(compact.length)) return { hex: compact.toLowerCase(), text: compact };
  if (/^[0-9a-f]+$/i.test(firstHex)) return { hex: firstHex.toLowerCase(), text: firstHex };
  return { base64: first.replace(/^\*/, ''), text: first };
}

function setStatus(stateName, chip, detail) {
  els.status.dataset.state = stateName;
  els.status.textContent = chip;
  els.detail.textContent = detail;
}

function compare() {
  els.results.querySelectorAll('tr.is-match').forEach((tr) => tr.classList.remove('is-match'));
  els.results.querySelectorAll('.hash-card.is-match, .hash-card.is-mismatch').forEach((c) => c.classList.remove('is-match', 'is-mismatch'));
  const expected = normalizeExpected(els.expected.value);
  const entries = currentEntries().map((e, i) => [e, i]).filter(([e]) => e.digests);
  if (!expected) { setStatus('waiting', 'Waiting', DEFAULT_DETAIL); return; }
  if (!entries.length) { setStatus('waiting', 'Waiting', 'Expected hash ready. Hash a file or some text and it is compared automatically.'); return; }

  const algos = selectedAlgos();
  const matches = [];
  for (const [entry, index] of entries) {
    for (const id of algos) {
      const bytes = entry.digests[id];
      if (!bytes) continue;
      const hit = expected.hex ? toHex(bytes) === expected.hex : toBase64(bytes) === expected.base64;
      if (hit) matches.push({ entry, index, id });
    }
  }
  if (matches.length) {
    for (const m of matches) {
      const cardEl = els.results.querySelector(`.hash-card[data-entry="${m.index}"]`);
      cardEl?.classList.add('is-match');
      cardEl?.querySelector(`tr[data-algo="${m.id}"]`)?.classList.add('is-match');
    }
    const m = matches[0];
    const where = entries.length > 1 || state.mode === 'file' ? ` of ${m.entry.name}` : '';
    setStatus('match', 'Match', `${LABEL[m.id]}${where} matches the expected hash.`);
    return;
  }
  const guess = expected.hex ? BY_HEX_LENGTH.get(expected.hex.length) : null;
  let detail;
  if (expected.hex && !guess) detail = `No match. ${expected.hex.length} hex digits is not a length any of these algorithms produce (MD5 32, SHA-1 40, SHA-256 64, SHA-384 96, SHA-512 128).`;
  else if (guess && !algos.includes(guess.id)) detail = `No match. This looks like a ${guess.label} hash, but ${guess.label} is switched off above.`;
  else if (guess) detail = `No match. This looks like a ${guess.label} hash and it differs from the ${guess.label} computed here. The file may be corrupted or a different version.`;
  else detail = 'No match against any result. Check that you copied the whole hash.';
  if (state.mode === 'text') detail += ' For text, also try toggling the trailing newline.';
  setStatus('mismatch', 'No match', detail);
  if (entries.length === 1) els.results.querySelector(`.hash-card[data-entry="${entries[0][1]}"]`)?.classList.add('is-mismatch');
}

// ---------- Downloads ----------
const csvCell = (v) => (/[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

function downloadCsv() {
  const algos = selectedAlgos();
  const anyError = state.files.some((e) => e.error);
  const header = ['file', 'size_bytes', ...algos.map((id) => LABEL[id]), ...(anyError ? ['error'] : [])];
  const rows = state.files.map((e) => [e.name, e.size, ...algos.map((id) => (e.digests && e.digests[id] ? formatDigest(e.digests[id]) : '')), ...(anyError ? [e.error || ''] : [])]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'hashes.csv');
  toast('Saved hashes.csv');
}

// Standard two-column format read by sha256sum -c and friends: "<lowercase hex>  <file name>".
function downloadList() {
  const id = els.listAlgo.value;
  const lines = state.files.filter((e) => e.digests && e.digests[id]).map((e) => `${toHex(e.digests[id])}  ${e.name}`);
  downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), 'checksums.txt');
  toast(`Saved checksums.txt (${LABEL[id]}, ${lines.length} file${lines.length === 1 ? '' : 's'})`);
}

// ---------- Tabs ----------
function setMode(mode) {
  state.mode = mode;
  for (const tab of els.tabs) {
    const on = tab.id === `tab-${mode}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  els.panels.file.hidden = mode !== 'file';
  els.panels.text.hidden = mode !== 'text';
  if (mode === 'text') els.progressWrap.hidden = true;
  else els.progressWrap.hidden = !state.files.length || state.files.every((e) => e.error && !e.digests);
  render();
}
els.tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => { setMode(tab.id.replace('tab-', '')); if (state.mode === 'text') els.text.focus(); });
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = els.tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + els.tabs.length) % els.tabs.length];
    next.focus();
    next.click();
  });
});

// ---------- Events ----------
let droppedDirs = new Set();
// Runs before wireDropzone's own drop handler (registered first), so folders are known when the files arrive.
els.zone.addEventListener('drop', (e) => {
  droppedDirs = new Set();
  for (const item of e.dataTransfer?.items || []) {
    const entry = item.kind === 'file' && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) droppedDirs.add(entry.name);
  }
});
wireDropzone(els.zone, els.input, (files) => {
  const dirs = droppedDirs;
  droppedDirs = new Set();
  hashFiles(files, dirs);
});

let textTimer = 0;
els.text.addEventListener('input', () => { clearTimeout(textTimer); textTimer = setTimeout(() => hashText(), 150); });
els.newline.addEventListener('change', () => hashText());
els.hashText.addEventListener('click', () => hashText({ explicit: true }));

els.format.addEventListener('change', () => { els.upper.disabled = els.format.value === 'base64'; render(); });
els.upper.addEventListener('change', render);

algoBoxes.forEach((box) => box.addEventListener('change', () => {
  if (!selectedAlgos().length) { box.checked = true; toast('Keep at least one algorithm switched on'); return; }
  const need = selectedAlgos();
  const missing = (e) => e.digests && need.some((id) => !e.digests[id]);
  if (state.files.some(missing)) runFiles();
  else render();
  if (state.text && missing(state.text)) hashText({ explicit: true });
}));

els.cancel.addEventListener('click', () => {
  state.run++;
  fileHasher.stop();
  state.files.forEach((e) => { if (!e.digests && !e.error) e.error = 'Cancelled before it finished.'; });
  finishProgress('Cancelled');
  els.progressPct.textContent = '';
  render();
});

els.expected.addEventListener('input', compare);
// Ctrl/Cmd+V in the compare field: replace the value with the pasted hash and compare right away.
els.expected.addEventListener('paste', (e) => {
  const pasted = e.clipboardData?.getData('text');
  if (pasted == null) return;
  e.preventDefault();
  els.expected.value = pasted.trim();
  compare();
});
// Pasting anywhere else on the page (outside a text box) also lands in the compare field.
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (t === els.expected || (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
  const pasted = e.clipboardData?.getData('text');
  if (!pasted || !pasted.trim()) return;
  e.preventDefault();
  els.expected.value = pasted.trim();
  els.expected.focus();
  compare();
});

els.results.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    toast('Hash copied');
  } catch {
    const code = btn.closest('tr')?.querySelector('code');
    if (code) getSelection().selectAllChildren(code);
    toast('Copy is blocked here. The hash is selected, press Ctrl+C or ⌘C.');
  }
});
els.downloadCsv.addEventListener('click', downloadCsv);
els.downloadList.addEventListener('click', downloadList);

// Called by the factory's screenshot script to show the tool in a realistic, fictional state.
window.__demo = async () => {
  const res = await fetch('./tests/fixtures/sample.txt');
  const file = new File([await res.blob()], 'sample.txt', { type: 'text/plain' });
  await hashFiles([file]);
  const entry = state.files[0];
  if (entry && entry.digests) {
    els.expected.value = `${toHex(entry.digests.sha256)}  sample.txt`;
    compare();
  }
};

export { hashFiles, hashText };
