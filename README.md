# Google Drive → AWS S3 Copier

Copy files from Google Drive to AWS S3 effortlessly. Supports both **AWS Global** and **AWS China** partitions.

A simple two-panel web UI: browse a Google Drive folder on the left, an S3 bucket on the right, select files, optionally rename, upload. Drops the manual "download from Drive → rename → drag into S3 console" loop.

---

## What it does

| Panel | Source / Target |
|-------|------------------|
| Left  | Google Drive (defaults to the folder you configure) |
| Right | S3 bucket (defaults to the bucket and prefix you configure) |

Workflow:

1. **Connect Google Drive** via one-time OAuth (drive.readonly scope).
2. The left panel opens at the configured source folder; navigate deeper if needed.
3. Click rows to select files.
4. The right panel lets you navigate the S3 bucket so the **current S3 folder** becomes the target prefix.
5. Click **Upload to S3 →**.
6. A modal opens with every selected file name editable. Rows highlighted in amber will overwrite an existing object at the target.
7. Confirm — a progress drawer streams per-file status (in-progress / success / failure) over NDJSON.

Uploads stream Drive → S3 (no disk staging) via multipart upload, so large files (multi-hundred-MB and beyond) go through cleanly.

### Cleaning up wrong uploads

Two ways:

- **Single object** — hover any object row in the S3 panel and a small trash icon appears on the right edge. Click it to open a confirmation modal showing the full `s3://bucket/key` path, file size, and last-modified date.
- **Bulk** — click anywhere on one or more object rows to select them (amber checkbox lights up). A selection bar appears in the panel footer with a **Delete** button that batches everything you've selected into a single `DeleteObjects` API call (S3's plural variant — much cheaper than N individual deletes, especially across slow cross-region links).

Either flow opens the same confirmation modal — for bulk it shows the first five keys, an "…and N more" hint, and the total byte count so you can sanity-check before confirming. Partial failures (e.g. permission on one specific key) surface inline with the per-key error message rather than aborting the whole batch.

Selection clears automatically when you navigate folders, change region, or paste a new location.

Requires `s3:DeleteObject` on the bucket (see *AWS credentials* below). If the bucket has versioning enabled, this creates a delete marker; on unversioned buckets the bytes are permanently gone.

### Switching source / target without editing `.env`

Each panel has a **location bar** under the header. The env-default location is pre-filled but always overridable in the browser:

- **Drive (left panel)** — paste either a folder URL (`https://drive.google.com/drive/folders/<id>?usp=sharing`) or a raw folder ID, hit Enter. The panel jumps to that folder; navigation continues normally from there. Submit it empty to reset to the env-default folder.
- **S3 (right panel)** — paste `bucket/path/prefix/` or a full `s3://bucket/path/prefix/` URI. The bucket and starting prefix are extracted; navigation continues from there. Submit empty to reset to the env defaults.

Cross-region buckets are handled automatically — the S3 client follows region redirects and caches the resolved region per bucket. The IAM principal still needs the usual `ListBucket / GetObject / PutObject / HeadObject` permissions on each bucket you target.

---

## Setup

```bash
npm install
cp .env.example .env
#  …fill in Google + S3 credentials in .env (see below)
npm start
# open http://localhost:3000
```

### Google OAuth credentials

You need an OAuth 2.0 client in a Google Cloud project. There are two realistic setups depending on what kind of Google account is hosting the project:

| If your Cloud project lives in… | Use this setup |
|---|---|
| A **Google Workspace org** (e.g. `your-company.com`) and you (or someone helpful) have project-create rights in that org | **Setup A — Internal** *(recommended)* |
| A **personal `@gmail.com`** account, or any account that's not a Workspace org admin | **Setup B — External + Testing** |

The differences matter:

| | Setup A (Internal) | Setup B (External + Testing) |
|---|---|---|
| Who can sign in | Anyone with an email in the Workspace org domain | Only emails on the **Test users** list (max 100) |
| Test-user whitelist | Not required | Required for every signer |
| Unverified-app warning | Not shown | Shown every sign-in (must click *Advanced → Go to app (unsafe)*) |
| Refresh-token lifetime | Standard (~6 months idle) | **7 days** — users must re-sign-in weekly |
| Google verification | Not required | Required if you ever switch to Production (multi-week review for sensitive scopes) |

