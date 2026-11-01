// Progress indicators: in MD3E, running work gets the package's own
// <md-progress-indicator variant="wavy" indeterminate> (vendor/md3e/
// components.js, its Compose LinearWavyProgressIndicator port: two segments
// travelling along a 20px wave over a secondary-container track, in primary):
//   - a running Background Commands row in the Overview panel: a bar along
//     the row's bottom edge, under the label
//   - the "N tasks running" status under the latest turn: a short bar in
//     front of the text
// md3e.css sizes them and stills what they replace (the terminal glyph's
// blinking caret, the status text's shimmer). The app's own 12-16px spinners
// stay: the package's circular indicator is a fixed 40/48px.
//
// A bar follows its host: added while the host shows the app's running mark,
// removed when it goes. Other themes keep the app's markup; this module's own
// rule hides the bars unless the page is MD3E.
function agyProgressIndicators() {
  if (!customElements.get('md-progress-indicator')) return null;   // vendor script missing
  const TARGETS = [
    { host: '[data-testid="background-task-row"]', running: '[data-testid="status-task-running"]', place: 'append', cls: 'agy-progress' },
    { host: '[data-testid="idle-status-text"]', running: '.animate-shimmer-text', place: 'prepend', cls: 'agy-progress' },
  ];
  const HOSTS = TARGETS.map((t) => t.host).join(', ');

  const style = document.createElement('style');
  style.id = 'agy-progress-css';
  style.textContent = `
    .agy-progress { display: none; }
    :root[data-agy-theme="md3e"] .agy-progress { display: block; }`;
  (document.head || document.documentElement).appendChild(style);

  function sync(host) {
    const target = TARGETS.find((t) => host.matches(t.host));
    if (!target) return;
    const bar = host.querySelector(':scope > .agy-progress');
    const running = !!host.querySelector(target.running);
    if (running && !bar) {
      const el = document.createElement('md-progress-indicator');
      el.className = target.cls;
      el.setAttribute('variant', 'wavy');
      el.setAttribute('indeterminate', '');
      el.setAttribute('aria-hidden', 'true');   // the host's own mark and text already say it
      if (target.place === 'append') host.append(el);
      else host.prepend(el);
    } else if (!running && bar) {
      bar.remove();
    }
  }

  // Hosts mount, and switch their running mark, inside the transcript and the
  // Overview panel: look only at the hosts a change touches, and rescan the
  // page every 2s for the rest (replaced roots, missed changes)
  function onMutations(records) {
    try {
      const hosts = new Set();
      for (const r of records) {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        const host = el?.closest(HOSTS);
        if (host) hosts.add(host);
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || n.classList.contains('agy-progress')) continue;
          if (n.matches(HOSTS)) hosts.add(n);
          else n.querySelectorAll(HOSTS).forEach((h) => hosts.add(h));
        }
      }
      hosts.forEach(sync);
    } catch {
      // app internals changed: leave the hosts as they are
    }
  }
  const observer = new MutationObserver(onMutations);
  let roots = [];
  function scan() {
    if (document.hidden) return;
    const next = [document.querySelector('[data-testid="autoscroll-viewport"]'), document.querySelector('[data-testid="overview-panel"]')].filter(Boolean);
    if (next.length !== roots.length || next.some((r, i) => r !== roots[i])) {
      observer.disconnect();
      roots = next;
      for (const r of roots) observer.observe(r, { childList: true, subtree: true });
    }
    try {
      document.querySelectorAll(HOSTS).forEach(sync);
    } catch {
      // as above
    }
  }

  const timer = setInterval(scan, 2000);
  scan();

  return {
    dispose() {
      clearInterval(timer);
      observer.disconnect();
      document.querySelectorAll('.agy-progress').forEach((el) => el.remove());
      style.remove();
    },
  };
}
