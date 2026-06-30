# OpenPencil design harness

This harness defines the expected structure for AI-authored OpenPencil product
design files. The goal is not to make screens that merely look polished. The
goal is to create a design artifact that a product designer, PM, and engineer
can inspect, edit, critique, and continue.

## What "Apple-like" means here

Use Apple as an example of file discipline, not as a visual style to copy.
Apple publishes official design resources and Human Interface Guidelines that
pair platform templates with component conventions, states, layout rules, and
hand-off expectations. Our OpenPencil output should follow the same kind of
discipline:

- clear page/section organization
- reusable foundations and components
- screen flows grouped by user task
- state matrices for interactive components
- annotated rationale and tradeoffs
- implementation notes that make engineering handoff possible

Do not interpret "Apple-like" as white surfaces, huge typography, or Apple.com
marketing layout.

Useful references:

- Apple Design Resources: https://developer.apple.com/design/resources/
- Apple Human Interface Guidelines: https://developer.apple.com/design/human-interface-guidelines

## Required file structure

Every serious OpenPencil product design should contain these top-level frames or
pages. Small exploratory sketches may omit some sections only when the user asks
for a quick sketch.

```txt
00 / Brief
01 / Reference Audit
02 / Information Architecture
03 / User Flows
04 / Foundations
05 / Components
06 / State Matrix
07 / Screens
08 / Responsive
09 / Review Notes
10 / Handoff
```

### 00 / Brief

Define the product context before drawing UI.

- product name and surface
- target user and user job
- primary task
- constraints and non-goals
- device targets
- success criteria
- explicit anti-references

This should be visible as an editable frame in the canvas, not hidden in chat.

### 01 / Reference Audit

Use references as research, not as sources to copy.

For each reference, capture:

- what problem it solves
- layout organization
- interaction pattern
- useful component vocabulary
- what not to copy

The audit should include callouts around screenshots or abstracted thumbnails.
If screenshots are not available, use labeled reference cards.

### 02 / Information Architecture

Show the content model and navigation hierarchy.

- main sections
- nested pages or tabs
- object types
- key actions
- empty/loading/error surfaces

For product tools, this often matters more than a beautiful hero.

### 03 / User Flows

Map screens by task, not by visual variety.

Each flow should show:

- entry point
- decision points
- success path
- error/recovery path
- exit or next action

Use flow names such as `Flow / Merchant signs in`, `Flow / Campaign budget
adjustment`, or `Flow / Checkout recovery review`.

### 04 / Foundations

Create shared primitives before composing screens.

Required foundations:

- color tokens
- type scale
- spacing scale
- radius/elevation
- grid and breakpoints
- icon style
- accessibility notes

Every text layer must use an explicit `fontFamily` and `fontWeight`. Use
`Inter` for English product UI and `Noto Sans SC` for Chinese UI unless a
project design system says otherwise.

### 05 / Components

Components should be editable, reusable frames, not one-off rectangles.

Required component coverage for product UI:

- button: primary, secondary, ghost, destructive
- text field: default, focus, filled, error, disabled
- navigation item: default, hover, active
- tab or segmented control
- card or panel only when it frames real repeated content
- table/list row when the product contains repeated records
- alert/toast/inline validation

Name components semantically:

```txt
Component / Button / Primary / Default
Component / TextField / Error
Component / NavItem / Active
Component / CampaignCard / Compact
```

### 06 / State Matrix

Interactive product design is incomplete without states.

Create a matrix for:

- default
- hover
- focus
- active
- selected
- disabled
- loading
- empty
- error
- success

If a state is intentionally out of scope, add a note explaining why.

### 07 / Screens

Screens should be composed from foundations and components.

Recommended screen layer tree:

```txt
Screen / <surface> / <viewport>
  Foundations / Background
  Layout / Header
  Layout / Sidebar
  Layout / Main
  Content / <domain section>
  Component Instance / <component name>
  States / <state variants>
  Notes / Design rationale
```

Avoid flat screen-only drawings. A human editor should be able to identify and
reuse the system behind the screen.

### 08 / Responsive

Show at least two viewport treatments when the surface is web or app UI.

- desktop
- tablet or narrow desktop when relevant
- mobile when relevant

For responsive layouts, call out structural changes: navigation collapse, grid
column changes, table-to-list conversion, sticky actions, and density changes.

### 09 / Review Notes

Use critique notes as part of the design file.

Include:

- open questions
- PM decisions needed
- UX risks
- engineering risks
- accessibility risks
- copy needing legal or brand review

### 10 / Handoff

Make implementation possible.

Include:

- token summary
- component inventory
- screen inventory
- assets needed
- interaction notes
- edge cases
- known deviations from references

## Generation workflow (staged and gated)

Do not jump straight to drawing. Design is a staged process with checkpoints, the
same way a human team moves from investigation to plan to build to review. Each
phase ends in a gate; do not advance until it passes.

```
Phase 0  INVESTIGATE   read existing .op nodes, any design-system notes, and the reference
Phase 1  CLARIFY       ask the user the question set below, then WAIT for answers
Phase 2  PLAN          Brief + IA + Flows as prose/plan, no .op writes — user approves
Phase 3  FOUNDATIONS   04 tokens (color/type/spacing/radius) as named layers
Phase 4  COMPONENTS    05 components + 06 state matrix
Phase 5  SCREENS       07 screens + 08 responsive
Phase 6  VISUAL REVIEW openpencil_screenshot → critique → fix → re-shoot (see below)
Phase 7  HANDOFF       09 review notes + 10 handoff, then save
```

