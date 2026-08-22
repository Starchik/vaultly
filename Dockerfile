# Vaultly — Dockerfile для Synology DSM Portainer
# Собирает и запускает сервер (Express) со статикой фронтенда.
# Слушает порт 9990 (для Synology DSM)
# Переопределяется переменной окружения PORT — подходит и для других Docker-хостингов.

FROM node:20-alpine

# Официальный образ node уже содержит непривилегированного пользователя
# "node" с UID/GID 1000 — используем готового.

WORKDIR /app

# Сначала копируем только манифесты зависимостей — так Docker кэширует
# слой npm install и не переустанавливает всё при каждом изменении кода.
COPY --chown=node:node server/package.json server/package-lock.json* ./server/
WORKDIR /app/server
RUN npm ci --omit=dev || npm install --omit=dev

WORKDIR /app
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

# Каталог для данных (БД, JWT-секрет, зашифрованные файлы). Если смонтирован
# постоянный том — переопределите DATA_DIR переменной окружения на его путь.
RUN mkdir -p /app/server/storage && chown -R node:node /app

USER node
ENV PORT=9990
EXPOSE 9990

WORKDIR /app/server

# Healthcheck для мониторинга в Portainer
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:9990 || exit 1

CMD ["node", "server.js"]
