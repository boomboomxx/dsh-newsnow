/**
 * Browser half of the NewsNow hot-news bundle.
 *
 * Three surfaces, one data path:
 *   - a sidebar panel entry (`sidebar.panellist` id `dsh-newsnow`)
 *   - its central panel (`main`, key `dsh-newsnow`): a responsive card grid,
 *     one card per enabled source, laid out the way the NewsNow site lays out
 *     its columns
 *   - a compact hot pill pinned to the New Session hero (`conversation.hero.options`)
 *
 * Everything reads `POST /api/dsh-newsnow/feed`, a route the Host half registers
 * on the connection Fetch bridge (same-origin, cookie authenticated). No Client
 * package is imported: this file is plain browser JavaScript handed to the
 * module loader, so it may only require the seed modules `react` and
 * `react/jsx-runtime`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-newsnow',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'newsnow'
    const PANEL_ID = 'dsh-newsnow'
    const FEED_PATH = 'api/dsh-newsnow/feed'
    const TEXT_PATH = 'api/dsh-newsnow/text'
    const REFRESH_MS = 5 * 60 * 1000
    const HOVER_DELAY_MS = 400
    /* Grace period after the pointer leaves an interactive (info) trigger:
     * long enough to travel onto the bubble, short enough to feel snappy. */
    const CLOSE_DELAY_MS = 240
    /** One upstream batch opens at most this many concurrent requests. */
    const BATCH_SIZE = 6
    /** localStorage key for the auto-refresh interval (seconds; 0 = off). */
    const AUTO_KEY = 'dsh-newsnow:auto-refresh'
    const SIDEBAR_KEY = 'dsh-newsnow:sidebar-browser'
    const AUTO_DEFAULT = 300
    const AUTO_CHOICES = [0, 60, 300, 900, 1800]
    /** NewsNow's own column width and gap, kept so the grid reads the same. */
    /*
     * The grid is driven by container query units, so column width and gutter
     * scale together as the panel narrows: a 1400px panel gets ~4 wide columns,
     * a 700px panel gets 2, and a stacked panel gets 1 with a tighter gutter.
     */
    const CARD_MIN_WIDTH = 320
    const CARD_MAX_WIDTH = 350
    const GRID_GAP = 24

    /**
     * Panel state that must survive `main`-slot remounts: switching to a
     * conversation or another panel unmounts this React subtree, so anything
     * kept in component state resets. The store and the embed browser already
     * live at module scope; these are the leftover bits of UI state.
     */
    const remembered = { scrollTop: 0, embedWidth: undefined, managing: false, cardOpen: {} }

    /**
     * UI strings live in locale/zh.json and locale/en.json ("text" section);
     * the Host serves them over /api/dsh-newsnow/text and apply() registers
     * them once they arrive. Components gate on the store textReady flag.
     */

    const GROUPS = ['tech', 'finance', 'news', 'community', 'social']
    const COLORS = [
      'blue',
      'sky',
      'cyan',
      'teal',
      'emerald',
      'green',
      'lime',
      'yellow',
      'orange',
      'red',
      'pink',
      'violet',
      'indigo',
      'slate',
      'gray',
    ]
    // Fallback tint table, used only when a descriptor arrives without one
    // (older host half); the host is the source of truth for card colours.
    const FALLBACK_TINT = [59, 130, 246]
    /** Fixed page background requested for the panel and the settings view. */
    const PAGE_RGB = 'rgb(241, 243, 245)'
    const tintOf = (source) => (Array.isArray(source.tint) && source.tint.length === 3 ? source.tint : FALLBACK_TINT)
    const tintAlpha = (tint, alpha) => `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${alpha})`

    /** Inline style sheet handed to the document once, owned by the plugin effect. */
    const STYLE_ID = 'dsh-newsnow-styles'
    const CSS = `
.dshnn-root { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); background:var(--dshnn-page); }
/* Ambient wash behind everything: the panel's stand-in for NewsNow's page background. */
.dshnn-ambient { position:absolute; inset:0; z-index:0; pointer-events:none; background-image:var(--dshnn-ambient); background-repeat:no-repeat; opacity:.55; }
.dshnn-grid { position:relative; z-index:1; }
/* Frosted surface: the card shell and the manager pane frost through this.
 * Card-local variables (set inline by SourceCard):
 *   --dshnn-wash  faint tint over the pane
 *   --dshnn-glow  corner glow colour
 *   --dshnn-edge  source colour used for the card border
 */
.dshnn-head-main { min-width:0; flex:1 1 160px; }
.dshnn-title { font-size:15px; font-weight:600; line-height:20px; }
.dshnn-sub { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:16px; margin-top:2px; }
.dshnn-btn { display:inline-flex; align-items:center; justify-content:center; gap:5px; height:28px; padding:0 10px; border-radius:8px; border:none; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; box-shadow:0 1px 2px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent); }
.dshnn-btn:hover { background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
.dshnn-btn:disabled { opacity:.55; cursor:default; }
.dshnn-btn-primary { border:none; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dshnn-btn-primary:hover { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent); }
.dshnn-btn-ghost { background:transparent; }

/* Responsive card grid: auto-fill columns down to one card on a narrow panel. */
.dshnn-grid { flex:1; min-height:0; overflow-y:auto; display:grid; align-content:start; container-type:inline-size;
  /* Gap and padding follow the panel width, then clamp to a sane range. */
  gap:clamp(12px, 2cqi, ${GRID_GAP}px);
  padding:0 clamp(10px, 2cqi, 18px) 24px;
  /* One column below 640px, then as many 320-350px cards as fit. */
  grid-template-columns:repeat(auto-fill, minmax(min(100%, clamp(280px, 26cqi, ${CARD_MAX_WIDTH}px)), 1fr));
}
/* Split view: the card wall on the left, the embedded browser docked beside it. */
.dshnn-split { position:relative; z-index:1; flex:1; min-height:0; display:flex; align-items:stretch; container-type:inline-size; }
/* The embedded browser pane: real guest webviews live inside .dshnn-embed-body. */
.dshnn-embed { position:relative; display:flex; flex-direction:column; min-width:0; min-height:0; align-self:stretch; flex:0 0 clamp(320px, 42%, 640px); margin:0 12px 24px 0; border-radius:16px; border:1px solid var(--dshnn-edge, var(--dsw-alias-border-l1)); background:var(--dshnn-pane); overflow:hidden; box-shadow:0 10px 28px -20px color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent); }
.dshnn-embed-hidden { display:none; }
.dshnn-embed-head { display:flex; align-items:center; gap:2px; padding:6px 8px; }
.dshnn-embed-addr { flex:1; min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:12px; color:var(--dsw-alias-label-secondary); padding:0 6px; }
/* Tab strip: one chip per guest page; the active tab lifts onto the pane. */
.dshnn-embed-tabs { display:flex; align-items:center; gap:4px; overflow-x:auto; padding:6px 8px; border-bottom:1px solid var(--dshnn-edge, var(--dsw-alias-border-l1)); scrollbar-width:none; }
.dshnn-embed-tabs::-webkit-scrollbar { display:none; }
.dshnn-embed-tab { display:inline-flex; align-items:center; gap:4px; max-width:180px; min-width:0; flex:0 0 auto; padding:3px 6px 3px 8px; border-radius:8px; border:1px solid transparent; background:transparent; font-size:12px; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dshnn-embed-tab:hover { background:var(--dsw-alias-bg-layer-2); }
.dshnn-embed-tab-on, .dshnn-embed-tab-on:hover { background:var(--dsw-alias-bg-layer-2); border-color:var(--dshnn-edge, var(--dsw-alias-border-l1)); color:var(--dsw-alias-label-primary); }
.dshnn-embed-tab-label { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; min-width:0; }
.dshnn-embed-tab-x { display:inline-flex; align-items:center; justify-content:center; padding:0; border:0; background:transparent; color:inherit; cursor:pointer; border-radius:4px; }
.dshnn-embed-tab-x:hover { background:var(--dshnn-edge, var(--dsw-alias-border-l1)); }
.dshnn-embed-err { padding:8px 12px; font-size:12px; color:var(--dsw-alias-state-error-primary); border-bottom:1px solid var(--dshnn-edge, var(--dsw-alias-border-l1)); }
.dshnn-embed-menu { position:absolute; z-index:200; display:flex; flex-direction:column; min-width:132px; padding:4px; border-radius:10px; border:1px solid var(--dshnn-edge, var(--dsw-alias-border-l1)); background:var(--dsw-alias-bg-layer-1); box-shadow:0 8px 24px rgba(0,0,0,0.14); }
.dshnn-embed-menu > button { border:0; background:transparent; text-align:left; font-size:12px; line-height:1.4; color:var(--dsw-alias-label-primary); padding:6px 10px; border-radius:6px; cursor:pointer; }
.dshnn-embed-menu > button:hover { background:var(--dsw-alias-bg-layer-2); }
.dshnn-embed-body { position:relative; flex:1; min-height:0; background:var(--dsw-alias-bg-base); }
/* Guests fill the body absolutely: percentage heights inside flex chains are unreliable for webviews. */
.dshnn-embed-body > webview { position:absolute; inset:0; width:100%; height:100%; border:0; background:var(--dsw-alias-bg-base); }
.dshnn-embed-body > webview[hidden] { display:none; }
/* A narrow panel can't fit a split view: the pane overlays instead of squeezing the cards. */
@container (max-width: 760px) {
  .dshnn-embed { position:absolute; inset:12px 12px 24px 12px; z-index:30; flex:0 0 auto; width:auto; }
}
/* Card = a faint colour wash over a frosted pane, plus a corner glow (sprinkle-*). */
.dshnn-card { position:relative; display:flex; flex-direction:column; min-width:0; height:clamp(300px, 46vh, 500px); border-radius:16px; padding:14px; border:1px solid var(--dshnn-edge, var(--dsw-alias-border-l1)); -webkit-backdrop-filter:var(--dshnn-blur); backdrop-filter:var(--dshnn-blur); background-image:radial-gradient(ellipse 90% 70% at 50% -20%, var(--dshnn-glow), transparent), linear-gradient(var(--dshnn-wash), var(--dshnn-wash)); background-color:var(--dshnn-pane); box-shadow:0 1px 2px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent), 0 10px 28px -20px color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent); transition:border-color .2s ease, box-shadow .2s ease, transform .2s ease; }
.dshnn-card:hover { border-color:var(--dshnn-edge, var(--dsw-alias-border-l2)); }
.dshnn-card[data-accent="blue"] { --dshnn-accent: var(--dsw-alias-brand-primary); }
.dshnn-card[data-accent="red"], .dshnn-card[data-accent="pink"] { --dshnn-accent: var(--dsw-alias-state-error-primary); }
.dshnn-card[data-accent="orange"], .dshnn-card[data-accent="yellow"] { --dshnn-accent: var(--dsw-alias-state-warn-primary); }
.dshnn-card[data-accent="green"] { --dshnn-accent: var(--dsw-alias-state-success-primary); }
.dshnn-card[data-accent="violet"] { --dshnn-accent: var(--dsw-alias-brand-primary); }
.dshnn-card-top { display:flex; align-items:flex-start; gap:10px; margin:0 2px 10px; }
.dshnn-badge { flex:0 0 auto; width:32px; height:32px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; color:var(--dsw-alias-bg-base); background:var(--dshnn-accent, var(--dsw-alias-brand-primary)); box-shadow:0 1px 2px -1px var(--dshnn-edge, transparent); }
.dshnn-card-id { min-width:0; flex:1; display:flex; flex-direction:column; gap:2px; }
.dshnn-card-name { display:flex; align-items:center; gap:6px; font-size:16px; font-weight:700; line-height:22px; min-width:0; }
.dshnn-card-name-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-tag { flex:0 0 auto; font-size:11px; line-height:16px; padding:0 5px; border-radius:5px; color:var(--dshnn-accent, var(--dsw-alias-label-secondary)); border:1px solid color-mix(in srgb, var(--dshnn-edge, var(--dsw-alias-border-l1)) 40%, transparent); background:color-mix(in srgb, var(--dshnn-wash) 60%, var(--dsw-alias-bg-layer-2)); }
.dshnn-card-meta { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-card-tools { display:flex; align-items:center; gap:2px; flex:0 0 auto; }
.dshnn-icon-btn { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; padding:0; border-radius:7px; border:1px solid transparent; background:transparent; color:var(--dshnn-accent, var(--dsw-alias-label-secondary)); cursor:pointer; }
.dshnn-icon-btn:hover { background:var(--dsw-alias-bg-layer-2); }
.dshnn-icon-btn:disabled { opacity:.5; cursor:default; }
.dshnn-scroll { position:relative; z-index:1; flex:1; min-height:0; overflow-y:auto; padding:6px; }
.dshnn-list { display:flex; flex-direction:column; gap:6px; margin:0; padding:0; list-style:none; }
.dshnn-row { display:flex; align-items:flex-start; gap:8px; padding:5px 6px; border-radius:8px; text-decoration:none; color:inherit; min-width:0; }
.dshnn-row:hover { background:var(--dsw-alias-bg-layer-2); }
.dshnn-rank { flex:0 0 20px; min-width:20px; height:20px; line-height:20px; text-align:center; border-radius:6px; font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.dshnn-row:nth-child(-n+3) .dshnn-rank { color:var(--dshnn-accent, var(--dsw-alias-label-primary)); background:color-mix(in srgb, var(--dshnn-edge, transparent) 14%, transparent); }
.dshnn-rank[data-top="true"] { color:var(--dsw-alias-bg-base); background:var(--dshnn-accent, var(--dsw-alias-brand-primary)); }
.dshnn-row-body { min-width:0; flex:1; display:flex; flex-direction:column; gap:2px; }
.dshnn-row-title { font-size:13px; line-height:19px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-row-hot { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-wire { display:flex; flex-direction:column; gap:4px; margin:0; padding:0 2px 0 8px; list-style:none; border-left:1px solid var(--dsw-alias-border-l1); }
.dshnn-wire-item { display:flex; flex-direction:column; gap:2px; padding:4px 6px; border-radius:8px; }
.dshnn-wire-item:hover { background:var(--dsw-alias-bg-layer-2); }
.dshnn-wire-meta { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshnn-wire-link { display:block; font-size:13px; line-height:19px; text-decoration:none; color:inherit; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-wire-link:hover { text-decoration:underline; }
.dshnn-card .dshnn-error { margin:6px; padding:8px 10px; border-radius:8px; border:1px solid var(--dsw-alias-state-error-primary); font-size:12px; color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; word-break:break-word; }
.dshnn-card .dshnn-note { padding:10px 8px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dshnn-skel { height:34px; margin:6px; border-radius:8px; background:var(--dsw-alias-bg-layer-2); animation:dshnn-pulse 1.4s ease-in-out infinite; }
@keyframes dshnn-pulse { 0%,100%{opacity:.5} 50%{opacity:1} }
.dshnn-empty { grid-column:1 / -1; padding:24px 8px; text-align:center; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dshnn-banner { display:flex; align-items:center; gap:10px; margin:14px 18px 0; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); font-size:12px; color:var(--dsw-alias-label-secondary); flex-wrap:wrap; }

/* Source manager: full-panel overlay so the grid keeps its own scroll position. */
/* The header stays pinned (Done always visible); only the body scrolls. */
.dshnn-modal { position:absolute; inset:0; z-index:30; display:flex; align-items:center; justify-content:center; padding:24px; background:color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent); }
.dshnn-dialog { display:flex; flex-direction:column; width:100%; max-width:720px; max-height:100%; min-height:0; border-radius:16px; border:1px solid var(--dsw-alias-border-l1); background:var(--dshnn-page); box-shadow:0 24px 60px -24px color-mix(in srgb, var(--dsw-alias-label-primary) 45%, transparent); }
.dshnn-dialog-head { display:flex; align-items:center; gap:8px; padding:14px 18px 10px; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dshnn-dialog-body { flex:1; min-height:0; overflow-y:auto; padding:14px 18px 18px; display:flex; flex-direction:column; gap:18px; }
.dshnn-dialog-footer { display:flex; justify-content:flex-end; gap:8px; padding:12px 18px; border-top:1px solid var(--dsw-alias-border-l1); }
.dshnn-manage-hint { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); }
.dshnn-group-title { font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); margin:0 0 8px; text-transform:none; }
/* Category sub-cards stack vertically; the channels inside are flat chips. */
.dshnn-group-card, .dshnn-panel-card { display:flex; flex-direction:column; gap:10px; padding:14px 16px; border-radius:16px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); transition:box-shadow .2s ease; }
.dshnn-group-card:hover, .dshnn-panel-card:hover { box-shadow:0 1px 2px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent), 0 10px 28px -20px color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent); }
.dshnn-chip-list { display:flex; flex-wrap:wrap; gap:8px; }
/* Chips stay transparent so the DSH surface shows through; the on state is a
 * brand border, hover is a neutral gray that flips with the theme. */
/* Chips are opaque base surfaces: white pills in light theme, dark base at night. */
.dshnn-chip { display:inline-flex; align-items:center; gap:2px; padding:3px 5px 3px 11px; border-radius:999px; border:1px solid transparent; background:var(--dsw-alias-bg-base); transition:border-color .15s ease, background-color .15s ease, opacity .15s ease; }
.dshnn-chip:hover { border-color:var(--dsw-alias-border-l1); background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
/* Active chips stay on the plain white surface: no brand border highlight. */
.dshnn-chip[data-on="false"] .dshnn-chip-btn { color:var(--dsw-alias-label-secondary); }
.dshnn-chip[data-pending="true"] { opacity:.6; }
.dshnn-chip-btn { display:inline-flex; align-items:center; gap:6px; border:none; background:transparent; padding:3px 4px; font:inherit; font-size:13px; font-weight:500; color:var(--dsw-alias-label-primary); cursor:pointer; }
.dshnn-chip-dot { flex:0 0 auto; width:7px; height:7px; border-radius:999px; }
.dshnn-chip-name { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-chip-remove { display:inline-flex; align-items:center; border:none; background:transparent; padding:3px; border-radius:50%; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.dshnn-chip-remove:hover { color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dshnn-form { display:grid; gap:8px; grid-template-columns:repeat(auto-fill, minmax(min(100%, 200px), 1fr)); align-items:end; }
.dshnn-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.dshnn-field-label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dshnn-input, .dshnn-select { height:30px; padding:0 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:12px; min-width:0; appearance:none; outline:none; }
.dshnn-input:hover { border-color:var(--dsw-alias-border-l2); }
.dshnn-input:focus, .dshnn-input:focus-visible { outline:none; border-color:var(--dsw-alias-brand-primary); box-shadow:none; }
.dshnn-select:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }

/*
 * Glass recipe. Every surface that frosts pulls its fill and blur from these
 * two variables, so the whole effect is tuned in one place:
 *   --dshnn-pane  translucent layer colour over the agent background
 *   --dshnn-blur  blur + saturation applied by backdrop-filter
 * Card-local variables (--dshnn-wash / -glow / -tint) carry the source colour
 * and are set inline per card by SourceCard.
 */
.dshnn-root, .dshnn-hero {
  --dshnn-pane: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 78%, transparent);
  --dshnn-blur: blur(14px) saturate(150%);
  /* Page tint: fixed light grey so the panel never reads as pure white. */
  --dshnn-page: ${PAGE_RGB};
  --dshnn-ambient: radial-gradient(ellipse 80% 60% at 50% -20%, var(--dsw-alias-bg-layer-2), transparent);
}
.dshnn-card, .dshnn-scroll {
  --dshnn-pane: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent);
  --dshnn-blur: blur(14px) saturate(150%);
}
.dshnn-card-head { display:flex; align-items:center; gap:6px; }
.dshnn-card-toggle { display:flex; align-items:center; gap:6px; flex:1; min-width:0; border:none; background:transparent; padding:2px 0; color:inherit; font:inherit; cursor:pointer; text-align:left; }
.dshnn-card-title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }
.dshnn-chev { display:inline-flex; flex:0 0 auto; color:var(--dsw-alias-label-secondary); transition:transform .15s ease; }
.dshnn-card-toggle[aria-expanded="false"] .dshnn-chev { transform:rotate(-90deg); }
.dshnn-count { flex:0 0 auto; padding:1px 8px; border-radius:999px; font-size:11px; color:var(--dsw-alias-label-secondary); background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.dshnn-tipwrap { position:relative; display:inline-flex; flex:0 0 auto; align-items:center; color:var(--dsw-alias-label-secondary); cursor:help; outline:none; }
.dshnn-tipwrap:hover, .dshnn-tipwrap:focus-visible { color:var(--dsw-alias-label-primary); }
.dshnn-card-body { display:flex; flex-direction:column; gap:10px; }
.dshnn-config-actions { display:flex; justify-content:flex-end; }

/* Hover popover: wraps any trigger, wraps text, flips at the viewport edges. */
.dshnn-pop { position:relative; display:block; min-width:0; }
.dshnn-pop-bubble { position:absolute; z-index:80; width:min(320px, 72vw); padding:8px 11px; border-radius:10px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:12px; font-weight:400; line-height:18px; white-space:normal; word-break:break-word; text-align:left; box-shadow:0 10px 28px -14px color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent); pointer-events:none; animation:dshnn-pop-in .18s ease; opacity:1; transform:none; transition:opacity .16s ease, transform .16s ease; }
.dshnn-pop-bubble[data-open="false"] { opacity:0; transform:translateY(3px); }
.dshnn-pop-bubble[data-interactive="true"] { pointer-events:auto; }
@keyframes dshnn-pop-in { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:none; } }
.dshnn-pop-inner { max-height:min(320px, 60vh); overflow-y:auto; }
.dshnn-pop-bubble::after { content:''; position:absolute; width:8px; height:8px; transform:rotate(45deg); background:var(--dsw-alias-bg-layer-1); }
.dshnn-pop-bottom::after { top:-4.5px; left:14px; border-left:1px solid var(--dsw-alias-border-l2); border-top:1px solid var(--dsw-alias-border-l2); }
.dshnn-pop-top::after { bottom:-4.5px; left:14px; border-right:1px solid var(--dsw-alias-border-l2); border-bottom:1px solid var(--dsw-alias-border-l2); }
/* Floating panel actions: stick to the top edge while the grid scrolls. */
.dshnn-fabs { position:sticky; top:0; z-index:25; grid-column:1 / -1; display:flex; justify-content:flex-end; gap:8px; padding:clamp(12px, 2cqi, 18px) 0 10px; margin:0; pointer-events:none; }
.dshnn-fabs > button { pointer-events:auto; }
.dshnn-fab { width:30px; height:30px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); box-shadow:0 2px 8px -4px color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent); }
.dshnn-fab:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.dshnn-fab[aria-pressed="true"] { color:var(--dsw-alias-label-primary); border-color:var(--dshnn-edge, var(--dsw-alias-border-l2)); background:var(--dsw-alias-bg-layer-2); }
/* Divider between the card wall and the pane: drag to resize (max 70% of the split). */
.dshnn-embed-drag { position:relative; z-index:6; flex:0 0 8px; margin:12px 0 24px; cursor:col-resize; touch-action:none; }
.dshnn-embed-drag::before { content:''; position:absolute; top:0; bottom:0; left:3px; width:2px; border-radius:1px; background:transparent; transition:background .15s ease; }
.dshnn-embed-drag:hover::before, .dshnn-embed-drag[data-dragging="true"]::before { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
@keyframes dshnn-spin { to { transform:rotate(360deg); } }
.dshnn-spin { animation:dshnn-spin .9s linear infinite; }
/* Narrow panels: less blur so text stays crisp when cards stack to one column. */
@media (max-width: 640px) {
  .dshnn-root, .dshnn-card, .dshnn-scroll { --dshnn-blur: blur(8px) saturate(140%); }
}
.dshnn-config { margin:0; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-border-l1); background:transparent; font-size:11px; line-height:16px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; word-break:break-word; overflow-x:auto; }
.dshnn-hero { display:inline-flex; align-items:center; gap:6px; height:28px; max-width:260px; padding:0 10px; border-radius:999px; border:1px solid var(--dsw-alias-border-l1); background:var(--dshnn-pane); -webkit-backdrop-filter:var(--dshnn-blur); backdrop-filter:var(--dshnn-blur); color:var(--dsw-alias-label-primary); font-size:12px; cursor:pointer; }
.dshnn-hero:hover { background:var(--dsw-alias-bg-layer-2); }
.dshnn-hero-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-warn-primary); flex:0 0 auto; }
.dshnn-hero-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshnn-glyph { display:inline-flex; align-items:center; justify-content:center; }
.dshnn-seg {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 5%, var(--dsw-alias-bg-base));
}
.dshnn-seg-item {
  height: 24px;
  padding: 0 10px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.dshnn-seg-item:hover { color: var(--dsw-alias-label-primary); }
.dshnn-seg-on {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent);
}
.dshnn-field { position: relative; }
.dshnn-dropdown { position: relative; display: flex; }
.dshnn-select-btn {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 108px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  cursor: pointer;
}
.dshnn-select-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshnn-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 8;
  min-width: 100%;
  max-height: 220px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 10px 28px -14px color-mix(in srgb, var(--dsw-alias-label-primary) 35%, transparent);
}
.dshnn-menu-item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
.dshnn-menu-item:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.dshnn-menu-on { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); color: var(--dsw-alias-label-primary); font-weight: 600; }
.dshnn-menu-check { color: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.dshnn-select-btn:focus-visible,
.dshnn-seg-item:focus-visible,
.dshnn-menu-item:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent);
}
@media (max-width: 640px) {
  .dshnn-grid { gap:14px; padding:12px; }
  .dshnn-card { height:min(60vh, 420px); }
  .dshnn-dialog-body { padding:12px; }
}
/* Dark theme: the app palette mirrors into prefers-color-scheme (Electron nativeTheme), so
   the page tint follows the theme instead of staying light grey, and cards drop the tinted
   wash for a neutral elevated surface with a hairline border (text already uses label tokens). */
@media (prefers-color-scheme: dark) {
  .dshnn-root { --dshnn-page: var(--dsw-alias-bg-base); }
  .dshnn-ambient { opacity:.25; }
  .dshnn-card { background-image:none; border-color:var(--dsw-alias-border-l1); box-shadow:0 1px 2px -1px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent); }
  .dshnn-group-card, .dshnn-panel-card { background:var(--dsw-alias-bg-layer-2); }
  .dshnn-chip { background:var(--dsw-alias-bg-layer-1); }
  .dshnn-input, .dshnn-select, .dshnn-select-btn { background:var(--dsw-alias-bg-layer-1); }
  .dshnn-seg { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, var(--dsw-alias-bg-layer-1)); }
  .dshnn-seg-item.dshnn-seg-on, .dshnn-seg-item.dshnn-seg-on:hover { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); box-shadow:none; }
}
`

    /** Write the stylesheet into the document once; the disposer removes it. */
    function useStyles() {
      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        let node = document.getElementById(STYLE_ID)
        if (node !== null && node !== undefined) {
          node.dataset.refs = String(Number(node.dataset.refs ?? '0') + 1)
          return () => {
            if (node === null) return
            const next = Number(node.dataset.refs ?? '1') - 1
            node.dataset.refs = String(Math.max(0, next))
            if (next <= 0) node.remove()
          }
        }
        node = document.createElement('style')
        node.id = STYLE_ID
        node.dataset.refs = '1'
        node.textContent = CSS
        document.head.appendChild(node)
        return () => {
          if (node !== null) node.remove()
        }
      }, [])
    }

    /** Two-digit clock text for the "updated at" note. */
    function clockText(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      try {
        return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /**
     * Relative time for realtime rows: `pubDate` is an epoch in milliseconds.
     * Under a minute reads 刚刚 / just now, then minutes, hours and days; anything
     * older falls back to a short calendar date so stale feeds stay readable.
     */
    function relativeTime(timestamp, t) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return ''
      const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
      if (seconds < 60) return t('justNow')
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return t('minAgo', { n: minutes })
      const hours = Math.round(minutes / 60)
      if (hours < 24) return t('hourAgo', { n: hours })
      const days = Math.round(hours / 24)
      if (days < 7) return t('dayAgo', { n: days })
      try {
        return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      } catch {
        return ''
      }
    }

    /** First character of a source name, used as the avatar in the card header. */
    function initial(name) {
      const text = typeof name === 'string' ? name.trim() : ''
      if (text === '') return '?'
      const first = Array.from(text)[0]
      return first === undefined ? '?' : first.toUpperCase()
    }

    /** Group id to a localized heading. */
    function groupLabel(t, group) {
      const key = `group${String(group ?? '').replace(/^./, (c) => c.toUpperCase())}`
      const probe = t(key)
      return probe === key ? String(group ?? '') : probe
    }

    /**
     * Talk to the Host. `body` is a control message (`action`) or a read
     * (`id`); both ride the same route so the panel has one code path.
     */
    async function requestFeed(body, options) {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        credentials: 'same-origin',
      }
      if (options?.signal !== undefined) init.signal = options.signal
      const response = await fetch(FEED_PATH, init)
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined || payload === null || typeof payload !== 'object') {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      if (payload.ok !== true) {
        const message = payload.error?.message
        throw new Error(typeof message === 'string' && message !== '' ? message : `${response.status}`)
      }
      return payload
    }

    /** Read the saved auto-refresh interval; anything odd falls back to the default. */
    function loadAutoSeconds() {
      try {
        const raw = window.localStorage?.getItem(AUTO_KEY)
        const seconds = Number(raw)
        return AUTO_CHOICES.includes(seconds) ? seconds : AUTO_DEFAULT
      } catch {
        return AUTO_DEFAULT
      }
    }

    /** Persist the auto-refresh interval; storage failures keep the choice in memory. */
    function saveAutoSeconds(seconds) {
      try {
        window.localStorage?.setItem(AUTO_KEY, String(seconds))
      } catch {
        /* private mode or blocked storage: the interval simply stays for this session */
      }
    }

    /** Desktop Electron bridge: real webview guests, present only in the app shell. */
    const desktopBridge = (() => {
      try {
        const carrier = globalThis.dshDesktop
        return carrier?.protocolVersion === 1 ? carrier.browser : undefined
      } catch {
        return undefined
      }
    })()

    /** Normalise a stored link mode; legacy boolean strings map onto the new choices. */
    function normalizeLinkMode(value) {
      if (value === 'embed' || value === 'sidebar' || value === 'system') return value
      if (value === 'on') return 'sidebar'
      if (value === 'off') return 'system'
      return undefined
    }

    /** Read the link-target preference; the embedded pane wins on the desktop app. */
    function loadLinkMode() {
      let stored
      try {
        stored = normalizeLinkMode(window.localStorage?.getItem(SIDEBAR_KEY))
      } catch {
        stored = undefined
      }
      return stored ?? (desktopBridge === undefined ? 'sidebar' : 'embed')
    }

    /** Persist the link-target preference; storage failures keep it for this session. */
    function saveLinkMode(mode) {
      try {
        window.localStorage?.setItem(SIDEBAR_KEY, mode)
      } catch {
        /* private mode or blocked storage: the choice simply stays for this session */
      }
    }

    /* ------------------------------------------------ embedded browser pane */

    /**
     * A real in-panel browser for the Desktop shell: leases a guest webview
     * through the app's own desktop bridge — the exact acquire →
     * about:blank#lease → partition attach dance the sidebar browser uses, so
     * the main process's will-attach-webview gate approves the guest — and
     * parks it inside the newsnow panel as a split-view sidebar. Absent on
     * the web, where the pane simply never renders.
     */
    function createEmbedBrowser(bridge) {
      const WORKSPACE = 'cwd:dsh-newsnow'
      const TABS_KEY = 'dsh-newsnow:embed-tabs'
      const listeners = new Set()
      let seq = 0
      let host = undefined // the .dshnn-embed-body container
      let tabs = [] // { id, lease, element, url, title, loading, ready, canGoBack, canGoForward, pendingLoad }
      let activeId = undefined
      let snapshot = { open: false, tabs: [], active: undefined, canGoBack: false, canGoForward: false, error: undefined }
      const activeTab = () => tabs.find((tab) => tab.id === activeId)
      const publish = (patch) => {
        snapshot = { ...snapshot, ...patch }
        for (const listener of [...listeners]) listener()
      }
      const tabRows = () => tabs.map(({ id, url, title, loading }) => ({ id, url, title, loading }))
      /*
       * Tab memory: urls and titles survive pane closes, panel switches and
       * restarts in localStorage. A record without a live guest is a "ghost"
       * tab; clicking it (or opening the pane) lazily rebuilds the guest.
       */
      try {
        const saved = JSON.parse(window.localStorage?.getItem(TABS_KEY) ?? 'null')
        if (saved?.version === 1 && Array.isArray(saved.tabs)) {
          const rows = []
          for (const row of saved.tabs) {
            if (typeof row?.url !== 'string' || /^https?:/i.test(row.url) !== true) continue
            rows.push({
              id: typeof row.id === 'string' ? row.id : `dshnn-tab-${++seq}`,
              lease: undefined,
              element: undefined,
              url: row.url,
              title: typeof row.title === 'string' ? row.title : '',
              loading: false,
              ready: false,
              canGoBack: false,
              canGoForward: false,
              pendingLoad: undefined,
            })
          }
          if (rows.length > 0) {
            tabs = rows
            seq = Number.isInteger(saved.seq) ? saved.seq : rows.length
            if (tabs.some((tab) => tab.id === saved.active)) activeId = saved.active
          }
        }
      } catch {
        /* corrupt state: start clean */
      }
      snapshot = { open: false, tabs: tabRows(), active: activeId, canGoBack: false, canGoForward: false, error: undefined }
      const persist = () => {
        try {
          window.localStorage?.setItem(
            TABS_KEY,
            JSON.stringify({ version: 1, seq, active: activeId, tabs: tabs.map(({ id, url, title }) => ({ id, url, title })) }),
          )
        } catch {
          /* storage unavailable: memory-only session */
        }
      }
      const syncTabRows = () => {
        publish({ tabs: tabRows(), active: activeId })
        persist()
      }
      const releaseLease = (lease) => {
        try {
          const released = bridge.release(lease)
          if (typeof released?.catch === 'function') released.catch(() => {})
        } catch {
          /* already gone */
        }
      }
      /** Drop a record entirely (user intent: the tab disappears). */
      const destroyTab = (tab) => {
        if (tab.lease !== undefined) releaseLease(tab.lease)
        try {
          tab.element?.remove()
        } catch {
          /* already detached */
        }
        tab.lease = undefined
        tab.element = undefined
        tabs = tabs.filter((entry) => entry !== tab)
      }
      /**
       * The guest died on its own (pane unmount, crash): demote the record to
       * a ghost and keep the tab. A later click or attach rebuilds it.
       */
      const guestDied = (tab) => {
        if (tab.lease !== undefined) releaseLease(tab.lease)
        tab.lease = undefined
        tab.element = undefined
        tab.ready = false
        tab.loading = false
        tab.pendingLoad = undefined
        if (activeId === tab.id && snapshot.open === true && host !== undefined) {
          const neighbor = tabs.find((entry) => entry !== tab)
          if (neighbor !== undefined) {
            activate(neighbor.id)
            return
          }
          publish({ open: false, canGoBack: false, canGoForward: false, error: undefined })
        }
        syncTabRows()
      }
      const observe = (tab) => {
        try {
          tab.url = tab.element.getURL() || tab.url
          tab.title = tab.element.getTitle() || ''
          tab.loading = tab.element.isLoading()
          tab.canGoBack = tab.element.canGoBack()
          tab.canGoForward = tab.element.canGoForward()
        } catch {
          /* a torn-down guest throws on access; the next event cleans up */
        }
        syncTabRows()
        if (tab.id === activeId) publish({ canGoBack: tab.canGoBack, canGoForward: tab.canGoForward })
      }
      const activate = (id) => {
        activeId = id
        for (const tab of tabs) {
          try {
            if (tab.element !== undefined) tab.element.hidden = tab.id !== id
          } catch {
            /* detached */
          }
        }
        const tab = activeTab()
        publish({ active: id, canGoBack: tab?.canGoBack ?? false, canGoForward: tab?.canGoForward ?? false, error: tab?.error })
        syncTabRows()
        if (tab !== undefined) void ensureGuest(tab)
      }
      /**
       * Lazily (re)build the webview guest behind a tab record. Concurrent
       * callers share one in-flight build (activate() fires it eagerly and
       * show() awaits the same promise).
       */
      const ensureGuest = (tab) => {
        if (tab.pendingGuest !== undefined) return tab.pendingGuest
        tab.pendingGuest = (async () => {
          if (tab.element !== undefined) {
            if (tab.element.isConnected) return true
            /* stale guest from a previous mount: its lease died with the DOM */
            if (tab.lease !== undefined) releaseLease(tab.lease)
            tab.element = undefined
            tab.lease = undefined
            tab.ready = false
          }
          if (bridge === undefined) return false
          let reservation
          try {
            reservation = await bridge.acquire(WORKSPACE)
          } catch {
            return false
          }
        const el = document.createElement('webview')
        el.className = 'dshnn-embed-view'
        el.dataset.sidebarBrowserFrame = 'webview'
        el.setAttribute('name', reservation.lease)
        el.setAttribute('partition', reservation.partition)
        el.setAttribute('allowpopups', '')
        el.setAttribute('src', `about:blank#${reservation.lease}`)
        tab.lease = reservation.lease
        tab.element = el
        tab.loading = true
        tab.pendingLoad = tab.url
        el.addEventListener('dom-ready', () => {
          tab.ready = true
          observe(tab)
          const target = tab.pendingLoad
          tab.pendingLoad = undefined
          if (target !== undefined) el.loadURL(target).catch(() => {})
        })
        el.addEventListener('did-navigate', () => observe(tab))
        el.addEventListener('did-navigate-in-page', (event) => {
          if (event?.isMainFrame !== false) observe(tab)
        })
        el.addEventListener('did-start-navigation', (event) => {
          if (event?.isMainFrame !== false) {
            tab.loading = true
            syncTabRows()
            if (tab.id === activeId) publish({ error: undefined })
          }
        })
        el.addEventListener('page-title-updated', () => observe(tab))
        el.addEventListener('did-fail-load', (event) => {
          if (event?.isMainFrame && event?.errorCode !== -3) {
            tab.loading = false
            syncTabRows()
            if (tab.id === activeId) publish({ error: event.errorDescription || String(event.errorCode) })
          }
        })
        el.addEventListener('render-process-gone', () => guestDied(tab))
        el.addEventListener('destroyed', () => guestDied(tab))
        el.hidden = tab.id !== activeId
        if (host !== undefined) host.appendChild(el)
        try {
          /* Popups load into the active tab instead of escaping the panel. */
          bridge.onOpenRequested(reservation.lease, (popup) => embed.navigate(popup))
        } catch {
          /* popup relay is best-effort */
        }
        syncTabRows()
        return true
        })()
        return tab.pendingGuest.finally(() => {
          tab.pendingGuest = undefined
        })
      }
      const embed = {
        get desktop() {
          return bridge !== undefined
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        /** Mount the tab guests into the pane container (idempotent per container). */
        attach(container) {
          if (container === null || container === undefined) {
            /* The pane unmounted: guests die with their DOM and demote to ghosts. */
            host = undefined
            return
          }
          if (host === container) return
          host = container
          host.replaceChildren()
          for (const tab of tabs) {
            if (tab.element !== undefined) {
              if (tab.element.isConnected === false) {
                /* stale guest: tear the lease down, the active tab rebuilds */
                if (tab.lease !== undefined) releaseLease(tab.lease)
                tab.element = undefined
                tab.lease = undefined
                tab.ready = false
                continue
              }
              host.appendChild(tab.element)
            }
          }
          if (activeId !== undefined) activate(activeId)
        },
        /** Open a tab on a URL (reuses a tab already showing it). */
        async show(url) {
          publish({ open: true, error: undefined })
          let tab = tabs.find((entry) => entry.url === url)
          if (tab === undefined) {
            tab = {
              id: `dshnn-tab-${++seq}`,
              lease: undefined,
              element: undefined,
              url,
              title: '',
              loading: true,
              ready: false,
              canGoBack: false,
              canGoForward: false,
              pendingLoad: undefined,
            }
            tabs.push(tab)
          }
          activate(tab.id)
          /* Wait for the guest before reporting success: a refused bridge must
             fall back to the sidebar chain instead of leaving both open. */
          const built = await ensureGuest(tab)
          if (built !== true) {
            publish({ error: 'bridge' })
            return false
          }
          return true
        },
        /** Reopen the pane on the remembered tab (after a close or restart). */
        restore() {
          if (tabs.length === 0) return false
          publish({ open: true, error: undefined })
          activate(activeId ?? tabs[tabs.length - 1].id)
          return true
        },
        /** Load a URL into the active tab (popups and relays land here). */
        navigate(url) {
          const tab = activeTab()
          if (tab === undefined) {
            void embed.show(url)
            return
          }
          try {
            tab.url = url
            tab.pendingLoad = tab.ready ? undefined : url
            syncTabRows()
            if (tab.ready) tab.element.loadURL(url).catch(() => {})
          } catch {
            /* guest gone */
          }
        },
        activate(id) {
          if (tabs.some((tab) => tab.id === id)) activate(id)
        },
        closeTab(id) {
          const index = tabs.findIndex((tab) => tab.id === id)
          if (index === -1) return
          const wasActive = activeId === id
          destroyTab(tabs[index])
          if (tabs.length === 0) {
            embed.closeAll()
            return
          }
          if (wasActive) activate((tabs[index] ?? tabs[index - 1]).id)
          else syncTabRows()
        },
        /** Context menu: keep the chosen tab, close the rest. */
        closeOthers(keepId) {
          if (tabs.some((tab) => tab.id === keepId) !== true) {
            embed.closeAll()
            return
          }
          for (const tab of [...tabs]) {
            if (tab.id !== keepId) destroyTab(tab)
          }
          activate(keepId)
        },
        /** Context menu: forget every tab and shut the pane. */
        closeAll() {
          for (const tab of [...tabs]) destroyTab(tab)
          activeId = undefined
          publish({ open: false, tabs: [], active: undefined, canGoBack: false, canGoForward: false, error: undefined })
          if (host !== undefined) host.replaceChildren()
          persist()
        },
        /** Context menu: hand a tab's URL to the system browser. */
        openExternal(url) {
          if (typeof url !== 'string' || /^https?:/i.test(url) !== true) return
          try {
            globalThis.open(url, '_blank', 'noopener')
          } catch {
            /* shell may refuse popups */
          }
        },
        back() {
          try {
            activeTab()?.element.goBack()
          } catch {
            /* guest gone */
          }
        },
        forward() {
          try {
            activeTab()?.element.goForward()
          } catch {
            /* guest gone */
          }
        },
        reload() {
          try {
            activeTab()?.element.reload()
          } catch {
            /* guest gone */
          }
        },
        /** Hide the pane but keep every tab for the next open. */
        close() {
          for (const tab of [...tabs]) {
            if (tab.lease !== undefined) releaseLease(tab.lease)
            try {
              tab.element?.remove()
            } catch {
              /* already detached */
            }
            tab.lease = undefined
            tab.element = undefined
            tab.ready = false
            tab.loading = false
            tab.pendingLoad = undefined
          }
          publish({ open: false, canGoBack: false, canGoForward: false, error: undefined })
          if (host !== undefined) host.replaceChildren()
          persist()
        },
      }
      return embed
    }
    /**
     * Panel-local store: the source directory (with enable flags), one feed per
     * source, the manager's working state, and every action the UI offers.
     */
    function createFeedStore() {
      let snapshot = {
        sources: [],
        baseUrl: '',
        refreshSeconds: 300,
        feeds: {},
        directoryError: undefined,
        refreshing: false,
        loaded: false,
        autoSeconds: loadAutoSeconds(),
        linkMode: loadLinkMode(),
        /* Locale dictionaries arrive over /api/dsh-newsnow/text; until then
           components render their loading skeleton instead of raw keys. */
        textReady: false,
      }
      /*
       * One small task queue feeds every read path (directory warm-up, lazy
       * cards, manual refresh), so the panel opens at most BATCH_SIZE upstream
       * requests at once no matter how many cards are on screen.
       */
      const queue = { list: [], active: 0, drained: [] }
      const pump = () => {
        while (queue.active < BATCH_SIZE && queue.list.length > 0) {
          const task = queue.list.shift()
          queue.active += 1
          void Promise.resolve()
            .then(task)
            .finally(() => {
              queue.active -= 1
              if (queue.active === 0 && queue.list.length === 0) {
                for (const notify of queue.drained.splice(0)) notify()
              }
              pump()
            })
        }
      }
      const enqueue = (task) => {
        queue.list.push(task)
        pump()
      }
      const whenDrained = () =>
        queue.active === 0 && queue.list.length === 0
          ? Promise.resolve()
          : new Promise((resolve) => queue.drained.push(resolve))
      const listeners = new Set()
      const publish = (next) => {
        snapshot = { ...snapshot, ...next }
        for (const listener of [...listeners]) listener()
      }
      let directoryRequested
      let lastConfig
      let lastAuto = 0

      const enabledSources = () => snapshot.sources.filter((source) => source.enabled)

      /**
       * The Host keeps both panel preferences in its own state file, which
       * outlives this browser's localStorage. When a directory or control
       * response carries them, the Host's saved values win: reconcile the
       * local copies so a fresh browser — or another machine — converges on
       * the persisted choice.
       */
      function adoptPrefs(prefs) {
        if (prefs === null || typeof prefs !== 'object') return
        if (AUTO_CHOICES.includes(prefs.autoRefresh) && prefs.autoRefresh !== loadAutoSeconds()) {
          saveAutoSeconds(prefs.autoRefresh)
          publish({ autoSeconds: prefs.autoRefresh })
        }
        if (prefs.sidebarBrowser !== undefined) {
          const mode = normalizeLinkMode(prefs.sidebarBrowser)
          if (mode !== undefined && mode !== loadLinkMode()) {
            saveLinkMode(mode)
            publish({ linkMode: mode })
          }
        }
      }

      const store = {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        /** Enabled sources in panel order. */
        enabled() {
          return enabledSources()
        },
        /** Persisted-config snippet the Host last reported, if any. */
        config() {
          return lastConfig
        },
        /** Locale dictionaries arrived (or gave up): stop gating on them. */
        markTextReady() {
          if (snapshot.textReady !== true) publish({ textReady: true })
        },
        async loadDirectory(options) {
          if (directoryRequested !== undefined && options?.force !== true) return directoryRequested
          directoryRequested = (async () => {
            try {
              const payload = await requestFeed({})
              const sources = Array.isArray(payload.sources) ? payload.sources : []
              publish({
                sources,
                baseUrl: typeof payload.baseUrl === 'string' ? payload.baseUrl : '',
                refreshSeconds: typeof payload.refreshSeconds === 'number' ? payload.refreshSeconds : 300,
                directoryError: undefined,
                loaded: true,
              })
              adoptPrefs(payload.prefs)
              // Warm the first screenful through the shared batch queue; cards
              // further down load lazily as they scroll into view.
              const first = sources.filter((source) => source.enabled).slice(0, BATCH_SIZE)
              for (const source of first) enqueue(() => store.loadSource(source.id))
            } catch (error) {
              publish({ directoryError: error instanceof Error ? error.message : String(error), loaded: true })
            } finally {
              directoryRequested = undefined
            }
          })()
          return directoryRequested
        },
        async loadSource(sourceId, options) {
          if (typeof sourceId !== 'string' || sourceId === '') return
          const existing = snapshot.feeds[sourceId]
          const force = options?.force === true
          if (!force && existing !== undefined && existing.pending !== true && Date.now() - existing.fetchedAt < REFRESH_MS) {
            return
          }
          publish({
            feeds: {
              ...snapshot.feeds,
              [sourceId]: { ...(existing ?? { items: [] }), pending: true, error: undefined },
            },
          })
          try {
            const payload = await requestFeed({ id: sourceId, force })
            const value = payload.value ?? { id: sourceId, items: [] }
            publish({
              feeds: {
                ...snapshot.feeds,
                [sourceId]: {
                  items: Array.isArray(value.items) ? value.items : [],
                  fetchedAt: Date.now(),
                  updatedTime: typeof value.updatedTime === 'number' ? value.updatedTime : undefined,
                  stale: value.stale === true,
                  pending: false,
                  error: value.status === 'error' && typeof value.error === 'string' ? value.error : undefined,
                },
              },
            })
          } catch (error) {
            publish({
              feeds: {
                ...snapshot.feeds,
                [sourceId]: {
                  items: existing?.items ?? [],
                  fetchedAt: existing?.fetchedAt ?? 0,
                  pending: false,
                  error: error instanceof Error ? error.message : String(error),
                },
              },
            })
          }
        },
        /**
         * A card scrolled (or rendered) into view: load its feed through the
         * shared queue unless a fresh read already covers it.
         */
        ensureVisible(sourceId) {
          const source = snapshot.sources.find((entry) => entry.id === sourceId)
          if (source === undefined || !source.enabled) return
          const existing = snapshot.feeds[sourceId]
          if (
            existing !== undefined &&
            (existing.pending === true ||
              Date.now() - existing.fetchedAt < REFRESH_MS ||
              (existing.items.length > 0 && existing.error !== undefined))
          ) {
            return
          }
          enqueue(() => store.loadSource(sourceId))
        },
        /** Resolves once no queued read is running or waiting. */
        drained() {
          return whenDrained()
        },
        /** Read every enabled source through the batch queue. */
        async refreshAll() {
          const ids = enabledSources().map((source) => source.id)
          if (ids.length === 0 || snapshot.refreshing) return
          publish({ refreshing: true })
          let remaining = ids.length
          for (const id of ids) {
            enqueue(() =>
              store.loadSource(id, { force: true }).finally(() => {
                remaining -= 1
                if (remaining === 0) publish({ refreshing: false })
              }),
            )
          }
        },
        /** Change the auto-refresh interval and persist the choice. */
        setAutoSeconds(seconds) {
          const next = AUTO_CHOICES.includes(seconds) ? seconds : AUTO_DEFAULT
          saveAutoSeconds(next)
          publish({ autoSeconds: next })
          /* Mirror the choice into the Host's persistent state file. */
          void requestFeed({ action: 'set-prefs', prefs: { autoRefresh: next } }).catch(() => {})
        },
        /** Choose where links open and persist the choice. */
        setLinkMode(mode) {
          const next = normalizeLinkMode(mode) ?? loadLinkMode()
          saveLinkMode(next)
          publish({ linkMode: next })
          /* Mirror the choice into the Host's persistent state file. */
          void requestFeed({ action: 'set-prefs', prefs: { sidebarBrowser: next } }).catch(() => {})
        },
        /**
         * Timer tick (called from the module effect): fires one batched
         * refresh when the chosen interval has elapsed.
         */
        maybeAutoRefresh(now) {
          const seconds = snapshot.autoSeconds
          if (!seconds || snapshot.refreshing || enabledSources().length === 0) return false
          if (now - lastAuto < seconds * 1000) return false
          lastAuto = now
          void store.refreshAll()
          return true
        },
        /** Apply one control message, then adopt the returned directory. */
        async control(message) {
          const payload = await requestFeed(message)
          if (Array.isArray(payload.sources)) {
            lastConfig = payload.config
            // Keep object identity for every source the control did not
            // touch, so memoised rows and cards skip their re-render and a
            // toggle stays a strictly local update.
            const previous = new Map(snapshot.sources.map((source) => [source.id, source]))
            const same = (old, next) =>
              old !== undefined &&
              old.enabled === next.enabled &&
              old.name === next.name &&
              old.title === next.title &&
              old.group === next.group &&
              old.color === next.color &&
              old.type === next.type &&
              old.home === next.home &&
              old.builtin === next.builtin
            publish({
              sources: payload.sources.map((source) => {
                const old = previous.get(source.id)
                return same(old, source) ? old : source
              }),
              directoryError: undefined,
            })
          }
          adoptPrefs(payload.prefs)
          return payload
        },
        async setEnabled(sourceId, enabled) {
          await store.control({ action: enabled ? 'enable' : 'disable', id: sourceId })
          if (enabled) void store.loadSource(sourceId)
        },
        async addCustom(source) {
          const payload = await store.control({ action: 'add-custom', source })
          const created = payload.sources.find((entry) => entry.id === source.id)
          if (created !== undefined && created.enabled) void store.loadSource(created.id)
          return payload
        },
        async removeCustom(sourceId) {
          return store.control({ action: 'remove-custom', id: sourceId })
        },
        async setAll(enabled) {
          const sources = snapshot.sources
          const target = sources.filter((source) => source.enabled !== enabled)
          for (const source of target) {
            await store.control({ action: enabled ? 'enable' : 'disable', id: source.id })
          }
          if (enabled) void store.refreshAll()
        },
      }
      return store
    }

    /** React binding for the store. */
    function useFeed(store) {      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /** Subscribe a component to the embedded browser pane's live state. */
    function useEmbed(embed) {
      return React.useSyncExternalStore((onChange) => embed.subscribe(onChange), embed.getSnapshot, embed.getSnapshot)
    }

    /** The sidebar glyph; `props.size` is the width the sidebar reserves. */
    function PanelGlyph(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h(
        'span',
        { className: 'dshnn-glyph', style: { width: size, height: size }, 'aria-hidden': 'true' },
        h(
          'svg',
          {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('path', { d: 'M4 5.5h11.5a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z' }),
          h('path', { d: 'M16.5 9.5H20a1 1 0 0 1 1 1V17a2.5 2.5 0 0 1-2.5 2.5H16.5' }),
          h('path', { d: 'M6.8 9.6h4.6M6.8 12.6h6.6M6.8 15.6h3.4' }),
          h('circle', { cx: 19, cy: 5.5, r: 2.1, fill: 'currentColor', stroke: 'none' }),
        ),
      )
    }

    /** A small icon set, drawn inline so the module imports nothing. */
    function Icon(props) {
      const { name, size = 15, className } = props
      const common = {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        className,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }
      if (name === 'refresh') {
        return h(
          'svg',
          common,
          h('path', { d: 'M20 12a8 8 0 1 1-2.3-5.6' }),
          h('path', { d: 'M20 4v4h-4' }),
        )
      }
      if (name === 'close') return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
      if (name === 'browser') {
        return h(
          'svg',
          common,
          h('circle', { cx: '12', cy: '12', r: '8.2' }),
          h('path', { d: 'M3.8 12h16.4' }),
          h('path', { d: 'M12 3.8c2.7 2.4 2.7 14 0 16.4' }),
          h('path', { d: 'M12 3.8c-2.7 2.4-2.7 14 0 16.4' }),
        )
      }
      if (name === 'back') return h('svg', common, h('path', { d: 'M15 5l-7 7 7 7' }))
      if (name === 'forward') return h('svg', common, h('path', { d: 'M9 5l7 7-7 7' }))
      if (name === 'check') return h('svg', common, h('path', { d: 'M5 12.5l4.5 4.5L19 7' }))
      if (name === 'chevron') return h('svg', common, h('path', { d: 'M6 9l6 6 6-6' }))
      if (name === 'info') {
        return h(
          'svg',
          common,
          h('circle', { cx: '12', cy: '12', r: '9' }),
          h('path', { d: 'M12 10.5V16.5' }),
          h('circle', { cx: '12', cy: '7.6', r: '1', fill: 'currentColor', stroke: 'none' }),
        )
      }
      if (name === 'settings') {
        return h(
          'svg',
          common,
          h('path', { d: 'M4 7h10M18 7h2M4 17h4M12 17h8' }),
          h('circle', { cx: 16, cy: 7, r: 2 }),
          h('circle', { cx: 10, cy: 17, r: 2 }),
        )
      }
      if (name === 'external') {
        return h('svg', common, h('path', { d: 'M14 4h6v6' }), h('path', { d: 'M20 4l-9 9' }), h('path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }))
      }
      if (name === 'trash') {
        return h('svg', common, h('path', { d: 'M4 7h16' }), h('path', { d: 'M9 7V5h6v2' }), h('path', { d: 'M6 7l1 12h10l1-12' }))
      }
      return null
    }

    /** One row of a `hottest` card: rank badge plus the headline. */
    /**
     * Generic hover popover: shows `content` next to the wrapped trigger,
     * wraps long text, fades in and out, and points an arrow at the trigger.
     * The bubble is a DOM node portalled into the panel root (`.dshnn-root`),
     * so the card's own scroll container can neither clip it nor trap it in a
     * sibling stacking context; coordinates come from the trigger's viewport
     * rect resolved against the host rect, with a viewport clamp on the left
     * edge. The node stays mounted through the fade-out (`shown`) while `open`
     * drives the CSS opacity, and any scroll hides it at once.
     */
    function Popover(props) {
      const [open, setOpen] = React.useState(false)
      const [shown, setShown] = React.useState(false)
      const rootRef = React.useRef(null)
      const bubbleRef = React.useRef(null)
      const timerRef = React.useRef(null)
      const showRef = React.useRef(null)
      const closeRef = React.useRef(null)
      const shownRef = React.useRef(false)
      React.useEffect(
        () => () => {
          if (timerRef.current !== null) clearTimeout(timerRef.current)
          if (showRef.current !== null) clearTimeout(showRef.current)
          if (closeRef.current !== null) clearTimeout(closeRef.current)
        },
        [],
      )
      const enter = () => {
        if (closeRef.current !== null) {
          clearTimeout(closeRef.current)
          closeRef.current = null
        }
        // Re-entering during the fade-out: cancel the pending unmount, the
        // bubble is still mounted and can just stay open.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        if (shownRef.current) {
          setOpen(true)
          return
        }
        if (showRef.current !== null) return
        // Hover intent: sweeping past rows must not flash bubbles everywhere.
        showRef.current = setTimeout(() => {
          showRef.current = null
          shownRef.current = true
          setShown(true)
          setOpen(true)
        }, HOVER_DELAY_MS)
      }
      const finishClose = () => {
        setOpen(false)
        if (timerRef.current === null) {
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            shownRef.current = false
            setShown(false)
          }, 180)
        }
      }
      // Interactive tips stay open through a grace period so the pointer can
      // travel onto the bubble itself; plain row popovers close at once.
      const scheduleClose = () => {
        if (closeRef.current !== null) return
        closeRef.current = setTimeout(() => {
          closeRef.current = null
          finishClose()
        }, CLOSE_DELAY_MS)
      }
      const cancelScheduledClose = () => {
        if (closeRef.current !== null) {
          clearTimeout(closeRef.current)
          closeRef.current = null
        }
      }
      const leave = () => {
        if (showRef.current !== null) {
          clearTimeout(showRef.current)
          showRef.current = null
        }
        if (props.interactive === true) {
          scheduleClose()
          return
        }
        finishClose()
      }
      React.useEffect(() => {
        if (!shown) return undefined
        const trigger = rootRef.current
        if (trigger === null || typeof document === 'undefined' || typeof document.createElement !== 'function') return undefined
        const host = typeof trigger.closest === 'function' ? trigger.closest('.dshnn-root') : null
        if (host === null) return undefined
        const node = document.createElement('div')
        node.className = 'dshnn-pop-bubble dshnn-pop-bottom'
        node.setAttribute('role', 'tooltip')
        node.dataset.open = 'true'
        const inner = document.createElement('div')
        inner.className = 'dshnn-pop-inner'
        inner.textContent = props.content
        node.appendChild(inner)
        host.appendChild(node)
        bubbleRef.current = node
        if (props.interactive === true) {
          node.dataset.interactive = 'true'
          // Hovering the bubble itself keeps it open; leaving it restarts the
          // same grace period as leaving the trigger.
          if (typeof node.addEventListener === 'function') {
            node.addEventListener('mouseenter', cancelScheduledClose)
            node.addEventListener('mouseleave', scheduleClose)
          }
        }
        const triggerRect = typeof trigger.getBoundingClientRect === 'function' ? trigger.getBoundingClientRect() : null
        if (triggerRect !== null && typeof host.getBoundingClientRect === 'function') {
          const hostRect = host.getBoundingClientRect()
          const viewportHeight = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
          const viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280
          const width = Math.min(320, viewportWidth * 0.72)
          const below = triggerRect.bottom + 208 + 8 <= viewportHeight
          let left = triggerRect.left
          if (left + width + 8 > viewportWidth) left = Math.max(8, viewportWidth - width - 8)
          node.classList.toggle('dshnn-pop-top', !below)
          node.classList.toggle('dshnn-pop-bottom', below)
          node.style.left = `${Math.round(left - hostRect.left)}px`
          node.style.right = 'auto'
          if (below) {
            node.style.top = `${Math.round(triggerRect.bottom + 6 - hostRect.top)}px`
            node.style.bottom = 'auto'
          } else {
            node.style.top = 'auto'
            node.style.bottom = `${Math.round(hostRect.bottom - triggerRect.top + 6)}px`
          }
        }
        return () => {
          bubbleRef.current = null
          node.remove()
        }
      }, [shown, props.content])
      React.useEffect(() => {
        const node = bubbleRef.current
        if (node !== null && node.dataset !== undefined) node.dataset.open = open ? 'true' : 'false'
      }, [open])
      React.useEffect(() => {
        if (!open || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        // Scrolling away always hides at once — no grace period, the anchor
        // has already moved under the pointer.
        const hide = () => {
          cancelScheduledClose()
          if (showRef.current !== null) {
            clearTimeout(showRef.current)
            showRef.current = null
          }
          finishClose()
        }
        window.addEventListener('scroll', hide, true)
        return () => window.removeEventListener('scroll', hide, true)
      }, [open])
      const body = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children]
      return h(
        'span',
        {
          className: props.className !== undefined ? `dshnn-pop ${props.className}` : 'dshnn-pop',
          ref: rootRef,
          onMouseEnter: enter,
          onMouseLeave: leave,
          onFocus: enter,
          onBlur: leave,
        },
        ...body,
      )
    }

    function HotRow(props) {
      const { item, index, openLink } = props
      return h(
        Popover,
        { className: 'dshnn-pop-row', content: item.summary !== undefined ? item.summary : item.title },
        h(
          'a',
          {
            className: 'dshnn-row',
            href: item.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            onClick: (event) => {
              if (typeof openLink !== 'function' || event.defaultPrevented) return
              event.preventDefault()
              openLink(item.url)
            },
          },
        h('span', { className: 'dshnn-rank', 'data-top': index < 3 ? 'true' : 'false' }, String(index + 1)),
        h(
          'span',
          { className: 'dshnn-row-body' },
          h('span', { className: 'dshnn-row-title' }, item.title),
          item.hot !== undefined ? h('span', { className: 'dshnn-row-hot' }, item.hot) : null,
          ),
        ),
      )
    }

    /** One row of a `realtime` card: a wire feed with timestamp and source line. */
    function WireRow(props) {
      const { item, t, openLink } = props
      const stamp = relativeTime(item.pubDate, t)
      const meta = stamp !== '' ? stamp : item.date ?? item.hot ?? ''
      return h(
        'li',
        { className: 'dshnn-wire-item' },
        h(
          'span',
          { className: 'dshnn-wire-meta' },
          h('span', null, '-'),
          meta !== '' ? h('span', null, meta) : null,
        ),
        h(
          Popover,
          { content: item.summary !== undefined ? item.summary : item.title },
          h(
            'a',
            {
              className: 'dshnn-wire-link',
              href: item.url,
              target: '_blank',
              rel: 'noreferrer noopener',
              onClick: (event) => {
                if (typeof openLink !== 'function' || event.defaultPrevented) return
                event.preventDefault()
                openLink(item.url)
              },
            },
            item.title,
          ),
        ),
      )
    }

    /** One source card: header, refresh/enable/home tools, then its feed. */
    function SourceCard(props) {
      const { source, feed, t, onRefresh, onToggle, onVisible, busy, openLink } = props
      const pending = feed?.pending === true || feed === undefined
      const rootRef = React.useRef(null)
      /*
       * Scroll lazy-load: the card asks the store for its feed only once it is
       * (nearly) on screen. Without IntersectionObserver the card falls back to
       * an immediate read, so content never stays missing.
       */
      React.useEffect(() => {
        if (feed !== undefined) return undefined
        if (typeof onVisible !== 'function') return undefined
        const Observer = typeof IntersectionObserver === 'undefined' ? undefined : IntersectionObserver
        const node = rootRef.current
        if (Observer === undefined || node === null || typeof node.nodeType !== 'number') {
          onVisible(source.id)
          return undefined
        }
        const observer = new Observer((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer.disconnect()
            onVisible(source.id)
          }
        }, { rootMargin: '240px 0px' })
        observer.observe(node)
        return () => observer.disconnect()
      /* onVisible stays out of the deps: it closes over the same stable store. */
      }, [source.id, feed === undefined])
      const items = feed?.items ?? []
      const note = clockText(feed?.updatedTime ?? feed?.fetchedAt)
      const metaText =
        note !== '' ? `${t('updated', { time: note })}${feed?.stale === true ? ` · ${t('stale')}` : ''}` : t('loading')

      const header = h(
        'div',
        { className: 'dshnn-card-top' },
        h('span', { className: 'dshnn-badge', 'aria-hidden': 'true' }, initial(source.name)),
        h(
          'span',
          { className: 'dshnn-card-id' },
          h(
            'span',
            { className: 'dshnn-card-name' },
            h('span', { className: 'dshnn-card-name-text', title: source.id }, source.name),
            source.title !== undefined ? h('span', { className: 'dshnn-tag' }, source.title) : null,
            source.builtin === false ? h('span', { className: 'dshnn-tag' }, t('customTag')) : null,
          ),
          h('span', { className: 'dshnn-card-meta', title: feed?.error ?? source.id }, metaText),
        ),
        h(
          'span',
          { className: 'dshnn-card-tools' },
          source.home !== undefined
            ? h(
                'a',
                {
                  className: 'dshnn-icon-btn',
                  href: source.home,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: t('openSource'),
                  'aria-label': t('openSource'),
                  onClick: (event) => {
                    if (typeof openLink !== 'function' || event.defaultPrevented) return
                    event.preventDefault()
                    openLink(source.home)
                  },
                },
                h(Icon, { name: 'external' }),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-icon-btn',
              title: t('refresh'),
              'aria-label': t('refresh'),
              disabled: busy,
              onClick: () => onRefresh(source.id),
            },
            h(Icon, { name: 'refresh' }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-icon-btn',
              title: t('disable'),
              'aria-label': t('disable'),
              onClick: () => onToggle(source.id, false),
            },
            h(Icon, { name: 'close' }),
          ),
        ),
      )

      let body
      if (pending && items.length === 0) {
        body = h(
          'div',
          { className: 'dshnn-scroll' },
          Array.from({ length: 6 }, (_, index) => h('div', { key: index, className: 'dshnn-skel' })),
        )
      } else if (feed?.error !== undefined && items.length === 0) {
        body = h(
          'div',
          { className: 'dshnn-scroll' },
          h(
            'div',
            { className: 'dshnn-error' },
            `${t('error')}: ${feed.error}`,
            h(
              'div',
              { style: { marginTop: 8 } },
              h(ActionButton, { label: t('retry'), onClick: () => onRefresh(source.id) }),
            ),
          ),
        )
      } else if (items.length === 0) {
        body = h('div', { className: 'dshnn-scroll' }, h('div', { className: 'dshnn-note' }, t('empty')))
      } else if (source.type === 'realtime') {
        body = h(
          'div',
          { className: 'dshnn-scroll' },
          h('ol', { className: 'dshnn-wire' }, items.map((item, index) => h(WireRow, { key: `${source.id}-${item.id ?? index}`, item, t, openLink }))),
        )
      } else {
        body = h(
          'div',
          { className: 'dshnn-scroll' },
          h(
            'ol',
            { className: 'dshnn-list' },
            items.map((item, index) => h(HotRow, { key: `${source.id}-${item.id ?? index}`, item, index, openLink })),
          ),
        )
      }

      /**
       * NewsNow paints each card as a 40%-opacity colour wash over a frosted
       * pane, then frosts the list inside it too (`bg-op-70!` + `backdrop-blur-5`
       * + a `sprinkle` corner glow). The glass itself lives in the `dshnn-card`
       * / `dshnn-scroll` classes; only the source colour travels inline, so the
       * CSS keeps every non-colour decision in one place.
       */
      const tint = tintOf(source)
      return h(
        'article',
        {
          className: 'dshnn-card',
          ref: rootRef,
          'data-accent': source.color ?? 'blue',
          'data-source': source.id,
          style: {
            /* Soft wash: barely tints the pane, so text keeps full contrast. */
            '--dshnn-wash': tintAlpha(tint, 0.07),
            /* Corner glow the NewsNow cards get from their sprinkle gradient. */
            '--dshnn-glow': tintAlpha(tint, 0.16),
            /* The source colour that is allowed to be strong: border + avatars. */
            '--dshnn-edge': tintAlpha(tint, 0.42),
          },
        },
        header,
        body,
      )
    }

    /** Memoised so a control publish only re-renders the card that changed. */
    const MemoSourceCard = React.memo(SourceCard)

    /**
     * Segmented control: a row of radio buttons inside one track, the same
     * shape the settings shell uses for narrow choice sets.
     */
    /** One flat pill button; `variant` picks the emphasis, everything else is props-through. */
    function ActionButton(props) {
      const { label, onClick, disabled, variant } = props
      const className = variant === 'primary' || variant === 'ghost'
        ? `dshnn-btn dshnn-btn-${variant}`
        : 'dshnn-btn'
      return h('button', { type: 'button', className, disabled, onClick }, label)
    }

    function Segmented(props) {
      const { value, options, onChange, label } = props
      return h(
        'div',
        { className: 'dshnn-seg', role: 'radiogroup', 'aria-label': label },
        options.map((option) =>
          h(
            'button',
            {
              key: String(option.value),
              type: 'button',
              role: 'radio',
              'aria-checked': value === option.value,
              className: value === option.value ? 'dshnn-seg-item dshnn-seg-on' : 'dshnn-seg-item',
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    /**
     * Dropdown select: a themed trigger button plus a listbox popover. It
     * replaces the native <select>, closing on Escape and on outside presses.
     */
    function Dropdown(props) {
      const { value, options, onChange, label } = props
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        const onPointer = (event) => {
          const node = rootRef.current
          if (node === null || node === undefined) return
          if (typeof node.contains === 'function' && node.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      const current = options.find((option) => option.value === value)
      return h(
        'div',
        { className: 'dshnn-dropdown', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dshnn-select-btn',
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-label': label,
            onClick: () => setOpen((seen) => !seen),
          },
          h('span', { className: 'dshnn-select-value' }, current?.label ?? ''),
          h(Icon, { name: 'chevron' }),
        ),
        open
          ? h(
              'div',
              { className: 'dshnn-menu', role: 'listbox', 'aria-label': label },
              options.map((option) =>
                h(
                  'button',
                  {
                    key: String(option.value),
                    type: 'button',
                    role: 'option',
                    'aria-selected': value === option.value,
                    className: value === option.value ? 'dshnn-menu-item dshnn-menu-on' : 'dshnn-menu-item',
                    onClick: () => {
                      setOpen(false)
                      onChange(option.value)
                    },
                  },
                  option.label,
                  value === option.value ? h(Icon, { name: 'check', size: 14, className: 'dshnn-menu-check' }) : null,
                ),
              ),
            )
          : null,
      )
    }

    /** Info glyph whose help bubble can be hovered: it closes on a grace
     * period after the pointer leaves, so the reader can move onto it. */
    function InfoTip(props) {
      return h(
        Popover,
        { interactive: true, content: props.label },
        h('span', { className: 'dshnn-tipwrap', tabIndex: 0 }, h(Icon, { name: 'info', size: 14 })),
      )
    }

    /** A titled card whose body folds away behind its header. */
    function CollapsibleCard(props) {
      const [open, setOpen] = React.useState(() => {
        if (props.persistKey === undefined) return props.defaultOpen !== false
        const saved = remembered.cardOpen[props.persistKey]
        return saved === undefined ? props.defaultOpen !== false : saved === true
      })
      const body = props.children === undefined ? [] : Array.isArray(props.children) ? props.children : [props.children]
      return h(
        'section',
        { className: props.className ?? 'dshnn-group-card' },
        h(
          'div',
          { className: 'dshnn-card-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-card-toggle',
              'aria-expanded': open ? 'true' : 'false',
              'aria-label': open ? props.collapseLabel : props.expandLabel,
              onClick: () =>
                setOpen((previous) => {
                  const next = !previous
                  if (props.persistKey !== undefined) remembered.cardOpen[props.persistKey] = next
                  return next
                }),
            },
            h('span', { className: 'dshnn-chev', 'aria-hidden': 'true' }, h(Icon, { name: 'chevron', size: 14 })),
            h('span', { className: 'dshnn-card-title' }, props.title),
            props.count !== undefined ? h('span', { className: 'dshnn-count' }, String(props.count)) : null,
          ),
          props.info !== undefined ? h(InfoTip, { label: props.info }) : null,
        ),
        open ? h('div', { className: 'dshnn-card-body' }, ...body) : null,
      )
    }

    /**
     * One enable/disable row inside the manager. The row keeps its own
     * pending state: clicking the switch must not grey out or re-render any
     * other row, button, or card.
     */
    function ToggleRow(props) {
      const { source, t, onToggle, onRemove } = props
      const [pending, setPending] = React.useState(false)
      const act = (work) => {
        if (pending) return
        setPending(true)
        Promise.resolve()
          .then(work)
          .catch(() => undefined)
          .then(() => setPending(false))
      }
      return h(
        'div',
        {
          className: 'dshnn-chip',
          'data-on': source.enabled ? 'true' : 'false',
          'data-pending': pending ? 'true' : 'false',
        },
        h(
          'button',
          {
            type: 'button',
            className: 'dshnn-chip-btn',
            role: 'switch',
            'aria-checked': source.enabled,
            'aria-label': `${source.name} ${source.enabled ? t('disable') : t('enable')}`,
            title: source.id,
            disabled: pending,
            onClick: () => act(() => onToggle(source.id, !source.enabled)),
          },
          h('span', {
            className: 'dshnn-chip-dot',
            'aria-hidden': 'true',
            style: { background: tintAlpha(tintOf(source), source.enabled ? 0.85 : 0.3) },
          }),
          h('span', { className: 'dshnn-chip-name' }, source.name),
          source.builtin === false ? h('span', { className: 'dshnn-tag' }, t('customTag')) : null,
        ),
        source.builtin === false
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshnn-chip-remove',
                title: t('remove'),
                'aria-label': t('remove'),
                disabled: pending,
                onClick: () => act(() => onRemove(source.id)),
              },
              h(Icon, { name: 'close', size: 12 }),
            )
          : null,
      )
    }

    /** Memoised so a control publish only re-renders the rows that changed. */
    const MemoToggleRow = React.memo(ToggleRow)

    /** The source manager: toggles per group, a custom-source form, the config snippet. */
    function SourceManager(props) {
      const { store, t, snapshot, onClose } = props
      const [form, setForm] = React.useState({ id: '', name: '', group: 'tech', color: 'blue', type: 'hottest' })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [copied, setCopied] = React.useState(false)

      const total = snapshot.sources.length
      const enabled = snapshot.sources.filter((source) => source.enabled).length
      const configText = JSON.stringify(
        store.config() ?? {
          sources: snapshot.sources.filter((source) => source.enabled).map((source) => source.id),
          disabledSources: snapshot.sources.filter((source) => !source.enabled).map((source) => source.id),
        },
        null,
        2,
      )

      const run = React.useCallback((work) => {
        setBusy(true)
        setError(undefined)
        Promise.resolve()
          .then(work)
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .then(() => setBusy(false))
      }, [])
      const toggleSource = React.useCallback((id, next) => run(() => store.setEnabled(id, next)), [run, store])
      const removeSource = React.useCallback((id) => run(() => store.removeCustom(id)), [run, store])

      const submit = () => {
        const id = form.id.trim().toLowerCase()
        if (id === '') {
          setError(t('addIdHint'))
          return
        }
        run(async () => {
          await store.addCustom({
            id,
            name: form.name.trim() === '' ? id : form.name.trim(),
            group: form.group,
            color: form.color,
            type: form.type,
          })
          setForm({ id: '', name: '', group: 'tech', color: 'blue', type: 'hottest' })
        })
      }

      const copy = () => {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clip === undefined || typeof clip.writeText !== 'function') {
          setError(t('configTitle'))
          return
        }
        clip
          .writeText(configText)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => setError(t('configTitle')))
      }

      // Row positions stay fixed for the lifetime of the overlay: toggling a
      // source must not shuffle the list under the cursor (the Host appends
      // re-enabled sources to the end of the panel order). Sources added
      // while the overlay is open are appended at the back of their group.
      const [order, setOrder] = React.useState(() => snapshot.sources.map((source) => source.id))
      React.useEffect(() => {
        const known = new Set(order)
        const fresh = snapshot.sources.filter((source) => !known.has(source.id)).map((source) => source.id)
        if (fresh.length > 0) setOrder([...order, ...fresh])
      }, [snapshot.sources, order])
      const byId = new Map(snapshot.sources.map((source) => [source.id, source]))
      const stable = order.map((id) => byId.get(id)).filter((source) => source !== undefined)
      const categories = GROUPS.map((group) => ({
        key: group,
        label: groupLabel(t, group),
        rows: stable.filter((source) => source.group === group),
      }))
        .concat([{ key: 'other', label: t('source'), rows: stable.filter((source) => !GROUPS.includes(source.group)) }])
        .filter((entry) => entry.rows.length > 0)

      return h(
        'div',
        { className: 'dshnn-modal', onClick: (event) => { if (event.target === event.currentTarget) onClose() } },
        h(
          'section',
          { className: 'dshnn-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('manageTitle') },
          h(
            'div',
            { className: 'dshnn-dialog-head' },
            h(
              'div',
              { className: 'dshnn-head-main' },
              h('div', { className: 'dshnn-title' }, t('manageTitle')),
              h('div', { className: 'dshnn-sub' }, t('enabledCount', { n: enabled, total })),
            ),
          ),
          h(
            'div',
            { className: 'dshnn-dialog-body' },
          error !== undefined ? h('div', { className: 'dshnn-error' }, error) : null,
          h(
            CollapsibleCard,
            { key: 'auto', persistKey: 'auto', title: t('autoTitle'), className: 'dshnn-panel-card', expandLabel: t('expand'), collapseLabel: t('collapse') },
            h('div', { className: 'dshnn-manage-hint' }, t('autoHint')),
            h(Segmented, {
              value: snapshot.autoSeconds,
              label: t('autoTitle'),
              options: AUTO_CHOICES.map((seconds) => ({
                value: seconds,
                label: seconds === 0 ? t('autoOff') : t('autoMinute', { n: seconds / 60 }),
              })),
              onChange: (seconds) => store.setAutoSeconds(seconds),
            }),
          ),
          h(
            CollapsibleCard,
            { key: 'links', persistKey: 'links', title: t('sidebarTitle'), className: 'dshnn-panel-card', expandLabel: t('expand'), collapseLabel: t('collapse') },
            h('div', { className: 'dshnn-manage-hint' }, t('sidebarHint')),
            h(Segmented, {
              value: snapshot.linkMode,
              label: t('sidebarTitle'),
              options: [
                { value: 'embed', label: t('sidebarEmbed') },
                { value: 'sidebar', label: t('sidebarSide') },
                { value: 'system', label: t('sidebarSystem') },
              ],
              onChange: (value) => store.setLinkMode(value),
            }),
          ),
          ...categories.map((entry) =>
            h(
              CollapsibleCard,
              { key: entry.key, persistKey: `group:${entry.key}`, title: entry.label, count: entry.rows.length, expandLabel: t('expand'), collapseLabel: t('collapse') },
              h(
                'div',
                { className: 'dshnn-chip-list' },
                entry.rows.map((source) =>
                  h(MemoToggleRow, {
                    key: source.id,
                    source,
                    t,
                    onToggle: toggleSource,
                    onRemove: removeSource,
                  }),
                ),
              ),
            ),
          ),
          h(
            CollapsibleCard,
            { key: 'add', persistKey: 'add', title: t('addTitle'), info: t('addHelp'), className: 'dshnn-panel-card', expandLabel: t('expand'), collapseLabel: t('collapse') },
            h('div', { className: 'dshnn-manage-hint' }, t('addHint')),
            h(
              'div',
              { className: 'dshnn-form' },
              h(
                'label',
                { className: 'dshnn-field' },
                h('span', { className: 'dshnn-field-label' }, t('addId')),
                h('input', {
                  className: 'dshnn-input',
                  value: form.id,
                  placeholder: 'zhihu',
                  spellCheck: false,
                  onChange: (event) => setForm({ ...form, id: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dshnn-field' },
                h('span', { className: 'dshnn-field-label' }, t('addName')),
                h('input', {
                  className: 'dshnn-input',
                  value: form.name,
                  onChange: (event) => setForm({ ...form, name: event.target.value }),
                }),
              ),
              h(
                'label',
                { className: 'dshnn-field' },
                h('span', { className: 'dshnn-field-label' }, t('addGroup')),
                h(Dropdown, {
                  value: form.group,
                  label: t('addGroup'),
                  options: GROUPS.map((group) => ({ value: group, label: groupLabel(t, group) })),
                  onChange: (group) => setForm({ ...form, group }),
                }),
              ),
              h(
                'label',
                { className: 'dshnn-field' },
                h('span', { className: 'dshnn-field-label' }, t('addColor')),
                h(Dropdown, {
                  value: form.color,
                  label: t('addColor'),
                  options: COLORS.map((color) => ({ value: color, label: color })),
                  onChange: (color) => setForm({ ...form, color }),
                }),
              ),
              h(
                'label',
                { className: 'dshnn-field' },
                h('span', { className: 'dshnn-field-label' }, t('addType')),
                h(Dropdown, {
                  value: form.type,
                  label: t('addType'),
                  options: [
                    { value: 'hottest', label: t('feed') },
                    { value: 'realtime', label: t('wire') },
                  ],
                  onChange: (type) => setForm({ ...form, type }),
                }),
              ),
              h(
                'div',
                { className: 'dshnn-field' },
                h('span', { className: 'dshnn-field-label' }, ' '),
                h(ActionButton, { label: t('add'), disabled: busy, variant: 'primary', onClick: submit }),
              ),
            ),
          ),
          h(
            CollapsibleCard,
            { key: 'config', persistKey: 'config', title: t('configTitle'), className: 'dshnn-panel-card', defaultOpen: false, expandLabel: t('expand'), collapseLabel: t('collapse') },
            h('div', { className: 'dshnn-manage-hint' }, t('manageHint')),
            h('pre', { className: 'dshnn-config' }, configText),
            h(
              'div',
              { className: 'dshnn-config-actions' },
              h(ActionButton, { label: copied ? t('copied') : t('copy'), variant: 'ghost', onClick: copy }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshnn-dialog-footer' },
          h(ActionButton, { label: t('enableAll'), disabled: busy, onClick: () => run(() => store.setAll(true)) }),
          h(ActionButton, { label: t('disableAll'), disabled: busy, onClick: () => run(() => store.setAll(false)) }),
          h(ActionButton, { label: t('done'), variant: 'primary', onClick: onClose }),
        ),
      ),
    )
    }

    /** The central panel: header, source manager overlay, responsive card grid. */
    /** The split-view browser pane docked beside the card wall (Desktop only). */
    function EmbedPane(props) {
      const embed = props.embed
      const t = props.t
      const state = useEmbed(embed)
      const active = state.tabs.find((tab) => tab.id === state.active)
      const address = active?.title || active?.url || ''
      /* A stable ref: inline callbacks churn every render and would detach the guest. */
      const attachRef = React.useCallback((el) => embed.attach(el), [embed])
      /* Tab context menu state: { x, y, id } while open, undefined otherwise. */
      const [menu, setMenu] = React.useState(undefined)
      React.useEffect(() => {
        if (menu === undefined) return undefined
        const dismiss = () => setMenu(undefined)
        document.addEventListener('click', dismiss)
        document.addEventListener('contextmenu', dismiss)
        return () => {
          document.removeEventListener('click', dismiss)
          document.removeEventListener('contextmenu', dismiss)
        }
      }, [menu])
      /* User-dragged width (px); undefined keeps the responsive clamp default. */
      const width = props.width
      return h(
        'aside',
        {
          className: state.open ? 'dshnn-embed' : 'dshnn-embed dshnn-embed-hidden',
          style: width !== undefined ? { flex: `0 0 ${Math.round(width)}px` } : undefined,
          'aria-label': t('sidebarEmbed'),
          'aria-hidden': state.open ? undefined : 'true',
        },
        h(
          'div',
          { className: 'dshnn-embed-head' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-icon-btn',
              title: t('embedBack'),
              'aria-label': t('embedBack'),
              disabled: !state.canGoBack,
              onClick: () => embed.back(),
            },
            h(Icon, { name: 'back', size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-icon-btn',
              title: t('embedForward'),
              'aria-label': t('embedForward'),
              disabled: !state.canGoForward,
              onClick: () => embed.forward(),
            },
            h(Icon, { name: 'forward', size: 14 }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-icon-btn',
              title: t('embedReload'),
              'aria-label': t('embedReload'),
              disabled: state.tabs.length === 0,
              onClick: () => embed.reload(),
            },
            h(Icon, { name: 'refresh', size: 14, className: active?.loading ? 'dshnn-spin' : undefined }),
          ),
          h('div', { className: 'dshnn-embed-addr', title: address }, address),
          h(
            'button',
            {
              type: 'button',
              className: 'dshnn-icon-btn',
              title: t('embedClose'),
              'aria-label': t('embedClose'),
              onClick: () => embed.close(),
            },
            h(Icon, { name: 'close', size: 14 }),
          ),
        ),
        state.tabs.length > 0
          ? h(
              'div',
              { className: 'dshnn-embed-tabs', role: 'tablist', 'aria-label': t('sidebarEmbed') },
              state.tabs.map((tab) =>
                h(
                  'div',
                  {
                    key: tab.id,
                    className: tab.id === state.active ? 'dshnn-embed-tab dshnn-embed-tab-on' : 'dshnn-embed-tab',
                    role: 'tab',
                    'aria-selected': tab.id === state.active,
                    title: tab.title || tab.url,
                    onClick: () => embed.activate(tab.id),
                    onAuxClick: (event) => {
                      /* Middle click: close the tab under the pointer. */
                      if (event?.button === 1) {
                        event.preventDefault()
                        event.stopPropagation()
                        embed.closeTab(tab.id)
                      }
                    },
                    onContextMenu: (event) => {
                      event.preventDefault()
                      /* Stop the shell-wide dismiss from eating this open. */
                      event.stopPropagation()
                      /* Menu lives inside the pane (absolute): the split's
                         container-type makes position:fixed unreliable. */
                      const pane = event.currentTarget.closest?.('.dshnn-embed')
                      const rect = pane?.getBoundingClientRect?.()
                      if (rect === undefined) return
                      setMenu({
                        x: Math.min(event.clientX - rect.left, rect.width - 148),
                        y: Math.max(4, event.clientY - rect.top),
                        id: tab.id,
                      })
                    },
                  },
                  h('span', { className: 'dshnn-embed-tab-label' }, tab.title || tab.url),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dshnn-embed-tab-x',
                      title: t('embedCloseTab'),
                      'aria-label': t('embedCloseTab'),
                      onClick: (event) => {
                        event.stopPropagation()
                        embed.closeTab(tab.id)
                      },
                    },
                    h(Icon, { name: 'close', size: 10 }),
                  ),
                ),
              ),
            )
          : null,
        state.error !== undefined ? h('div', { className: 'dshnn-embed-err' }, state.error) : null,
        menu !== undefined
          ? h(
              'div',
              { className: 'dshnn-embed-menu', role: 'menu', style: { left: menu.x, top: menu.y } },
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    embed.closeTab(menu.id)
                    setMenu(undefined)
                  },
                },
                t('embedCloseTab'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    embed.closeOthers(menu.id)
                    setMenu(undefined)
                  },
                },
                t('embedCloseOthers'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    embed.openExternal(state.tabs.find((tab) => tab.id === menu.id)?.url)
                    setMenu(undefined)
                  },
                },
                t('embedOpenSystem'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    embed.closeAll()
                    setMenu(undefined)
                  },
                },
                t('embedCloseAll'),
              ),
            )
          : null,
        // The guest webviews are managed imperatively: React never reconciles them.
        h('div', {
          className: 'dshnn-embed-body',
          ref: attachRef,
        }),
      )
    }

    function NewsPanel(props) {
      useStyles()
      const store = props.store
      const t = props.t
      const openLink = props.openLink
      const snapshot = useFeed(store)
      /* Until the locale dictionaries arrive over the text route, every label
         would render as its raw key — show the quiet skeleton instead. */
      if (snapshot.textReady !== true) {
        return h(
          'div',
          { className: 'dshnn-root' },
          h('div', { className: 'dshnn-ambient', 'aria-hidden': 'true' }),
          h(
            'div',
            { className: 'dshnn-split' },
            h('div', { className: 'dshnn-grid' }, h('div', { className: 'dshnn-empty' }, '…')),
          ),
        )
      }
      const [managing, setManaging] = React.useState(() => remembered.managing === true)
      const updateManaging = React.useCallback((next) => {
        remembered.managing = next === true
        setManaging(next === true)
      }, [])
      const [busyId, setBusyId] = React.useState(undefined)
      /* The embedded pane's live state (only present on the desktop shell). */
      const embedState = props.embed !== undefined ? useEmbed(props.embed) : { open: false }
      const [embedWidth, setEmbedWidth] = React.useState(remembered.embedWidth)
      /* The floating toggle opens the pane on the first enabled source's home page. */
      const toggleEmbed = React.useCallback(() => {
        const pane = props.embed
        if (pane === undefined) return
        if (embedState.open) {
          pane.close()
          return
        }
        /* Remembered tabs win: reopen on the last active tab. */
        if (pane.restore() === true) return
        const home = snapshot.sources.find((source) => source.enabled)?.home
        void pane.show(typeof home === 'string' && home !== '' ? home : 'about:blank')
      }, [props.embed, embedState.open, snapshot.sources])
      /* Drag the divider: the pane's flex-basis follows the pointer, capped at 70%. */
      const startEmbedDrag = React.useCallback((event) => {
        const splitter = event.currentTarget
        const rect = splitter.parentElement.getBoundingClientRect()
        splitter.setPointerCapture(event.pointerId)
        const move = (ev) => {
          const width = Math.max(280, Math.min(rect.right - ev.clientX, rect.width * 0.7))
          remembered.embedWidth = width
          setEmbedWidth(width)
        }
        const stop = () => {
          splitter.removeEventListener('pointermove', move)
          splitter.removeEventListener('pointerup', stop)
          splitter.removeEventListener('pointercancel', stop)
        }
        splitter.addEventListener('pointermove', move)
        splitter.addEventListener('pointerup', stop)
        splitter.addEventListener('pointercancel', stop)
      }, [])

      React.useEffect(() => {
        void store.loadDirectory()
      }, [store])

      const enabled = snapshot.sources.filter((source) => source.enabled)

      // Stable identities so memoised cards skip re-renders they do not care about.
      const refreshOne = React.useCallback(
        (id) => {
          setBusyId(id)
          void store.loadSource(id, { force: true }).then(() => setBusyId(undefined))
        },
        [store],
      )
      const toggle = React.useCallback(
        (id, next) => {
          setBusyId(id)
          void store
            .setEnabled(id, next)
            .catch(() => undefined)
            .then(() => setBusyId(undefined))
        },
        [store],
      )
      const showCard = React.useCallback((id) => store.ensureVisible(id), [store])

      /* The card wall unmounts on every panel switch; put the reader back
       * where they were by replaying the remembered scroll offset. */
      const rememberScroll = React.useCallback((event) => {
        remembered.scrollTop = event?.currentTarget?.scrollTop ?? 0
      }, [])
      const restoreScroll = React.useCallback((el) => {
        if (el !== null && el !== undefined && remembered.scrollTop > 0) el.scrollTop = remembered.scrollTop
      }, [])

      /* Floating actions replace the header: two icon buttons pinned to the
       * top-right, sticking to the edge while the card wall scrolls. The
       * strip itself paints nothing and lets clicks fall through. */
      const fabs = h(
        'div',
        { className: 'dshnn-fabs' },
        props.embed !== undefined
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshnn-icon-btn dshnn-fab',
                title: t('embedToggle'),
                'aria-label': t('embedToggle'),
                'aria-pressed': embedState.open === true,
                onClick: toggleEmbed,
              },
              h(Icon, { name: 'browser', size: 15 }),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'dshnn-icon-btn dshnn-fab',
            title: t('refresh'),
            'aria-label': t('refresh'),
            disabled: snapshot.refreshing || enabled.length === 0,
            onClick: () => void store.refreshAll(),
          },
          h(Icon, { name: 'refresh', size: 15, className: snapshot.refreshing ? 'dshnn-spin' : undefined }),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dshnn-icon-btn dshnn-fab',
            title: t('manage'),
            'aria-label': t('manage'),
            onClick: () => updateManaging(true),
          },
          h(Icon, { name: 'settings', size: 15 }),
        ),
      )

      let grid
      if (snapshot.directoryError !== undefined) {
        grid = h(
          'div',
          { className: 'dshnn-grid' },
          fabs,
          h(
            'div',
            { className: 'dshnn-empty' },
            `${t('error')}: ${snapshot.directoryError}`,
            h(
              'div',
              { style: { marginTop: 10 } },
              h(ActionButton, { label: t('retry'), onClick: () => void store.loadDirectory({ force: true }) }),
            ),
          ),
        )
      } else if (snapshot.sources.length === 0) {
        grid = h('div', { className: 'dshnn-grid' }, fabs, h('div', { className: 'dshnn-empty' }, snapshot.loaded ? t('noneAtAll') : t('loading')))
      } else if (enabled.length === 0) {
        grid = h(
          'div',
          { className: 'dshnn-grid' },
          fabs,
          h(
            'div',
            { className: 'dshnn-empty' },
            t('allDisabled'),
            h(
              'div',
              { style: { marginTop: 10 } },
              h(ActionButton, { label: t('manage'), variant: 'primary', onClick: () => setManaging(true) }),
            ),
          ),
        )
      } else {
        grid = h(
          'div',
          {
            className: 'dshnn-grid',
            ref: restoreScroll,
            onScroll: rememberScroll,
          },
          fabs,
          enabled.map((source) =>
            h(MemoSourceCard, {
              key: source.id,
              source,
              feed: snapshot.feeds[source.id],
              t,
              busy: busyId === source.id,
              onRefresh: refreshOne,
              onToggle: toggle,
              onVisible: showCard,
              openLink,
            }),
          ),
        )
      }

      return h(
        'div',
        { className: 'dshnn-root' },
        h('div', { className: 'dshnn-ambient', 'aria-hidden': 'true' }),
        // The embedded browser docks beside the card wall as a split view.
        h(
          'div',
          { className: 'dshnn-split' },
          grid,
          props.embed !== undefined && embedState.open
            ? h('div', { className: 'dshnn-embed-drag', onPointerDown: startEmbedDrag, 'aria-hidden': 'true' })
            : null,
          props.embed !== undefined ? h(EmbedPane, { embed: props.embed, t, width: embedWidth }) : null,
        ),
        // Settings opens as a modal dialog above the card wall.
        managing ? h(SourceManager, { store, t, snapshot, onClose: () => updateManaging(false) }) : null,
      )
    }

    /** The compact pill pinned to the New Session hero row. */
    function HeroHot(props) {
      useStyles()
      const store = props.store
      const t = props.t
      const snapshot = useFeed(store)

      React.useEffect(() => {
        void store.loadDirectory()
      }, [store])

      const first = snapshot.sources.find((source) => source.enabled)
      const feed = first === undefined ? undefined : snapshot.feeds[first.id]
      const headline = feed?.items?.[0]
      /* The pill can mount before the locale route answers; stay wordless. */
      const label =
        snapshot.textReady === true ? (headline !== undefined ? headline.title : t('heroEmpty')) : '…'
      return h(
        'button',
        {
          type: 'button',
          className: 'dshnn-hero',
          title: t('open'),
          onClick: () => {
            try {
              props.layout.selectPanel(PANEL_ID)
            } catch {
              // The layout service may be absent in a stripped build; the pill stays inert.
            }
          },
        },
        h('span', { className: 'dshnn-hero-dot' }),
        h('span', { className: 'dshnn-hero-text' }, label),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout', 'sidebarRight'],
      apply(ctx) {
        const store = createFeedStore()
        /** Translator bound to this namespace; re-read on every render for locale switches. */
        const translate = () => ctx.locale.bind(NS)

        /* The embedded split-view pane exists only on the desktop shell, where
           the app exposes its browser-bridge API. On the web it stays undefined. */
        const embed = desktopBridge !== undefined ? createEmbedBrowser(desktopBridge) : undefined

        /* Link target chosen by the user: the embedded pane (desktop), the
           sidebar browser, or the system browser. The preference is re-read on
           every click so toggling it in settings applies immediately.

           The sidebar chain: the right dock's openTab only works while a
           conversation session is on screen (ui-sidebar-right publishes
           `mounted` only when the main panel is the conversation). While THIS
           panel is active there is no on-screen session, so we first return to
           the conversation and raise the right dock, then open the tab once
           the surface mounts. */
        const trySidebarTab = (right, url) => {
          try {
            right.openTab('browser', { params: { url } })
            return true
          } catch {
            return false
          }
        }
        const openSystem = (url) => {
          try {
            if (typeof globalThis.open === 'function') globalThis.open(url, '_blank', 'noopener')
          } catch {
            /* nothing else we can do */
          }
        }
        const openSidebarLink = (url) => {
          const right = ctx.sidebarRight
          if (right !== undefined && typeof right.openTab === 'function') {
            if (trySidebarTab(right, url)) return
            /* No on-screen session: go back to the conversation and raise the
               right dock, then retry while the session surface mounts. */
            try {
              const layout = ctx.layout
              if (layout !== undefined && typeof layout.selectPanel === 'function') {
                layout.selectPanel(null)
                if (typeof layout.openRightbar === 'function') layout.openRightbar(true, false)
                let attempt = 0
                const retry = () => {
                  attempt += 1
                  if (trySidebarTab(right, url)) return
                  if (attempt < 4) {
                    globalThis.setTimeout(retry, 150)
                    return
                  }
                  openSystem(url)
                }
                globalThis.setTimeout(retry, 150)
                return
              }
            } catch {
              /* layout unavailable: fall through to the system browser */
            }
          }
          openSystem(url)
        }
        const openLink = (url) => {
          if (typeof url !== 'string' || !/^https?:/i.test(url)) return
          const mode = loadLinkMode()
          if (mode === 'embed') {
            if (embed === undefined) {
              /* The web shell has no desktop bridge: use the sidebar chain. */
              openSidebarLink(url)
              return
            }
            void embed.show(url).then((opened) => {
              if (opened) return
              /* The guest could not attach (bridge refused): fall back. */
              openSidebarLink(url)
            })
            return
          }
          if (mode === 'sidebar') openSidebarLink(url)
          else openSystem(url)
        }

        /* Locale dictionaries live in locale/*.json on the Host and arrive
           over the authenticated text route. Registration publishes through
           the locale service, and markTextReady lifts the render gate. */
        ctx.effect(
          () => {
            /* POST + buffered: the /api bridge cannot carry a GET body, so the
               text route is POST like the feed route. */
            fetch(TEXT_PATH, { method: 'POST' })
              .then((response) => response.json())
              .then((payload) => {
                const text = payload?.text
                if (text !== null && typeof text === 'object') ctx.locale.register(NS, text)
              })
              .catch((error) => {
                /* missing route: fall through and let keys echo rather than freeze */
                console.warn('[dsh-newsnow] locale dictionaries failed to load:', error)
              })
              .finally(() => store.markTextReady())
          },
          'dsh-newsnow: dictionaries',
        )

        /* A short tick checks the user-chosen auto-refresh interval. */
        ctx.effect(() => {
          const timer = setInterval(() => store.maybeAutoRefresh(Date.now()), 15000)
          return () => clearInterval(timer)
        }, 'dsh-newsnow: auto refresh')

        /* Release the embedded guest when the plugin deactivates. */
        ctx.effect(
          () => {
            if (embed === undefined) return undefined
            return () => embed.close()
          },
          'dsh-newsnow: embed pane',
        )

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => translate()('panel'), locale: NS },
            PanelGlyph,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => h(NewsPanel, { store, t: translate(), openLink, embed })),
        )

        ctx.slots.inject('conversation.hero.options', () =>
          ctx.slots.register(
            { name: 'conversation.hero.options', id: 'dsh-newsnow-hot', order: 30, locale: NS },
            () => h(HeroHot, { store, t: translate(), layout: ctx.layout }),
          ),
        )
      },
    }
  },
})
