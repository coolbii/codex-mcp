# OpenPencil design prompt (paste into ChatGPT)

Use this with the DevSpace OpenPencil MCP connected. It forces a staged, gated
flow (clarify → plan → foundations → build → **look at it** → save) instead of a
one-shot guess. Replace the bracketed parts.

---

You are designing a professional product UI in OpenPencil via the `openpencil_*`
tools. Work in stages and do not skip the gates.

**Reference (optional):** Analyze `[URL or "the attached screenshots"]` as a style
reference only. Do not copy its logo, text, images, layout, or brand. Extract only
reusable principles: visual tone, typography behavior, spacing rhythm, color
strategy, interaction feel, component organization, and section structure.

**STAGE 1 — CLARIFY (do this first, then stop and wait for my answers):**
Ask me, in one message, all of:
1. Who is the user and the single job this screen must accomplish?
2. Surface and viewport(s)?
3. Three adjectives for the feel (not "modern").
4. Existing brand tokens (color / type / spacing / radius), or should you propose
   a set for me to approve?
5. Which components are in scope?
6. Which screens, and how many?
7. Which of the 10 states (default, hover, focus, active, selected, disabled,
   loading, empty, error, success) matter, and which are N/A?
8. Is the deliverable a full design package (00–10 with section bars) or one
   polished screen?
Summarize my answers as a one-paragraph Brief and wait for me to say "go".

**STAGE 2 — PLAN (no canvas writes yet):** Propose the Information Architecture,
the user flow, and the design foundations (color/type/spacing/radius tokens with
rationale). Wait for my approval.

**STAGE 3 — BUILD (node-by-node, not `op design`):**
- Define `04 / Foundations` tokens as named layers and reuse them everywhere.
- If a package: stack section bands top-to-bottom, each a frame named
  `Section / NN <Title>` (00 Brief … 10 Handoff) with a VISIBLE COLORED bar — a
  full-width `Banner BG` rectangle as the **last child** in the band's category
  color (00 slate #1F2937, 04 teal #0F766E, 06 amber #B45309, 07 rose #BE123C,
  10 cyan #0E7490, etc.), plus `Index Chip` + `Index Number`, a white
  `Section Title`, and a `Section Subtitle`.
- Build `06 / State Matrix` as a real grid: a `Matrix / Header Row` with the 10
  state headers, then `Matrix / Row / <Component>` rows whose
  `Matrix Cell / <Component> / <State>` cells each hold a variant or a
  `n/a — reason` text (never blank).
- Every text node sets an explicit `fontFamily` ("Inter" for English, "Noto Sans
  SC" for Chinese) and a concrete `fontWeight`. Size text to its box.

**STAGE 4 — VISUAL REVIEW (mandatory before saving):**
- Call `openpencil_screenshot` (use `id` to crop to each `Screen` / `Section`).
- Look at the returned image and score it honestly: any overlap, clipping, or
  misalignment? Are the section bars visible and colored? Are all matrix cells
  filled? Is the primary action obvious when you squint? Does it look professional
  and match my three adjectives, or generic?
- Fix every problem with `openpencil_update` / `openpencil_move`, then screenshot
  again. Repeat until it looks right (max ~3 rounds). Show me the screenshots.

**STAGE 5 — FINISH:** Run `openpencil_lint_design` and fix all errors
(`missing-font-family`, `background-z-order`, `empty-frame`,
`missing-section-banners`, `empty-state-cell`). Then save to
`designs/[name].op` with `openpencil_save` and confirm with `openpencil_get`.

Do not claim the design is done until you have shown me a screenshot you are
willing to defend as professional.
