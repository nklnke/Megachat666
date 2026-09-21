# MegaChat666 💬

Локальный LAN-чат в духе Telegram: Python-сервер + веб-клиент. Без фреймворков и зависимостей — только стандартная библиотека Python.

## Возможности (v0.11)

- **Общий чат и комнаты** — создание комнат (кнопка ＋, до 30), закрытые комнаты 🔒 с паролем
- **Личные сообщения** — клик по человеку из «онлайн», формат комнат `dm:A|B`
- **Профили** — эмодзи-аватар или фото (до 2 МБ) + «о себе» (шестерёнка или клик по шапке)
- **Файлы до 15 МБ** — скрепка 📎 или drag'n'drop на чат (можно несколько сразу, видно спиннер отправки), картинки инлайн с просмотром в модалке, всего не больше 200 МБ, авточистка старше 7 дней
- **Голосовые сообщения** — кнопка 🎤, запись до 5 минут, плеер прямо в чате (с телефонов нужен HTTPS, см. ниже)
- **Ответы** — кнопка ↩️, цитата с переходом к оригиналу
- **Реакции** — кнопка 🙂, тогл повторным кликом, видно кто поставил
- **Редактирование и удаление** своих сообщений (✏️/🗑); админ может удалять чужие
- **Опросы** 📊 — до 8 вариантов, один выбор, живые проценты
- **Закрепы** 📌 — один на комнату, баннер с переходом
- **Пересылка** ⏩ сообщений между комнатами и личкой
- **Поиск** 🔍 по сообщениям с подсветкой и переходом (чужие ЛС скрыты), вкладка 🖼️ **Медиа** — фото/файлы/аудио/ссылки чата
- **Галочки прочтения** — в личке ✓/✓✓, в комнатах 👁 со счётчиком
- **Уведомления** — десктоп, звуковой бип, счётчик в заголовке вкладки, `@упоминания`
- **«Печатает...»** ✍️, онлайн-статусы, защита ника токеном (до 5 устройств)
- **Админка** 👑 — первый вошедший становится админом; мут ⏸/▶ с таймером
- **Темы** 🌙/☀️, мобильный вид (drawer по ☰), PWA-установка на телефон
- **Markdown-lite** — `**жирный**`, `*курсив*`, `` `код` ``, блоки ` ``` `, автоссылки
- **Черновики** — недописанное хранится отдельно для каждой комнаты
- **Команды-бот** 🤖 — `/help`, `/stats`, `/online` прямо в чате
- Realtime через **WebSocket** (самописный, stdlib), при обрыве — автопереподключение + fallback на polling

## Быстрый старт

1. Установите Python 3: https://www.python.org/downloads/ (при установке — галочка «Add python.exe to PATH»).
2. Запустите сервер — дабл-клик по `start_chat.bat` или вручную:

```powershell
python server.py
```

3. Откройте в браузере:
   - на этом ПК — http://localhost:8000
   - с других устройств в той же сети — `http://IP_сервера:8000` (IP сервер печатает при старте)

Другой порт: `python server.py --port 9000`. Сделать админом сразу: `python server.py --admin Ник`.

> После обновления файлов фронта обновляйте страницу через **Ctrl+F5** (кеш статики + service worker).

## Доступ из локальной сети

1. Все устройства — в одной сети (один Wi-Fi/роутер).
2. На «серверном» ПК разрешите Python в брандмауэре при первом запросе.
3. На гостевом устройстве откройте `http://IP_сервера:8000`, введите ник — всё.

Для автозапуска положите ярлык `start_chat.bat` в `shell:startup`.

## HTTPS (микрофон с телефонов, PWA)

Браузеры дают микрофон только через `localhost`/HTTPS. Вариант с `mkcert`:

```powershell
mkcert -install
mkcert 192.168.1.5 localhost 127.0.0.1
python server.py --tls --cert 192.168.1.5.pem --key 192.168.1.5-key.pem
```

Или самоподписанный через openssl (браузер попросит принять исключение один раз):

```powershell
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=megachat" -addext "subjectAltName=IP:192.168.1.5,DNS:localhost"
python server.py --tls --cert cert.pem --key key.pem
```

Открывать по `https://IP:8000`, WebSocket сам перейдёт на `wss://`.

## Файлы проекта

| Файл | Назначение |
|---|---|
| `server.py` | Весь бэкенд: HTTP API + WebSocket (stdlib only) |
| `index.html` / `style.css` / `app.js` | Веб-клиент |
| `manifest.json` / `sw.js` / `icon.svg` | PWA |
| `start_chat.bat` | Запуск сервера в один клик |
| `data/*.json` (сообщения, сессии, профили, комнаты, закрепы, файлы, админы, муты, доступы, прочтения), `uploads/` | Создаются рантаймом. В репозиторий не коммитятся |

## API (кратко)

Все ответы — `{ok: True, ...}` или `{ok: False, "error": ...}`.

- `POST /api/join` `{"username","token?"}` → `{username, token, profile, admin}`; лимит 5 устройств → 409 `{suggest}`
- `POST /api/leave`, `POST /api/heartbeat`
- `GET /api/state?username=` — rooms + online + profiles + pinned + admins + muted одним запросом (тексты закрепов закрытых комнат — только при доступе)
- `GET /api/rooms` / `POST /api/rooms` `{"username","name","password?"}`
- `POST /api/room_unlock` `{"username","room","password"}`
- `POST /api/profile` `{"username","emoji","bio"}`, `POST /api/avatar` `{"username","filename","mime","data"}` (пустой `data` — убрать), `GET /api/profiles`
- `POST /api/read` `{"username","room","id"}` — отметить прочитанным (монотонно)
- `GET /api/messages?room=ID&since=N&username=` / `POST /api/messages` `{"username","room","text","reply_to?"}`
- `POST /api/upload` `{"username","room","filename","mime","data(base64)","text?"}`, `GET /files/<id>`
- `POST /api/react` `{"username","id","emoji"}` (тогл)
- `POST /api/edit` `{"username","id","text"}` / `POST /api/delete` `{"username","id"}` (чужое — только админ)
- `POST /api/pin` `{"username","room","id"}` (закреп/откреп)
- `POST /api/forward` `{"username","id","room"}` (опрос пересылается как новый опрос без голосов)
- `POST /api/polls` `{"username","room","question","options[2..8]"}` / `POST /api/vote` `{"username","id","option"}`
- `POST /api/mute` `{"admin","user","minutes"}` (0 — снять), только админ
- `GET /api/search?q=&username=&room?` (мин. 2 символа; чужие ЛС исключены)
- `GET /api/typing` / `POST /api/typing`
- `WS /ws?username=...&token=...` (токен из `/api/join`, чужой ник без токена — 403) — события: `msg` `msg_update` `msg_delete` `typing` `pin` `muted` `online` `rooms` `init` `read`; команды: `send` `react` `vote` `typing` `hb`

## Честные ограничения

LAN-grade, не production: ники/токены/пароли комнат — от любопытных, не от атакующих. Файлы и сообщения хранятся как есть на диске сервера.
