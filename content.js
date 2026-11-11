// Runs on file:///...ipynb pages. When Chrome shows the notebook as raw text/JSON,
// this covers the page with the viewer (an extension page in a full-screen iframe)
// and hands it the file contents. The tab's URL stays the same.
(() => {
  'use strict';

  if (window.top !== window) return;
  if (document.getElementById('__ipynb_viewer_frame')) return;

  // If the browser already rendered it as a real HTML page, leave it alone.
  const contentType = (document.contentType || '').toLowerCase();
  if (/html|xml/.test(contentType)) return;

  const pre = document.querySelector('body > pre');
  const text = ((pre || document.body) && (pre || document.body).textContent) || '';

  // Cheap sniff; the viewer does the real parsing and reports errors.
  if (!/"(cells|worksheets)"\s*:\s*\[/.test(text)) return;

  const extOrigin = new URL(chrome.runtime.getURL('/')).origin;

  let name = 'notebook.ipynb';
  try {
    name = decodeURIComponent(location.pathname.split('/').pop() || name);
  } catch (e) {
    name = location.pathname.split('/').pop() || name;
  }

  const frame = document.createElement('iframe');
  frame.id = '__ipynb_viewer_frame';
  frame.src = chrome.runtime.getURL('viewer.html');
  Object.assign(frame.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    border: '0',
    margin: '0',
    zIndex: '2147483647',
    background: '#fff',
  });

  // The viewer announces itself when it is ready; only our extension's origin is accepted.
  window.addEventListener('message', (event) => {
    if (event.origin !== extOrigin) return;
    if (!event.data || event.data.type !== 'ipynb-viewer-ready') return;
    frame.contentWindow.postMessage(
      { type: 'ipynb-data', text, name, url: location.href },
      extOrigin
    );
  });

  frame.addEventListener('load', () => frame.focus());

  document.documentElement.style.overflow = 'hidden';
  document.documentElement.style.background = '#fff';
  if (document.body) document.body.style.display = 'none';
  document.documentElement.appendChild(frame);
})();
