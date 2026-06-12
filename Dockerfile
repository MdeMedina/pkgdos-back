FROM node:22-alpine

# Install openssl for Prisma compatibility in alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the application
COPY . .

# Generate Prisma Client (build phase, doesn't touch the DB)
RUN npx prisma generate

# Build TypeScript to Javascript
RUN npm run build

# Expose backend port
EXPOSE 5001

# Run in production
CMD ["npm", "start"]
