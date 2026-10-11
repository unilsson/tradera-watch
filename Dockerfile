FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run check && npm run test && npm run build && npm prune --omit=dev
ENV PORT=3000 DATA_DIR=/app/data NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
