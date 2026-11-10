FROM node:24-bookworm-slim
WORKDIR /opt/smoke
COPY smoke.mjs .
USER node
EXPOSE 9000
CMD ["node", "smoke.mjs"]
