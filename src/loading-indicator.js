// Loading indicator: in MD3E, the agent's "Working" / "Compacting" row
// gets the package's own <md-loading-indicator> in front of its text: the
// Compose LoadingIndicator port in vendor/md3e/components.js (seven matched cubic morphs,
// spring 0.6 / 200, a new shape every 650ms with a quarter turn, one full
// turn every 4666ms), drawn in primary. md3e.css stills the row's shimmer
// text, so the indicator is the one thing moving.
//
// Other themes keep the app's row as it is: this module's own rule hides the
// element unless the page is MD3E (theme CSS comes and goes with the theme,
// and the element's :host display would beat a UA [hidden]).
// The element lives in the row React renders; when the run ends the row
// unmounts and the component stops its own animation frame loop.
function agyLoadingIndicator() {
  const ROW = '[data-testid="agent-loading"]';
  if (!customElements.get('md-loading-indicator')) return null;   // vendor script missing

  const style = document.createElement('style');
  style.id = 'agy-loader-css';
  style.textContent = `
    .agy-loader { display: none; }
    :root[data-agy-theme="md3e"] .agy-loader { display: flex; }`;   /* flex: no line box around the 24px canvas */
  (document.head || document.documentElement).appendChild(style);

  function decorate(row) {
    if (row.querySelector(':scope > .agy-loader')) return;
    const el = document.createElement('md-loading-indicator');
    el.className = 'agy-loader';
    el.setAttribute('size', '24');
    el.setAttribute('aria-hidden', 'true');   // the row's text already says it
    row.prepend(el);
  }

  // The row mounts about a second into a run: look inside what the
  // transcript adds, and rescan every 2s for a replaced viewport
  let viewport = null, observer = null;
  function onMutations(records) {
    try {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || n.classList.contains('agy-loader')) continue;
          if (n.matches(ROW)) decorate(n);
          else n.querySelectorAll(ROW).forEach(decorate);
        }
      }
    } catch {
      // app internals changed: leave the row as it is
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
    viewport?.querySelectorAll(ROW).forEach(decorate);
  }

  const timer = setInterval(scan, 2000);
  scan();

  return {
    dispose() {
      clearInterval(timer);
      observer?.disconnect();
      document.querySelectorAll('.agy-loader').forEach((el) => el.remove());
      style.remove();
    },
  };
}
