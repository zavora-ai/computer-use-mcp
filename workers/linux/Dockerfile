# Build from a checkout containing dist and its Linux native binary (CI artifacts).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends xvfb openbox dbus-x11 python3-gi gir1.2-atspi-2.0 at-spi2-core libxtst6 libxrandr2 libxi6 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts
COPY dist ./dist
COPY libexec ./libexec
COPY computer-use-napi.linux-*.node ./
COPY workers/linux/start.sh /start.sh
ENV DISPLAY=:99 HOME=/workspace NO_AT_BRIDGE=0
USER 1000:1000
ENTRYPOINT ["sh", "/start.sh"]
