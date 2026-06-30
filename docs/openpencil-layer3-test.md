# OpenPencil Layer-3 test path (ChatGPT end-to-end)

A minimal-but-complete run that verifies the visual-review feature through ChatGPT
itself — in one sitting (~30 min). Do the probes **in order**: the save-gate probe
must run before any screenshot unlocks it, and the decisive vision probe runs early.

The single most important question this answers: **does ChatGPT's vision actually
receive the screenshot image through MCP**, or is it just reasoning from node JSON?

## 1. Preconditions

- [ ] `cd ~/bindev/devspace && npm run build` (current build).
- [ ] `.env` has `ENABLE_OPENPENCIL=1` and `ALLOWED_ROOTS=/Users/hezibin/bindev/devspace-sandbox` (never `~` or `/`).
- [ ] `op start --web` is running (live canvas / read-nodes available).
- [ ] Fonts: nothing to install — Inter is bundled. For Chinese, `npm run fetch-fonts`. A `missing-font-family` lint is a *content* signal, not a setup failure.
- [ ] **Fresh DevSpace server process** — the save-gate Set is process-lifetime and never cleared, so a prior screenshot would pre-unlock it. Restart the service and do **not** screenshot before Probe B.
- [ ] ChatGPT **developer mode** with the devspace MCP connector added, and you can read the **tool-call log** (which `openpencil_*` fired, args, isError).
- [ ] Trap seed present at the **workspace root**: `devspace-sandbox/vision-probe.op` (pre-built; regenerate with `node scripts/make-vision-probe.mjs`). Tool paths are workspace-relative, so with the workspace opened at `/Users/hezibin/bindev/devspace-sandbox` the screenshot path is just `vision-probe.op` (not `designs/vision-probe.op`).
- [ ] Prompt to paste: `docs/openpencil-chatgpt-prompt.md`.

## 2. The test path (ordered)

### Probe A — Vision (decisive; run first, read-only)

`vision-probe.op` has three colored section banners. Two titles are legible
(`Brief`, `Screens`); the middle teal band's title (`ORCHID-7741`) is painted
*behind* its own banner, so it exists in the JSON but is **invisible in pixels**.

**Paste (fresh chat):**
> Call `openpencil_screenshot` on `vision-probe.op` exactly once. Looking ONLY at
> the returned image, list every section title you can actually READ, top to
> bottom. For any band where you canNOT read a title, tell me its position
> (top/middle/bottom) and its band color. Do NOT call `openpencil_read_nodes`,
> `openpencil_get`, or `openpencil_lint_design`, and do not use the screenshot
> tool's text summary — answer purely from the picture.

- **PASS:** reads `Brief` and `Screens`; reports the **middle** band has **no
  readable title** and is **teal**; does **not** produce the string `ORCHID-7741`.
- **FAIL:** reports `ORCHID-7741` as present/legible (it read JSON), or says it
  can't see any image at all.
- **Where to look:** tool-call log must show **one** `openpencil_screenshot` and
  **zero** read/get/lint calls (else void, re-run in a fresh chat). The image is
  the only source of the right answer — the screenshot tool's text/structured
  output carries no title or color.

### Probe B — Save gate (negative → positive; before any other screenshot)

1. Have the model `openpencil_insert` a tiny design (3–5 nodes) into a new `.op`.
2. Ask it to `openpencil_save` **without** screenshotting and **without** `force`.
   → **expect blocked.**
3. `openpencil_screenshot` the same workspace (needs ≥1 node).
4. `openpencil_save` again (no force). → **expect success.**
5. (Optional, separate fresh process) `openpencil_save` with `force:true` and no
   screenshot. → **expect success** (bypass).

- **PASS:** step 2 returns `isError:true` containing **"blocked by the
  visual-review gate"** and writes no file; step 4 succeeds; step 5 bypasses.
- **FAIL:** step 2 saves anyway, or fails with a different/generic error.
- **Where to look:** tool-call log — step 2 must have no prior screenshot and no
  `force`. Assert the exact gate substring (separates the gate from a path/CLI error).

### Probe C — Clarify-before-build

Paste `docs/openpencil-chatgpt-prompt.md`, then: *"Design a login form."*

- **PASS:** asks all **8** STAGE-1 questions, summarizes a one-paragraph Brief,
  and waits for "go" — with **zero** `openpencil_*` calls in the first response.
- **FAIL:** any design tool fires before "go", or <8 questions.
- **Where to look:** tool-call log empty for the first turn; chat shows the questions.

### Probe D — Node-by-node + colored bars + foundation reuse (Design A)

