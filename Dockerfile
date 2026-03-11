FROM node:20-alpine

WORKDIR /app

COPY package.json .
COPY proxy.js .

EXPOSE 3000 3443

CMD ["node", "proxy.js"]
