// AGY code tools: two toggles in every chat code block's header, beside
// "Copy code": Wrap lines (the app's default; off scrolls long lines
// sideways) and Line numbers. One choice for all code blocks, kept in the
// agy-code cookie like the theme, and applied as attributes on <html>.
//
// The buttons are the app's own header buttons (its classes, a Material
// Symbols glyph at 14px; Outlined like the app's icons, md3e.css swaps in
// Rounded), so each theme styles them as it styles Copy code. Line numbers
// are a CSS counter on the app's .code-line rows (::before): nothing is
// added to the rows React renders, and the numbers stay out of selections
// and of Copy code. Themes color them through --agy-lineno.
function agyCodeTools() {
  const COOKIE = 'agy-code';
  const COPY = 'button[aria-label="Copy code"], button[aria-label="Copied"]';
  const BUTTON_CLASSES = 'appearance-none bg-transparent border-0 p-0 cursor-pointer text-secondary-foreground hover:text-foreground transition-colors';
  const TOOLS = [
    { key: 'wrap', label: 'Wrap lines', on: (p) => !p.nowrap,   // wrap_text
      icon: 'M570 -192 432 -330 570 -468 621 -417 569 -366H672Q702 -366 723 -387Q744 -408 744 -438Q744 -468 723 -489Q702 -510 672 -510H192V-582H672Q732 -582 774 -540Q816 -498 816 -438Q816 -378 774 -336Q732 -294 672 -294H570L621 -243ZM192 -294V-366H384V-294ZM192 -726V-798H768V-726Z' },
    { key: 'lines', label: 'Line numbers', on: (p) => p.lines,   // format_list_numbered
      icon: 'M144 -144V-192H240V-216H192V-264H240V-288H144V-336H264Q274 -336 281 -329Q288 -322 288 -312V-264Q288 -254 281 -247Q274 -240 264 -240Q274 -240 281 -233Q288 -226 288 -216V-168Q288 -158 281 -151Q274 -144 264 -144ZM144 -384V-480Q144 -490 151 -497Q158 -504 168 -504H240V-528H144V-576H264Q274 -576 281 -569Q288 -562 288 -552V-480Q288 -470 281 -463Q274 -456 264 -456H192V-432H288V-384ZM192 -624V-768H144V-816H240V-624ZM360 -240V-312H816V-240ZM360 -444V-516H816V-444ZM360 -648V-720H816V-648Z' },
  ];

  const style = document.createElement('style');
  style.id = 'agy-code-css';
  style.textContent = `
    .agy-code-tool { display: inline-flex; align-items: center; justify-content: center; }
    .agy-code-tool[aria-pressed="true"] { color: var(--foreground); }
    :root[data-agy-code-lines] .agy-code { counter-reset: agy-line; }
    :root[data-agy-code-lines] .agy-code .code-line { counter-increment: agy-line; }
    :root[data-agy-code-lines] .agy-code .code-line::before {
      content: counter(agy-line);
      flex: none; min-width: 2ch; margin-right: 16px; text-align: right;
      color: var(--agy-lineno, var(--editor-line-number-foreground, rgb(128 128 128 / 0.5)));
      font-variant-numeric: tabular-nums; user-select: none;
    }
    :root[data-agy-code-nowrap] .agy-code { white-space: pre; word-break: normal; }
    :root[data-agy-code-nowrap] .agy-code > :last-child { overflow-x: auto; }
    :root[data-agy-code-nowrap] .agy-code .line-content { white-space: pre !important; word-break: normal; }   /* inline pre-wrap */`;
  (document.head || document.documentElement).appendChild(style);

  // ---- The choice ---------------------------------------------------------------
  const readPref = () => {
    try {
      const flags = ((document.cookie.match(/(?:^|;\s*)agy-code=([^;]*)/) || [])[1] || '').split('.');
      return { nowrap: flags.includes('nowrap'), lines: flags.includes('lines') };
    } catch {
      return { nowrap: false, lines: false };
    }
  };
  let pref = readPref();
  function apply() {
    const root = document.documentElement;
    root.toggleAttribute('data-agy-code-nowrap', pref.nowrap);
    root.toggleAttribute('data-agy-code-lines', pref.lines);
    for (const b of document.querySelectorAll('.agy-code-tool')) {
      const tool = TOOLS.find((t) => t.key === b.dataset.tool);
      b.setAttribute('aria-pressed', String(tool.on(pref)));
    }
  }
  function toggle(key) {
    if (key === 'wrap') pref.nowrap = !pref.nowrap;
    else pref.lines = !pref.lines;
    const value = [pref.nowrap && 'nowrap', pref.lines && 'lines'].filter(Boolean).join('.');
    try {
      document.cookie = `${COOKIE}=${value}; Max-Age=31536000; Path=/; SameSite=Strict; Secure`;
    } catch {}
    apply();
  }

  // ---- The buttons --------------------------------------------------------------
  // Header markup: block > [header > [language, buttons…], body]
  function decorate(copy) {
    const group = copy.parentElement, header = group?.parentElement, block = header?.parentElement;
    if (!block || !header.nextElementSibling || group.querySelector(':scope > .agy-code-tool')) return;
    block.classList.add('agy-code');
    for (const tool of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `${BUTTON_CLASSES} agy-code-tool`;
      b.dataset.tool = tool.key;
      b.setAttribute('aria-label', tool.label);
      b.setAttribute('aria-pressed', String(tool.on(pref)));
      b.innerHTML = `<svg viewBox="0 -960 960 960" fill="currentColor" class="h-3.5 w-3.5" aria-hidden="true"><path d="${tool.icon}"></path></svg>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(tool.key);
      });
      group.insertBefore(b, copy);
    }
  }

  // Code blocks mount with their message: look inside what the transcript
  // adds, and rescan it every 2s for a replaced viewport
  let viewport = null, observer = null;
  function onMutations(records) {
    try {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || n.classList.contains('agy-code-tool')) continue;
          if (n.matches(COPY)) decorate(n);
          else n.querySelectorAll(COPY).forEach(decorate);
        }
      }
    } catch {
      // app internals changed: leave the code blocks as they are
    }
  }
  function scan() {
    if (document.hidden) return;
    const vp = document.querySelector('[data-testid="autoscroll-viewport"]');
    if (vp !== viewport) {
      observer?.disconnect();
      viewport = vp;
      if (vp) {
        observer = new MutationObserver(onMutations);
        observer.observe(vp, { childList: true, subtree: true });
      }
    }
    viewport?.querySelectorAll(COPY).forEach(decorate);
  }

  apply();
  const timer = setInterval(scan, 2000);
  scan();

  return {
    dispose() {
      clearInterval(timer);
      observer?.disconnect();
      document.querySelectorAll('.agy-code-tool').forEach((b) => b.remove());
      document.querySelectorAll('.agy-code').forEach((b) => b.classList.remove('agy-code'));
      document.documentElement.removeAttribute('data-agy-code-nowrap');
      document.documentElement.removeAttribute('data-agy-code-lines');
      style.remove();
    },
  };
}
