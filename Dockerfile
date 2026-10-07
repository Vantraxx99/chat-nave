FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
COPY package.json package-lock.json organizzatori.txt partecipanti.sha256 ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
