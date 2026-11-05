// AGY theme host: applies one theme from a bundle, remembers the choice, and
// adds a "Theme" menu to the title bar (Ctrl+Shift+F12 cycles themes; not
// Ctrl+Alt+<letter>: Windows reads Ctrl+Alt as AltGr, and on the Turkish Q
// layout AltGr+T types "₺"). In MD3E the title bar's menus and Theme fold
// into one app menu button (the package's <md-menu>).
//
// Context-free on purpose: it only touches the DOM and document.cookie, so it
// runs the same when inject.mjs evaluates it in the page and when a preload
// calls it from Electron's isolated world.
function agyThemeHost(bundle) {
  // Bump when this file's code changes. A same-version host only takes the
  // new bundle; an older one would keep running its old code through
  // update(), so it is disposed and replaced (same task: no flash).
  const HOST_VERSION = 20;   // also bump when a module it starts (context-card, turn-tokens, loading-/progress-indicator, code-tools) changes: the host starts them once
  const existing = window.__agyThemeHost;
  if (existing?.version === HOST_VERSION) return existing.update(bundle);
  existing?.dispose();

  const COOKIE = 'agy-theme';
  const readChoice = () => {
    try {
      return (document.cookie.match(/(?:^|;\s*)agy-theme=([^;]+)/) || [])[1];
    } catch {
      return null;
    }
  };
  const saveChoice = (key) => {
    try {
      document.cookie = `${COOKIE}=${key}; Max-Age=31536000; Path=/; SameSite=Strict; Secure`;
    } catch {}
  };

  let options = new Map();
  let current = null;

  // Fonts come as bytes and are registered with the FontFace API: no
  // network fetch, no CSP font-src, and no 300 KB data URI in the CSS text.
  const loadedFonts = new Set();
  function ensureFonts() {
    for (const f of bundle.fonts?.[current.theme] ?? []) {
      const key = `${f.family}|${f.weight}|${f.stretch}`;
      if (loadedFonts.has(key) || !document.fonts) continue;
      loadedFonts.add(key);
      try {
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        const face = new FontFace(f.family, bytes.buffer, { weight: f.weight, stretch: f.stretch, style: 'normal', display: 'swap' });
        document.fonts.add(face);
        face.load().catch(() => {});
      } catch {
        // a theme without its font still works on the fallback stack
      }
    }
  }

  // Light or dark follows the app's own setting (System / Light / Dark),
  // which it marks on <body> (theme-light / theme-dark). The themes' token
  // blocks live on :root, so the mode is mirrored there as data-agy-mode.
  // No mark yet (startup) counts as dark, the themes' default.
  function readMode() {
    const body = document.body;
    if (!body) return 'dark';
    const light = body.classList.contains('theme-light')
      || (body.classList.contains('theme-standalone') && !body.classList.contains('dark'));
    return light ? 'light' : 'dark';
  }
  function syncMode() {
    const root = document.documentElement;
    const mode = readMode();
    if (!root || root.getAttribute('data-agy-mode') === mode) return false;
    root.setAttribute('data-agy-mode', mode);
    return true;
  }
  const modeObserver = new MutationObserver(() => {
    watchMode();
    if (!syncMode()) return;
    announceTheme();
    // The app re-sends its own (mis-parsed) overlay color on theme changes
    requestAnimationFrame(() => syncTitleBarOverlay());
    setTimeout(syncTitleBarOverlay, 300);
  });
  // The vendored md3e-web components cache their colors; the package's own
  // window event makes them read the tokens again (the app uses no such event)
  const announceTheme = () => window.dispatchEvent(new Event('theme-change'));
  let modeTarget = null;
  function watchMode() {
    const target = document.body ?? document.documentElement;
    if (!target || target === modeTarget) return;
    modeObserver.disconnect();
    modeTarget = target;
    if (target === document.body) modeObserver.observe(target, { attributes: true, attributeFilter: ['class'] });
    else modeObserver.observe(target, { childList: true });   // until <body> exists
  }

  function apply() {
    const root = document.documentElement;
    if (!root || !current) return;
    ensureFonts();
    watchMode();
    syncMode();
    if (current.theme === 'antigravity') {
      root.removeAttribute('data-agy-theme');
      root.removeAttribute('data-agy-seed');
      const style = document.getElementById('agy-theme-css');
      if (style) style.textContent = '';
    } else {
      root.setAttribute('data-agy-theme', current.theme);
      if (current.seed) root.setAttribute('data-agy-seed', current.seed);
      else root.removeAttribute('data-agy-seed');
      let style = document.getElementById('agy-theme-css');
      if (!style) {
        style = document.createElement('style');
        style.id = 'agy-theme-css';
      }
      const css = bundle.themes[current.theme] || '';
      if (style.textContent !== css) style.textContent = css;
      // Last in <head> so equal-specificity ties go to the theme
      const parent = document.head || root;
      if (style.parentNode !== parent || style !== parent.lastElementChild) parent.appendChild(style);
    }
    announceTheme();
    renderMenu();
    if (appMenuBuilt) buildAppMenu(false);
    if (current.theme !== 'md3e') closeAppMenu();
    // Themes change the title bar's padding and font: re-anchor the menu
    requestAnimationFrame(() => { position(); syncTitleBarOverlay(); });
  }

  // The window controls (minimize/maximize/close) are drawn by Windows in
  // the color the app passes to setTitleBarOverlay. The app derives it from
  // --sidebar by taking the first three numbers of the computed color, which
  // turns a non-RGB serialization such as lch(12% 4 190) into rgb(12, 4, 190):
  // the bright blue behind the close button. Resolve through a canvas, which
  // always reads back sRGB bytes. electronNative is frozen (contextBridge),
  // so it cannot be wrapped; re-assert on focus instead.
  let overlayCanvas = null;
  function cssHex(varName) {
    const probe = document.createElement('div');
    probe.style.color = `var(${varName})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    overlayCanvas ??= document.createElement('canvas');
    overlayCanvas.width = overlayCanvas.height = 1;
    const ctx = overlayCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  }
  function syncTitleBarOverlay() {
    if (!document.body || !window.electronNative?.setTitleBarOverlay) return;
    try {
      window.electronNative.setTitleBarOverlay({ color: cssHex('--sidebar'), symbolColor: cssHex('--foreground') });
    } catch {
      // older shells without the overlay API
    }
  }

  function select(key) {
    const next = options.get(key);
    if (!next) return;
    current = next;
    saveChoice(key);
    apply();
  }

  function update(nextBundle) {
    bundle = nextBundle;
    options = new Map(bundle.options.map((o) => [o.key, o]));
    current = options.get(readChoice()) || options.get(current?.key) || options.get(bundle.default) || bundle.options[0];
    apply();
    return api;
  }

  // ---- Title bar menu (shadow DOM on <body>, outside React's tree) --------
  let hostEl = null, shadow = null, trigger = null, menu = null, retry = 0;
  let appMenu = null, appTrigger = null;

  function mount() {
    if (hostEl || !document.body) return;
    hostEl = document.createElement('div');
    hostEl.id = 'agy-theme-switcher';
    hostEl.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483000;display:none;';
    shadow = hostEl.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: var(--font-sans, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif);
          font-size: 13px;
        }
        button, [role="menuitemradio"] { -webkit-app-region: no-drag; }
        .trigger {
          display: flex; align-items: center; padding: 0 8px; border: 0; border-radius: 6px;
          background: transparent; color: var(--muted-foreground, #999); font: inherit; cursor: default;
        }
        .trigger:hover, .trigger[aria-expanded="true"] { background: var(--secondary, #333); color: var(--foreground, #eee); }
        .menu {
          position: absolute; top: calc(100% + 6px); left: 0; min-width: 230px; padding: 6px;
          border: 1px solid var(--border, #333); border-radius: 12px;
          background: var(--card, #1c1c1f); color: var(--foreground, #eee);
          box-shadow: 0 16px 40px -12px rgb(0 0 0 / 0.75);
        }
        .menu[hidden] { display: none; }
        [role="menuitemradio"], .menu-sub-trigger {
          display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px;
          border-radius: 8px; font: inherit; color: inherit; cursor: default; outline: none;
        }
        [role="menuitemradio"]:hover, [role="menuitemradio"]:focus-visible,
        .menu-sub-trigger:hover, .menu-sub-wrapper:hover .menu-sub-trigger { background: var(--secondary, #333); }
        .swatch { width: 12px; height: 12px; border-radius: 999px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.2); }
        .name { flex: 1; }
        .check { visibility: hidden; }
        [aria-checked="true"] .check { visibility: visible; }
        .chevron { color: var(--muted-foreground, #999); font-size: 13px; margin-left: auto; }
        .menu-sub-wrapper { position: relative; }
        .menu-sub-flyout {
          display: none; position: absolute; top: -6px; left: calc(100% + 4px); min-width: 170px; padding: 6px;
          border: 1px solid var(--border, #333); border-radius: 12px;
          background: var(--card, #1c1c1f); color: var(--foreground, #eee);
          box-shadow: 0 16px 40px -12px rgb(0 0 0 / 0.75);
        }
        .menu-sub-wrapper:hover .menu-sub-flyout { display: block; }
        .hint { padding: 6px 10px 2px; color: var(--muted-foreground, #999); font-size: 11px; }

        /* MD3E: the md-menu anatomy of md3e.css section 50 (one
           surface-container-low group, 16px, level 2; 44px items with their
           shape 4px in, 12px at the ends; selected = tertiary-container pill
           and the Rounded check), opening with the menu's scale + fade */
        :host-context([data-agy-theme="md3e"]) .trigger:hover { background: var(--md-hover); color: var(--md-sys-color-on-surface); }
        :host-context([data-agy-theme="md3e"]) .trigger[aria-expanded="true"] {
          background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container);
        }
        :host-context([data-agy-theme="md3e"]) .menu {
          top: calc(100% + 4px); min-width: 260px; padding: 4px 0; border: 0; border-radius: 16px;
          background: var(--md-sys-color-surface-container-low); color: var(--md-sys-color-on-surface);
          box-shadow: var(--md-sys-elevation-level2);
          font: var(--md-sys-typescale-label-large); letter-spacing: var(--md-sys-typescale-label-large-tracking);
          transform-origin: top left; transition: scale var(--md-fast), opacity var(--md-color-fast);
        }
        @starting-style { :host-context([data-agy-theme="md3e"]) .menu { scale: 0.8; opacity: 0; } }
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"] {
          position: relative; isolation: isolate; height: 44px; gap: 12px; padding: 0 16px; border-radius: 0;
        }
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"]::before {
          content: ""; position: absolute; inset: 0 4px; z-index: -1; border-radius: 4px;
          transition: background-color var(--md-state);
        }
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"]:first-child::before { border-radius: 12px 12px 4px 4px; }
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"]:hover,
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"]:focus-visible { background: transparent; }
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"]:hover::before { background: color-mix(in srgb, currentColor 8%, transparent); }
        :host-context([data-agy-theme="md3e"]) [role="menuitemradio"]:focus-visible::before { background: color-mix(in srgb, currentColor 10%, transparent); }
        :host-context([data-agy-theme="md3e"]) [aria-checked="true"] { color: var(--md-sys-color-on-tertiary-container); }
        :host-context([data-agy-theme="md3e"]) [aria-checked="true"]::before { border-radius: 12px; background: var(--md-sys-color-tertiary-container); }
        :host-context([data-agy-theme="md3e"]) [aria-checked="true"]:hover::before {
          background: color-mix(in srgb, var(--md-sys-color-on-tertiary-container) 8%, var(--md-sys-color-tertiary-container));
        }
        :host-context([data-agy-theme="md3e"]) .swatch { width: 16px; height: 16px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent); }
        :host-context([data-agy-theme="md3e"]) .check {
          width: 20px; height: 20px; font-size: 0; background: currentColor;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 -960 960 960'%3E%3Cpath d='M389 -369 688 -668Q699 -679 714 -679Q728 -679 739 -668Q750 -657 750 -642Q750 -628 739 -617L415 -292Q404 -281 390 -281Q375 -281 364 -292L221 -435Q210 -446 210 -460Q210 -475 221 -486Q232 -497 246 -497Q261 -497 272 -486Z'/%3E%3C/svg%3E") center / contain no-repeat;
        }
        :host-context([data-agy-theme="md3e"]) .hint {
          padding: 8px 16px 6px; font: var(--md-sys-typescale-label-medium); color: var(--md-sys-color-on-surface-variant);
        }

        /* MD3E app menu: an xsmall M3 icon button (32px, 20px icon); the
           <md-menu> it opens draws itself */
        .appmenu { display: none; min-width: 220px; }
        :host-context([data-agy-theme="md3e"][data-agy-appmenu]) .trigger,
        :host-context([data-agy-theme="md3e"][data-agy-appmenu]) .menu { display: none !important; }
        :host-context([data-agy-theme="md3e"][data-agy-appmenu]) .appmenu { display: block; }
        .appmenu md-menu {
          min-width: 220px;
        }
        .appmenu-trigger {
          display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0;
          border-radius: 9999px; background: transparent; color: var(--md-sys-color-on-surface-variant);
          cursor: default; outline: none; transition: background-color var(--md-state), color var(--md-state);
        }
        .appmenu-trigger:hover { background: var(--md-hover); color: var(--md-sys-color-on-surface); }
        .appmenu-trigger[aria-expanded="true"] {
          background: var(--md-sys-color-secondary-container); color: var(--md-sys-color-on-secondary-container);
        }
        .appmenu-trigger:focus-visible { outline: 3px solid var(--md-sys-color-secondary); outline-offset: 2px; }
        .appmenu svg { display: block; width: 20px; height: 20px; fill: currentColor; }
        .appmenu .swatch { width: 16px; height: 16px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--md-sys-color-on-surface) 24%, transparent); }
      </style>
      <button class="trigger" aria-haspopup="menu" aria-expanded="false">Theme</button>
      <div class="menu" role="menu" aria-label="Theme" hidden></div>`;
    trigger = shadow.querySelector('.trigger');
    menu = shadow.querySelector('.menu');
    mountAppMenu();
    trigger.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[role="menuitemradio"]');
      if (item) { select(item.dataset.key); closeMenu(); return; }
      const subTrig = e.target.closest('.menu-sub-trigger');
      if (subTrig) {
        const activeSeed = [...options.values()].find((o) => o.theme === 'md3e' && o.key === current?.key);
        select(activeSeed ? activeSeed.key : 'md3e-teal');
        closeMenu();
      }
    });
    menu.addEventListener('keydown', onMenuKey);
    document.body.appendChild(hostEl);
    renderMenu();
    if (appMenuBuilt) buildAppMenu(false);
    position();
  }

  function renderMenu() {
    if (!menu) return;
    menu.innerHTML = '';
    // Standalone options
    for (const o of options.values()) {
      if (o.theme === 'md3e') continue;
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(o.key === current?.key));
      item.tabIndex = -1;
      item.dataset.key = o.key;
      item.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="check">✓</span>';
      item.querySelector('.swatch').style.background = o.swatch || 'transparent';
      item.querySelector('.name').textContent = o.name;
      menu.appendChild(item);
    }
    // Group MD3E into single entry with submenu flyout
    const md3eOptions = [...options.values()].filter((o) => o.theme === 'md3e');
    if (md3eOptions.length) {
      const isMd3eActive = current?.theme === 'md3e';
      const subWrapper = document.createElement('div');
      subWrapper.className = 'menu-sub-wrapper';
      const subTrigger = document.createElement('div');
      subTrigger.className = 'menu-sub-trigger';
      subTrigger.setAttribute('role', 'button');
      subTrigger.tabIndex = -1;
      subTrigger.innerHTML = '<span class="swatch" style="background:#a5faf9"></span><span class="name">Material 3 Expressive</span><span class="check">✓</span><span class="chevron">›</span>';
      if (!isMd3eActive) subTrigger.querySelector('.check').style.visibility = 'hidden';
      else subTrigger.querySelector('.check').style.visibility = 'visible';
      subWrapper.appendChild(subTrigger);

      const flyout = document.createElement('div');
      flyout.className = 'menu-sub-flyout';
      flyout.setAttribute('role', 'menu');
      for (const o of md3eOptions) {
        const item = document.createElement('div');
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(o.key === current?.key));
        item.tabIndex = -1;
        item.dataset.key = o.key;
        item.innerHTML = '<span class="swatch"></span><span class="name"></span><span class="check">✓</span>';
        item.querySelector('.swatch').style.background = o.swatch || 'transparent';
        item.querySelector('.name').textContent = o.name;
        flyout.appendChild(item);
      }
      subWrapper.appendChild(flyout);
      menu.appendChild(subWrapper);
    }
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Ctrl+Shift+F12: next theme';
    menu.appendChild(hint);
  }

  // ---- MD3E app menu ----------------------------------------------------------
  // A text menu bar has no place in an M3 top app bar, so in MD3E the title
  // bar's menus (Antigravity, Workspace, View, Window) and Theme sit behind one
  // icon button that opens the package's <md-menu>, each menu a cascading
  // submenu. The app stays the source of truth: md3e.css only hides its menu
  // bar (while data-agy-appmenu is set), the items are read from its menu
  // components' props on every open, and choosing one runs the app's own
  // handler. Without the vendored component the app's menu bar stays.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Material Symbols Rounded (FILL 0, opsz 20, wght 400), as in md3e-icons.css
  const GLYPHS = {
    menu: 'M180 -264Q165 -264 154 -274Q144 -285 144 -300Q144 -315 154 -326Q165 -336 180 -336H780Q795 -336 806 -326Q816 -315 816 -300Q816 -285 806 -274Q795 -264 780 -264ZM180 -444Q165 -444 154 -454Q144 -465 144 -480Q144 -495 154 -506Q165 -516 180 -516H780Q795 -516 806 -506Q816 -495 816 -480Q816 -465 806 -454Q795 -444 780 -444ZM180 -624Q165 -624 154 -634Q144 -645 144 -660Q144 -675 154 -686Q165 -696 180 -696H780Q795 -696 806 -686Q816 -675 816 -660Q816 -645 806 -634Q795 -624 780 -624Z',
    info: 'M516 -324V-492Q516 -507 506 -518Q495 -528 480 -528Q465 -528 454 -518Q444 -507 444 -492V-324Q444 -309 454 -298Q465 -288 480 -288Q495 -288 506 -298Q516 -309 516 -324ZM516 -636Q516 -651 506 -662Q495 -672 480 -672Q465 -672 454 -662Q444 -651 444 -636Q444 -621 454 -610Q465 -600 480 -600Q495 -600 506 -610Q516 -621 516 -636ZM480 -96Q401 -96 331 -126Q261 -156 208 -208Q156 -261 126 -331Q96 -401 96 -480Q96 -560 126 -630Q156 -699 208 -752Q261 -804 331 -834Q401 -864 480 -864Q560 -864 630 -834Q699 -804 752 -752Q804 -699 834 -629Q864 -560 864 -480Q864 -401 834 -331Q804 -261 752 -208Q699 -156 629 -126Q560 -96 480 -96ZM480 -168Q610 -168 701 -259Q792 -350 792 -480Q792 -610 701 -701Q610 -792 480 -792Q350 -792 259 -701Q168 -610 168 -480Q168 -350 259 -259Q350 -168 480 -168Z',
    workspaces: 'M240 -144Q180 -144 138 -186Q96 -228 96 -288Q96 -348 138 -390Q180 -432 240 -432Q300 -432 342 -390Q384 -348 384 -288Q384 -228 342 -186Q300 -144 240 -144ZM720 -144Q660 -144 618 -186Q576 -228 576 -288Q576 -348 618 -390Q660 -432 720 -432Q780 -432 822 -390Q864 -348 864 -288Q864 -228 822 -186Q780 -144 720 -144ZM240 -216Q270 -216 291 -237Q312 -258 312 -288Q312 -318 291 -339Q270 -360 240 -360Q210 -360 189 -339Q168 -318 168 -288Q168 -258 189 -237Q210 -216 240 -216ZM720 -216Q750 -216 771 -237Q792 -258 792 -288Q792 -318 771 -339Q750 -360 720 -360Q690 -360 669 -339Q648 -318 648 -288Q648 -258 669 -237Q690 -216 720 -216ZM480 -528Q420 -528 378 -570Q336 -612 336 -672Q336 -732 378 -774Q420 -816 480 -816Q540 -816 582 -774Q624 -732 624 -672Q624 -612 582 -570Q540 -528 480 -528ZM480 -600Q510 -600 531 -621Q552 -642 552 -672Q552 -702 531 -723Q510 -744 480 -744Q450 -744 429 -723Q408 -702 408 -672Q408 -642 429 -621Q450 -600 480 -600Z',
    visibility: 'M480 -312Q550 -312 599 -361Q648 -410 648 -480Q648 -550 599 -599Q550 -648 480 -648Q410 -648 361 -599Q312 -550 312 -480Q312 -410 361 -361Q410 -312 480 -312ZM480 -384Q440 -384 412 -412Q384 -440 384 -480Q384 -520 412 -548Q440 -576 480 -576Q520 -576 548 -548Q576 -520 576 -480Q576 -440 548 -412Q520 -384 480 -384ZM68 -445Q63 -453 61 -462Q59 -471 59 -480Q59 -489 61 -498Q63 -507 68 -515Q132 -629 241 -698Q350 -768 480 -768Q610 -768 719 -698Q828 -629 892 -515Q897 -507 899 -498Q901 -489 901 -480Q901 -471 899 -462Q897 -453 892 -445Q828 -331 719 -262Q610 -192 480 -192Q350 -192 241 -262Q132 -331 68 -445ZM833 -480Q782 -580 687 -638Q592 -696 480 -696Q368 -696 273 -638Q178 -580 127 -480Q178 -380 273 -322Q368 -264 480 -264Q592 -264 687 -322Q782 -380 833 -480Z',
    select_window: 'M168 -96Q138 -96 117 -117Q96 -138 96 -168V-504Q96 -534 117 -555Q138 -576 168 -576H240V-792Q240 -822 261 -843Q282 -864 312 -864H792Q822 -864 843 -843Q864 -822 864 -792V-456Q864 -426 843 -405Q822 -384 792 -384H720V-168Q720 -138 699 -117Q678 -96 648 -96ZM168 -168H648Q648 -168 648 -168Q648 -168 648 -168V-432H168V-168Q168 -168 168 -168Q168 -168 168 -168ZM720 -456H792Q792 -456 792 -456Q792 -456 792 -456V-720H312V-576H648Q678 -576 699 -555Q720 -534 720 -504Z',
    palette: 'M480 -96Q401 -96 331 -126Q261 -156 208 -208Q156 -261 126 -331Q96 -401 96 -480Q96 -560 126 -630Q157 -699 210 -752Q264 -804 336 -834Q407 -864 488 -864Q566 -864 634 -837Q703 -810 754 -763Q805 -716 834 -653Q864 -590 864 -518Q864 -422 797 -355Q730 -288 634 -288H566Q558 -288 552 -283Q546 -278 546 -270Q546 -255 561 -245Q576 -235 576 -192Q576 -155 549 -126Q522 -96 480 -96ZM264 -444Q289 -444 306 -462Q324 -479 324 -504Q324 -529 306 -546Q289 -564 264 -564Q239 -564 222 -546Q204 -529 204 -504Q204 -479 222 -462Q239 -444 264 -444ZM384 -588Q409 -588 426 -606Q444 -623 444 -648Q444 -673 426 -690Q409 -708 384 -708Q359 -708 342 -690Q324 -673 324 -648Q324 -623 342 -606Q359 -588 384 -588ZM576 -588Q601 -588 618 -606Q636 -623 636 -648Q636 -673 618 -690Q601 -708 576 -708Q551 -708 534 -690Q516 -673 516 -648Q516 -623 534 -606Q551 -588 576 -588ZM696 -444Q721 -444 738 -462Q756 -479 756 -504Q756 -529 738 -546Q721 -564 696 -564Q671 -564 654 -546Q636 -529 636 -504Q636 -479 654 -462Q671 -444 696 -444ZM480 -168Q491 -168 498 -176Q504 -185 504 -192Q504 -208 489 -220Q474 -232 474 -270Q474 -308 500 -334Q527 -360 565 -360H634Q700 -360 746 -406Q792 -452 792 -518Q792 -633 704 -712Q615 -792 488 -792Q354 -792 261 -701Q168 -610 168 -480Q168 -350 259 -259Q350 -168 480 -168Z',
  };
  // the first menu is the product's own (its title is the app name)
  const MENU_GLYPHS = { Workspace: 'workspaces', View: 'visibility', Window: 'select_window' };
  // "Version …" is a label in the app's menu, not a dead command: read, not 38%
  const INFO_COLORS = JSON.stringify({ disabledTextColor: 'var(--md-sys-color-on-surface-variant)' });
  let appMenus = [];

  function glyph(name, slot) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('aria-hidden', 'true');
    if (slot) svg.setAttribute('slot', slot);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', GLYPHS[name]);
    svg.appendChild(path);
    return svg;
  }
  function menuItem(headline, attrs = {}) {
    const item = document.createElement('md-menu-item');
    item.setAttribute('headline', headline);
    for (const [name, value] of Object.entries(attrs)) {
      if (value != null && value !== false) item.setAttribute(name, value === true ? '' : String(value));
    }
    return item;
  }
  function submenu(label, children) {
    const sub = document.createElement('md-menu');
    sub.slot = 'submenu';
    sub.setAttribute('label', label);
    sub.append(...children);
    return sub;
  }

  function patchComponentSheets() {
    try {
      const dummyItem = document.createElement('md-menu-item');
      if (dummyItem.shadowRoot?.adoptedStyleSheets?.length) {
        const s = dummyItem.shadowRoot.adoptedStyleSheets[0];
        s.insertRule('.text { white-space: nowrap !important; overflow-wrap: normal !important; max-width: none !important; }', 0);
        s.insertRule('.item { min-width: 220px !important; max-width: 320px !important; }', 0);
      }
      const dummyMenu = document.createElement('md-menu');
      if (dummyMenu.shadowRoot?.adoptedStyleSheets?.length) {
        const ms = dummyMenu.shadowRoot.adoptedStyleSheets[0];
        ms.insertRule('.menu { min-width: 220px !important; max-width: 320px !important; will-change: transform, opacity !important; }', 0);
      }
    } catch {}
  }

  function mountAppMenu() {
    if (!customElements.get('md-menu')) return;
    patchComponentSheets();
    appMenu = document.createElement('md-menu');
    appMenu.className = 'appmenu';
    appMenu.setAttribute('label', 'Application menu');
    appTrigger = document.createElement('button');
    appTrigger.className = 'appmenu-trigger';
    appTrigger.slot = 'trigger';
    appTrigger.setAttribute('aria-label', 'Application menu');
    appTrigger.title = 'Menu';
    appTrigger.appendChild(glyph('menu'));
    appMenu.appendChild(appTrigger);
    // these run before the menu's own handlers on its trigger slot
    appTrigger.addEventListener('click', () => buildAppMenu(false));
    appTrigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') buildAppMenu(false); });
    appMenu.addEventListener('select', onAppMenuSelect);
    shadow.appendChild(appMenu);
    document.documentElement.setAttribute('data-agy-appmenu', '');
  }

  // The app's menu bar renders one component per menu, { title, options:
  // [{ label, shortcut, onClick, nonSelectable }] }: read from React's fiber
  function readAppMenus() {
    const bar = document.querySelector('[data-testid="title-menu-bar"]');
    const key = bar && Object.keys(bar).find((k) => k.startsWith('__reactFiber$'));
    const menus = [];
    for (let f = key ? bar[key].child : null; f; f = f.sibling) {
      const p = f.memoizedProps;
      if (typeof p?.title === 'string' && Array.isArray(p.options) && p.options.length) menus.push({ title: p.title, options: p.options });
    }
    return menus;
  }

  function fixItemStyle(el) {
    if (!el || !el.shadowRoot) return;
    try {
      let s = el.shadowRoot.querySelector('#agy-item-fix');
      if (!s) {
        s = document.createElement('style');
        s.id = 'agy-item-fix';
        s.textContent = `
          .text { white-space: nowrap !important; overflow-wrap: normal !important; max-width: none !important; }
          .item { min-width: 220px !important; max-width: 320px !important; }
        `;
        el.shadowRoot.appendChild(s);
      }
    } catch {}
  }

  function fixMenuStyle(menu) {
    if (!menu || !menu.shadowRoot) return;
    try {
      let s = menu.shadowRoot.querySelector('#agy-menu-fix');
      if (!s) {
        s = document.createElement('style');
        s.id = 'agy-menu-fix';
        s.textContent = `
          .menu { min-width: 220px !important; max-width: 320px !important; will-change: transform, opacity !important; }
        `;
        menu.shadowRoot.appendChild(s);
      }
    } catch {}
    for (const it of menu.querySelectorAll('md-menu-item')) fixItemStyle(it);
    for (const sub of menu.querySelectorAll('md-menu')) fixMenuStyle(sub);
  }

  let appMenuBuilt = false;
  function buildAppMenu(force = false) {
    const forced = force === true;
    if (!appMenu || (!forced && appMenu.open)) return;
    if (appMenuBuilt && !forced) {
      window.__buildAppMenuHitCache = (window.__buildAppMenuHitCache || 0) + 1;
      for (const item of appMenu.querySelectorAll('md-menu-item[value^="theme:"]')) {
        const val = item.getAttribute('value') || '';
        item.selected = (val === `theme:${current?.key}`);
      }
      fixMenuStyle(appMenu);
      return;
    }
    window.__buildAppMenuFullBuild = (window.__buildAppMenuFullBuild || 0) + 1;
    appMenus = readAppMenus();
    if (!appMenus.length && !forced) return;
    const items = appMenus.map((m, i) => {
      const top = menuItem(m.title);
      top.append(glyph(MENU_GLYPHS[m.title] || 'info', 'start'), submenu(m.title, m.options.map((o, j) => menuItem(String(o.label), {
        value: `app:${i}:${j}`,
        'trailing-text': typeof o.shortcut === 'string' && o.shortcut ? o.shortcut : null,
        disabled: !!o.nonSelectable,
        colors: o.nonSelectable ? INFO_COLORS : null,
      }))));
      return top;
    });
    // Theme: standalone themes, MD3E submenu, and Next theme
    const choices = document.createElement('md-menu-group');
    for (const o of options.values()) {
      if (o.theme === 'md3e') continue;
      const item = menuItem(o.name, { value: `theme:${o.key}`, 'selection-mode': 'single', selected: o.key === current?.key, 'selected-icon': 'check' });
      if (o.swatch && o.swatch !== 'transparent') {
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.slot = 'end';
        swatch.style.background = o.swatch;
        item.appendChild(swatch);
      }
      choices.appendChild(item);
    }
    const md3eItems = [];
    for (const o of options.values()) {
      if (o.theme !== 'md3e') continue;
      const item = menuItem(o.name, { value: `theme:${o.key}`, 'selection-mode': 'single', selected: o.key === current?.key, 'selected-icon': 'check' });
      if (o.swatch) {
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.slot = 'end';
        swatch.style.background = o.swatch;
        item.appendChild(swatch);
      }
      md3eItems.push(item);
    }
    if (md3eItems.length) {
      const md3eMenu = menuItem('Material 3 Expressive');
      md3eMenu.append(glyph('palette', 'start'), submenu('Material 3 Expressive', md3eItems));
      choices.appendChild(md3eMenu);
    }
    const cycle = document.createElement('md-menu-group');
    cycle.appendChild(menuItem('Next theme', { value: 'theme:next', 'trailing-text': 'Ctrl+Shift+F12' }));
    const theme = menuItem('Theme');
    theme.append(glyph('palette', 'start'), submenu('Theme', [choices, cycle]));
    for (const el of [...appMenu.children]) if (el !== appTrigger) el.remove();
    appMenu.append(...items, theme);
    appMenuBuilt = true;
    fixMenuStyle(appMenu);
  }

  function onAppMenuSelect(e) {
    const [kind, a, b] = String(e.detail?.item?.value ?? '').split(':');
    // Close without handing focus back to the button: the command may move it
    // (Command Palette, New Conversation)
    e.preventDefault();
    closeAppMenu();
    if (kind === 'theme') {
      if (a === 'next') cycleTheme();
      else select(a);
    } else if (kind === 'app') {
      try {
        appMenus[Number(a)]?.options[Number(b)]?.onClick?.();
      } catch {
        // the app's own handler failed; its menu would have failed the same
      }
    }
  }
  function closeAppMenu() {
    if (!appMenu?.open) return;
    if (typeof appMenu._requestClose === 'function') appMenu._requestClose(false);
    else appMenu.open = false;
  }

  function position() {
    if (!hostEl) return;
    // MD3E: the app menu button at the bar's start, its icon in line with
    // the drawer's icons below
    if (appMenu && current?.theme === 'md3e') {
      const bar = document.querySelector('[data-testid="title-menu-bar"]');
      if (!bar) {
        hostEl.style.display = 'none';
        if (retry++ < 60) setTimeout(position, 500);
        return;
      }
      const r = bar.getBoundingClientRect();
      hostEl.style.display = 'block';
      hostEl.style.transform = `translate(${Math.round(r.left + 22)}px, ${Math.round(r.top + (r.height - 32) / 2)}px)`;
      return;
    }
    const items = document.querySelectorAll('[data-testid="title-menu-bar-item"]');
    const last = items[items.length - 1];
    if (!last) {
      hostEl.style.display = 'none';
      if (retry++ < 60) setTimeout(position, 500);
      return;
    }
    const r = last.getBoundingClientRect();
    const prev = items[items.length - 2]?.getBoundingClientRect();
    const gap = prev ? Math.max(0, r.left - prev.right) : 2;
    const cs = getComputedStyle(last);
    hostEl.style.display = 'block';
    hostEl.style.transform = `translate(${Math.round(r.right + gap)}px, ${Math.round(r.top)}px)`;
    trigger.style.height = `${r.height}px`;
    trigger.style.font = cs.font;
    trigger.style.letterSpacing = cs.letterSpacing;
    trigger.style.padding = cs.padding;
    trigger.style.borderRadius = cs.borderRadius;
  }

  function openMenu() {
    position();
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('[role="menuitemradio"]'))?.focus();
  }
  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }
  function onMenuKey(e) {
    const items = [...menu.querySelectorAll('[role="menuitemradio"]')];
    const i = items.indexOf(shadow.activeElement);
    if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { if (items[i]) { select(items[i].dataset.key); closeMenu(); } e.preventDefault(); }
    else if (e.key === 'Escape') { closeMenu(); trigger.focus(); }
  }

  // ---- M3 ripple ------------------------------------------------------------
  const RIPPLE_TARGETS = 'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="tab"], [data-testid="conversation-row-sidebar"]';
  const PRESSED_OPACITY = 0.1;
  let rippleLayer = null;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function startRipple(e) {
    if (!(bundle.ripple ?? []).includes(current?.theme) || e.button !== 0 || reducedMotion?.matches) return;
    if (hostEl && e.composedPath().includes(hostEl)) return;
    const target = e.target instanceof Element ? e.target.closest(RIPPLE_TARGETS) : null;
    if (!target || target.isContentEditable) return;
    const x = e.clientX, y = e.clientY, start = performance.now();
    let released = false, onRelease = null;
    const release = () => {
      released = true;
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      onRelease?.();
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    requestAnimationFrame(() => {
      const box = target.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return;
      const cs = getComputedStyle(target);
      // md-menu items draw their shape 4px inside the row (::before): ripple there
      const shape = target.matches('[role="menu"] [role^="menuitem"]') ? getComputedStyle(target, '::before') : null;
      const inset = shape?.content && shape.content !== 'none' ? parseFloat(shape.left) || 0 : 0;
      const r = { left: box.left + inset, top: box.top, width: box.width - inset * 2, height: box.height };
      const radius = inset ? shape.borderRadius : cs.borderRadius;
      if (!rippleLayer?.isConnected) {
        rippleLayer = document.createElement('div');
        rippleLayer.id = 'agy-ripple-layer';
        rippleLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000;contain:strict;';
        document.body.appendChild(rippleLayer);
      }
      const clip = document.createElement('div');
      clip.style.cssText = `position:absolute;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:${radius};overflow:hidden;`;
      const endR = Math.hypot(r.width, r.height) / 2 + 10;
      const startScale = (Math.max(r.width, r.height) * 0.3) / endR;
      const cx = r.width / 2, cy = r.height / 2;
      const ink = document.createElement('div');
      ink.style.cssText = `position:absolute;left:${cx - endR}px;top:${cy - endR}px;width:${endR * 2}px;height:${endR * 2}px;border-radius:50%;background:${cs.color};opacity:0;`;
      clip.appendChild(ink);
      rippleLayer.appendChild(clip);
      ink.animate(
        [{ transform: `translate(${x - r.left - cx}px, ${y - r.top - cy}px) scale(${startScale})` }, { transform: 'none' }],
        { duration: 225, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
      );
      ink.animate([{ opacity: 0 }, { opacity: PRESSED_OPACITY }], { duration: 75, fill: 'forwards' });
      const fadeOut = () => {
        const wait = Math.max(0, 225 - (performance.now() - start));
        setTimeout(() => {
          ink.animate([{ opacity: PRESSED_OPACITY }, { opacity: 0 }], { duration: 150, fill: 'forwards' })
            .finished.finally(() => clip.remove());
          setTimeout(() => clip.remove(), 400);
        }, wait);
      };
      if (released) fadeOut();
      else onRelease = fadeOut;
    });
  }

  // ---- Expansion: animated open and close ------------------------------------
  // The app swaps the region in and out at once. Opening grows the new region
  // from 0; closing plays a clone of the old one down to 0. Both ride the M3
  // Expressive springs from the tokens: height the spatial (medium) spring,
  // opacity the effects (fast) one.
  const COLLAPSIBLES = [
    { toggle: '[data-testid="changed-files-card-header"]', card: '[data-testid="changed-files-card"]', region: ':scope > .relative:not([data-agy-ghost])' },
  ];
  function spring(name) {
    const cs = getComputedStyle(document.documentElement);
    const duration = parseFloat(cs.getPropertyValue(`--md-sys-motion-${name}-duration`));
    const easing = cs.getPropertyValue(`--md-sys-motion-${name}-easing`).trim();
    return duration && easing ? { duration, easing } : { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
  }
  // closing holds the end state until the clone is removed; opening must not,
  // or the region would keep a fixed height after it
  function animateRegion(el, from, to, closing) {
    const fill = closing ? 'forwards' : 'none';
    el.animate({ opacity: closing ? [1, 0] : [0, 1] }, { ...spring('effect-fast'), fill });
    return el.animate([{ height: `${from}px`, clipPath: 'inset(0)' }, { height: `${to}px`, clipPath: 'inset(0)' }], { ...spring('spatial-medium'), fill });
  }
  function onClickCapture(e) {
    if (!(bundle.ripple ?? []).includes(current?.theme) || reducedMotion?.matches) return;
    const t = e.target instanceof Element ? e.target : null;
    for (const c of COLLAPSIBLES) {
      const toggle = t?.closest(c.toggle);
      if (!toggle || t.closest('button, a') && toggle.contains(t.closest('button, a'))) continue;
      const card = toggle.closest(c.card);
      if (!card) return;
      card.querySelectorAll(':scope > [data-agy-ghost]').forEach((g) => g.remove());
      const region = card.querySelector(c.region);
      if (!region) {
        // collapsed: React adds the region before the next frame
        requestAnimationFrame(() => {
          const opened = card.isConnected && card.querySelector(c.region);
          if (opened) animateRegion(opened, 0, opened.getBoundingClientRect().height, false);
        });
        return;
      }
      const height = region.getBoundingClientRect().height;
      const scrolled = [...region.querySelectorAll('.overflow-y-auto')].map((el) => el.scrollTop);
      const ghost = region.cloneNode(true);
      ghost.setAttribute('data-agy-ghost', '');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.inert = true;
      ghost.style.overflow = 'clip';
      requestAnimationFrame(() => {
        if (region.isConnected || !toggle.isConnected) return;
        toggle.after(ghost);
        ghost.querySelectorAll('.overflow-y-auto').forEach((el, i) => (el.scrollTop = scrolled[i] ?? 0));
        animateRegion(ghost, height, 0, true).finished.finally(() => ghost.remove());
        setTimeout(() => ghost.remove(), 900);
      });
      return;
    }
  }

  // ---- Global listeners -----------------------------------------------------
  function onPointerDown(e) {
    startRipple(e);
    if (hostEl && !e.composedPath().includes(hostEl)) closeMenu();
    const transcript = document.querySelector('[data-testid="autoscroll-viewport"]');
    if (transcript && !transcript.classList.contains('no-focus-agent-input')) transcript.classList.add('no-focus-agent-input');
  }
  function cycleTheme() {
    const keys = [...options.keys()];
    select(keys[(keys.indexOf(current.key) + 1) % keys.length]);
  }
  function onKeyDown(e) {
    if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === 'F12') {
      cycleTheme();
      e.preventDefault();
    }
  }
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('click', onClickCapture, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', position);
  window.addEventListener('focus', syncTitleBarOverlay);
  document.fonts?.addEventListener('loadingdone', position);

  // ---- Virtual list layout guard --------------------------------------------
  // Antigravity virtualizes the sidebar and auxiliary panels with TanStack
  // Virtual. On mounting long lists (e.g. 299 diffs in Review or 95 sidebar
  // items), TanStack Virtual synchronously reads offsetHeight on every
  // [data-index] element while dirtying container styles between each item.
  // In a large conversation, each forced reflow costs 80-100ms, causing a 2s+
  // freeze upon entry. This guard serves known fixed heights or cached values
  // for virtual rows, preventing layout thrashing while letting ResizeObserver
  // handle real dynamic size changes asynchronously on idle frames.
  const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get;
  const virtualHeightCache = new WeakMap();
  if (origOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      get() {
        if (this.hasAttribute('data-index')) {
          const cached = virtualHeightCache.get(this);
          if (cached !== undefined) return cached;
          if (this.firstElementChild?.classList.contains('sticky')) {
            virtualHeightCache.set(this, 33);
            return 33;
          }
          if (this.classList.contains('bg-sidebar') || this.querySelector('h2')) {
            virtualHeightCache.set(this, 24);
            return 24;
          }
          if (this.querySelector('.agy-sidebar-row') || this.classList.contains('pb-[1px]')) {
            virtualHeightCache.set(this, 33);
            return 33;
          }
          if (!this.textContent.trim()) {
            virtualHeightCache.set(this, 16);
            return 16;
          }
        }
        const val = origOffsetHeight.call(this);
        if (this.hasAttribute('data-index')) virtualHeightCache.set(this, val);
        return val;
      },
      configurable: true,
    });
  }

  // Start the Overview panel's Context card; every theme gets it
  const contextCard = typeof agyContextCard === 'function' ? agyContextCard() : null;
  // ...and the token line under each finished turn
  const turnTokens = typeof agyTurnTokens === 'function' ? agyTurnTokens() : null;
  // ...and, in MD3E, the M3 loading indicator in the agent's "Working" row
  const loadingIndicator = typeof agyLoadingIndicator === 'function' ? agyLoadingIndicator() : null;
  // ...and wavy progress bars on running background work
  const progressIndicators = typeof agyProgressIndicators === 'function' ? agyProgressIndicators() : null;
  // ...and Wrap lines / Line numbers in every code block's header
  const codeTools = typeof agyCodeTools === 'function' ? agyCodeTools() : null;

  function dispose() {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('click', onClickCapture, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('focus', syncTitleBarOverlay);
    document.fonts?.removeEventListener('loadingdone', position);
    hostEl?.remove();
    document.documentElement?.removeAttribute('data-agy-appmenu');
    rippleLayer?.remove();
    contextCard?.dispose();
    turnTokens?.dispose();
    loadingIndicator?.dispose();
    progressIndicators?.dispose();
    codeTools?.dispose();
    if (origOffsetHeight) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
        get: origOffsetHeight,
        configurable: true,
      });
    }
    document.querySelectorAll('[data-agy-ghost]').forEach((g) => g.remove());
    document.getElementById('agy-theme-css')?.remove();
    document.documentElement?.removeAttribute('data-agy-theme');
    document.documentElement?.removeAttribute('data-agy-seed');
    modeObserver.disconnect();
    document.documentElement?.removeAttribute('data-agy-mode');
    document.querySelectorAll('[data-testid="autoscroll-viewport"].no-focus-agent-input')
      .forEach((el) => el.classList.remove('no-focus-agent-input'));
    syncTitleBarOverlay();
    delete window.__agyThemeHost;
    delete window.agyTheme;
  }

  const api = {
    version: HOST_VERSION,
    update,
    dispose,
    select,
    get: () => current?.key,
    options: () => bundle.options.map(({ key, name }) => ({ key, name })),
  };
  window.__agyThemeHost = api;
  window.agyTheme = api;

  update(bundle);
  if (!document.documentElement) {
    new MutationObserver((_, mo) => {
      if (document.documentElement) { mo.disconnect(); apply(); }
    }).observe(document, { childList: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { apply(); mount(); }, { once: true });
  } else {
    mount();
  }
  return api;
}

if (typeof module === 'object' && module.exports) module.exports = agyThemeHost;
