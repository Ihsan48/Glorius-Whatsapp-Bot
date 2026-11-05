# Gunakan Node.js 22 slim resmi (kompatibel dengan @napi-rs/canvas & Baileys)
FROM node:22-bookworm-slim

# Pasang font standar agar teks kupon HD (1344x630) selalu tajam di Linux/Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Buat folder sesi WhatsApp dengan izin tulis penuh (kompatibel HuggingFace Spaces UID 1000)
RUN mkdir -p /app/auth_info_baileys && chmod -R 777 /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN chmod -R 777 /app

# Port 7860 adalah port standar Hugging Face Spaces (Gratis 24 Jam 16GB RAM)
# Juga mendukung Render / Railway / Koyeb via variabel PORT
ENV PORT=7860
EXPOSE 7860

CMD ["node", "src/server.js"]
