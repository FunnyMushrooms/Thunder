# Lasting Atlas — backend API image
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
RUN mkdir -p /app/data && addgroup -S atlas && adduser -S atlas -G atlas && chown -R atlas /app
USER atlas
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:4000/api/health >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]