### Phase 1 — the CLARIFY questions

Ask these and wait for answers before any `openpencil_insert`. Summarize the
answers back as a one-paragraph Brief and get an explicit "go".

1. Who is the user and what is the one job?
2. What surface and viewport(s)? (1440 desktop, 390 mobile, both…)
3. Three adjectives for the feel — a real direction, not "modern".
4. Reference source: a Figma file, a live URL, or screenshots to extract
   structure and tokens from (not to copy)? If a public URL is given and
   `extract_design_reference` is available, call it to get the real palette, type
   scale, weights, spacing, radii, and a screenshot — ground `01 / Reference
   Audit` and `04 / Foundations` in those values instead of guessing.
5. Existing brand tokens (color/type/spacing/radius), or should you propose a set
   for approval?
6. Which components are in scope for `05` and the `06` state matrix?
7. Which screens, and how many?
8. Which of the 10 canonical states matter here? Any that are N/A?
9. Is the deliverable a full design package (`00`–`10` with section bars) or a
   single polished screen?

### Phase 6 — the visual review loop

Structural lint cannot tell whether a screen looks good to a human. Render it and
look. Run a bounded loop (≈3 iterations max):

1. **Render.** Call `openpencil_screenshot` (optionally `id` to crop to one
   `Screen` or `Section` frame). It returns a PNG as an image you can see.
2. **Critique.** Score the image: any overlap, clipping, or misalignment? Are the
   section bars visible and colored? Are all state-matrix cells filled? Is the
   primary action obvious when you squint? Does it look professional and match the
   three adjectives from CLARIFY — or generic?
3. **Fix.** For each problem, `openpencil_update` / `openpencil_move` the offending
   node, then re-shoot.
4. **Stop.** Exit when it passes or after ~3 iterations; if it still fails, report
   the remaining issues to the user rather than claiming success.

`openpencil_save` is gated on having run `openpencil_screenshot` at least once
(pass `force: true` only after a deliberate human decision to skip review).

## Canvas organization (section bars)

"Apple-like file discipline" must be visible on the canvas, not just in the layer
panel. Lay the package out as a vertical rail of `Section / NN <Title>` bands with
colored banners. **Use the helpers — they produce this lint-clean by construction:**

- **`openpencil_insert_section_band`** — one call per section (`index`, `title`,
  `subtitle`). Writes the `Section / NN <Title>` frame with a full-width `Banner BG`
  rectangle (category color, **last child** so it paints behind), `Index Chip` +
  `Index Number`, white `Section Title`, and `Section Subtitle`, auto-stacked down
  the page. Category colors: `00` slate `#1F2937`, `01` violet `#5B21B6`, `02`
  indigo `#3730A3`, `03` blue `#1D4ED8`, `04` teal `#0F766E`, `05` green `#15803D`,
  `06` amber `#B45309`, `07` rose `#BE123C`, `08` fuchsia `#A21CAF`, `09` orange
  `#C2410C`, `10` cyan `#0E7490` (override with `color`).
- **`openpencil_insert_state_matrix`** — one call for band `06` (`components`,
  `states`). Authors a `Matrix / Header Row` plus one `Matrix / Row / <Component>`
  per component, every `Matrix Cell` filled — so `missing-state-matrix-headers` and
  `empty-state-cell` pass automatically.

Both write canonical op JSON (array fills) directly into the `.op` file, which is
reliable; `op insert --file` does **not** persist to the file, and `write_file` of
raw `.op` JSON is error-prone — so prefer the helpers.

## Authoring path

Build the rail and matrix with the helpers above. For tokens and bespoke content,
use `openpencil_insert` / `openpencil_update` / `openpencil_move` /
`openpencil_replace` (array fills), not `op design`. `op design` is a one-shot
black box you cannot organize into bands or fix during visual review, because it
does not give you node ids to update — use it only to seed the interior of a single
screen, then lift that content into the node-authored structure.

Note: read tools — `openpencil_lint_design` and `openpencil_screenshot` read via
`op get` (reliable), because `op read-nodes` can return empty (JSON formatting) or
stale (the running app's cache) data.

## Quality gate

Do not claim product-ready output unless all are true:

- the file contains a brief, flow, component inventory, screens, and handoff
- layers are semantically named
- components have multiple states, and `06` matrix cells are all filled
- the canvas carries visible colored `Section / NN` bars (≥3 for a package)
- references are analyzed, not copied
- typography, spacing, color, and radii are tokenized
- the design includes real domain content
- you ran `openpencil_screenshot` and visually confirmed it looks professional
- `openpencil_lint_design` has no errors

### Gate ↔ lint-code map

| Requirement | Enforced by |
| --- | --- |
| Explicit fonts | `missing-font-family` (error) |
| Background behind content | `background-z-order` (error) |
| No empty frames | `empty-frame` (error) |
| Visible colored section bars | `missing-section-banners` (error), `incomplete-section-banner` (warning) |
| Filled state matrix | `empty-state-cell` (error), `missing-state-matrix-headers` (warning) |
| Looked at the result | `openpencil_save` visual-review gate |

