FROM node:18-slim

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better Docker layer caching
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Create data directory for SQLite and JSON persistence
RUN mkdir -p /app/data/logs /app/data/backtest_cache

# Expose the app port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the application
CMD ["node", "server.js"]
