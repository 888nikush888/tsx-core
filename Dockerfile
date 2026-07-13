# ==========================================
# STAGE 1: Builder (TypeScript compilation)
# ==========================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Copy root and frontend package files
COPY package*.json tsconfig.json ./
COPY frontend/package*.json ./frontend/

# Install root and frontend dependencies
RUN npm ci
RUN npm ci --prefix frontend

# Copy backend source and frontend source
COPY src/ ./src/
COPY frontend/ ./frontend/

# Run the build hook (compiles backend to dist/ and frontend to frontend/dist/)
RUN npm run build


# ==========================================
# STAGE 2: Runner (Production runtime)
# ==========================================
FROM node:20-bookworm-slim AS runner

# Install sqlite3 and compiler tools for native node-sqlite3 compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlite3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production Node.js dependencies
RUN npm ci --only=production

# Copy compiled backend from builder stage
COPY --from=builder /app/dist ./dist

# Copy compiled frontend from builder stage
COPY --from=builder /app/frontend/dist ./frontend/dist

# Copy templates directory
COPY templates/ ./templates/

# Set production environment
ENV NODE_ENV=production

# Expose Web Dashboard (8080) and Prometheus Metrics (9100) ports
EXPOSE 8080 9100

# Run start script (compiled TS in dist/)
CMD ["node", "dist/forwarder.js"]
