# Gunakan Node.js 22 slim resmi (kompatibel dengan @napi-rs/canvas & Baileys)
FROM node:22-bookworm-slim

# Pasang font standar agar teks kupon HD (1344x630) selalu tajam di Linux/Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Buat folder data persisten untuk sesi WA dan antrean (dengan izin tulis penuh)
RUN mkdir -p /app/data /app/data/auth_info_baileys && chmod -R 777 /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN chmod -R 777 /app

# Port standar service
ENV PORT=7860
ENV WA_DATA_DIR=/app/data
ENV WA_AUTH_DIR=/app/data/auth_info_baileys
EXPOSE 7860

CMD ["node", "src/server.js"]
