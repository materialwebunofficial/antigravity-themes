// Context card: a "Context" section at the top of the Overview panel —
// how full the conversation's context window is and what takes it up.
// Two looks, chosen in CSS from the page's data-agy-theme (:host-context), so
// a theme switch restyles it at once: Matte (the panel's own quiet rows, flat
// 4px bar) for every theme but MD3E, and M3 Expressive for MD3E. Segment and
// dot colors are per-theme custom properties (--k-*), never set from JS.
//
// Read-only, from the app's own state:
//   used    the latest model call's prompt: input + cache-read + cache-write
//           tokens (CortexStepMetadata.modelUsage) in the conversation view's
//           trajectorySlice (React props above the transcript viewport)
//   groups  Rules / Skills / MCP tools / ... from getTokenBase() on the app's
//           agent service, the call its Customizations screen makes
//   window  by model family: the app's model configs carry no size; the bar,
//           the chip and the warnings measure against it
//   total   the conversation's own running count: every model call the card
//           sees is added once (by step index) and kept per conversation in
//           the agy-usage cookie (last 20; cookies are the one store that
//           survives the app's port changing per launch). Reading the whole
//           history instead costs ~12 KB a step; a conversation first
//           seen part-way says which step its count starts from.
// Warnings at 80% and 95% of the window: one quiet line under the summary.
function agyContextCard() {
  const WINDOWS = [[/^gemini/i, 1048576], [/^claude/i, 200000], [/gpt-oss/i, 131072]];
  const LEVELS = [[0.95, 'critical', 'The context window is almost full.'],
    [0.8, 'warn', 'The context window is filling up.']];
  const GROUP_NAMES = { 1: 'System prompt', 2: 'Tools', 3: 'Rules', 4: 'MCP tools', 5: 'Skills', 6: 'Subagents', 7: 'Messages', 8: 'Workflows', 9: 'Plugins', 10: 'Flows' };
  const GROUP_KINDS = { 3: 'rules', 4: 'mcp', 5: 'skills' };
  const color = (kind) => `var(--k-${kind})`;

  const TICK_MS = 2000;
  const BASE_MS = 120000;
  const CHEVRON = '<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="M517.85-480l-184-184L376-706.15L602.15-480L376-253.85L333.85-296l184-184Z"/></svg>';

  const num = (v) => Number(v ?? 0) || 0;
  const fmt = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));
  const pct = (n, d) => {
    const p = (n / d) * 100;
    return p > 0 && p < 0.1 ? '<0.1%' : `${p.toFixed(p < 10 ? 1 : 0)}%`;
  };
  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith('__reactFiber$'))];

  // ---- Data -------------------------------------------------------------------
  function readSlice() {
    let f = fiberOf(document.querySelector('[data-testid="autoscroll-viewport"]'));
    for (let i = 0; f && i < 40; i++, f = f.return) {
      if (f.memoizedProps?.trajectorySlice) return f.memoizedProps.trajectorySlice;
    }
    return null;
  }
  function readUsage(slice) {
    const steps = slice?.stepsInSlice ?? [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const u = steps[i]?.metadata?.modelUsage;
      if (u) return num(u.inputTokens) + num(u.cacheReadTokens) + num(u.cacheWriteTokens);
    }
    return null;
  }
  // ---- Conversation total -----------------------------------------------------
  // Cookie: "id:in.out.cache.from.last|…", numbers in base 36, newest first
  const TOTALS_COOKIE = 'agy-usage';
  const TOTALS_MAX = 20;
  function readTotals() {
    const raw = (document.cookie.match(/(?:^|;\s*)agy-usage=([^;]*)/) || [])[1];
    if (!raw) return [];
    return decodeURIComponent(raw).split('|').map((entry) => {
      const [id, nums = ''] = entry.split(':');
      const [input, output, cache, from, last] = nums.split('.').map((n) => parseInt(n, 36));
      return { id, input, output, cache, from, last };
    }).filter((r) => r.id && [r.input, r.output, r.cache, r.from, r.last].every(Number.isFinite));
  }
  function writeTotals(list) {
    const value = list.map((r) => `${r.id}:${[r.input, r.output, r.cache, r.from, r.last].map((n) => n.toString(36)).join('.')}`).join('|');
    document.cookie = `${TOTALS_COOKIE}=${encodeURIComponent(value)}; Max-Age=31536000; Path=/; SameSite=Strict; Secure`;
  }
  let totals = readTotals();
  function countTotal(slice) {
    const id = slice?.conversationId;
    if (!id) return null;
    const start = num(slice.stepsSlice?.startIndex);
    const length = num(slice.totalStepsLength);
    let rec = totals.find((r) => r.id === id);
    let changed = false;
    if (!rec) {
      rec = { id, input: 0, output: 0, cache: 0, from: start, last: start - 1 };
      changed = true;
    }
    if (length && rec.last >= length) {   // undone ("Undo to this point"): later steps get reused indices
      rec.last = length - 1;
      changed = true;
    }
    (slice.stepsInSlice ?? []).forEach((s, i) => {
      const u = s?.metadata?.modelUsage;
      if (!u || start + i <= rec.last) return;
      rec.input += num(u.inputTokens) + num(u.cacheWriteTokens);
      rec.output += num(u.outputTokens);
      rec.cache += num(u.cacheReadTokens);
      rec.last = start + i;
      changed = true;
    });
    if (changed) {
      totals = [rec, ...totals.filter((r) => r !== rec)].slice(0, TOTALS_MAX);
      writeTotals(totals);
    }
    return rec;
  }

  function readWindow(slice) {
    const name = slice?.generatorMetadatasInSlice?.at(-1)?.plannerConfig?.modelName
      || document.querySelector('[data-testid="model-selector-trigger"]')?.textContent || '';
    return WINDOWS.find(([re]) => re.test(name.trim()))?.[1] ?? null;
  }

  let service = null;
  function agentService() {
    if (service) return service;
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    const stack = [root?.[key]?.stateNode?.current ?? root?.[key]];
    const seen = new Set();
    while (stack.length && seen.size < 30000) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const v = f.memoizedProps?.value;
      if (v && typeof v.getTokenBase === 'function') return (service = v);
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  let base = null, baseFor = null, baseAt = 0, baseLoading = false;
  function refreshBase(slice) {
    const convo = slice?.conversationId ?? null;
    if (baseLoading || (convo === baseFor && Date.now() - baseAt < BASE_MS)) return;
    const svc = agentService();
    if (!svc) return;
    baseLoading = true;
    const uris = slice?.metadata?.workspaceUris;
    svc.getTokenBase(Array.isArray(uris) ? { workspaceUris: uris } : {})
      .then((r) => {
        base = (r.customizationTokenBase?.groups ?? [])
          .map((g) => ({
            type: g.type,
            name: GROUP_NAMES[g.type] || g.name,
            tokens: num(g.numTokens),
            children: (g.children ?? []).map((c) => ({ name: c.name, tokens: num(c.numTokens) })).sort((a, b) => b.tokens - a.tokens),
          }))
          .filter((g) => g.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens);
        baseFor = convo;
        baseAt = Date.now();
        render();
      })
      .catch(() => {})
      .finally(() => { baseLoading = false; });
  }

  // ---- View -------------------------------------------------------------------
  let hostEl = null, shadow = null, state = null, signature = '';
  let open = true;
  const openGroups = new Set();

  function mount() {
    const list = document.querySelector('[data-testid="overview-panel"] > .overflow-y-auto');
    if (!list) return false;
    if (hostEl?.parentElement === list) return true;
    if (!hostEl) {
      hostEl = document.createElement('div');
      hostEl.id = 'agy-context-card';
      shadow = hostEl.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { display: block; padding: 4px; }
          *, *::before, *::after { box-sizing: border-box; }
          button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: default; text-align: start; }
          svg { width: 16px; height: 16px; fill: currentColor; flex: none; }

          /* =========================================================================
             SHARED LAYOUT & ANIMATION
             ========================================================================= */
          .body, .kids { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 300ms cubic-bezier(0.2, 0, 0, 1); }
          .body[hidden], .kids[hidden] { display: grid; grid-template-rows: 0fr; }
          .clip { min-height: 0; overflow: hidden; }
          [hidden] > .clip { visibility: hidden; transition: visibility 0s 300ms; }
          ul { list-style: none; margin: 0; padding: 2px 0 0; }
          .status[hidden], .total[hidden] { display: none; }
          .total-value { font-variant-numeric: tabular-nums; }
          .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .n, .p { text-align: end; }
          .head:focus-visible, .row:focus-visible {
            outline: 2px solid var(--md-sys-color-secondary, var(--ring, currentColor)); outline-offset: -2px;
          }
          @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

          /* =========================================================================
             MATTE THEME STYLING (matches stock Overview items & Background Commands)
             ========================================================================= */
          :host-context(:root:not([data-agy-theme="md3e"])) {
            color: var(--foreground, #dcdcde);
            font-family: var(--font-sans, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif);
            /* Matte's own tokens (matte.css, light and dark), with its dark
               values as fallbacks for any other non-MD3E theme */
            --k-conversation: var(--m-text, #dcdcde);
            --k-rules: var(--m-blue, #7aa2f7);
            --k-skills: var(--m-amber, #e5a84b);
            --k-mcp: var(--m-teal, #73daca);
            --k-other: var(--m-text-3, #86868c);
            --k-free: var(--m-line-3, rgba(255, 255, 255, 0.18));   /* legend dot; the bar's own track shows the free part */
            --k-hover: var(--m-hover, rgba(255, 255, 255, 0.045));
            --k-track: var(--m-line, rgba(255, 255, 255, 0.075));
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .head:focus-visible svg { opacity: 0.7; }
          :host-context(:root:not([data-agy-theme="md3e"])) .head {
            display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; min-height: 24px; padding: 0 6px 0 8px;
            border-radius: 8px; font-size: 12px; font-weight: 500; cursor: pointer;
            transition: background 150ms ease;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .head:hover {
            background: var(--k-hover);
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .title {
            color: var(--foreground, #dcdcde);
            opacity: 0.5;
            transition: opacity 150ms ease;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .head:hover .title { opacity: 1; }
          :host-context(:root:not([data-agy-theme="md3e"])) .chip {
            padding: 1px 6px; border-radius: 9999px;
            background: var(--border, rgba(255, 255, 255, 0.08));
            color: var(--foreground, #dcdcde);
            font-size: 10px; font-weight: 500; font-family: var(--font-mono, monospace); line-height: 14px;
            opacity: 0.5;
            transition: opacity 150ms ease;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .head:hover .chip { opacity: 1; }
          :host-context(:root:not([data-agy-theme="md3e"])) .head svg {
            margin-left: auto; width: 14px; height: 14px;
            color: var(--muted-foreground, #86868c);
            opacity: 0;
            rotate: 90deg;
            transition: opacity 150ms ease, rotate 150ms ease;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .head:hover svg { opacity: 0.7; }
          :host-context(:root:not([data-agy-theme="md3e"])) .head[aria-expanded="false"] svg { rotate: 0deg; }
          :host-context(:root:not([data-agy-theme="md3e"])) .summary {
            padding: 2px 8px 6px; font-size: 11px; font-variant-numeric: tabular-nums;
            color: var(--muted-foreground, #86868c);
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .total {
            padding: 0 8px 6px; font-size: 11px; line-height: 14px; color: var(--muted-foreground, #86868c);
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .total-value { color: var(--secondary-foreground, #a3a3a8); }
          :host-context(:root:not([data-agy-theme="md3e"])) .status {
            padding: 0 8px 6px; font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums;
            color: var(--muted-foreground, #86868c);
          }
          /* Warnings stay monochrome: the chip comes forward, then inverts */
          :host-context(:root:not([data-agy-theme="md3e"])) :is([data-level="warn"], [data-level="critical"]) .chip { opacity: 1; }
          :host-context(:root:not([data-agy-theme="md3e"])) [data-level="critical"] .chip {
            background: var(--foreground, #dcdcde); color: var(--background, #111113);
          }
          :host-context(:root:not([data-agy-theme="md3e"])) [data-level="critical"] .status { color: var(--foreground, #dcdcde); }
          :host-context(:root:not([data-agy-theme="md3e"])) .bar {
            position: relative; display: flex; gap: 1px; height: 4px; margin: 0 8px 6px;
            border-radius: 2px; background: var(--k-track); overflow: hidden;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .seg {
            flex: var(--v) 1 0; min-width: 2px; border-radius: 0; background: var(--c);
            transition: flex-grow 300ms ease;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .seg.free { background: transparent; }
          :host-context(:root:not([data-agy-theme="md3e"])) .row {
            display: grid; grid-template-columns: 6px 1fr auto 40px 14px; align-items: center; gap: 8px;
            width: 100%; min-height: 24px; padding: 2px 8px; border-radius: 6px;
            font-size: 12px; font-variant-numeric: tabular-nums;
            color: var(--secondary-foreground, #dcdcde);
            cursor: default;
            transition: background 120ms ease;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .row[aria-expanded] { cursor: pointer; }
          :host-context(:root:not([data-agy-theme="md3e"])) .row[aria-expanded]:hover { background: var(--k-hover); }
          :host-context(:root:not([data-agy-theme="md3e"])) .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
          :host-context(:root:not([data-agy-theme="md3e"])) .n, :host-context(:root:not([data-agy-theme="md3e"])) .p {
            font-size: 11px; font-family: var(--font-mono, monospace); color: var(--muted-foreground, #86868c);
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .row svg {
            width: 12px; height: 12px; color: var(--muted-foreground, #86868c); opacity: 0.4;
            transition: rotate 200ms ease, opacity 150ms ease;
            rotate: 0deg;
          }
          :host-context(:root:not([data-agy-theme="md3e"])) .row[aria-expanded="true"] svg { rotate: 90deg; opacity: 0.8; }
          :host-context(:root:not([data-agy-theme="md3e"])) .kids .row { padding-left: 18px; min-height: 22px; opacity: 0.85; }
          :host-context(:root:not([data-agy-theme="md3e"])) .more { padding: 2px 8px 4px 28px; font-size: 11px; color: var(--muted-foreground, #86868c); }

          /* =========================================================================
             MD3E THEME STYLING (Expressive tonal container, pill shapes, spring motion)
             ========================================================================= */
          :host-context([data-agy-theme="md3e"]) {
            color: var(--md-sys-color-on-surface, var(--foreground));
            font-family: var(--font-sans, "Roboto Variable", Roboto, sans-serif);
            /* tonal roles that stay apart in every seed (primary and
               primary-container are near twins in the expressive schemes) */
            --k-conversation: var(--md-sys-color-primary);
            --k-rules: var(--md-sys-color-secondary);
            --k-skills: var(--md-sys-color-tertiary);
            --k-mcp: var(--md-sys-color-outline);
            --k-other: var(--md-sys-color-outline-variant);
            --k-free: var(--md-sys-color-secondary-container);   /* the M3 progress track */
          }
          /* the Rounded symbol, as md3e-icons.css does for the app's own icons */
          :host-context([data-agy-theme="md3e"]) svg path {
            d: path("M522 -480 358 -644Q347 -655 347 -670Q347 -684 358 -695Q369 -706 384 -706Q398 -706 409 -695L599 -505Q604 -500 606 -494Q609 -487 609 -480Q609 -473 606 -466Q604 -460 599 -455L409 -265Q398 -254 384 -254Q370 -255 359 -266Q348 -277 348 -292Q348 -306 359 -317Z");
          }
          :host-context([data-agy-theme="md3e"]) .head {
            display: flex; align-items: center; gap: 6px; width: 100%; min-height: 28px; padding: 4px 8px;
            border-radius: var(--md-sys-shape-corner-full, 14px);
            font: var(--md-sys-typescale-label-medium, 500 12px/16px Roboto, sans-serif);
            cursor: pointer;
            transition: background-color 15ms linear;
          }
          :host-context([data-agy-theme="md3e"]) .head:hover, :host-context([data-agy-theme="md3e"]) .row[aria-expanded]:hover {
            background: color-mix(in srgb, currentColor 8%, transparent);
          }
          :host-context([data-agy-theme="md3e"]) .title {
            color: var(--md-sys-color-on-surface-variant, var(--muted-foreground));
          }
          :host-context([data-agy-theme="md3e"]) .chip {
            padding: 1px 8px; border-radius: var(--md-sys-shape-corner-full, 999px);
            background: var(--md-sys-color-secondary-container, var(--border));
            color: var(--md-sys-color-on-secondary-container, inherit);
            font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums;
            transition: background-color var(--md-color-fast, 150ms), color var(--md-color-fast, 150ms), border-radius var(--md-fast, 300ms);
          }
          /* Warnings: tertiary at 80%, error at 95%; the chip also changes
             shape (full -> 6px) to say the state changed */
          :host-context([data-agy-theme="md3e"]) [data-level="warn"] .chip {
            background: var(--md-sys-color-tertiary-container); color: var(--md-sys-color-on-tertiary-container);
          }
          :host-context([data-agy-theme="md3e"]) [data-level="critical"] .chip {
            border-radius: 6px;
            background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container);
          }
          :host-context([data-agy-theme="md3e"]) .status {
            padding: 0 8px 8px; font: var(--md-sys-typescale-body-small, 400 12px/16px Roboto, sans-serif);
            color: var(--md-sys-color-tertiary);
          }
          :host-context([data-agy-theme="md3e"]) [data-level="critical"] .status { color: var(--md-sys-color-error); }
          :host-context([data-agy-theme="md3e"]) [data-level="critical"] .bar::after { background: var(--md-sys-color-error); }
          :host-context([data-agy-theme="md3e"]) .total { padding: 6px 8px 8px; }
          :host-context([data-agy-theme="md3e"]) .total-label {
            font: var(--md-sys-typescale-label-small, 500 11px/16px Roboto, sans-serif); color: var(--md-sys-color-on-surface-variant, var(--muted-foreground));
          }
          :host-context([data-agy-theme="md3e"]) .total-value {
            font: var(--md-sys-typescale-body-small, 400 12px/16px Roboto, sans-serif); color: var(--md-sys-color-on-surface, var(--foreground));
          }
          :host-context([data-agy-theme="md3e"]) .head svg {
            margin-left: auto; width: 16px; height: 16px;
            color: var(--md-sys-color-on-surface-variant, var(--muted-foreground));
            rotate: 90deg;
            transition: rotate 300ms cubic-bezier(0.2, 0, 0, 1.2);
          }
          :host-context([data-agy-theme="md3e"]) .head[aria-expanded="false"] svg { rotate: 0deg; }
          :host-context([data-agy-theme="md3e"]) .summary {
            padding: 0 8px 8px; color: var(--md-sys-color-on-surface-variant, var(--muted-foreground));
            font: var(--md-sys-typescale-body-small, 400 12px/16px Roboto, sans-serif); font-variant-numeric: tabular-nums;
          }
          :host-context([data-agy-theme="md3e"]) .bar {
            position: relative; display: flex; gap: 3px; height: 6px; margin: 0 8px 4px;
          }
          :host-context([data-agy-theme="md3e"]) .seg {
            flex: var(--v) 1 0; min-width: 3px; border-radius: 3px; background: var(--c);
            transition: flex-grow var(--md-sys-motion-spatial-default-duration, 500ms) var(--md-sys-motion-spatial-default-easing, cubic-bezier(0.2, 0, 0, 1));
          }
          :host-context([data-agy-theme="md3e"]) .seg.free {
            background: var(--k-free);
          }
          :host-context([data-agy-theme="md3e"]) .bar::after {
            content: ""; position: absolute; right: 1px; top: 1px; width: 4px; height: 4px; border-radius: 50%;
            background: var(--md-sys-color-primary, var(--primary));
          }
          :host-context([data-agy-theme="md3e"]) .row {
            display: grid; grid-template-columns: 8px 1fr auto 44px 16px; align-items: center; gap: 8px;
            width: 100%; min-height: 28px; padding: 2px 8px; border-radius: var(--md-sys-shape-corner-full, 14px);
            font: var(--md-sys-typescale-body-small, 400 12px/16px Roboto, sans-serif); font-variant-numeric: tabular-nums;
            transition: background-color 15ms linear;
          }
          :host-context([data-agy-theme="md3e"]) .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
          :host-context([data-agy-theme="md3e"]) .n, :host-context([data-agy-theme="md3e"]) .p {
            text-align: end; color: var(--md-sys-color-on-surface-variant, var(--muted-foreground));
          }
          :host-context([data-agy-theme="md3e"]) .row svg {
            width: 14px; height: 14px; color: var(--md-sys-color-on-surface-variant, var(--muted-foreground));
            transition: rotate 300ms cubic-bezier(0.2, 0, 0, 1.2);
            rotate: 0deg;
          }
          :host-context([data-agy-theme="md3e"]) .row[aria-expanded="true"] svg { rotate: 90deg; }
          :host-context([data-agy-theme="md3e"]) .kids .row { grid-template-columns: 8px 1fr auto 44px 16px; min-height: 24px; opacity: 0.85; padding-left: 16px; }
          :host-context([data-agy-theme="md3e"]) .more { padding: 2px 8px 4px 32px; font-size: 11px; color: var(--md-sys-color-on-surface-variant, var(--muted-foreground)); }
        </style>
        <section aria-label="Context window" data-level="">
          <button class="head" aria-expanded="true"><span class="title">Context</span><span class="chip" hidden></span>${CHEVRON}</button>
          <div class="summary"></div>
          <div class="status" role="status" hidden></div>
          <div class="bar" role="meter" aria-label="Context used" aria-valuemin="0" aria-valuemax="100"></div>
          <div class="total" hidden><div class="total-label"></div><div class="total-value"></div></div>
          <div class="body"><div class="clip"><ul class="legend"></ul></div></div>
        </section>`;
      state = {
        section: shadow.querySelector('section'), head: shadow.querySelector('.head'), chip: shadow.querySelector('.chip'),
        summary: shadow.querySelector('.summary'), status: shadow.querySelector('.status'), bar: shadow.querySelector('.bar'),
        total: shadow.querySelector('.total'), totalLabel: shadow.querySelector('.total-label'), totalValue: shadow.querySelector('.total-value'),
        body: shadow.querySelector('.body'), legend: shadow.querySelector('.legend'),
      };
      state.head.addEventListener('click', () => {
        open = !open;
        state.head.setAttribute('aria-expanded', String(open));
        state.body.hidden = !open;
      });
      const toggleGroup = (e) => {
        const row = e.target.closest('.row[aria-expanded]');
        if (!row) return;
        const name = row.dataset.group;
        openGroups.has(name) ? openGroups.delete(name) : openGroups.add(name);
        row.setAttribute('aria-expanded', String(openGroups.has(name)));
        row.nextElementSibling.hidden = !openGroups.has(name);
      };
      state.legend.addEventListener('click', toggleGroup);
      state.legend.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(e); }
      });
    }
    list.prepend(hostEl);
    signature = '';
    return true;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const row = (color, name, tokens, share, group) => `
    <div class="row"${group ? ` aria-expanded="${openGroups.has(group)}" data-group="${esc(group)}" role="button" tabindex="0"` : ''} style="--c:${color}">
      <span class="dot"></span><span class="name">${esc(name)}</span><span class="n">${fmt(tokens)}</span><span class="p">${share}</span>${group ? CHEVRON : '<span></span>'}
    </div>`;

  let last = null;
  function render() {
    if (!state || !last) return;
    const { used, windowSize, total: conv } = last;
    const groups = base ?? [];
    const custom = groups.reduce((s, g) => s + g.tokens, 0);
    const parts = [];
    if (used != null) parts.push({ id: 'conversation', name: 'Conversation & system', tokens: Math.max(0, used - custom), color: color('conversation') });
    for (const g of groups) {
      parts.push({ id: `g${g.type}`, name: g.name, tokens: g.tokens, color: color(GROUP_KINDS[g.type] || 'other'), children: g.children });
    }
    const total = windowSize || Math.max(used ?? 0, custom) || 1;
    const free = windowSize && used != null ? Math.max(0, windowSize - used) : null;
    const share = windowSize && used != null ? used / windowSize : null;
    const [, level = '', message = ''] = (share != null && LEVELS.find(([at]) => share >= at)) || [];

    const convText = conv && (conv.input || conv.output)
      ? [`${fmt(conv.input)} in`, `${fmt(conv.output)} out`, conv.cache ? `${fmt(conv.cache)} cache` : ''].filter(Boolean).join(' · ')
      : '';
    const convLabel = conv?.from > 0 ? `This conversation, counted from step ${conv.from.toLocaleString('en-US')}` : 'This conversation';

    const sig = JSON.stringify([used, windowSize, convText, convLabel, parts.map((p) => [p.id, p.tokens]), [...openGroups]]);
    if (sig === signature) return;
    signature = sig;

    hostEl.hidden = used == null && !groups.length;
    state.section.dataset.level = level;
    state.chip.hidden = share == null;
    state.chip.textContent = share != null ? pct(used, windowSize) : '';
    state.summary.textContent = used == null
      ? 'No model response yet'
      : windowSize ? `${fmt(used)} of ${fmt(windowSize)} tokens used` : `${fmt(used)} tokens used`;
    state.status.hidden = !message;
    state.status.textContent = message;
    state.total.hidden = !convText;
    state.totalLabel.textContent = convLabel;
    state.totalValue.textContent = convText;
    state.bar.setAttribute('aria-valuenow', share != null ? String(Math.min(100, Math.round(share * 100))) : '0');

    // Segments keep their elements so the widths spring to new values
    const segs = [...parts, ...(free != null ? [{ id: 'free', tokens: free }] : [])];
    const ids = segs.map((s) => s.id).join();
    if (state.bar.dataset.ids !== ids) {
      state.bar.dataset.ids = ids;
      state.bar.innerHTML = segs.map((s) => `<span class="seg${s.id === 'free' ? ' free' : ''}" data-id="${s.id}"></span>`).join('');
    }
    for (const s of segs) {
      const el = state.bar.querySelector(`[data-id="${s.id}"]`);
      if (el) {
        el.style.setProperty('--v', String(Math.max(s.tokens / total, 0.004)));
        if (s.color) el.style.setProperty('--c', s.color);
      }
    }

    state.legend.innerHTML = [
      ...parts.map((p) => {
        const share = pct(p.tokens, total);
        if (!p.children?.length) return `<li>${row(p.color, p.name, p.tokens, share)}</li>`;
        const kids = p.children.slice(0, 8).map((c) => row(p.color, c.name, c.tokens, pct(c.tokens, total))).join('');
        const more = p.children.length > 8 ? `<div class="more">and ${p.children.length - 8} more</div>` : '';
        return `<li>${row(p.color, p.name, p.tokens, share, p.name)}<div class="kids"${openGroups.has(p.name) ? '' : ' hidden'}><div class="clip">${kids}${more}</div></div></li>`;
      }),
      free != null ? `<li>${row(color('free'), 'Free space', free, pct(free, total))}</li>` : '',
    ].join('');
  }

  function tick() {
    try {
      // Count even while the card is hidden: the app keeps only the last ~240
      // steps, so calls made meanwhile would otherwise fall out uncounted
      const slice = readSlice();
      const total = countTotal(slice);
      if (!mount()) return;
      if (document.hidden) return;
      last = { used: readUsage(slice), windowSize: readWindow(slice), total };
      refreshBase(slice);
      render();
    } catch {
      // app internals changed: leave the card as it was
    }
  }

  const timer = setInterval(tick, TICK_MS);
  tick();

  return {
    dispose() {
      clearInterval(timer);
      hostEl?.remove();
    },
  };
}
