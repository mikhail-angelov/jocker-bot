FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Create directory for persistent data
RUN mkdir -p /app/data

# Copy package files and install deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY src/ ./src/
COPY data/ ./data/

# Ensure data directory is writable by the node user
RUN chown -R node:node /app/data

# Use non-root user for security
USER node
