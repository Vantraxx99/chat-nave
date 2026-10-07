FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npm", "start"]
