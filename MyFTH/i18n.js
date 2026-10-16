/* =====================================================================
   MyFTH — language switch (Thai default / English)
   - the app is written in English; in Thai mode every text on the page (text nodes and the attributes placeholder / title / aria-label / alt / data-l)
     is translated with the dictionary in i18n-th.js, also for content the app builds later (a MutationObserver translates what is added or changed)
   - dictionary keys are the exact English texts; {0} {1} … stand for values filled in at run time ("2 bills" -> "{0} bills"), {s} = an optional "s"
   - the chosen language is remembered in this browser (localStorage) and, after sign-in, in the account itself (user_metadata.lang) so it follows the person
   - add data-notr to an element to keep its whole content untouched (the printed Payment advice, map widgets)
   - native dialogs (confirm / prompt / alert) are translated too
   ===================================================================== */
(function () {
  const KEY = 'fth_lang', DEFAULT = 'th';
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-l'];
  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, svg: 1, SVG: 1 };
  const MONTHS = { January: 1, February: 1, March: 1, April: 1, May: 1, June: 1, July: 1, August: 1, September: 1, October: 1, November: 1, December: 1 };
  const norm = s => String(s).replace(/\s+/g, ' ').trim();

  /* ---------- dictionary: exact texts + patterns ---------- */
  const exact = new Map(), pats = [];
  function esc(s) { return s.replace(/[.*+?^$|()[\]\\]/g, '\\$&'); }
  function compile(dict) {
    for (const [en, th] of Object.entries(dict)) {
      const key = norm(en);
      if (!/\{(\d+|s)\}/.test(key)) { exact.set(key, th); continue; }
      const parts = key.split(/(\{\d+\}|\{s\})/), lit = parts.filter((_, i) => i % 2 === 0).join('').length;
      const re = new RegExp('^' + parts.map((p, i) => i % 2 === 0 ? esc(p) : (p === '{s}' ? 's?' : '(.+?)')).join('') + '$');
      pats.push({ re, th, lit });
    }
    pats.sort((a, b) => b.lit - a.lit);                 // the most specific pattern first
  }
  compile(window.I18N_TH || {});

  let LANG = DEFAULT;
  function exactOnly(s) { const v = exact.get(norm(s)); return v === undefined ? null : v; }
  function tr(s) {
    if (LANG !== 'th' || s == null) return s;
    const str = String(s), k = norm(str);
    if (!k || !/[A-Za-z]/.test(k)) return str;
    let out = exact.get(k);
    if (out === undefined) {
      for (const p of pats) {
        const m = p.re.exec(k); if (!m) continue;
        out = p.th.replace(/\{(\d+)\}/g, (_, i) => { const g = m[+i + 1]; const t = exactOnly(g); return t !== null ? t : g; });   // a captured value may itself be a known text
        break;
      }
    }
    if (out === undefined) return str;
    const lead = /^\s*/.exec(str)[0], trail = /\s*$/.exec(str)[0];
    return lead + out + trail;
  }

  /* ---------- the page ---------- */
  const skipped = el => !!(el && el.closest && el.closest('[data-notr]'));
  function xText(node) {
    const p = node.parentNode;
    if (!p || SKIP[p.nodeName] || skipped(p)) return;
    const cur = node.nodeValue;
    if (node.__tr === cur) return;                                   // our own output
    if (!/[A-Za-z]/.test(cur)) return;
    if (p.nodeName !== 'OPTION' && MONTHS[norm(cur)]) return;       // a person called May / June is not a month
    const th = tr(cur);
    if (th !== cur) { node.__en = cur; node.__tr = th; node.nodeValue = th; }
  }
  function xAttr(el, name) {
    const cur = el.getAttribute(name);
    if (cur == null || skipped(el)) return;
    if (el.__attrTr && el.__attrTr[name] === cur) return;
    if (!/[A-Za-z]/.test(cur)) return;
    const th = tr(cur);
    if (th !== cur) {
      (el.__attrEn || (el.__attrEn = {}))[name] = cur; (el.__attrTr || (el.__attrTr = {}))[name] = th;
      el.setAttribute(name, th);
    }
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return xText(root);
    if (root.nodeType !== 1 || SKIP[root.nodeName] || skipped(root)) return;
    for (const a of ATTRS) if (root.hasAttribute(a)) xAttr(root, a);
    for (let c = root.firstChild; c; c = c.nextSibling) walk(c);
  }
  function restore(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.__en !== undefined && n.nodeValue === n.__tr) { n.nodeValue = n.__en; n.__tr = undefined; n.__en = undefined; }
    root.querySelectorAll('*').forEach(el => {
      if (!el.__attrEn) return;
      for (const a in el.__attrEn) if (el.getAttribute(a) === el.__attrTr[a]) el.setAttribute(a, el.__attrEn[a]);
      el.__attrEn = el.__attrTr = undefined;
    });
  }

  let obs = null;
  function observe() {
    if (obs || !window.MutationObserver) return;
    obs = new MutationObserver(list => {
      if (LANG !== 'th') return;
      for (const m of list) {
        if (m.type === 'childList') m.addedNodes.forEach(walk);
        else if (m.type === 'characterData') xText(m.target);
        else if (m.type === 'attributes') xAttr(m.target, m.attributeName);
      }
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function paint() {
    document.documentElement.lang = LANG;
    if (LANG === 'th') walk(document.documentElement); else restore(document.documentElement);
    document.querySelectorAll('[data-lang]').forEach(b => { const on = b.dataset.lang === LANG; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); });
  }

  function set(l, opt) {
    if (l !== 'th' && l !== 'en') return;
    LANG = l;
    if (!opt || opt.save !== false) { try { localStorage.setItem(KEY, l); } catch { /* private window */ } }
    paint();
  }
  function saved() { try { const v = localStorage.getItem(KEY); if (v === 'th' || v === 'en') return v; } catch { /* ignore */ } return DEFAULT; }

  /* ---------- native dialogs ---------- */
  const _confirm = window.confirm, _prompt = window.prompt, _alert = window.alert;
  window.confirm = m => _confirm.call(window, tr(m));
  window.prompt = (m, d) => _prompt.call(window, tr(m), d);
  window.alert = m => _alert.call(window, tr(m));

  /* ---------- start ---------- */
  LANG = saved();
  document.documentElement.lang = LANG;
  observe();
  function ready() {
    document.querySelectorAll('[data-lang]').forEach(b => { b.onclick = () => { set(b.dataset.lang); if (api.onUserChoice) api.onUserChoice(b.dataset.lang); }; });
    paint();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();

  const api = {
    tr, set, get lang() { return LANG; },
    onUserChoice: null,           // set by the app: called when the person picks a language (saves it in the account)
    _count: () => ({ exact: exact.size, patterns: pats.length }),
  };
  window.FTHLang = api;
})();
