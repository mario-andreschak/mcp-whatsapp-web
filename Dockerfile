# Use Node.js 18+ as specified in package.json engines
FROM node:18-slim

# Install system dependencies required for Puppeteer and WhatsApp Web
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libgconf-2-4 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxi6 \
    libxtst6 \
    libnss3 \
    libcups2 \
    libxss1 \
    libxrandr2 \
    libgconf-2-4 \
    libxkbcommon0 \
    libgtk-3-0 \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome for Puppeteer (required by whatsapp-web.js)
RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build the TypeScript project
RUN npm run build

# Create directory for WhatsApp session data
RUN mkdir -p /app/.wwebjs_auth /app/.wwebjs_cache

# Set Chrome path for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expose port if your app uses one (adjust as needed)
EXPOSE 3000

# Create a non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && chown -R appuser:appuser /app

USER appuser

# Start the application
CMD ["npm", "start"]
