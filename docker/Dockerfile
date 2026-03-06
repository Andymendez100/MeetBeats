FROM node:20-bookworm

# Avoid interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Virtual display
    xvfb \
    # Audio
    pulseaudio \
    # Media processing
    ffmpeg \
    # yt-dlp dependencies
    python3 \
    python3-pip \
    # Playwright / Chromium dependencies
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libwayland-client0 \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    # Cleanup
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (--no-cache-dir ensures fresh version on rebuild)
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

# Set up working directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium

# Copy the rest of the project
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Copy Docker-specific files
COPY docker/entrypoint.sh /entrypoint.sh
COPY docker/pulse-default.pa /etc/pulse/default.pa
RUN chmod +x /entrypoint.sh

# Create cache directory
RUN mkdir -p /tmp/meetbeats

# PulseAudio runtime directories
ENV XDG_RUNTIME_DIR=/tmp/runtime
ENV HOME=/root
RUN mkdir -p /tmp/runtime && chmod 700 /tmp/runtime \
    && mkdir -p /root/.config/pulse

# Set display for Xvfb
ENV DISPLAY=:99

ENTRYPOINT ["/entrypoint.sh"]
