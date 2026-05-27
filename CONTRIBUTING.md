# Contributing

Thanks for your interest in improving this project. Bug reports, feature suggestions, and pull requests are all welcome.

---

## Reporting bugs / requesting features

Open an issue with:

- **What you did** (steps to reproduce — copy/paste-able if possible).
- **What you expected.**
- **What actually happened** (full error message, stack trace, or screenshot).
- **Environment**: Node version (`node --version`), OS, AWS partition (Global vs China), browser if it's a UI bug.

For feature requests, describe the use-case first, then the proposed change — it's easier to suggest a different approach if the underlying need is clear.

---

## Development setup

Prerequisites: **Node ≥ 18** and an AWS account + Google Cloud project (see [README.md](README.md) for OAuth and credential setup).

```bash
git clone <your-fork-url>
cd copy-google-drive-to-aws-s3
npm install
cp .env.example .env
# fill in Google + AWS credentials in .env (see README)
npm run dev
# open http://localhost:3000
```

`npm run dev` uses Node's `--watch` flag, so the server restarts on file changes. The frontend (`public/`) has no build step — just refresh the browser.

### Project layout

```
config/         # Env wiring + validation
services/       # Google Drive + S3 clients
middleware/     # Auth guard
routes/         # Express route handlers (auth, drive, s3, transfer)
public/         # Static frontend (HTML/CSS/JS, no bundler)
server.js       # Express bootstrap
```

---

## Code conventions

- **ES modules** — the project uses `"type": "module"`; use `import` / `export`, not `require`.
- **Small files, single responsibility** — extract a new file under `services/` or `routes/` rather than growing existing ones past ~400 lines.
- **No unnecessary dependencies** — the frontend is intentionally framework-free (vanilla JS, no bundler). Don't add React/Vue/Webpack/etc. for a UI tweak. Server-side, prefer the existing AWS SDK and `googleapis` packages over alternatives.
- **No hardcoded secrets, bucket names, folder IDs, or domains** — everything configurable goes through `.env` and `config/config.js`.
- **Error handling is mandatory** — every async path should either handle errors explicitly or let them propagate to the route's error handler. No silent `catch {}` blocks.
- **Validate at boundaries** — sanitize/parse user-supplied input (paste-bar URIs, query params, OAuth callback data) before passing it to the SDK clients.
- **Immutability where reasonable** — `const` over `let`, return new objects instead of mutating arguments.
- **No comments restating the code.** Only comment when the *why* is non-obvious (a workaround, a hidden constraint, an SDK quirk).

### Naming

- Files: `camelCase.js` (matches existing `googleDrive.js`, `awsS3.js`).
- Variables / functions: `camelCase`. Booleans get `is` / `has` / `should` prefixes.
- Constants: `UPPER_SNAKE_CASE`.

---

## Pull requests

1. **Branch from `main`** — `git checkout -b feat/your-feature` or `fix/your-bug`.
2. **Keep PRs focused** — one logical change per PR. Unrelated cleanups belong in their own PR.
3. **Test the change manually** before requesting review:
   - For backend changes: hit the affected route, watch the server log.
   - For UI changes: load `http://localhost:3000`, click through the golden path *and* an error path.
   - For S3 changes: verify against **both** AWS Global and AWS China if the code touches partition / region resolution.
4. **Update [README.md](README.md)** if you change config variables, env vars, IAM permissions, or user-visible workflow.
5. **Commit messages** — use [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add bulk delete to S3 panel`
   - `fix: correct region resolution on cross-partition buckets`
   - `docs: clarify Setup B test-user step`
   - `refactor: extract multipart upload helper`
   - `chore: bump @aws-sdk/client-s3 to 3.750.0`
6. **PR description** should include:
   - **What** changed and **why**.
   - **How to test** (steps a reviewer can follow).
   - **Screenshots** for UI changes.
   - **Linked issue** if applicable (`Closes #12`).

---

## Security

Do **not** open public issues for security vulnerabilities. Email the maintainer directly instead, with:

- Description of the vulnerability.
- Steps to reproduce.
- Affected versions / commits.
- Suggested fix if you have one.

In particular, please don't paste real credentials, real bucket names, or real Drive folder IDs into issues or PRs — redact them.

---

## License

By submitting a contribution, you agree that it will be licensed under the same terms as the rest of the project.
