// Turn tokens: under every finished agent turn, beside the turn's time in
// its toolbar, one plain line of what the turn's model calls used:
//   "2.5k in · 358 out · 142k cache"
// Each model call stores its usage on the step it produced
// (CortexStepMetadata.modelUsage); the line sums them over the turn, the same
// totals the app's own flag-gated cost summary lists as Input, Cache, Output.
//   in     input + cache-write tokens (prompt the provider had to process)
//   out    output tokens (thinking included)
//   cache  cache-read tokens (left out when 0)
// Read-only: the turn's steps come from the toolbar's React props. The span
// carries the time label's own classes, so each theme styles it as the time.
function agyTurnTokens() {
  const TOOLBAR = '[data-testid="cascade-system-message-toolbar"]';
  const CLASSES = 'agy-turn-tokens text-xs text-muted-foreground px-1 whitespace-nowrap tabular-nums';

  const num = (v) => Number(v ?? 0) || 0;
  const fmt = (n) => (n >= 999500 ? `${+(n / 1e6).toFixed(1)}M`
    : n >= 9950 ? `${Math.round(n / 1e3)}k`
    : n >= 1000 ? `${+(n / 1e3).toFixed(1)}k`
    : String(n));
  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith('__reactFiber$'))];

  // The toolbar's component gets the turn's steps (and showThumbsUpDown)
  function stepsOf(toolbar) {
    let f = fiberOf(toolbar);
    for (let i = 0; f && i < 8; i++, f = f.return) {
      const p = f.memoizedProps;
      if (Array.isArray(p?.steps) && 'showThumbsUpDown' in p) return p.steps;
    }
    return null;
  }
  function lineFor(steps) {
    let input = 0, output = 0, cache = 0;
    for (const s of steps) {
      const u = s?.metadata?.modelUsage;
      if (!u) continue;
      input += num(u.inputTokens) + num(u.cacheWriteTokens);
      output += num(u.outputTokens);
      cache += num(u.cacheReadTokens);
    }
    if (!input && !output) return '';
    return [`${fmt(input)} in`, `${fmt(output)} out`, cache ? `${fmt(cache)} cache` : ''].filter(Boolean).join(' · ');
  }

  // toolbar -> { steps, el } it was labelled for: a labelled toolbar costs a
  // few property reads, no DOM queries
  const labelled = new WeakMap();
  function label(toolbar) {
    const steps = stepsOf(toolbar);
    const prev = labelled.get(toolbar);
    if (prev && prev.steps === steps && (!prev.el || prev.el.isConnected)) return;
    const group = toolbar.querySelector(':scope > div > div.ml-auto');   // time, copy, thumbs
    if (!group) return;
    const text = steps ? lineFor(steps) : '';
    let el = group.querySelector(':scope > .agy-turn-tokens');
    if (!text) {
      el?.remove();
      labelled.set(toolbar, { steps, el: null });
      return;
    }
    if (!el) {
      el = document.createElement('span');
      el.className = CLASSES;
      group.prepend(el);
    }
    if (el.textContent !== text) el.textContent = text;
    labelled.set(toolbar, { steps, el });
  }

  // A toolbar mounts when its turn finishes: look inside what the transcript
  // adds (small subtrees while a reply streams), and rescan it every 2s for
  // the rest (a new viewport after navigation, steps that changed in place)
  let viewport = null, observer = null;
  function onMutations(records) {
    try {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || n.classList.contains('agy-turn-tokens')) continue;
          if (n.matches(TOOLBAR)) label(n);
          else n.querySelectorAll(TOOLBAR).forEach(label);
        }
      }
    } catch {
      // app internals changed: leave the toolbars as they are
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
    try {
      viewport?.querySelectorAll(TOOLBAR).forEach(label);
    } catch {
      // as above
    }
  }

  const timer = setInterval(scan, 2000);
  scan();

  return {
    dispose() {
      clearInterval(timer);
      observer?.disconnect();
      document.querySelectorAll('.agy-turn-tokens').forEach((el) => el.remove());
    },
  };
}