Both setups need the same three scopes and the same redirect URI. Only the User type and test-user step differ.

---

#### Setup A — Workspace project, Internal user type *(recommended when available)*

1. Open [console.cloud.google.com](https://console.cloud.google.com) **while signed in with your Workspace account** (e.g. `you@your-company.com`).
2. Create a new project (e.g. `gdrive-to-s3`). Confirm in the top breadcrumb that the project's **Organization** is your Workspace domain, not "No organization". This is the key step — if it says "No organization", the project is personal and Internal mode won't be available.
3. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
4. **APIs & Services → OAuth consent screen → Get started** (or **Branding** if already configured):

   | Field | Value |
   |---|---|
   | App name | `gdrive-to-s3` (or whatever) |
   | User support email | yours |
   | Developer contact | yours |

5. **Audience → User type → Internal** → **Save**. *(If "Internal" is greyed out, the project isn't inside a Workspace org — see Setup B instead.)*
6. **Data Access → Add or remove scopes**, tick all three:
   - `https://www.googleapis.com/auth/drive.readonly` *(sensitive)*
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`

   Click **Update → Save**.
7. **Credentials → + Create credentials → OAuth client ID → Web application**:

   | Field | Value |
   |---|---|
   | Name | `gdrive-to-s3 local` |
   | Authorized JavaScript origins | `http://localhost:3000` |
   | Authorized redirect URIs | `http://localhost:3000/auth/google/callback` *(must match exactly — same scheme, host, port, path)* |

8. Copy the **Client ID** and **Client Secret** into `.env`:

   ```dotenv
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   ```

9. Restart `npm start`, open `http://localhost:3000`, click **Link Google Drive**. Sign in with any account in your Workspace domain — works immediately, no warning, no test-user list to manage.

---

#### Setup B — Personal Gmail project, External user type *(for solo testing or when you don't have Workspace admin access)*

This is what you use if you're testing on your own `@gmail.com` account but want to sign in to the app with a different email.

1. Open [console.cloud.google.com](https://console.cloud.google.com) signed in with your **personal `@gmail.com`** (or any non-Workspace account).
2. Create a new project (e.g. `gdrive-to-s3-dev`).
3. **APIs & Services → Library** → search **Google Drive API** → **Enable**. **Don't skip this step** — without it, Google rejects the OAuth request with `access_denied`.
4. **APIs & Services → OAuth consent screen → Get started**:

   | Field | Value |
   |---|---|
   | App name | `gdrive-to-s3` (or whatever) |
   | User support email | yours |
   | Developer contact | yours |

5. **Audience → User type → External** → **Save**. (Internal will be unavailable here — that's expected on a personal project.)
6. **Data Access → Add or remove scopes** — tick all three (same as Setup A):
   - `https://www.googleapis.com/auth/drive.readonly` *(sensitive)*
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`

   Click **Update → Save**. **Critical**: even though your email is on the test-user list, Google will return `access_denied` if the scopes aren't declared here.
7. **Audience → Test users → + Add users** → add **every email that will sign in**, including yours. Add up to 100 — for a small team paste them all now. Save.
8. **Publishing status** at the bottom of the consent screen must say **Testing**. Don't click "Publish to production" — that triggers Google's app-verification queue.
9. **Credentials → + Create credentials → OAuth client ID → Web application**:

   | Field | Value |
   |---|---|
   | Name | `gdrive-to-s3 local` |
   | Authorized JavaScript origins | `http://localhost:3000` |
   | Authorized redirect URIs | `http://localhost:3000/auth/google/callback` |

10. Copy Client ID / Secret into `.env` (same as Setup A step 8). Restart `npm start`.

**When you sign in:**

1. Open `http://localhost:3000`, click **Link Google Drive**.
2. Pick the **whitelisted account** — *not* the personal gmail account that owns the project.
3. A yellow "**Google hasn't verified this app**" warning appears. **This is expected.**
4. Click the **Advanced** link (small, bottom-left).
5. Click **Go to gdrive-to-s3 (unsafe)** at the bottom.
6. The real consent screen appears with the three scopes. Click **Continue / Allow**.
7. You land back at `localhost:3000` signed in.

If you click **Back to safety** on the warning, the callback URL gets `?auth_error=access_denied` — that's not a bug.

**Ongoing maintenance for Setup B:**

- Every additional teammate needs adding under **Test users**.
- Refresh tokens expire **every 7 days**. After that, the next API call returns `401`, the UI prompts to re-link, and signing in again restores access. There's no way to extend this on External + Testing.
- The unverified-app warning shows up every fresh sign-in.

---

#### Reusing an existing OAuth client (Setup C)

If someone else already created an OAuth client in a Workspace project and you just need to wire your dev box to it:

1. Ask the project owner to add `http://localhost:3000/auth/google/callback` under **Credentials → click the OAuth client → Authorized redirect URIs**.
2. If the client is External, ask them to add your email under **Audience → Test users**.
3. Confirm the three scopes above are on the consent screen (they should be if you're not the first user).
4. Paste the Client ID / Secret into `.env` and restart `npm start`.

---

#### Common errors

| Error | Cause | Fix |
|---|---|---|
| `?auth_error=access_denied` returned to localhost | Most common: scopes missing from the consent screen. Also: Drive API disabled. Also: clicked "Back to safety" on the unverified-app warning. Also: signed in with an email not on the Test users list. | Follow Setup B step 6 (scopes), step 3 (enable Drive API), step 7 (test users); on next sign-in click *Advanced → Go to app (unsafe)* through the warning. |
| `Access blocked: <app> has not completed the Google verification process` | External + Testing, your email isn't on Test users | Add it under **Audience → Test users**, or switch to Internal (Setup A) |
| `redirect_uri_mismatch` | The URL the server actually runs on (scheme + host + port + path) doesn't match what's registered on the client | Add the exact URI under **Credentials → OAuth client → Authorized redirect URIs** |
| `invalid_grant` after sign-in | Stale auth code reused after a delay, or refresh token expired (7-day clock on External + Testing) | Sign in again |
| `disabled_client` | Client ID was deleted or its project was disabled / unbilled | Use a different client |
| Sensitive-scope verification screen in Production | External + Published, but Google hasn't verified `drive.readonly` | Move back to Testing, or submit for verification, or switch to Internal (Setup A) |

The tool only ever requests `drive.readonly` — it never writes to or deletes from Drive.

### AWS China regions (cn-north-1 / cn-northwest-1)

The AWS China partition (`aws-cn`) is a **completely separate cloud** from the global AWS — different sign-in, different IAM, different S3 endpoint TLD (`*.amazonaws.com.cn` instead of `*.amazonaws.com`). Credentials don't cross partitions.

The tool detects China regions automatically and pins the China endpoint, but there are two ways to actually use it:

**Option 1 — Run the whole tool against China (single-partition).** If all your transfers go to China buckets, point `.env` at China:

```dotenv
AWS_PROFILE=china         # profile in ~/.aws/credentials with China keys
AWS_REGION=cn-north-1     # or cn-northwest-1
S3_BUCKET=your-china-bucket
S3_DEFAULT_PREFIX=path/to/folder/
```

Your `~/.aws/credentials` should have a section like:

```ini
[china]
aws_access_key_id     = AKIAxxxxx...     # from your China AWS account
aws_secret_access_key = ...
```

Region goes in `.env`, not in the credentials file — the tool passes `AWS_REGION` to the SDK explicitly.

**Option 2 — Switch regions from the UI.** Right of the S3 location bar there is a **region dropdown** populated from the same partition as your configured credentials. Pick `cn-north-1` / `cn-northwest-1` (or any other region) and the next list/upload uses it. The dropdown's default value is whatever `AWS_REGION` is set to in `.env`. The chip in the topbar reflects the active selection (e.g. `s3 · cn-north-1`).

For power-users there's also a **`bucket@region/path/` shorthand** in the location bar:

```
my-bucket@cn-north-1/path/to/folder/
```

That `@region` forces the listing/upload to talk to that specific region for this paste, regardless of the dropdown. After submitting, the dropdown updates to match.

**The server logs which credentials and region it actually loaded on startup** — e.g. `AWS: region=cn-north-1 partition=aws-cn credentials=profile=china (~/.aws/credentials)`. Check this if the UI is targeting a region you didn't expect.

> **Note about stale shell env vars**: `.env` values **override** anything inherited from the parent shell (`~/.zshrc` exports, etc.). If you had `export AWS_REGION=eu-west-1` lying around in `.zshrc`, it would otherwise win — even after editing `.env`.

**Gotchas:**
- The AWS account holding the China credentials must own (or have IAM access to) the China bucket. Global credentials *cannot* read or write China buckets.
- Cross-partition `GetBucketLocation` does not work, so the tool may fall back to your configured region. Use the `@region` shorthand if auto-detection misfires.
- The standard bucket-name validity rules apply (lowercase, 3-63 chars, no dots-in-a-row).

### AWS credentials

The tool resolves AWS credentials using the standard chain:

1. If `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are set in `.env` / process env → those are used.
2. Otherwise the profile named by `AWS_PROFILE` (default: `default`) is read from `~/.aws/credentials`.

The credentials need at minimum on the target bucket / prefix:

- `s3:ListBucket`
- `s3:GetObject` (for listing rendering)
- `s3:HeadObject` (for collision pre-check)
- `s3:PutObject` (for the upload itself)
- `s3:AbortMultipartUpload` (so failed multiparts can clean up)
- `s3:DeleteObject` (for the per-row trash button — see *Cleaning up wrong uploads* above)
- `s3:GetBucketLocation` (optional — used to auto-detect cross-region buckets; the tool falls back gracefully if it's denied)

### S3 target

Set the bucket + default prefix in `.env`:

```dotenv
S3_BUCKET=your-bucket-name
S3_DEFAULT_PREFIX=path/to/folder/
```

The default prefix is what the right panel opens at; users can still navigate elsewhere in the bucket.

---

## Configuration reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | no | `3000` | HTTP port |
| `SESSION_SECRET` | recommended | dev-only fallback | Express session signing key |
| `GOOGLE_CLIENT_ID` | yes | — | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | yes | — | OAuth client secret |
| `GOOGLE_REDIRECT_URI` | no | `http://localhost:$PORT/auth/google/callback` | Must match the URI registered in Google Cloud |
| `DEFAULT_DRIVE_FOLDER_ID` | no | empty | Folder shown on first open |
| `AWS_REGION` | no | `ap-south-1` | AWS region for the S3 client |
| `AWS_PROFILE` | no | `default` | Profile name read from `~/.aws/credentials` when no explicit creds |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | — | Overrides the profile chain when set |
| `S3_BUCKET` | yes | — | Target bucket |
| `S3_DEFAULT_PREFIX` | no | empty | Folder opened by default in the right panel |

---

## Architecture

```
public/                  # Static frontend (vanilla HTML/CSS/JS — no build step)
  index.html
  styles.css
  app.js

config/config.js         # Env wiring + validation
services/
  googleDrive.js         # OAuth client + Drive list/get/download
  awsS3.js               # S3 list/head + multipart Upload helper
middleware/auth.js       # Session guard for Google-protected routes
routes/
  auth.js                # /auth/google + /auth/google/callback + /auth/me
  drive.js               # /api/drive/files, /api/drive/default-folder
  s3.js                  # /api/s3/config, /api/s3/objects, /api/s3/check-existing
  transfer.js            # /api/transfer/upload (NDJSON stream)
server.js                # Express bootstrap
```

The upload endpoint streams NDJSON events back to the browser so each file's status (start / success / error) updates live without polling.

---

## Tech stack

- Node ≥ 18.
- Express 4 + express-session.
- `googleapis` for OAuth + Drive API.
- `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (multipart) + `@aws-sdk/credential-providers`.
- Vanilla JS frontend — no bundler, no framework.

---

## Notes

- Session cookies are HTTP-only and expire in 8 hours. There is no persisted user database — sign in again after that.
- Sessions live in memory (`express-session` default), so a server restart logs everyone out. Fine for a single-operator tool.
- If you deploy this somewhere other than `localhost`, set `cookie.secure = true` in `server.js` and put it behind HTTPS.
