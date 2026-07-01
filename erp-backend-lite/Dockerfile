FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

VOLUME /app/data
VOLUME /app/config

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget --spider -q http://localhost:3001/health || exit 1

CMD ["node", "--experimental-sqlite", "src/app.js"]
