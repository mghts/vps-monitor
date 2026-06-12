**Comparison Target**

- Source visual truth: `design/signal-atlas-reference.png`
- Desktop implementation: `design/qa/signal-atlas-desktop-final.png`
- 3D implementation: `design/qa/signal-atlas-globe-desktop-final.png`
- Mobile implementation: `design/qa/signal-atlas-mobile.png`
- Full-view comparison: `design/qa/signal-atlas-comparison.png`
- Focused comparison: `design/qa/signal-atlas-focus-comparison.png`
- Round 1 comparison: `design/qa/round1-comparison.png`
- Round 1 2D map: `design/qa/round1-map-2d.png`
- Round 1 3D stability state: `design/qa/round1-map-3d-stable.png`
- Round 1 multi-target Ping: `design/qa/round1-ping-both.png`
- Round 2 comparison: `design/qa/round2-comparison.png`
- Round 2 wrapped 2D map: `design/qa/round2-map-2d.png`
- Round 2 animated 3D globe: `design/qa/round2-map-3d.png`
- Round 2 softened Ping palette: `design/qa/round2-ping-both.png`
- Viewport: 1440 x 1024 desktop; 390 x 844 mobile
- State: dark theme, populated demo dataset, overview dashboard; 2D default plus manually selected 3D state

**Findings**

- No actionable P0, P1, or P2 mismatch remains.
- Typography: the implementation keeps the reference's compact operational hierarchy using an Inter/SF Pro/system stack, readable 14px product text, restrained small labels, and no negative letter spacing.
- Spacing and layout: sidebar width, status strip, asymmetric map/health composition, and lower table/chart split follow the source hierarchy. The 2D map shown in the default implementation is an intentional product requirement, not design drift.
- Colors and tokens: graphite surfaces, cyan telemetry, emerald healthy state, amber warning, and coral critical state map closely to the source. Contrast remains readable in both dark and optional light themes.
- Image and map quality: the 3D globe uses a project-local 2048 x 1024 equirectangular Earth texture rather than a placeholder. Canvas verification showed a nonblank crop with 8,067 colors and grayscale standard deviation 0.05349.
- Copy and content: Chinese labels consistently describe actual product behavior. Logical map lines are explicitly marked `逻辑连接 · 非真实路由`.
- Responsive behavior: the 390px viewport has no horizontal overflow (`scrollWidth` 375 at a 390px viewport), controls wrap cleanly, and dense tables remain scrollable.
- Interaction: 2D/3D switching, theme switching, navigation, filters, Ping ranges, admin registration/login, and admin workspace loading were exercised against the local app and API.
- Map round 1: 2D logical connections now use great-circle interpolation with a soft glow/core treatment. Leaflet is clamped to world bounds, tiles use `noWrap`, and repeated horizontal worlds are disabled.
- Globe round 1: camera state survived more than two 5-second dashboard refresh cycles after a manual drag. Auto-rotation is disabled, rotation speed is reduced, and the reset control returns the center server to the viewport center.
- Ping round 1: three simultaneous targets were verified with distinct colors. Latency uses solid curves, packet loss uses dashed curves, and latency-only, loss-only, and combined modes were exercised.
- Public sidebar: center node name and coordinates are visible in a dedicated lower-left card.
- Round 2 world wrapping: the 2D map permits one controlled adjacent world in either direction, preventing empty side gutters while keeping horizontal panning finite. Cross-dateline arcs use unwrapped longitudes and remain continuous.
- Round 2 motion: 2D route dash offset changed from `-13.2143px` to `-27.4993px` during a 650ms observation. Two 3D canvas samples 900ms apart differed by 7,262 pixels, confirming moving route particles.
- Round 2 globe routing: long routes now use spherical interpolation. Front-facing paths are softly elevated, while hidden-side continuation is rendered as a low-opacity surface trace so American routes do not appear broken.
- Round 2 palette: map and Ping lines now share a softer cyan, mint, lavender, amber, coral, blue, and mauve family with sufficient contrast against the graphite background.
- Admin persistence: the center-location card remains present after entering the management workspace.

**Patches Made During QA**

- Corrected the Three.js renderer CSS sizing so the globe no longer rendered oversized and clipped.
- Recentered the camera and changed the initial globe rotation toward Asia-Pacific.
- Lazy-loaded the Three.js bundle so the default 2D view does not download the 3D engine.
- Split charts, maps, icons, React, and the globe into separate production chunks.
- Added responsive rules for status metrics, map controls, tables, forms, and the mobile sidebar.
- Added independent reset controls for 2D and 3D map modes.
- Added target identity fields to the public Ping series API so legends remain data-backed.
- Added controlled world copies and duplicate node/route layers for seamless 2D dateline rendering.
- Added animated 2D route pulses and moving Three.js route particles.
- Renamed the combined Ping mode to `延迟 + 丢包`.

**Follow-up Polish**

- P3: a future release could add reduced-detail globe geometry for very old mobile GPUs, although current rendering already caps device pixel ratio at 2.

**Implementation Checklist**

- [x] Public dashboard redesigned.
- [x] Admin workspace redesigned.
- [x] Smooth truthful telemetry curves.
- [x] Default 2D map and optional interactive 3D globe.
- [x] Desktop and mobile visual verification.
- [x] 2D world-bound and reset interaction verification.
- [x] 3D camera persistence and reset interaction verification.
- [x] Multi-target Ping legend and display-mode verification.
- [x] Center-location card persistence in the management workspace.
- [x] Controlled 2D world extension with no side gutters.
- [x] Dynamic 2D and 3D route-motion verification.
- [x] American-route continuity verification on the 3D globe.
- [x] Production build and Docker image build.

final result: passed
