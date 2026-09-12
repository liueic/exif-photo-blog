# Deploying to Tencent CloudBase

This fork replaces Vercel+Postgres with Tencent CloudBase:

| Concern | Service |
| --- | --- |
| App hosting | CloudBase Run (container, built from `Dockerfile`) |
| Database | CloudBase document database (`photos` / `albums` / `about` collections) |
| Photo storage | CloudBase storage (COS bucket + CDN domain) |
| AI text generation | CloudBase AI (OpenAI-compatible gateway, resource-point billing) |

## One-time setup

### 1. CloudBase Run service runtime variables

Configure these in the CloudBase console under the `exif-photo-blog` service
(service settings → environment variables). The `/api/health` endpoint
reports their presence as booleans.

| Variable | Required | Purpose |
| --- | --- | --- |
| `CLOUDBASE_ENV` | ✅ | Environment id, e.g. `codebuddy-test-3gdqhtzxa73afca7`. Also derives the CloudBase AI base URL |
| `AUTH_SECRET` | ✅ | NextAuth secret (`openssl rand -base64 32`) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | ✅ | Initial admin sign-in |
| `NEXT_PUBLIC_CLOUDBASE_STORAGE_BUCKET` | ✅ | Storage bucket id |
| `NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN` | ✅ | Storage CDN domain (also a `next/image` remote pattern) |
| `NEXT_PUBLIC_CLOUDBASE_STORAGE_REGION` | ➖ | Bucket region, e.g. `ap-shanghai` |
| `CLOUDBASE_AI_API_KEY` | ➖ | CloudBase AI key (see below) |
| `CLOUDBASE_AI_MODEL` | ➖ | Model id, defaults to `hy3` (text-only — see vision caveat below) |
| `REDIS_URL` / `REDIS_TOKEN` | ➖ | Upstash rate limiting (optional, off when unset) |

`NEXT_PUBLIC_*` variables are inlined at build time. The pipeline relies on
the `ARG` defaults baked into `Dockerfile` (they point at this environment);
override them there when targeting a different environment.

### 2. CloudBase AI (LLM quota)

1. In the CloudBase console open **AI → 模型管理** and check which models
   are enabled for the environment. The bundled free model is `hy3`
   (Hunyuan text generation; legacy hunyuan ids auto-switch to it).
2. Create an environment API key at
   [tcb.cloud.tencent.com/dev#/env/apikey](https://tcb.cloud.tencent.com/dev#/env/apikey)
   and store it as `CLOUDBASE_AI_API_KEY` on the service. The storage
   credential `CLOUDBASE_APIKEY` is accepted as a fallback.

Billing uses the environment's resource points (体验版 includes a monthly
allotment). The gateway does not support `response_format: json_schema`, so
structured generation (title/caption/tags) automatically switches to a
JSON-in-prompt contract with client-side zod validation — no extra config.

> **Vision caveat:** `hy3` is a text-only model, but every AI feature in
> this app sends a photo for description. With `hy3`, AI field generation
> fails gracefully (uploads succeed, fields are simply left empty and
> flagged) — a vision model such as `glm-5v-turbo` or `kimi-k2.6` must be
> enabled in the console and set via `CLOUDBASE_AI_MODEL` for descriptions
> to work. Availability of vision models varies; several series carry
> offline notices.

### 3. GitHub Actions secrets

Repository → Settings → Secrets and variables → Actions:

| Secret | Purpose |
| --- | --- |
| `TENCENTCLOUD_SECRETID` | Tencent Cloud API key id (account-level, used by `tcb login`) |
| `TENCENTCLOUD_SECRETKEY` | Matching secret |

Create the key pair at [console.cloud.tencent.com/cam/capi](https://console.cloud.tencent.com/cam/capi).
For a smaller blast radius you can instead create an environment-level key
(`tcb env apikey create`) and change the login step in
`.github/workflows/deploy.yml` to `tcb login --cloudbase-api-key <key> -e <envId>`.

## CI/CD

`.github/workflows/deploy.yml` runs on every push to `main`:

1. `pnpm install --frozen-lockfile`
2. `tsc --noEmit` + `jest --ci` (the `github.test.ts` suite is skipped — it
   calls api.github.com anonymously and rate-limits on shared runner IPs)
3. `tcb cloudrun deploy` — uploads the source, builds the `Dockerfile`
   remotely, and switches the service to the new version
4. Polls `/api/health` and fails the job unless `ready: true`

Manual deploy from a machine with the CLI logged in:

```bash
tcb cloudrun deploy -e codebuddy-test-3gdqhtzxa73afca7 \
  -s exif-photo-blog --port 3000 --force --wait
```

## Verifying a deployment

- `GET /api/health` — database reachability plus environment-variable
  booleans (never secret values)
- Admin → App configuration — per-provider status cards and connection tests
- Upload a photo — AI fields generate when a provider is active
