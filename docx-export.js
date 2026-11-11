/* docx-export.js - converts the rendered notebook DOM into a real .docx (Word) file,
 * using the bundled `docx` library. Runs entirely in the browser.
 * It reads the DOM that is on screen, so edits, deletions and the view toggles are respected. */
(function (global) {
  'use strict';

  const MAX_IMG_W = 600; // px at 96 dpi (~6.25 in, the text width with 1 in margins on A4)
  const MAX_IMG_H = 860;
  const TABLE_W = 9000; // twips
  const SKIP = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT']);
  const BLOCK = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE',
    'HR', 'SECTION', 'ARTICLE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY', 'DL', 'DT', 'DD',
    'CENTER', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'THEAD', 'TBODY', 'TFOOT', 'TR',
  ]);

  const hooks = { loadImageData }; // replaceable (tests)

  // ------------------------------------------------------------------ images
  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  function loadHtmlImage(url) {
    return withTimeout(
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image failed to load'));
        img.src = url;
      }),
      10000,
      'image timed out'
    );
  }

  // Returns { data: Uint8Array, type: 'png' | 'jpg', width, height } for any image src.
  // PNG/JPEG pass through untouched; SVG/GIF/WebP are rasterised to PNG via a canvas.
  async function loadImageData(src) {
    const response = await withTimeout(fetch(src), 10000, 'image fetch timed out');
    let blob = await response.blob();
    let mime = (blob.type || '').split(';')[0].toLowerCase();
    if (/^data:image\/svg/i.test(src) || mime === 'image/svg+xml') {
      blob = new Blob([blob], { type: 'image/svg+xml' });
      mime = 'image/svg+xml';
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadHtmlImage(url);
      const width = img.naturalWidth || 600;
      const height = img.naturalHeight || 400;
      if (mime === 'image/png' || mime === 'image/jpeg') {
        return {
          data: new Uint8Array(await blob.arrayBuffer()),
          type: mime === 'image/png' ? 'png' : 'jpg',
          width,
          height,
        };
      }
      const scale = mime === 'image/svg+xml' ? 2 : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) throw new Error('could not convert image');
      return { data: new Uint8Array(await png.arrayBuffer()), type: 'png', width, height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function imageRun(img, d) {
    try {
      const src = img.currentSrc || img.getAttribute('src') || img.src;
      if (!src) return null;
      const info = await hooks.loadImageData(src);
      let w = Number(img.getAttribute('width')) || info.width;
      let h = info.height * (w / info.width);
      if (w > MAX_IMG_W) { h = (h * MAX_IMG_W) / w; w = MAX_IMG_W; }
      if (h > MAX_IMG_H) { w = (w * MAX_IMG_H) / h; h = MAX_IMG_H; }
      return new d.ImageRun({
        type: info.type,
        data: info.data,
        transformation: { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) },
      });
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------------ inline
  function hex(cssColor) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(cssColor || '');
    if (!m) return undefined;
    return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function textRun(d, text, st) {
    const o = {
      text,
      bold: st.bold || undefined,
      italics: st.italics || undefined,
      strike: st.strike || undefined,
      font: st.font,
      size: st.size,
      color: st.link ? '0969DA' : st.color,
      underline: st.underline || st.link ? {} : undefined,
      superScript: st.sup || undefined,
      subScript: st.sub || undefined,
      highlight: st.highlight || undefined,
    };
    if (st.shading) o.shading = { type: d.ShadingType.CLEAR, fill: st.shading, color: 'auto' };
    return new d.TextRun(o);
  }

  // Step 1: DOM -> simple specs. Step 2 (toRuns): specs -> docx runs, with edge whitespace trimmed.
  async function inlineSpecs(nodes, d, st, out) {
    for (const node of nodes) {
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, ' ');
        if (t) out.push({ kind: 'text', text: t, st });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;

      if (node.classList && node.classList.contains('katex')) {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]');
        out.push({ kind: 'text', text: tex ? tex.textContent : node.textContent, st: Object.assign({}, st, { italics: true, font: 'Cambria Math' }) });
        continue;
      }
      if (tag === 'BR') { out.push({ kind: 'br' }); continue; }
      if (tag === 'IMG') {
        const run = await imageRun(node, d);
        out.push(run ? { kind: 'obj', obj: run } : { kind: 'text', text: '[image' + (node.alt && node.alt !== 'Notebook output image' ? ': ' + node.alt : '') + ']', st });
        continue;
      }
      if (tag === 'INPUT') { out.push({ kind: 'text', text: node.checked ? '☑ ' : '☐ ', st }); continue; }

      let next = st;
      if (tag === 'B' || tag === 'STRONG') next = Object.assign({}, st, { bold: true });
      else if (tag === 'I' || tag === 'EM' || tag === 'CITE') next = Object.assign({}, st, { italics: true });
      else if (tag === 'CODE' || tag === 'KBD' || tag === 'SAMP' || tag === 'TT') next = Object.assign({}, st, { font: 'Consolas', size: st.size || 20, shading: 'F0F2F4' });
      else if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') next = Object.assign({}, st, { strike: true });
      else if (tag === 'U' || tag === 'INS') next = Object.assign({}, st, { underline: true });
      else if (tag === 'SUB') next = Object.assign({}, st, { sub: true });
      else if (tag === 'SUP') next = Object.assign({}, st, { sup: true });
      else if (tag === 'MARK') next = Object.assign({}, st, { highlight: 'yellow' });
      else if (tag === 'SMALL') next = Object.assign({}, st, { size: 18 });

      const href = tag === 'A' ? node.getAttribute('href') || '' : '';
      if (/^https?:\/\//i.test(href)) {
        const inner = [];
        await inlineSpecs(node.childNodes, d, Object.assign({}, next, { link: true }), inner);
        if (inner.length) out.push({ kind: 'link', href, specs: inner });
        continue;
      }

      await inlineSpecs(node.childNodes, d, next, out);
      if (BLOCK.has(tag)) out.push({ kind: 'br' }); // blocks nested in inline contexts (table cells)
    }
    return out;
  }

  function toRuns(specs, d) {
    const trimEdge = (end) => {
      while (specs.length) {
        const s = end ? specs[specs.length - 1] : specs[0];
        if (s.kind === 'br' || (s.kind === 'text' && !s.text.trim())) (end ? specs.pop() : specs.shift());
        else break;
      }
    };
    trimEdge(false);
    trimEdge(true);
    if (specs[0] && specs[0].kind === 'text') specs[0].text = specs[0].text.replace(/^\s+/, '');
    const last = specs[specs.length - 1];
    if (last && last.kind === 'text') last.text = last.text.replace(/\s+$/, '');

    const runs = [];
    specs.forEach((s) => {
      if (s.kind === 'text') runs.push(textRun(d, s.text, s.st));
      else if (s.kind === 'br') runs.push(new d.TextRun({ break: 1 }));
      else if (s.kind === 'obj') runs.push(s.obj);
      else if (s.kind === 'link') {
        const children = toRuns(s.specs, d);
        if (children.length) runs.push(new d.ExternalHyperlink({ children, link: s.href }));
      }
    });
    return runs;
  }

  const inlineRuns = async (nodes, d, st) => toRuns(await inlineSpecs(nodes, d, st || {}, []), d);

  // ------------------------------------------------------------------- code
  const FRAME = (d, color) => {
    const side = { style: d.BorderStyle.SINGLE, size: 4, color: color || 'D0D7DE', space: 4 };
    return { top: side, bottom: side, left: side, right: side };
  };

  // <pre> (code or text output) -> one shaded paragraph, keeping syntax / ANSI colours.
  function codeBlock(pre, d, shade) {
    const runs = [];
    const textNodes = [];
    const collect = (n) => {
      if (n.nodeType === 3) textNodes.push(n);
      else n.childNodes.forEach(collect);
    };
    collect(pre);
    const lastText = textNodes[textNodes.length - 1];
    let lineBreakPending = false;

    const walk = (node, st) => {
      if (node.nodeType === 3) {
        let value = node.nodeValue.replace(/\t/g, '    ');
        if (node === lastText) value = value.replace(/\n+$/, '');
        value.split('\n').forEach((part, i) => {
          const o = { text: part, font: 'Consolas', size: 18, color: st.color, bold: st.bold || undefined, underline: st.underline ? {} : undefined };
          if (i > 0 || lineBreakPending) o.break = 1;
          lineBreakPending = false;
          runs.push(new d.TextRun(o));
        });
      } else if (node.nodeType === 1) {
        const cs = global.getComputedStyle(node);
        const next = {
          color: hex(cs.color) || st.color,
          bold: Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold',
          underline: /underline/.test(cs.textDecorationLine || ''),
        };
        node.childNodes.forEach((c) => walk(c, next));
      }
    };
    walk(pre, { color: '24292E' });
    if (!runs.length) runs.push(new d.TextRun({ text: '', font: 'Consolas', size: 18 }));

    return new d.Paragraph({
      children: runs,
      shading: shade ? { type: d.ShadingType.CLEAR, fill: shade, color: 'auto' } : undefined,
      border: FRAME(d),
      spacing: { before: 40, after: 160, line: 252 },
    });
  }

  const labelPara = (d, text) =>
    new d.Paragraph({
      children: [new d.TextRun({ text, font: 'Consolas', size: 16, color: '6E7781' })],
      spacing: { before: 60, after: 20 },
      keepNext: true,
    });

  // ------------------------------------------------------------------ blocks
  const HEADINGS = (d) => ({
    H1: d.HeadingLevel.HEADING_1, H2: d.HeadingLevel.HEADING_2, H3: d.HeadingLevel.HEADING_3,
    H4: d.HeadingLevel.HEADING_4, H5: d.HeadingLevel.HEADING_5, H6: d.HeadingLevel.HEADING_6,
  });

  function paragraph(d, children, o, extra) {
    return new d.Paragraph(
      Object.assign(
        {
          children,
          spacing: { after: 120 },
          indent: o.indent ? { left: o.indent } : undefined,
          border: o.quote ? { left: { style: d.BorderStyle.SINGLE, size: 12, color: 'D0D7DE', space: 8 } } : undefined,
        },
        extra || {}
      )
    );
  }

  async function tableBlock(tableEl, ctx) {
    const d = ctx.d;
    const rows = Array.from(tableEl.querySelectorAll('tr')).filter((tr) => tr.closest('table') === tableEl);
    if (!rows.length) return null;
    const cellsOf = (tr) => Array.from(tr.children).filter((c) => /^(TD|TH)$/.test(c.tagName));
    const span = (c) => Math.max(1, parseInt(c.getAttribute('colspan'), 10) || 1);
    const ncols = Math.max(1, ...rows.map((tr) => cellsOf(tr).reduce((n, c) => n + span(c), 0)));
    const colW = Math.floor(TABLE_W / ncols);
    const line = { style: d.BorderStyle.SINGLE, size: 4, color: 'D0D7DE' };

    const trs = [];
    for (const tr of rows) {
      const tcs = [];
      for (const cell of cellsOf(tr)) {
        const isHead = cell.tagName === 'TH';
        const runs = await inlineRuns(cell.childNodes, d, { bold: isHead, size: 18 });
        const align = global.getComputedStyle(cell).textAlign;
        tcs.push(
          new d.TableCell({
            columnSpan: span(cell) > 1 ? span(cell) : undefined,
            width: { size: colW * span(cell), type: d.WidthType.DXA },
            shading: isHead ? { type: d.ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } : undefined,
            margins: { top: 40, bottom: 40, left: 80, right: 80 },
            children: [
              new d.Paragraph({
                children: runs.length ? runs : [new d.TextRun('')],
                alignment: align === 'right' || align === 'end' ? d.AlignmentType.RIGHT : align === 'center' ? d.AlignmentType.CENTER : undefined,
              }),
            ],
          })
        );
      }
      if (tcs.length) trs.push(new d.TableRow({ children: tcs, tableHeader: !!tr.closest('thead') }));
    }
    if (!trs.length) return null;
    return new d.Table({
      rows: trs,
      columnWidths: new Array(ncols).fill(colW),
      width: { size: colW * ncols, type: d.WidthType.DXA },
      borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
    });
  }

  async function listBlocks(listEl, ctx, o, level) {
    const d = ctx.d;
    const out = [];
    const ordered = listEl.tagName === 'OL';
    const instance = ordered ? ++ctx.ol : 0;
    const lv = Math.min(level, 3);

    for (const li of Array.from(listEl.children)) {
      if (li.tagName !== 'LI') continue;
      let buffer = [];
      let first = true;
      const flush = async () => {
        const runs = await inlineRuns(buffer, d, {});
        buffer = [];
        if (!runs.length && !first) return;
        out.push(
          new d.Paragraph(
            first
              ? Object.assign(
                  { children: runs, spacing: { after: 60 } },
                  ordered ? { numbering: { reference: 'ol', level: lv, instance } } : { bullet: { level: lv } }
                )
              : { children: runs, indent: { left: 720 + lv * 360 }, spacing: { after: 60 } }
          )
        );
        first = false;
      };
      for (const n of Array.from(li.childNodes)) {
        const tag = n.nodeType === 1 ? n.tagName.toUpperCase() : '';
        if (tag === 'UL' || tag === 'OL') {
          if (buffer.length || first) await flush();
          out.push(...(await listBlocks(n, ctx, o, level + 1)));
        } else if (tag === 'P') {
          if (buffer.length) await flush();
          buffer = Array.from(n.childNodes);
          await flush();
        } else if (tag && BLOCK.has(tag)) {
          if (buffer.length || first) await flush();
          out.push(...(await blockElement(n, ctx, Object.assign({}, o, { indent: 720 + lv * 360 }))));
        } else {
          buffer.push(n);
        }
      }
      await flush();
    }
    return out;
  }

  async function blockElement(node, ctx, o) {
    const d = ctx.d;
    const tag = node.tagName.toUpperCase();
    if (/^H[1-6]$/.test(tag)) {
      const runs = await inlineRuns(node.childNodes, d, {});
      return runs.length ? [paragraph(d, runs, o, { heading: HEADINGS(d)[tag], spacing: { before: 200, after: 100 } })] : [];
    }
    if (tag === 'P') {
      const runs = await inlineRuns(node.childNodes, d, {});
      if (!runs.length) return [];
      const onlyMath = node.children.length === 1 && node.firstElementChild.classList.contains('katex-display') && !node.textContent.replace(node.firstElementChild.textContent, '').trim();
      return [paragraph(d, runs, o, onlyMath ? { alignment: d.AlignmentType.CENTER } : undefined)];
    }
    if (tag === 'UL' || tag === 'OL') return listBlocks(node, ctx, o, 0);
    if (tag === 'PRE') return [codeBlock(node, d, 'F6F8FA')];
    if (tag === 'BLOCKQUOTE') return blocks(node, ctx, Object.assign({}, o, { indent: (o.indent || 0) + 360, quote: true }));
    if (tag === 'TABLE') {
      const t = await tableBlock(node, ctx);
      return t ? [t, new d.Paragraph({ spacing: { after: 120 } })] : [];
    }
    if (tag === 'HR') return [new d.Paragraph({ thematicBreak: true, spacing: { after: 120 } })];
    return blocks(node, ctx, o); // DIV, SECTION, ...: look inside
  }

  async function blocks(parent, ctx, o) {
    const d = ctx.d;
    const out = [];
    let inline = [];
    const flush = async () => {
      const buf = inline;
      inline = [];
      if (buf.every((n) => n.nodeType === 3 && !n.nodeValue.trim())) return;
      const runs = await inlineRuns(buf, d, {});
      if (runs.length) out.push(paragraph(d, runs, o));
    };
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) { inline.push(node); continue; }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (!BLOCK.has(tag)) { inline.push(node); continue; }
      await flush();
      out.push(...(await blockElement(node, ctx, o)));
    }
    await flush();
    return out;
  }

  // ------------------------------------------------------------------- cells
  async function outputBlocks(row, ctx) {
    const d = ctx.d;
    const out = [];
    const body = row.querySelector('.out-body');
    const el = body && body.firstElementChild;
    if (!el) return out;
    const promptText = (row.querySelector('.prompt') || {}).textContent || '';
    if (ctx.opts.prompts && promptText.trim()) out.push(labelPara(d, promptText.trim()));

    if (el.tagName === 'PRE') {
      const bad = el.classList.contains('stderr') || el.classList.contains('out-error');
      out.push(codeBlock(el, d, bad ? 'FFE3E3' : null));
    } else if (el.classList.contains('out-html')) {
      out.push(...(await blocks(el.shadowRoot || el, ctx, {})));
    } else if (el.classList.contains('out-note')) {
      out.push(new d.Paragraph({ children: [new d.TextRun({ text: el.textContent, italics: true, color: '6E7781' })], spacing: { after: 120 } }));
    } else {
      out.push(...(await blocks(el, ctx, {}))); // .out-image, .markdown
    }
    return out;
  }

  async function cellBlocks(cell, ctx) {
    const d = ctx.d;
    const out = [];
    if (cell.classList.contains('markdown-cell')) {
      const md = cell.querySelector('.markdown');
      return md ? blocks(md, ctx, {}) : out;
    }
    if (cell.classList.contains('raw-cell')) {
      const pre = cell.querySelector('pre.raw');
      if (pre) out.push(codeBlock(pre, d, 'F6F8FA'));
      return out;
    }
    if (cell.classList.contains('code-cell')) {
      if (ctx.opts.code) {
        const row = cell.querySelector('.code-input');
        const pre = row && row.querySelector('pre.code');
        if (pre) {
          if (ctx.opts.prompts) out.push(labelPara(d, (row.querySelector('.prompt') || {}).textContent || ''));
          out.push(codeBlock(pre, d, 'F6F8FA'));
        }
      }
      if (ctx.opts.outputs) {
        for (const row of cell.querySelectorAll('.outputs > .output')) out.push(...(await outputBlocks(row, ctx)));
      }
    }
    return out;
  }

  // opts: { code, outputs, prompts } - same switches as the toolbar checkboxes.
  async function exportDocx(container, opts) {
    const d = global.docx;
    if (!d) throw new Error('The Word library did not load.');
    const ctx = { d, opts: Object.assign({ code: true, outputs: true, prompts: true }, opts), ol: 0 };

    const children = [];
    for (const wrap of Array.from(container.children)) {
      const cell = wrap.querySelector(':scope > .cell');
      if (cell) children.push(...(await cellBlocks(cell, ctx)));
    }
    if (!children.length) children.push(new d.Paragraph(''));

    const doc = new d.Document({
      creator: 'IPYNB Viewer',
      styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
      numbering: {
        config: [
          {
            reference: 'ol',
            levels: [0, 1, 2, 3].map((l) => ({
              level: l,
              format: l === 1 ? d.LevelFormat.LOWER_LETTER : l === 2 ? d.LevelFormat.LOWER_ROMAN : d.LevelFormat.DECIMAL,
              text: '%' + (l + 1) + '.',
              alignment: d.AlignmentType.START,
              style: { paragraph: { indent: { left: 720 + l * 360, hanging: 360 } } },
            })),
          },
        ],
      },
      sections: [{ properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }],
    });
    return d.Packer.toBlob(doc);
  }

  global.DocxExport = { exportDocx, hooks };
})(window);
