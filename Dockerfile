FROM node:20-alpine

RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json .
COPY proxy.js .

EXPOSE 3000 3443

CMD ["node", "proxy.js"]
