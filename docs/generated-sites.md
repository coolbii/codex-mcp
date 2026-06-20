# Generated site previews

devspace can create small, versioned static websites from ChatGPT and serve them
through the same HTTP server used for MCP.

## Where files are written

Generated sites live under the first configured `ALLOWED_ROOTS` entry:

```text
<ALLOWED_ROOTS[0]>/devspace-sites/<siteId>/
```

For example:

```text
/Users/you/ryta/devspace-sites/nimbusops-saas-landing-page-4f5610c6/
  index.html
  styles.css
  script.js
  .devspace-site.json
  .git/
```

`ALLOWED_ROOTS` itself must already exist. The `devspace-sites` folder and each
site folder are created automatically.

## Preview URLs

When `PUBLIC_BASE_URL` is set, every site gets a shareable local-tunnel preview:

```text
https://devspace.example.com/sites/<siteId>/
```

The preview server only serves files inside the generated site directory. It does
not expose the rest of the allowed root.

## Versioning

Each generated site is its own git repository. `create_site` initializes the repo
and commits the first version. `update_site` writes the supplied full files and
commits a new version when content changed.

Useful commands:

```bash
cd /Users/you/ryta/devspace-sites/<siteId>
git log --oneline
git status
git show HEAD:index.html
```

## Tools

| Tool | What it does |
|---|---|
| `create_site` | Creates a static site, initializes git, returns a preview URL, and opens the ChatGPT preview widget. |
| `update_site` | Replaces supplied full files and commits a new version. |
| `list_sites` | Lists generated sites and their preview URLs. |
| `get_site_versions` | Shows recent git commit history for one site. |

## Archetypes

`create_site` accepts an optional `archetype`. Prefer an archetype plus a clear
prompt over raw `html`/`css` when you want a faster, more consistent first pass.

| Archetype | Best for |
|---|---|
| `b2b-saas-quiet` | Restrained B2B or product landing pages. |
| `internal-dashboard` | Dense operational tools, admin consoles, and internal workflows. |
| `product-docs` | Documentation, API guides, setup pages, and onboarding references. |
| `editorial-product` | Product storytelling, launch pages, and narrative feature pages. |

When `html`, `css`, or `js` are omitted, DevSpace writes starter files from the
selected archetype. Supplying any of those fields overrides that file while still
keeping the site versioned and previewable.

## HTML safety

Model-generated HTML is normalized before writing. If a model returns a partial
document, devspace adds the missing document structure (`doctype`, `html`,
`head`, `body`, and closing tags) so browser/CDN-injected scripts do not get
parsed into an unterminated tag.

This is a guardrail, not a design system. For higher quality output, prefer
templates and design tokens rather than unconstrained generation.

The current default visual direction is documented in
[site-design-direction.md](site-design-direction.md).
