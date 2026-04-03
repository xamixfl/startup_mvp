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
