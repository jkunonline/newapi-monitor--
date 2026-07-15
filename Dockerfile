FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 8788
CMD ["node", "server.js"]
