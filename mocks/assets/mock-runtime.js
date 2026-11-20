/* Tiny runtime so the design mocks run as plain HTML files.
   Supports what the mocks use: {{ holes }}, <sc-for>, <sc-if>, <helmet>,
   on* event bindings and a DCLogic class with setState. Mock-only code. */
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, next);
      schedule();
    }
    forceUpdate() { schedule(); }
  }
  window.DCLogic = DCLogic;

  let template = null, instance = null, mount = null, queued = false;
  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  function lookup(scope, path) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
  }
  function value(str, scope) {
    const m = str.match(WHOLE);
    if (m) return lookup(scope, m[1]);
    return str.replace(HOLE, (_, p) => { const v = lookup(scope, p); return v == null ? '' : String(v); });
  }

  function build(node, scope, out) {
    if (node.nodeType === 3) { const v = value(node.nodeValue, scope); out.appendChild(document.createTextNode(v == null ? '' : String(v))); return; }
    if (node.nodeType !== 1) return;
    const tag = node.localName;
    if (tag === 'helmet') return;
    if (tag === 'sc-for') {
      const list = value(node.getAttribute('list'), scope) || [];
      const as = node.getAttribute('as') || 'item';
      list.forEach((item, i) => {
        const s = Object.create(scope); s[as] = item; s.$index = i;
        node.childNodes.forEach((c) => build(c, s, out));
      });
      return;
    }
    if (tag === 'sc-if') {
      if (value(node.getAttribute('value'), scope)) node.childNodes.forEach((c) => build(c, scope, out));
      return;
    }
    const el = node.namespaceURI === 'http://www.w3.org/1999/xhtml'
      ? document.createElement(node.localName)
      : document.createElementNS(node.namespaceURI, node.localName);
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name;
      if (name.startsWith('hint-')) continue;
      const v = value(attr.value, scope);
      if (/^on[a-z]+$/.test(name) && typeof v === 'function') { el.addEventListener(name.slice(2), v); continue; }
      if (name === 'value' && 'value' in el) { el.value = v == null ? '' : String(v); continue; }
      if (v === false || v == null) continue;
      el.setAttribute(name, v === true ? '' : String(v));
    }
    node.childNodes.forEach((c) => build(c, scope, el));
    out.appendChild(el);
  }

  function render() {
    queued = false;
    const active = document.activeElement;
    const focusId = active && active.id;
    const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const frag = document.createDocumentFragment();
    const scope = instance.renderVals();
    template.childNodes.forEach((c) => build(c, scope, frag));
    mount.replaceChildren(frag);
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) {} }
    }
  }
  function schedule() { if (!queued && instance) { queued = true; Promise.resolve().then(render); } }

  document.addEventListener('DOMContentLoaded', () => {
    const xdc = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    template = xdc;
    xdc.remove();
    const helmet = xdc.querySelector('helmet');
    if (helmet) Array.from(helmet.children).forEach((c) => document.head.appendChild(c.cloneNode(true)));
    const props = {};
    try {
      const decl = JSON.parse(script.getAttribute('data-props') || '{}');
      Object.keys(decl).forEach((k) => { if (k[0] !== '$' && decl[k] && 'default' in decl[k]) props[k] = decl[k].default; });
    } catch (e) {}
    const Component = new Function('DCLogic', script.textContent + '\nreturn Component;')(DCLogic);
    instance = new Component(props);
    mount = document.createElement('div');
    document.body.prepend(mount);
    render();
  });
})();
