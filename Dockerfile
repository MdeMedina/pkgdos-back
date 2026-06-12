FROM node:22-slim

# OpenSSL para el query engine de Prisma (debian-openssl-3.0.x)
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies (incluye dev: tsx, prisma)
COPY package.json package-lock.json ./
RUN npm ci

# Prisma client
COPY prisma ./prisma
RUN npx prisma generate

# App source
COPY . .

EXPOSE 5001

# Producción sin compilar: tsx ejecuta TS directamente (sin watch)
CMD ["npx", "tsx", "src/server.ts"]
