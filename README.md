# Moderneer Site

Official marketing site for **Moderneer** and **Telos Studio**.

## Positioning

- **Moderneer** — Outcome Engineering for enterprise technology leaders.
- **Telos Studio** — the executive decision-intelligence layer for Moderneer.

## Executive narrative

The homepage follows a single-page buying story:

**Problem → Outcome Engineering → Evidence → What you get → Telos Studio → Where it fits → Trust → Executive briefing**

The Telos page is a product-level deep dive:

**Decision Agenda → Executive workflow → Fix Now / Invest / Assure → Decision trust → Evidence → Briefing**

All product claims are grounded in the current Moderneer/Telos implementation. Public copy avoids invented customers, ROI claims or certifications.

## Structure

```text
.
├── index.html
├── telos.html
├── 404.html
├── CNAME
├── robots.txt
├── sitemap.xml
├── assets/
│   ├── css/styles.css
│   ├── js/app.js
│   └── images/
├── design/
└── docs/
```

## Local preview

Run any static web server from the repository root:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## GitHub Pages

The site deploys from `main` using `.github/workflows/pages.yml`.

`CNAME` is set to:

```text
moderneer.co.uk
```

## Contact

The executive briefing CTA opens email to `hello@moderneer.co.uk`. No non-functional demo form is published.

## Design principles

- Premium enterprise editorial rather than generic SaaS
- One continuous story on the homepage
- Dark Telos product sections provide the strongest visual contrast
- Real product constructs instead of vague feature claims
- Visible uncertainty and evidence provenance are part of the product story
- Responsive navigation and reduced-motion support are included