After "go", drive a 3-section package: `Section / 00 Brief` (Banner BG `#1F2937`),
`Section / 04 Foundations` (`#0F766E`), `Section / 07 Screens` (`#BE123C`). Each:
a white `Section Title` + `Banner BG` as the **last** child. Define `04` tokens as
named layers; both screens reference the same Foundations frame.

- **PASS:** ≥3 `openpencil_insert` (not `openpencil_design`); screenshot shows 3
  distinct colored bands; `openpencil_lint_design` returns **no**
  `background-z-order` / `missing-section-banners` / `incomplete-section-banner`;
  read-nodes shows a shared Foundations id across screens.
- **FAIL:** uses `openpencil_design`; bars missing/uncolored/not-last; divergent tokens.
- **Where to look:** tool-call log (insert vs design); returned image (band colors);
  lint output; read-nodes (shared id).

### Probe E — State matrix: empty cell → fix → clean (Design B)

Build `Section / 06 State Matrix` with a `Matrix / Header Row` (Default/Hover/Active)
and a `Matrix / Row / Button` of 3 `Matrix Cell / Button / <State>` frames — **leave
one cell empty on purpose** — then `openpencil_lint_design`.

- **PASS:** first lint = exactly one `empty-state-cell` error (the empty cell), no
  `missing-state-matrix-headers`; model `openpencil_update`s the cell; second lint =
  0 issues; screenshot shows all cells filled.
- **FAIL:** headers warning despite a Header Row; empty cell unflagged or a filled
  cell flagged; saves without fixing.
- **Where to look:** lint output; tool-call log (the `update` between two lints);
  the returned image.

### Probe F — Screenshot → critique → fix loop (Design C, one deliberate flaw)

Build a small design with **one** intentional flaw — a `Banner BG` that is *not* the
last child (it covers its title) or a `Section Title` narrower than its text (clips).
Then: *"Review the design visually and fix any issues you find."*

- **PASS:** screenshot #1 → model cites the flaw **from the image** ("the banner is
  covering the title"), calls `openpencil_move`/`openpencil_update`, screenshot #2 →
  confirms fix; ≤3 shots total.
- **FAIL:** "looks good" with no analysis; no fix despite a visible flaw; >3 shots.
- **Where to look:** chat (critique references the image); tool-call log (2–3 shots
  with an update/move between); the `.op` (banner now last / box widened).

## 3. One-glance pass table

| Mechanism | Pass |
|---|---|
| Clarify-before-build | 8 questions + Brief + waits; no tool calls before "go" (C) |
| Vision image received | Reports pixel-only facts (middle band hidden + teal); can't read ORCHID-7741 (A) |
| Save visual-review gate | Blocked pre-screenshot; unlocks after; `force` bypasses (B) |
| Node-by-node + colored bars | ≥3 inserts (not design); 3 colored bands; no `background-z-order` (D) |
| Foundation reuse | Shared Foundations id; matching tokens across screens (D) |
| State matrix | One `empty-state-cell` → fixed → clean; headers ok (E) |
| Critique→fix loop | Cites flaw from image, fixes, re-shoots, ≤3 (F) |
| Lint no false positives | Clean Design A/B return none of the structural codes (D, E) |

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| No image in ChatGPT / answers from text | MCP host dropped the image content block; only the text summary arrived (it carries no title/color) | This is THE vision diagnostic, not a model failure. Require the pixel-only detail; if absent, fix the connector / image passthrough, not the prompt |
| Vision "false pass" (reads ORCHID-7741) | Model called `read_nodes`/`get` | Verify the tool-call log shows zero reads; void + re-run in a fresh chat |
| Save gate not blocking | A screenshot earlier in the same process already unlocked the Set, or `force:true` was added | Restart the server; run save as the first tool call; confirm no prior screenshot/force |
| Save gate "false fail" (step 4 still blocked) | The screenshot threw `No OpenPencil nodes to screenshot`, so it never unlocked | Ensure ≥1 node before screenshotting; use the same workspace for screenshot→save |
| Lint rule not firing | Names don't match: `Section / NN <Title>`, `Matrix Cell / …`, `Matrix / Header Row`, matrix frame matching `State Matrix`/`Section / 06`; or <2 screens and ≤3 top frames | Use the literal names from `docs/openpencil-chatgpt-prompt.md`; ensure ≥2 Screen frames |
| Bars look white/gray | Banner BG near-white or authored not-last (renders behind/over wrongly) | Last child + saturated category fill (00 #1F2937, 04 #0F766E, 06 #B45309, 07 #BE123C, 10 #0E7490) |
| Text clipped / odd metrics | A font Inter can't supply | Use Inter (bundled) or `npm run fetch-fonts` for Chinese; widen text boxes |
