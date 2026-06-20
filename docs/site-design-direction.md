# Site design direction

This is the default visual direction for generated site previews. It is meant to
reduce generic "AI-generated SaaS" output and push generated pages toward
specific, usable, reviewable design.

## Principles

- Start from the domain and audience, not from a generic landing page pattern.
- Use restrained typography and spacing. Make hierarchy obvious without
  oversized text everywhere.
- Prefer a few purposeful sections over many shallow cards.
- Make UI dense enough for the use case: operational tools should feel quieter
  and more work-focused than marketing pages.
- Use real content structure: concrete headings, specific benefits, plausible
  pricing or workflow details, and clear next actions.
- Keep responsive layout stable with explicit grid, width, and aspect-ratio
  constraints where useful.
- Keep HTML complete and semantic. Every generated page should have a valid
  document structure and accessible text contrast.

## Anti-patterns

Avoid these unless the user explicitly asks for them:

- Gradient blobs, bokeh, decorative orbs, and purple-blue default gradients.
- Fake dashboard screenshots used as generic decoration.
- Over-rounded nested cards and card-inside-card layouts.
- One-note palettes dominated by one hue family.
- Vague headings such as "Transform your workflow" without domain context.
- Huge hero sections that hide the next section on first viewport.
- Inline SVG illustrations where real content, layout, or product state would be
  more useful.
- Dense animation or parallax that distracts from inspecting the generated site.

## Baseline Style

- Radius: 8px or less for cards/buttons unless a brand direction says otherwise.
- Letter spacing: use 0 for normal text; small positive tracking only for short
  labels or eyebrows.
- Type: system UI stack by default; avoid viewport-scaled font sizes.
- Color: choose a functional palette with at least one neutral base and one
  restrained accent. Avoid default purple gradients.
- Layout: use full-width sections with constrained inner content. Use cards only
  for repeated items or framed tools.

## Built-in Archetypes

`create_site` includes starter archetypes so ChatGPT can choose a constrained
layout before writing custom markup:

```text
b2b-saas-quiet
internal-dashboard
product-docs
editorial-product
```

These are intentionally plain HTML/CSS templates. The goal is to make the first
preview specific and editable, not to hide everything behind a complex generator.

## Next Steps

The next improvement should be to externalize the built-in archetypes into
editable template files and shared tokens:

```text
templates/
  b2b-saas-quiet.html
  internal-dashboard.html
  product-docs.html
  editorial-product.html
tokens.json
```

After that, add a small design review pass that scores generated pages against
the anti-pattern list before returning the preview.
