# Quality gates

Everything is dependency-free Node (22 or later). Nothing here is published: the deploy job removes `tools/`, `docs/quality/`, `.githooks/`, `.gitattributes` and the allow-lists before uploading.

## What runs

| Check | Command | Covers |
|---|---|---|
| Secret scan | `node tools/quality/scan-secrets.mjs` | Credential formats in tracked files |
| Hygiene | `node tools/quality/check-hygiene.mjs` | Tracked secrets and oversized files, `.only`, fake test scripts, workflows that can falsely pass |
| Tool tests | `node --test "tools/quality/*.test.mjs"` | The checks above and below, including that each rule fails on a real defect |
| Site checks | `node tools/quality/check-site.mjs` | Doctype, lang, charset, viewport, unique title, description, canonical, one h1, tag balance, duplicate ids, alt text, labels, button and link names, `aria-labelledby`, internal links and fragments, referenced and required assets (case-sensitive), CSS `url()`, robots, sitemap, CNAME, what deployment would publish |
| Smoke | `node tools/quality/smoke-site.mjs` | Serves tracked files as Pages does and requests every page and asset; scripts must parse; unknown paths must give the 404 page |

CI: `.github/workflows/pages.yml`. On `main` the `deploy` job `needs: quality`, so a failed check stops publishing. Branches and pull requests run `quality` only.

Settings: `tools/quality/site.config.json`. A new page must be in `sitemap.xml`; a new top-level folder fails until it is added to `published.allowedTopLevel`.

## Run on Windows

```powershell
node tools/quality/scan-secrets.mjs
node tools/quality/check-hygiene.mjs
node --test "tools/quality/*.test.mjs"
node tools/quality/check-site.mjs
node tools/quality/smoke-site.mjs
```

## Install hooks

```powershell
git config core.hooksPath .githooks
```

`pre-commit` runs the secret scan on staged content, hygiene and site checks. `pre-push` runs everything.

## Published files

The deploy job removes tooling, `docs/`, `design/`, `.gitignore` and every Markdown file, then fails if any remaining file is not on its list of approved paths and types. These documents are still readable in the public repository.

## Not covered

- No real browser: JavaScript is parsed, not executed. The mobile menu, journey tabs and layout are not exercised.
- No colour contrast, keyboard or screen-reader testing. The accessibility checks are structural.
- External links are not requested.
- Em dashes in the existing titles and copy are not gated.
- GitHub Pages environment settings are not verifiable from the repository.
