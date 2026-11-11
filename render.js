/* render.js - turns a parsed .ipynb (nbformat 3 or 4) into DOM.
 * Everything is static: nothing is executed and no kernel is needed.
 * Needs the globals DOMPurify, marked, hljs and katex (loaded by viewer.html). */
(function (global) {
  'use strict';

  let baseUrl = ''; // where the notebook lives, used to resolve relative image/link paths

  // ---------------------------------------------------------------- helpers
  const joinText = (v) => (Array.isArray(v) ? v.join('') : v == null ? '' : String(v));
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function preHtml(className, html) {
    const node = h('pre', className);
    node.innerHTML = html; // callers pass escaped text or sanitized markup only
    return node;
  }

  // ------------------------------------------------------------------- ANSI
  const ANSI_NORMAL = ['#3e424d', '#e75c58', '#00a250', '#ddb62b', '#208ffb', '#d160c4', '#60c7c7', '#c5c1b4'];
  const ANSI_BRIGHT = ['#282c36', '#b22b31', '#007427', '#b27d12', '#0065ca', '#a03196', '#258f8f', '#a1a6b2'];

  function color256(n) {
    if (n < 8) return ANSI_NORMAL[n];
    if (n < 16) return ANSI_BRIGHT[n - 8];
    if (n < 232) {
      const i = n - 16;
      const level = (x) => (x ? 55 + x * 40 : 0);
      return `rgb(${level(Math.floor(i / 36))},${level(Math.floor((i % 36) / 6))},${level(i % 6)})`;
    }
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
  }

  function ansiToHtml(input) {
    let text = input.replace(/\r\n/g, '\n');
    // Progress bars (tqdm etc.) rewrite the line with \r: keep the final state of each line.
    if (text.indexOf('\r') !== -1) {
      text = text
        .split('\n')
        .map((line) => {
          if (line.indexOf('\r') === -1) return line;
          const parts = line.split('\r').filter((p) => p.length);
          return parts.length ? parts[parts.length - 1] : '';
        })
        .join('\n');
    }
    // Drop cursor/erase sequences; keep colour ('m') sequences.
    text = text.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '');

    const fresh = () => ({ fg: null, bg: null, bold: false, underline: false });
    let st = fresh();
    let out = '';
    let last = 0;

    const flush = (chunk) => {
      if (!chunk) return;
      const styles = [];
      if (st.fg) styles.push('color:' + st.fg);
      if (st.bg) styles.push('background:' + st.bg);
      if (st.bold) styles.push('font-weight:bold');
      if (st.underline) styles.push('text-decoration:underline');
      out += styles.length ? `<span style="${styles.join(';')}">${esc(chunk)}</span>` : esc(chunk);
    };

    const re = /\x1b\[([0-9;]*)m/g;
    let m;
    while ((m = re.exec(text))) {
      flush(text.slice(last, m.index));
      last = re.lastIndex;
      const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) st = fresh();
        else if (c === 1) st.bold = true;
        else if (c === 4) st.underline = true;
        else if (c === 22) st.bold = false;
        else if (c === 24) st.underline = false;
        else if (c >= 30 && c <= 37) st.fg = ANSI_NORMAL[c - 30];
        else if (c >= 90 && c <= 97) st.fg = ANSI_BRIGHT[c - 90];
        else if (c === 39) st.fg = null;
        else if (c >= 40 && c <= 47) st.bg = ANSI_NORMAL[c - 40];
        else if (c >= 100 && c <= 107) st.bg = ANSI_BRIGHT[c - 100];
        else if (c === 49) st.bg = null;
        else if (c === 38 || c === 48) {
          let col = null;
          if (codes[i + 1] === 5) {
            col = color256(codes[i + 2]);
            i += 2;
          } else if (codes[i + 1] === 2) {
            col = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
            i += 4;
          }
          if (c === 38) st.fg = col;
          else st.bg = col;
        }
      }
    }
    flush(text.slice(last));
    return out;
  }

  // --------------------------------------------------- markdown + math + code
  function mathHtml(tex, display) {
    try {
      return global.katex.renderToString(tex.trim(), {
        displayMode: display,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
      });
    } catch (e) {
      return '<code>' + esc(tex) + '</code>';
    }
  }

  function highlight(code, lang) {
    try {
      if (lang && global.hljs && global.hljs.getLanguage(lang)) {
        return global.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
    } catch (e) {
      /* fall through to plain text */
    }
    return esc(code);
  }

  function resolveUrls(root) {
    if (!baseUrl) return;
    const relative = (v) => v && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(v);
    const fix = (selector, attr) =>
      root.querySelectorAll(selector).forEach((n) => {
        const v = n.getAttribute(attr);
        if (!relative(v)) return;
        try {
          n.setAttribute(attr, new URL(v, baseUrl).href);
        } catch (e) {
          /* leave as is */
        }
      });
    fix('img[src], source[src], video[src], audio[src]', 'src');
    fix('a[href]', 'href');
  }

  function markdownToHtml(source, attachments) {
    let src = joinText(source);

    // Images pasted into the cell live in cell.attachments.
    if (attachments) {
      src = src.replace(/attachment:([^)"'\s>]+)/g, (match, name) => {
        let key = name;
        try {
          key = attachments[name] ? name : decodeURIComponent(name);
        } catch (e) {
          /* keep name */
        }
        const bundle = attachments[key];
        const mime = bundle && Object.keys(bundle).find((k) => /^image\//.test(k));
        return mime ? `data:${mime};base64,${joinText(bundle[mime]).replace(/\s+/g, '')}` : match;
      });
    }

    // Keep $...$ out of the markdown parser's hands (underscores, asterisks, backslashes).
    const code = [];
    const maths = [];
    src = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, (m) => {
      code.push(m);
      return '' + (code.length - 1) + '';
    });
    const stash = (tex, display) => {
      maths.push({ tex, display });
      return '' + (maths.length - 1) + '';
    };
    src = src
      .replace(
        /\\begin\{(equation\*?|align\*?|gather\*?|alignat\*?|eqnarray\*?|multline\*?)\}([\s\S]+?)\\end\{\1\}/g,
        (m, env, inner) => stash(/^equation/.test(env) ? inner : m, true)
      )
      .replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => stash(t, true))
      .replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => stash(t, true))
      .replace(/\\\(([\s\S]+?)\\\)/g, (m, t) => stash(t, false))
      .replace(/(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?!\d)/g, (m, t) => stash(t, false));
    src = src.replace(/(\d+)/g, (m, i) => code[+i]);

    let html = global.marked.parse(src, { gfm: true, breaks: false });
    html = global.DOMPurify.sanitize(html);
    return html.replace(/(\d+)/g, (m, i) => mathHtml(maths[+i].tex, maths[+i].display));
  }

  function markdownEl(source, attachments) {
    const div = h('div', 'markdown');
    div.innerHTML = markdownToHtml(source, attachments);
    div.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((heading) => {
      if (!heading.id) heading.id = heading.textContent.trim().replace(/\s+/g, '-');
    });
    div.querySelectorAll('pre code[class*="language-"]').forEach((block) => {
      const m = /language-([\w+-]+)/.exec(block.className);
      if (m && global.hljs && global.hljs.getLanguage(m[1].toLowerCase())) {
        block.innerHTML = highlight(block.textContent, m[1].toLowerCase());
        block.classList.add('hljs');
      }
    });
    resolveUrls(div);
    return div;
  }

  // Links open in a new tab; in-page "#anchors" are handled by viewer.js.
  global.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName && node.tagName.toLowerCase() === 'a' && node.hasAttribute('href')) {
      if (!(node.getAttribute('href') || '').startsWith('#')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });

  // ---------------------------------------------------------------- outputs
  const SHADOW_CSS = `
    :host { display: block; max-width: 100%; overflow-x: auto; }
    table { border-collapse: collapse; border: none; color: #000; font-size: 12px; }
    thead { border-bottom: 1px solid #000; vertical-align: bottom; }
    th, td { text-align: right; vertical-align: middle; padding: 0.5em; line-height: normal; border: none; }
    th { font-weight: bold; }
    tbody tr:nth-child(odd) { background: #f5f5f5; }
    img, svg { max-width: 100%; }
  `;

  // text/html output is shown inside a shadow root so its <style> blocks can't leak into the page.
  function htmlEl(html) {
    const clean = global.DOMPurify.sanitize(html, { FORCE_BODY: true });
    const probe = document.createElement('template');
    probe.innerHTML = clean;
    probe.content.querySelectorAll('style').forEach((s) => s.remove());
    const visible =
      probe.content.textContent.trim() ||
      probe.content.querySelector('img,svg,table,video,canvas,hr,math');
    if (!visible) return null; // e.g. a Plotly/Bokeh wrapper whose content was a <script>

    const host = h('div', 'out-html');
    if (host.attachShadow) {
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>' + SHADOW_CSS + '</style>' + clean;
      resolveUrls(root);
    } else {
      host.innerHTML = clean;
      resolveUrls(host);
    }
    return host;
  }

  function imgEl(src, meta) {
    const wrap = h('div', 'out-image');
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Notebook output image';
    if (meta && Number(meta.width) > 0) img.setAttribute('width', String(Number(meta.width)));
    wrap.appendChild(img);
    return wrap;
  }

  const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const INTERACTIVE = /^application\/vnd\.(jupyter\.widget|plotly|bokehjs|vega|vegalite|holoviews)/;

  function bundleEl(data, meta) {
    if (data['text/html'] != null) {
      const node = htmlEl(joinText(data['text/html']));
      if (node) return node;
    }
    if (data['image/svg+xml'] != null) {
      return imgEl(
        'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(joinText(data['image/svg+xml'])),
        meta['image/svg+xml']
      );
    }
    for (const mime of IMAGE_MIMES) {
      if (data[mime] != null) {
        return imgEl(`data:${mime};base64,${joinText(data[mime]).replace(/\s+/g, '')}`, meta[mime]);
      }
    }
    if (data['text/markdown'] != null) return markdownEl(data['text/markdown']);
    if (data['text/latex'] != null) return markdownEl(data['text/latex']);
    if (data['application/json'] != null) {
      const v = data['application/json'];
      return preHtml('out-text', esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2)));
    }
    const interactive = Object.keys(data).find((k) => INTERACTIVE.test(k));
    if (interactive) {
      return h('div', 'out-note', `Interactive output (${interactive}) can't be shown in a static viewer.`);
    }
    if (data['text/plain'] != null) return preHtml('out-text', ansiToHtml(joinText(data['text/plain'])));
    return null;
  }

  function outputEl(out) {
    const type = out.output_type;
    let body = null;
    let promptText = '';

    if (type === 'stream') {
      const text = joinText(out.text);
      if (!text) return null;
      body = preHtml('out-stream ' + (out.name === 'stderr' ? 'stderr' : 'stdout'), ansiToHtml(text));
    } else if (type === 'error') {
      const trace =
        Array.isArray(out.traceback) && out.traceback.length
          ? out.traceback.join('\n')
          : `${out.ename || 'Error'}: ${out.evalue || ''}`;
      body = preHtml('out-error', ansiToHtml(trace));
    } else if (type === 'execute_result' || type === 'display_data' || type === 'update_display_data') {
      body = bundleEl(out.data || {}, out.metadata || {});
      if (type === 'execute_result') {
        promptText = 'Out[' + (out.execution_count == null ? ' ' : out.execution_count) + ']:';
      }
    }
    if (!body) return null;

    const row = h('div', 'row output');
    row.appendChild(h('div', 'prompt out', promptText));
    const wrap = h('div', 'out-body');
    wrap.appendChild(body);
    row.appendChild(wrap);
    return row;
  }

  // Jupyter joins consecutive writes to the same stream into one block.
  function mergeStreams(outputs) {
    const merged = [];
    outputs.forEach((o) => {
      if (o.output_type !== 'stream') return merged.push(o);
      const prev = merged[merged.length - 1];
      if (prev && prev.output_type === 'stream' && prev.name === o.name) {
        prev.text += joinText(o.text);
      } else {
        merged.push({ output_type: 'stream', name: o.name, text: joinText(o.text) });
      }
    });
    return merged;
  }

  // ------------------------------------------------------------------ cells
  const MAGIC_LANG = {
    bash: 'bash', sh: 'bash', sql: 'sql', js: 'javascript', javascript: 'javascript',
    html: 'xml', svg: 'xml', markdown: 'markdown', python: 'python', python3: 'python',
    r: 'r', ruby: 'ruby', perl: 'perl',
  };

  function langForCell(src, notebookLang) {
    const m = /^%%(\w+)/.exec(src);
    return (m && MAGIC_LANG[m[1].toLowerCase()]) || notebookLang;
  }

  function codeEl(src, lang) {
    const pre = h('pre', 'code');
    const code = h('code', 'hljs');
    code.innerHTML = highlight(src.replace(/\n+$/, ''), lang);
    pre.appendChild(code);
    return pre;
  }

  function cellEl(cell, lang) {
    const type = cell.cell_type;
    const src = joinText(cell.source);
    const wrap = h('div', 'cell ' + type + '-cell');

    if (type === 'markdown') {
      if (!src.trim()) return null;
      const row = h('div', 'row');
      row.appendChild(h('div', 'prompt'));
      const body = h('div', 'cell-body');
      body.appendChild(markdownEl(src, cell.attachments));
      row.appendChild(body);
      wrap.appendChild(row);
      return wrap;
    }

    if (type === 'raw') {
      if (!src.trim()) return null;
      const row = h('div', 'row');
      row.appendChild(h('div', 'prompt'));
      const body = h('div', 'cell-body');
      body.appendChild(preHtml('raw', esc(src)));
      row.appendChild(body);
      wrap.appendChild(row);
      return wrap;
    }

    if (type === 'code') {
      const outputs = mergeStreams(Array.isArray(cell.outputs) ? cell.outputs : []);
      const outputEls = outputs.map(outputEl).filter(Boolean);
      if (!src.trim() && !outputEls.length) return null;

      if (src.trim()) {
        const row = h('div', 'row code-input');
        const count = cell.execution_count == null ? ' ' : cell.execution_count;
        row.appendChild(h('div', 'prompt in', 'In [' + count + ']:'));
        const body = h('div', 'cell-body');
        body.appendChild(codeEl(src, langForCell(src, lang)));
        row.appendChild(body);
        wrap.appendChild(row);
      }
      if (outputEls.length) {
        const box = h('div', 'outputs');
        outputEls.forEach((o) => box.appendChild(o));
        wrap.appendChild(box);
      }
      return wrap;
    }
    return null;
  }

  // --------------------------------------------------- nbformat 3 -> 4 shape
  const V3_MIME = {
    text: 'text/plain', html: 'text/html', png: 'image/png', jpeg: 'image/jpeg',
    svg: 'image/svg+xml', latex: 'text/latex', json: 'application/json',
    javascript: 'application/javascript',
  };

  function v3Output(o) {
    if (o.output_type === 'stream') return { output_type: 'stream', name: o.stream || 'stdout', text: o.text };
    if (o.output_type === 'pyerr') {
      return { output_type: 'error', ename: o.ename, evalue: o.evalue, traceback: o.traceback };
    }
    const data = {};
    Object.keys(V3_MIME).forEach((k) => {
      if (o[k] != null) data[V3_MIME[k]] = o[k];
    });
    return {
      output_type: o.output_type === 'pyout' ? 'execute_result' : 'display_data',
      execution_count: o.prompt_number,
      data,
      metadata: {},
    };
  }

  function getCells(nb) {
    if (Array.isArray(nb.cells)) return nb.cells;
    if (Array.isArray(nb.worksheets)) {
      const cells = [];
      nb.worksheets.forEach((ws) =>
        (ws.cells || []).forEach((c) => {
          if (c.cell_type === 'code') {
            cells.push({
              cell_type: 'code',
              source: c.input,
              execution_count: c.prompt_number,
              outputs: (c.outputs || []).map(v3Output),
            });
          } else if (c.cell_type === 'heading') {
            cells.push({ cell_type: 'markdown', source: '#'.repeat(c.level || 1) + ' ' + joinText(c.source) });
          } else {
            cells.push(c);
          }
        })
      );
      return cells;
    }
    return null;
  }

  // ----------------------------------------------------------------- public
  // Returns a working copy shaped like nbformat 4 (old nbformat 3 files are converted).
  // The returned object's `cells` array is what the viewer edits and saves.
  function normalize(nb) {
    if (!nb || typeof nb !== 'object') throw new Error('This file is not a Jupyter notebook.');
    if (Array.isArray(nb.cells)) return nb;
    const cells = getCells(nb);
    if (!cells) throw new Error('This JSON file is not a Jupyter notebook (no "cells" list found).');
    const out = Object.assign({}, nb, { cells, nbformat: 4, nbformat_minor: 5 });
    delete out.worksheets;
    return out;
  }

  function notebookLang(nb) {
    const md = nb.metadata || {};
    return String(
      (md.language_info && md.language_info.name) ||
        (md.kernelspec && md.kernelspec.language) ||
        md.language ||
        'python'
    ).toLowerCase();
  }

  // Per-cell buttons; they only show while the viewer is in "Edit mode".
  function actionsEl() {
    const bar = h('div', 'cell-actions');
    [
      ['edit', 'Edit', 'Edit this cell'],
      ['clear', 'Clear output', 'Remove the saved output of this cell'],
      ['delete', 'Delete', 'Delete this cell'],
    ].forEach(([action, label, title]) => {
      const b = h('button', 'act act-' + action, label);
      b.type = 'button';
      b.dataset.action = action;
      b.title = title;
      bar.appendChild(b);
    });
    return bar;
  }

  // One cell -> `.cell-wrap` (actions + rendered cell). wrap._cell points at the cell object,
  // so edits and deletes act on the notebook data directly. Returns null for empty cells.
  function makeWrap(cell, lang) {
    let node;
    try {
      node = cellEl(cell, lang);
    } catch (e) {
      node = h('div', 'cell-error', 'This cell could not be displayed: ' + e.message);
    }
    if (!node) return null;
    const wrap = h('div', 'cell-wrap');
    wrap._cell = cell;
    wrap.dataset.type = cell.cell_type;
    wrap.classList.toggle('no-output', !(cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length));
    wrap.appendChild(actionsEl());
    wrap.appendChild(node);
    return wrap;
  }

  function renderNotebook(nb, container) {
    nb = normalize(nb);
    const cells = nb.cells;
    const lang = notebookLang(nb);
    const md = nb.metadata || {};

    const frag = document.createDocumentFragment();
    cells.forEach((cell) => {
      const wrap = makeWrap(cell, lang);
      if (wrap) frag.appendChild(wrap);
    });
    container.textContent = '';
    container.appendChild(frag);

    return {
      cells: cells.length,
      language: lang,
      kernel: (md.kernelspec && (md.kernelspec.display_name || md.kernelspec.name)) || '',
      nbformat: nb.nbformat,
      minor: nb.nbformat_minor,
    };
  }

  global.IpynbRender = {
    renderNotebook,
    normalize,
    makeWrap,
    notebookLang,
    ansiToHtml,
    setBaseUrl(url) {
      baseUrl = url || '';
    },
  };
})(window);
