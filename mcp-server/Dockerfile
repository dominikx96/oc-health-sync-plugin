# Build context is the repo root (so we can COPY supabase/... into the image).
# Build with: docker build -f mcp-server/Dockerfile -t <tag> .

FROM node:24-alpine AS build
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci
COPY mcp-server/ .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# psql is needed by the `migrate` entrypoint. bash makes the migrate script portable.
RUN apk add --no-cache postgresql-client bash

COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist                     ./dist

# Release payload baked into the image.
COPY supabase/migrations                        /release/migrations
COPY supabase/functions/ingest                  /release/functions/ingest
COPY mcp-server/scripts/migrate.sh              /usr/local/bin/migrate
RUN chmod +x /usr/local/bin/migrate

EXPOSE 3737
CMD ["node", "dist/index.js"]
