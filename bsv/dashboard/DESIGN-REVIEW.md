# Dashboard visual review — 31 October 2026

Audience: judges at the TUM hackathon, watching a live projector demo.

## Review method and limitation

This review is based on source, not screenshots. Chromium was attempted before edits at 1440×900 but terminated before rendering: `sandbox_host_linux.cc: shutdown: Operation not permitted`. No connected browser session was available. The user explicitly authorised proceeding with a source-based redesign and marking screenshots and browser checks unverified. No before/after screenshots were produced; none are represented by mockups.

Work is on `feat/dashboard`. No commit, push, service startup or transaction execution is part of this review.

## Ten source-observed problems and their treatment

| Before | After |
| --- | --- |
| Three identical-width summary panels compete before the decisions. | Decisions lead a wide column; account context occupies a 300 px margin. |
| The common `.card` treatment adds rounded borders to unrelated sections. | Rules separate the ledger and account sections; page content has no enclosing cards. |
| Status and source badges repeat the same visual grammar. | Sources use plain text; the watcher decision gets a single dot and word. |
| Multiple colours label regimes, freshness, price changes and confirmations. | Neutral text states those conditions; teal is the accent, with green/red on decisions and thin chain markers. |
| The flow appears as six pill-shaped controls. | A thin-line, six-node diagram represents the same existing state. |
| Body copy uses arrows, checkmarks and triangles as decoration. | Short phrases state relationships and check outcomes; data and raw refusal reasons are unchanged. |
| Nearly every section uses the same padding and radius. | Tight 6–12 px internal relationships, 20–24 px account groups, 28–40 px major separation. |
| Time and full technical sentences use monospace. | Humanist sans handles prose and time; mono is limited to identifiers, keys and amounts. |
| An unavailable watcher gives no useful next step. | It identifies the configured endpoint and the watcher startup command; RPC failures point to connection settings. |
| A live price exposes a link to the removed tamper section. | The broken link is removed; the signature requirement is explained directly. |

## Visual system

- Type: Segoe UI / Ubuntu / Trebuchet MS for text; Cascadia Mono / Liberation Mono / DejaVu Sans Mono for identifiers and amounts. Local fallbacks preserve file access without font downloads. Actual font selection needs browser verification.
- Scale: 12, 14, 18, 24 and 36 px. Large amounts have small, muted units. Heading weights stop at 600.
- Grid: fluid activity column and 300 px account margin, separated by 40 px; full-width ledger. At small widths, activity and ledger precede account context. Wide ledger content scrolls inside its labelled, keyboard-focusable region.
- Palette: warm neutral backgrounds, teal links and focus; thin blue/ochre chain markers. Text conveys status independently of colour.
- Ledger: thin row rules, no zebra or hover tint, right-aligned limit and outflow figures, plain intent states, one watcher-decision marker.
- Motion: 200 ms arriving-decision highlight; no flow animation. Reduced-motion preference disables animation.

## Checks performed

- Node syntax check for dashboard JavaScript.
- In-memory DOM rendering checks for initial, unavailable and populated states. These are isolated renderer tests, not a running browser or an online watcher test; no fixture data is bundled into the dashboard.
- Byte comparison against the pre-edit source confirms unchanged configuration/state, derived data, polling, caching, deduplication, RPC/transaction handling, render scheduling and tab handlers. `config.js` and `chain.js` are unchanged.
- Calculated contrast for text, muted text, accent, approval and refusal colours against every defined surface: light minimum **5.55:1**, dark minimum **6.68:1**. Rendered contrast and focus appearance remain unverified.
- HTML ID/reference checks and whitespace/diff checks.

## Still requires a real browser

| Viewport | Light, watcher offline/online | Dark, watcher offline/online |
| --- | --- | --- |
| 1440×900 | Unverified | Unverified |
| 1280×720 | Unverified | Unverified |
| 390×844 | Unverified | Unverified |

For each condition, capture a screenshot, check the browser console, verify no page-level horizontal overflow, and inspect long refusal reasons and IDs. Check the intentional table scroller, tab arrow keys, disclosure focus, theme switching and reduced motion. Repeat from `file://` and a static server. An actual online watcher must be supplied by the owner; no signing process was started here.

The source redesign is implemented. It is not a claim of completed visual acceptance, browser compatibility or end-to-end transaction testing.
