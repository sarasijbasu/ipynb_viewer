/* viewer.js - the UI around render.js: gets a notebook (from the page that opened us,
 * a dropped file or the file picker), applies view toggles, lets you edit / delete cells and
 * clear outputs, and exports to PDF, Word or a new .ipynb. Nothing is ever executed. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const nbEl = $('notebook');
  const emptyEl = $('empty');
  const errorEl = $('error');
  const hasChrome = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;
  const inFrame = window.parent !== window;
  const PREF_KEY = 'ipynb-viewer-prefs';

  let fileName = 'notebook.ipynb';
  let loaded = false;
  let toastTimer = null;
  let pdfHintShown = false;

  // notebook state
  let nb = null; // working copy (what is shown, edited and saved)
  let originalText = ''; // as opened, for Reset
  let lang = 'python';
  let info = null;
  let changed = false; // differs from what was opened (enables Reset)
  let unsaved = false; // edits not yet saved to a file (warns before leaving)
  let lastDeleted = null;
  let editor = null; // wrap currently being edited

  const baseName = () => fileName.replace(/\.ipynb$/i, '');
  const joinText = (v) => (Array.isArray(v) ? v.join('') : v == null ? '' : String(v));

  // ------------------------------------------------------------ preferences
  function readPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    } catch (e) {
      return {};
    }
  }
  const prefs = Object.assign({ code: true, outputs: true, prompts: true }, readPrefs());

  function applyPrefs() {
    document.body.classList.toggle('hide-code', !prefs.code);
    document.body.classList.toggle('hide-outputs', !prefs.outputs);
    document.body.classList.toggle('hide-prompts', !prefs.prompts);
    $('optCode').checked = prefs.code;
    $('optOutputs').checked = prefs.outputs;
    $('optPrompts').checked = prefs.prompts;
  }

  [['optCode', 'code'], ['optOutputs', 'outputs'], ['optPrompts', 'prompts']].forEach(([id, key]) => {
    $(id).addEventListener('change', (e) => {
      prefs[key] = e.target.checked;
      try {
        localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      } catch (err) {
        /* preferences just won't persist */
      }
      applyPrefs();
    });
  });
  applyPrefs();

  $('optEdit').addEventListener('change', (e) => {
    document.body.classList.toggle('edit-mode', e.target.checked);
    if (!e.target.checked && editor) finishEdit(editor, true);
  });

  // ------------------------------------------------------------------ toast
  function toast(message, action, ms) {
    const el = $('toast');
    el.textContent = message;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        el.hidden = true;
        action.fn();
      });
      el.appendChild(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms || 4500);
  }

  // ------------------------------------------------------------------ state
  function updateMeta() {
    if (!info) return;
    const n = nb ? nb.cells.length : info.cells;
    $('meta').textContent = [
      info.kernel,
      info.nbformat ? 'nbformat ' + info.nbformat + (info.minor != null ? '.' + info.minor : '') : '',
      n + (n === 1 ? ' cell' : ' cells'),
      changed ? 'edited' : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  function setChanged(isChanged) {
    changed = isChanged;
    unsaved = isChanged;
    $('btnReset').disabled = !changed;
    $('btnSave').disabled = !changed;
    updateMeta();
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (!loaded) emptyEl.hidden = false;
  }

  function openText(text, name, url) {
    const clean = String(text).replace(/^﻿/, '');
    let model;
    try {
      model = IpynbRender.normalize(JSON.parse(clean));
    } catch (e) {
      showError(
        e instanceof SyntaxError
          ? 'This file isn’t valid JSON, so it can’t be opened as a notebook.'
          : e.message || String(e)
      );
      return;
    }

    try {
      IpynbRender.setBaseUrl(url || '');
      info = IpynbRender.renderNotebook(model, nbEl);
    } catch (e) {
      showError(e.message || String(e));
      return;
    }

    nb = model;
    originalText = clean;
    lang = info.language;
    fileName = name || 'notebook.ipynb';
    loaded = true;
    editor = null;
    lastDeleted = null;
    $('fileName').textContent = fileName;
    document.title = fileName + ' - IPYNB Viewer';
    setChanged(false);

    emptyEl.hidden = true;
    errorEl.hidden = true;
    nbEl.hidden = false;
    $('toolbar').hidden = false;
    window.scrollTo(0, 0);
  }

  function refreshAll() {
    const y = window.scrollY;
    editor = null;
    info = IpynbRender.renderNotebook(nb, nbEl);
    lang = info.language;
    window.scrollTo(0, y);
    updateMeta();
  }

  function openFile(file) {
    if (!file) return;
    if (unsaved && !window.confirm('You have unsaved edits. Open another file anyway?')) return;
    const reader = new FileReader();
    reader.onload = () => openText(reader.result, file.name, '');
    reader.onerror = () => showError('Could not read that file.');
    reader.readAsText(file);
  }

  // ------------------------------------------------------------ cell editing
  const toLines = (text) => {
    const parts = text.split('\n');
    return parts.map((l, i) => (i < parts.length - 1 ? l + '\n' : l)).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  };

  function replaceWrap(wrap) {
    const fresh = IpynbRender.makeWrap(wrap._cell, lang);
    if (fresh) wrap.replaceWith(fresh);
    else wrap.remove();
  }

  function startEdit(wrap) {
    if (editor && editor !== wrap) finishEdit(editor, false);
    if (wrap.classList.contains('editing')) return;
    const cell = wrap._cell;
    const isCode = cell.cell_type === 'code';

    const box = document.createElement('div');
    box.className = 'editor';
    const prompt = document.createElement('div');
    prompt.className = 'prompt';
    prompt.textContent = isCode ? 'Code' : cell.cell_type === 'markdown' ? 'Markdown' : 'Raw';
    const col = document.createElement('div');
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.value = joinText(cell.source);
    const buttons = document.createElement('div');
    buttons.className = 'editor-buttons';
    buttons.innerHTML =
      '<button type="button" class="primary" data-action="save-edit">Save</button>' +
      '<button type="button" data-action="cancel-edit">Cancel</button>' +
      '<span>Ctrl/⌘+Enter to save · Esc to cancel</span>';
    col.append(ta, buttons);
    box.append(prompt, col);

    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 4, window.innerHeight * 0.7) + 'px';
    };
    ta.addEventListener('input', autosize);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finishEdit(wrap, false);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finishEdit(wrap, true);
      } else if (e.key === 'Tab' && isCode && !e.shiftKey) {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText('    ', s, ta.selectionEnd, 'end');
        autosize();
      }
    });

    wrap.classList.add('editing');
    wrap.appendChild(box);
    editor = wrap;
    autosize();
    ta.focus();
  }

  function finishEdit(wrap, save) {
    const box = wrap.querySelector(':scope > .editor');
    const ta = box && box.querySelector('textarea');
    const cell = wrap._cell;
    let edited = false;
    if (save && ta && ta.value !== joinText(cell.source)) {
      cell.source = toLines(ta.value);
      edited = true;
    }
    wrap.classList.remove('editing');
    if (box) box.remove();
    if (editor === wrap) editor = null;
    if (edited) {
      replaceWrap(wrap);
      setChanged(true);
    }
  }

  function deleteCell(wrap) {
    const cell = wrap._cell;
    const index = nb.cells.indexOf(cell);
    if (index < 0) return;
    if (editor === wrap) editor = null;
    nb.cells.splice(index, 1);
    wrap.remove();
    lastDeleted = { cell, index };
    setChanged(true);
    toast('Cell deleted.', { label: 'Undo', fn: undoDelete }, 8000);
  }

  function undoDelete() {
    if (!lastDeleted) return;
    nb.cells.splice(Math.min(lastDeleted.index, nb.cells.length), 0, lastDeleted.cell);
    lastDeleted = null;
    refreshAll();
    setChanged(true);
  }

  function clearOutput(wrap) {
    const cell = wrap._cell;
    if (cell.cell_type !== 'code') return;
    cell.outputs = [];
    cell.execution_count = null;
    replaceWrap(wrap);
    setChanged(true);
  }

  function clearAllOutputs() {
    let n = 0;
    nb.cells.forEach((c) => {
      if (c.cell_type !== 'code') return;
      if (c.outputs && c.outputs.length) n++;
      c.outputs = [];
      c.execution_count = null;
    });
    refreshAll();
    if (n) {
      setChanged(true);
      toast('Cleared the outputs of ' + n + (n === 1 ? ' cell.' : ' cells.'));
    } else {
      toast('There were no outputs to clear.');
    }
  }

  function resetNotebook() {
    if (!changed) return;
    if (!window.confirm('Discard all edits and restore the notebook as it was opened?')) return;
    nb = IpynbRender.normalize(JSON.parse(originalText));
    lastDeleted = null;
    refreshAll();
    setChanged(false);
    toast('Restored the original notebook.');
  }

  // ------------------------------------------------------------- exporting
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function saveIpynb() {
    if (!loaded) return;
    if (editor) finishEdit(editor, true);
    const json = JSON.stringify(nb, null, 1) + '\n';
    download(new Blob([json], { type: 'application/json' }), baseName() + '-edited.ipynb');
    unsaved = false;
    toast('Saved a copy as “' + baseName() + '-edited.ipynb” in your Downloads folder.');
  }

  async function exportWord() {
    if (!loaded) return;
    if (editor) finishEdit(editor, true);
    const btn = $('btnWord');
    btn.disabled = true;
    toast('Building the Word file…', null, 60000);
    try {
      const blob = await DocxExport.exportDocx(nbEl, { code: prefs.code, outputs: prefs.outputs, prompts: prefs.prompts });
      download(blob, baseName() + '.docx');
      toast('Word file downloaded.');
    } catch (e) {
      console.error(e);
      toast('Word export failed: ' + (e && e.message ? e.message : e), null, 8000);
    } finally {
      btn.disabled = false;
    }
  }

  function exportPdf() {
    if (!loaded) return;
    if (editor) finishEdit(editor, true);
    const previousTitle = document.title;
    document.title = baseName(); // becomes the suggested PDF file name
    const restore = () => {
      document.title = previousTitle;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    if (!pdfHintShown) {
      pdfHintShown = true;
      toast('In the print dialog, set Destination to “Save as PDF”.');
    }
    setTimeout(() => window.print(), 60);
  }

  $('btnPdf').addEventListener('click', exportPdf);
  $('btnWord').addEventListener('click', exportWord);
  $('btnSave').addEventListener('click', saveIpynb);
  $('btnReset').addEventListener('click', resetNotebook);
  $('btnClearAll').addEventListener('click', clearAllOutputs);

  window.addEventListener('keydown', (e) => {
    if (!loaded || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'p') {
      e.preventDefault();
      exportPdf();
    } else if (key === 's') {
      e.preventDefault();
      saveIpynb();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (unsaved) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------------------------------------------------------- file selection
  const chooseFile = () => $('fileInput').click();
  $('btnChoose').addEventListener('click', chooseFile);
  $('btnOpen').addEventListener('click', chooseFile);
  $('fileInput').addEventListener('change', (e) => {
    openFile(e.target.files && e.target.files[0]);
    e.target.value = '';
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    openFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  // Clicks inside the notebook: per-cell buttons, and in-page links like [Intro](#Introduction).
  nbEl.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button[data-action]');
    if (btn) {
      const wrap = btn.closest('.cell-wrap');
      if (!wrap || !wrap._cell) return;
      const action = btn.dataset.action;
      if (action === 'edit') startEdit(wrap);
      else if (action === 'save-edit') finishEdit(wrap, true);
      else if (action === 'cancel-edit') finishEdit(wrap, false);
      else if (action === 'clear') clearOutput(wrap);
      else if (action === 'delete') deleteCell(wrap);
      return;
    }
    const a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    let id = a.getAttribute('href').slice(1);
    try {
      id = decodeURIComponent(id);
    } catch (err) {
      /* use raw id */
    }
    const target = document.getElementById(id);
    if (target) target.scrollIntoView({ block: 'start' });
  });

  // -------------------------------------------------- opened by content.js?
  if (inFrame) {
    window.addEventListener('message', (e) => {
      if (e.source !== window.parent) return;
      const m = e.data;
      if (m && m.type === 'ipynb-data' && typeof m.text === 'string') openText(m.text, m.name, m.url);
    });
    window.parent.postMessage({ type: 'ipynb-viewer-ready' }, '*'); // payload carries no data
  }

  // ----------------------------------------------------- setup status panel
  if (hasChrome) {
    if (chrome.extension && chrome.extension.isAllowedFileSchemeAccess) {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => {
        const status = $('fileAccessStatus');
        status.textContent = allowed ? '✓' : '✗';
        status.className = 'status ' + (allowed ? 'ok' : 'bad');
      });
    }
    $('btnSettings').addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
    });
  } else {
    $('btnSettings').hidden = true;
  }
})();
