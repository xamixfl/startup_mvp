# HTTPS на production через Let's Encrypt

Ниже минимальный рабочий порядок для production.

## 1. Требование

Let's Encrypt не выдаёт сертификаты на голый IP-адрес.  
Нужен домен, который указывает на ваш сервер, например:

- `pulse.example.com`
- `www.pulse.example.com`

## 2. Подготовить nginx

Скопируйте шаблон:

- [server/nginx.https.example.conf](C:\Users\Алексей\projects\startup\startup_mvp\server\nginx.https.example.conf)

Подставьте:

- ваш домен вместо `pulse.example.com`
- путь к сайту вместо `/var/www/pulse`

Пример размещения:

```bash
sudo cp server/nginx.https.example.conf /etc/nginx/sites-available/pulseapp
sudo ln -s /etc/nginx/sites-available/pulseapp /etc/nginx/sites-enabled/pulseapp
sudo nginx -t
sudo systemctl reload nginx
```

## 3. Установить certbot

Ubuntu:

```bash
sudo apt update
sudo apt install certbot python3-certbot-nginx
```

## 4. Получить сертификат

```bash
sudo certbot --nginx -d pulse.example.com -d www.pulse.example.com
```

Certbot:

- выпишет сертификат
- пропишет SSL-пути
- настроит автопродление

## 5. Включить secure cookies на backend

В production `server/.env`:

```env
NODE_ENV=production
COOKIE_SECURE=true
CSRF_COOKIE_NAME=csrf_token
UPLOAD_MAX_FILE_SIZE_BYTES=5242880
```

После этого перезапустите API:

```bash
cd ~/pulseapp/server
pm2 restart pulseapp-api --update-env
sudo systemctl reload nginx
```

## 6. Проверка

Проверьте:

```bash
curl -I https://pulse.example.com
curl -I https://pulse.example.com/api/health
```

Ожидаемо:

- сайт открывается по `https://`
- `http://` редиректит на `https://`
- API отвечает по HTTPS

## 7. Если сайт иногда открывается, а иногда показывает чужую страницу

Это почти всегда проблема DNS, а не frontend/backend.

Типичный симптом:

- без VPN сайт открывается нормально
- через VPN или мобильную сеть открывается парковочная страница регистратора
- в разных сетях домен резолвится по-разному

Что проверить в панели DNS у регистратора:

- для `pulse.example.com` должен быть только ваш актуальный `A`-запись
- для `www.pulse.example.com` должен быть только один корректный `A` или `CNAME`
- не должно оставаться старых IP-адресов от регистратора или прежнего хостинга
- если сервер не настроен на IPv6, не добавляйте `AAAA`
- отключите parking / domain forwarding / default parking page у регистратора

Проверка из терминала:

```bash
dig +short pulse.example.com
dig +short www.pulse.example.com
dig +short AAAA pulse.example.com
dig +short NS pulse.example.com
```

Нормально, когда:

- домен возвращает только IP вашего сервера
- `www` указывает туда же
- `AAAA` пустой, если IPv6 у вас не настроен

Плохо, когда:

- домен возвращает два разных IP, и один из них не ваш
- один из IP ведёт на страницу регистратора
- `www` и корневой домен смотрят в разные места без вашей задумки

После исправления DNS:

- дождитесь обновления кэша DNS, обычно от нескольких минут до 24 часов
- перепроверьте домен через VPN и без VPN
- отдельно проверьте, что nginx настроен на ваш домен в `server_name`
