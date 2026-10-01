FROM node:22-alpine
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "docker-start"]
