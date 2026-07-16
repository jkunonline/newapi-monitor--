FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
VOLUME ["/app/data"]
EXPOSE 8788
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8788/api/status || exit 1
CMD ["node", "server.js"]
