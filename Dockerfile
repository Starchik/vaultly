# Vaultly — Dockerfile
# Собирает и запускает сервер (Express) со статикой фронтенда.
# По умолчанию слушает порт 7860 (стандарт Hugging Face Spaces),
# но переопределяется переменной окружения PORT — подходит и для Render,
# и для любого другого Docker-хостинга.

FROM node:20-alpine

# Официальный образ node уже содержит непривилегированного пользователя
# "node" с UID/GID 1000 — именно тот UID, от которого запускает контейнеры
# Hugging Face Spaces. Создавать ещё одного с тем же UID нельзя (конфликт),
# поэтому просто используем готового.

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
ENV PORT=7860
EXPOSE 7860

WORKDIR /app/server
CMD ["node", "server.js"]
