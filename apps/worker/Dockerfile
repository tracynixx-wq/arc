FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm install --no-audit --no-fund

COPY apps/worker ./apps/worker
COPY apps/web/src/lib/supabase/database.types.ts ./apps/web/src/lib/supabase/database.types.ts
WORKDIR /app/apps/worker
CMD ["npm", "run", "start"]
