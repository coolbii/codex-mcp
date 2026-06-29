# OpenPencil design guidelines

These rules keep AI-authored OpenPencil canvases usable by designers and
credible as product UI. They apply whenever an assistant uses `openpencil_*`
tools to create or modify native OpenPencil nodes.

For full product design files, use the file-level harness in
[openpencil-design-harness.md](openpencil-design-harness.md). These guidelines
define the quality of individual screens and components; the harness defines
how a complete design artifact should be organized.

## Design quality bar

OpenPencil output should feel like a professional product surface, not a loose
wireframe unless the user explicitly asks for wireframes. Before inserting
nodes, define a short design brief:

- **User and job:** who is using this screen, what they are trying to finish.
- **Surface type:** dashboard, form, settings, onboarding, editor, report, etc.
- **Information priority:** primary action, secondary action, main content,
  supporting content, status/error areas.
- **Design strategy:** density, theme, color strategy, typography scale, and
  responsive assumptions.

Reject generic AI styling. Avoid decorative gradients, blobs, vague hero copy,
oversized type in dense tools, random rounded cards, inconsistent controls, and
monochrome gray placeholders that make the design unreadable.

Do not treat reference images as screenshots to recreate. Extract their
structure: page grouping, callout style, state coverage, component taxonomy,
handoff notes, and flow organization.

## Product UI principles

- Use familiar product patterns: header, sidebar, tabs, toolbar, form layout,
  tables, cards only where they frame a real repeated item or contained widget.
- Prefer restrained color: tinted neutral surfaces plus one accent for primary
  action, selection, and focus. Semantic colors are reserved for status.
- Typography should use one UI family, clear size steps, and readable contrast.
  Product labels should not use display fonts or decorative spacing.
- Every text node must set an explicit bundled `fontFamily`. Use `Inter` for
  English product UI, `Noto Sans SC` for Chinese UI, or another font bundled
  with OpenPencil. Do not rely on system fallback fonts; remote CanvasKit
  previews can render missing glyph boxes when a layer omits `fontFamily`.
- Size text to its container. Large headlines need deliberate wrapping,
  sufficient height, and enough distance from adjacent cards or controls.
- Every interactive element needs at least default, hover/focus implication, and
  disabled/error/loading states represented or documented in nearby component
  variants.
- Layout should be aligned to a grid. Use deliberate spacing rhythm instead of
  identical padding everywhere.

## Component organization

Build canvases as design systems, not flat drawings.

For production-oriented work, organize the overall file like a design package:

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

This is the intended meaning of "Apple-like" organization: template discipline,
component/state coverage, and handoff clarity. It is not an instruction to copy
Apple visual style.

Recommended layer tree:

```txt
Page
  Screen / <surface name> / <width>
    Foundations
      Background
      Grid
      Tokens note
    Components
      Button / Primary / Default
      Button / Secondary / Default
      TextField / Default
      TextField / Error
      NavItem / Active
      Card / Metric
    Layout
      Header
      Sidebar
      Main
      Aside
    Content
      <domain sections and widgets>
    States
      Empty
      Loading
      Error
```

Use frames for semantic groups and reusable component instances. Name layers by
role, not appearance: `Login Form Card`, `Email Field`, `Primary Action Button`.
Avoid names like `Rectangle 23`, `Text 9`, or `Blue Box`.

## Tokens

Prefer a small token set before drawing:

- **Color:** `surface/base`, `surface/panel`, `text/primary`,
  `text/secondary`, `border/subtle`, `accent/primary`, `status/error`,
  `status/success`.
- **Spacing:** 4, 8, 12, 16, 24, 32, 48.
- **Radius:** 6 or 8 for most product UI; larger only for major panels.
- **Type:** label, body, body-strong, title, display only when the surface is
  genuinely editorial or marketing.

If OpenPencil variables are unavailable, represent tokens as clearly named
foundation layers or notes so a human can turn them into variables later.

## OpenPencil node authoring

- Insert one coherent root frame per screen. Avoid scattering unrelated top-level
  nodes across the page.
- Put full-frame background layers at the bottom of their parent frame. In the
  current OpenPencil renderer, that means the background must be the **last child**
  of its parent. If a background covers content, use `openpencil_move` with
  `index: 999` to move it behind content.
- Set `fontFamily` and `fontWeight` on every text layer. Missing font family is
  treated as a design lint error because it can look correct locally while
  rendering as unreadable boxes in the ChatGPT preview.
- Use `openpencil_read_nodes` before edits and preserve human-edited nodes unless
  the user explicitly asks for replacement.
- Use `openpencil_move` for z-order and grouping. Do not rely on accidental child
  order.
- Before saving or attaching preview, run `openpencil_lint_design`. Fix any
  errors, especially `background-z-order`, `empty-frame`, `missing-section-banners`,
  and `empty-state-cell`.
- Before saving, run `openpencil_screenshot` and actually look at the rendered PNG:
  check for overlap, clipping, misalignment, uncolored section bars, empty matrix
  cells, weak contrast, and whether it looks professional to a human. Fix issues
  and re-shoot. `openpencil_save` is gated on having run a screenshot review.
- For a multi-section package, group frames under visible colored `Section / NN
  <Title>` bars (see the harness "Canvas organization" section), not a bare grid.
- Save with `openpencil_save` and verify with `openpencil_read_nodes`,
  `openpencil_lint_design`, or `openpencil_get` before claiming success.

## Review checklist

Before finalizing an OpenPencil design, confirm:

- Text is readable, uses explicit font families, and is not rendered as missing
  glyph boxes or tiny placeholder blocks.
- Primary action is obvious, but not visually shouting.
- Layer tree is navigable and semantically named.
- Backgrounds do not cover content.
- Spacing and alignment are consistent across sections.
- Components have a clear reusable vocabulary.
- The design has enough real domain content to be evaluated by a human.
