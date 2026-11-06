# After Hours design

The user's selected reference guides the public website and local console: warm black, ivory typography, copper accents, brushed metal artwork, and layered command cards. The network uses records and tables without a flowchart.

The design changes how pages look, not which pages there are or how you move between them. The site keeps its own flow: the header lists Home (Live demo when connected to the demo), Network, Recalls, Check a tool, Report, Protect an agent and Recall a tool, in that order, and an unknown address shows the home page.

## Coverage

- Public: home, network, recalls, individual recall, tool check, reports, agent protection, recall issuance, and agent record.
- Connected demo: responsive agent cards, controls, records, inbox, and activity history.
- Console: agents, this machine, reports, diary, Arkiv, and services; confirmation dialogs and loading/offline states.
- Motion for React (`motion/react`, backed by Framer Motion): page entrances, mobile navigation, active console navigation, agent cards, and confirmation dialogs. Reduced-motion preferences are respected.

## Running locally

From the repository root:

```sh
npm run web
```

The public website opens at `http://localhost:5173`. Use `npm run web:demo` for the connected demo with the existing demo backend running; its live screen is the home page, `http://localhost:5173`. The real console still starts with `ceasenet console`; open the authenticated URL printed by the CLI.

## Verification

The tests, TypeScript and both production builds pass. Motion marks its modules `use client`, which the bundler drops in these browser-only apps; the build hides that one warning.

`scripts/design-check.mjs` verifies the public routes and all six console pages at 1440, 768, 390, and 320 pixels. It checks that the header lists every page in order and that each link opens its page, that the mobile menu lists the same pages, that an unknown address shows the home page, confirmation validation and cancellation, diary filtering and empty state, readable mobile diary entries, and reduced motion. All external APIs are intercepted. Browser fixtures do not exercise real wallet signing, World ID verification, storage, or on-chain writes.

To repeat the browser checks, run the public server on 5173 and a console Vite server on 5174 (`npx vite apps/console --host 127.0.0.1 --port 5174`), then run `npm run test:design`. Chrome is used by default; set `DESIGN_BROWSER` to another installed Playwright browser channel if needed. `DESIGN_WEB_URL` and `DESIGN_CONSOLE_URL` override the server URLs.

For the connected-demo layout, run the public server in demo mode on 5175, then run `node scripts/design-live-check.mjs`. Its API responses are also intercepted. Screenshots and the main regression results are written to the ignored `.design-review/` directory.

## Artwork

- Saved asset: `apps/web/public/metal-ribbon.png`, with its style in `.metal-art`. It was made for a landing page the site no longer has, and is kept with the design.
- Generation: built-in image generation tool, opaque raster background.
- Prompt summary: wide abstract brushed-metal ribbon on a near-black background, finely textured silver surfaces with subtle warm copper edges, sweeping through the right side and lower edge, dark negative space on the left for the headline; premium photographic lighting; no text, interface, logos, nodes, or flowcharts.
- The artwork supplies only the background. Headline, buttons, panels, controls, and records are real HTML and React components.
