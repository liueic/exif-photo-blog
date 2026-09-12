# syntax=docker/dockerfile:1
#
# Production image for CloudBase Run (container type).
#
# Built on Debian slim rather than Alpine so that `sharp` uses its prebuilt
# glibc binaries and needs no extra libc shims.

# ===== Stage 1: dependencies =====
FROM node:22-slim AS deps
WORKDIR /app
RUN npm install -g pnpm@12
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ===== Stage 2: build =====
FROM node:22-slim AS builder
WORKDIR /app
RUN npm install -g pnpm@12
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* values are inlined into the client bundle during `next build`,
# so they must be present here — changing them later requires a rebuild.
#
# Defaults describe the CloudBase environment this app is deployed into.
# Override them (docker build --build-arg ...) when targeting another env.
ARG NEXT_PUBLIC_DOMAIN=exif-photo-blog-312660-9-1301730159.sh.run.tcloudbase.com
ARG NEXT_PUBLIC_CLOUDBASE_STORAGE_BUCKET=636f-codebuddy-test-3gdqhtzxa73afca7-1301730159
ARG NEXT_PUBLIC_CLOUDBASE_STORAGE_REGION=ap-shanghai
ARG NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN=636f-codebuddy-test-3gdqhtzxa73afca7-1301730159.tcb.qcloud.la
ARG NEXT_PUBLIC_CATEGORY_VISIBILITY
ARG NEXT_PUBLIC_SITE_FEEDS
ARG NEXT_PUBLIC_IMAGE_QUALITY
ENV NEXT_PUBLIC_DOMAIN=$NEXT_PUBLIC_DOMAIN \
    NEXT_PUBLIC_CLOUDBASE_STORAGE_BUCKET=$NEXT_PUBLIC_CLOUDBASE_STORAGE_BUCKET \
    NEXT_PUBLIC_CLOUDBASE_STORAGE_REGION=$NEXT_PUBLIC_CLOUDBASE_STORAGE_REGION \
    NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN=$NEXT_PUBLIC_CLOUDBASE_STORAGE_DOMAIN \
    NEXT_PUBLIC_CATEGORY_VISIBILITY=$NEXT_PUBLIC_CATEGORY_VISIBILITY \
    NEXT_PUBLIC_SITE_FEEDS=$NEXT_PUBLIC_SITE_FEEDS \
    NEXT_PUBLIC_IMAGE_QUALITY=$NEXT_PUBLIC_IMAGE_QUALITY \
    NEXT_TELEMETRY_DISABLED=1

RUN pnpm build

# ===== Stage 3: runtime =====
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # Next.js standalone binds to localhost by default, which is unreachable
    # from outside the container
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# `public/` holds runtime assets (fonts for OG image generation) and is not
# part of the standalone bundle; `.next/static` likewise has to be copied in
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
