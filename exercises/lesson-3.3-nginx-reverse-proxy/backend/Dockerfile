FROM node:24-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY server.ts ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/server.js"]
