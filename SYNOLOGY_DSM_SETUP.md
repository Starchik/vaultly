# Запуск Vaultly на Synology DSM через Portainer

## Быстрый старт

### Способ A: Через Stack в Portainer (рекомендуется)

1. **Откройте Portainer** на вашем DSM
   - Обычно доступен на `http://192.168.1.XXX:9000`

2. **Перейдите на: Environments → Stacks → Add Stack**

3. **Выберите источник**:
   - `Git repository`

4. **Заполните параметры**:
   - **Repository URL**: `https://github.com/Starchik/vaultly`
   - **Repository ref**: `synology-dsm-portainer`
   - **Compose file path**: `docker-compose.yml`

5. **Переменные окружения** (если нужно переопределить):
   ```
   NODE_ENV=production
   PORT=9990
   ```

6. **Нажмите Deploy**

### Способ B: Copy-paste Compose файла

1. В Portainer → **Stacks** → **Add Stack** → **Web editor**
2. Скопируйте содержимое `docker-compose.yml`
3. Вставьте в редактор
4. Нажмите **Deploy**

---

## Доступ к приложению

После развертывания Vaultly будет доступен по адресу:

```
http://192.168.1.XXX:9990
```

Замените `192.168.1.XXX` на IP-адрес вашего Synology NAS.

---

## Проверка статуса контейнера

### Через Portainer UI:
- **Containers** → найдите `vaultly` → проверьте статус (должен быть `running`)

### Через SSH на DSM:
```bash
ssh admin@192.168.1.XXX

# Проверить контейнер
docker ps | grep vaultly

# Посмотреть логи
docker logs vaultly

# Реальное имя контейнера (если отличается)
docker logs -f vaultly_vaultly_1
```

---

## Управление данными

### Где хранятся данные?

Все данные находятся в Docker volume `vaultly_data`:
- База данных (`db.json`)
- JWT-секрет (`.jwt-secret`)
- Загруженные файлы (зашифрованные)

### Бэкап данных

**Через Portainer:**
1. **Volumes** → найдите `vaultly_data`
2. Можно просмотреть каталог контейнера

**Через SSH:**
```bash
# Найти физическое расположение volume
docker volume inspect vaultly_data

# Обычно находится в:
/var/lib/docker/volumes/vaultly_data/_data

# Создать бэкап
tar -czf vaultly_backup_$(date +%Y%m%d).tar.gz /var/lib/docker/volumes/vaultly_data/_data
```

### Восстановление из бэкапа

```bash
# Остановить контейнер
docker stop vaultly

# Очистить volume
docker volume rm vaultly_data

# Восстановить
docker volume create vaultly_data
docker run --rm -v vaultly_data:/data -v $(pwd):/backup alpine tar -xzf /backup/vaultly_backup_YYYYMMDD.tar.gz -C /data

# Запустить контейнер
docker start vaultly
```

---

## Переменные окружения

### PORT
- **По умолчанию**: `9990`
- **Описание**: Порт, на котором слушает сервер

### NODE_ENV
- **По умолчанию**: `production`
- **Значения**: `production`, `development`

### DATA_DIR
- **По умолчанию**: `/app/server`
- **Описание**: Куда сохраняются `db.json`, `.jwt-secret` и папка `storage/`
- **На DSM обычно используется**: `/app/server/storage` (волюм `vaultly_data`)

### JWT_SECRET
- **По умолчанию**: генерируется автоматически и сохраняется в файл
- **Важно**: Если вы хотите, чтобы JWT-токены сохранялись между перезагрузками контейнера, оставьте автогенерацию. На DSM с постоянным volume это автоматически сохранится.

### TRASH_TTL_DAYS
- **По умолчанию**: `30`
- **Описание**: Через сколько дней файлы в корзине удаляются окончательно
- **Значение `0`**: отключить автоочистку

---

## Здоровье контейнера (Healthcheck)

Контейнер проверяет свое состояние каждые 30 секунд:
- **Интервал**: 30s
- **Timeout**: 3s
- **Максимум попыток**: 3
- **Время перед первой проверкой**: 40s

Если контейнер нездоров, Portainer покажет это в интерфейсе.

---

## Рекомендации для DSM

✅ **Используйте постоянные volumes** — данные сохранятся при перезагрузке  
✅ **Включена автоперезагрузка** (`restart: unless-stopped`)  
✅ **Healthcheck включен** — Portainer будет мониторить здоровье  
✅ **Используйте bridge-сеть** — изолированное окружение для контейнера  

---

## Решение проблем

### Контейнер не запускается

```bash
# Посмотреть логи ошибок
docker logs vaultly

# Если ошибка с портом 9990 — проверить, занят ли он
netstat -tlnp | grep 9990

# Если порт занят, измените PORT в docker-compose.yml на другой
```

### Медленная загрузка первого раза

При первом запуске контейнер:
1. Устанавливает npm зависимости
2. Создает БД
3. Генерирует JWT-секрет

Это может занять 1-2 минуты — это нормально.

### Потеря доступа к файлам после перезагрузки

Если используется эфемерный volume (без постоянного монтирования), данные теряются. Убедитесь, что volume `vaultly_data` правильно настроен в docker-compose.yml.

### 403 Forbidden при загрузке файлов

Обычно причина — неправильные права доступа к volume. Проверьте, что контейнер запущен от пользователя `node`.

---

## Отключение и удаление

### Остановить контейнер (сохранить данные):
```bash
docker stop vaultly
```

### Перезапустить:
```bash
docker start vaultly
```

### Полное удаление контейнера (данные в volume сохранятся):
Через Portainer: **Containers** → найдите `vaultly` → нажмите иконку удаления

### Удаление вместе с данными:
```bash
# ВНИМАНИЕ: это удалит все данные!
docker rm vaultly
docker volume rm vaultly_data
```

---

## Дополнительно

### Nginx Reverse Proxy (опционально)

Если хотите защитить доступ или добавить SSL:

```yaml
# Добавьте в docker-compose.yml сервис nginx
nginx:
  image: nginx:alpine
  ports:
    - "443:443"
  volumes:
    - ./nginx.conf:/etc/nginx/nginx.conf:ro
    - ./ssl:/etc/nginx/ssl:ro
  networks:
    - vaultly-network
```

---

Готово! Vaultly теперь запущена на вашем Synology DSM 🎉
