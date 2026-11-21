FROM node:20-alpine
WORKDIR /app
COPY server.js twin.js index.html login.htmlpackage.json ./
ENV NODE_ENV=production PORT=8080 DATA_FILE=/data/data.json
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
