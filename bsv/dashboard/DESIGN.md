# Dashboard design

Audience: hackathon judges, on a projector or in a 2:30 demo video, for the BSV, API3 and TUM Blockchain tracks.

## Visual system

- One identity colour per chain, used on marks only (dots, rules, bars, tags): API3 / Base Sepolia blue, BSV mainnet
  gold. Text stays in the text tokens. Dark: `#4c8bed` / `#b98a1f` on `#111316`; light: `#2f63c8` / `#9a6b00` on
  white. Both pairs pass the dataviz palette validator (lightness band, CVD separation, normal-vision floor, contrast).
- Green and red mean valid / refused and always come with a word (“Rejected”, “Valid”, “Refused”).
- Sizes are in rem, so video mode scales the whole page from one root size (16 → 18 px).
- Glass layer (visionOS-like): frosted translucent panels (`backdrop-filter`) on a softly lit gradient backdrop,
  26 px radii, a floating icon rail with chain dots, a top bar with connection pills and round controls. In the light
  theme the same panels are milk glass.
- Charts from live data only: signed BSV/USD prices accepted on chain (line, last value labelled), each withdrawal
  against the limit its intent set on Base (bars with a limit marker, newest highlighted, legend), the daily budget as
  a ring. Hover titles give the exact values.
- Layout: icon rail on desktop, top bar on tablets and phones; cards on a 1.25 rem grid; tables scroll inside their
  card on phones.
- Motion: a short settle on new steps and checks, a breathing dot for “waiting”, a spotlight ring on the chapter's
  panel in video mode. Reduced-motion turns all of it off.

## Checked

Rendered with headless Chromium against the live sources (Base Sepolia, WhatsOnChain; watcher and owner server
offline): every view at 1920×1080 dark, the API3 view at 1440×900 light, the overview at 390×844, and video mode
chapters 1, 3, 5 and 6. The tamper test returned “1 valid · 4 rejected” on the live contract with a fresh runner price,
and pasting `api3/test/fixtures/coinpaprika-bsv-usd.json` gave StaleSignature for the untouched copy and four
rejections. Not checked here: the owner actions and “Run the agent” against a running owner server and watcher.
