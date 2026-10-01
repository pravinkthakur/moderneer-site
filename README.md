# Moderneer Site

Official marketing site for **Moderneer** and **Telos Studio**.

## Positioning

- **Moderneer** — Outcome Engineering for enterprise technology leaders.
- **Telos Studio** — the executive decision-intelligence experience for Moderneer.

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
│   ├── css/
│   │   └── styles.css
│   ├── js/
│   │   └── app.js
│   └── images/
│       ├── favicon.svg
│       ├── moderneer-mark.svg
│       ├── moderneer-wordmark.svg
│       ├── social-preview.svg
│       └── telos-decision-visual.svg
├── design/
│   ├── README.md
│   └── tokens.json
└── docs/
    ├── CONTENT_GUIDE.md
    └── WEBSITE_STRATEGY.md
```

## Local preview

Run any static web server from the repository root, for example:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## GitHub Pages

The repository is designed to publish directly from the root of the `main` branch.

`CNAME` is already set to:

```text
moderneer.co.uk
```

After enabling GitHub Pages, configure the DNS records at the domain provider and then enable HTTPS in GitHub Pages when available.

## Notes

The contact form is currently a visual/demo form and does not send data. Connect it to the chosen CRM or form handler before using it for live lead capture.


## Deployment

Published with GitHub Pages from the `main` branch using the Pages Actions workflow.
