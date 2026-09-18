# AGENTS.md — MegaChat666

Локальный LAN-чат: Python-сервер + ванильный JS-фронт. Никаких фреймворков и зависимостей.

## Железо проекта

- `server.py` (~1000+ строк) — весь бэкенд: HTTP API + **самописный WebSocket** (stdlib only). Не разбивать без спроса.
- Фронт: `index.html` / `style.css` / `app.js`, плюс `manifest.json` / `sw.js` / `icon.svg` (PWA), `start_chat.bat`.
- **Зависимостей нет и не должно появляться** (`stdlib`-only — ключевое требование). `node` используется только для `node --check`.
- `Megachat/` — чужой пустой git-стаб, не трогать.
- JSON-файлы (`messages.json`, `sessions.json` и др.) и `uploads/` создаются рантаймом. После тестов удалять; в репо им не место.

## Проверки (обязательно после правок)

```powershell
python -c "import py_compile; py_compile.compile('server.py', doraise=True)"
node --check app.js   # и sw.js, если менялся
```

Живой API-тест — сервер в фоне, потом запросы (порты 18080+ чтобы не конфликтовать):

```powershell
Start-Job -Name t -ScriptBlock { Set-Location -LiteralPath "D:\Users\user\Desktop\Megachat666"; python server.py --port 18080 } | Out-Null
Start-Sleep -Seconds 3
# ... Invoke-RestMethod / python-скрипт ...
Stop-Job -Name t; Remove-Job -Name t -Force
# затем удалить созданные *.json и uploads/
```

## Ловушки PowerShell 5.1 / Windows

- Нет `||` / `&&` — только `;` и `if ($?) { }`.
- Эмодзи в выводе ломают cp1251: перед python-тестами ставить `$env:PYTHONIOENCODING="utf-8"`.
- `edit`: якоря только маленькие и уникальные; `"""` и несмежные строки в `oldString` не матчатся. Кавычки в `bash -c` съедаются — сложные скрипты класть в файл через `write` и запускать файлом.

## Конвенции кода (нарушать нельзя молча)

- API-ответы: `{ok: True, ...}` / `{ok: False, "error": ...}` с HTTP-кодом (400/403/409/413). Новые эндпоинты — в том же стиле.
- ID комнат: `"general"`, слаги, личка строго `dm:A|B` (отсортировано, см. `dm_room`). Клиент дублирует эту логику — менять синхронно.
- WS-события сервера: `msg` (новое), `msg_update` (реакции/правки/голоса), `msg_delete`, `typing`, `pin`, `muted`, `online`, `rooms`, `init`. Команды клиента: `send`/`react`/`vote`/`typing`/`hb`. Реакция/голос/правка = изменить объект + broadcast `msg_update`, отдельных типов не плодить.
- `can_access()` — lock-free по дизайну (вызывается и под `state_lock`); не добавлять туда блокировок — будет дедлок.
- Хеш пароля комнаты никогда не отдавать в API — только флаг `locked` через `public_rooms()`.
- Фронт: кэш `cache[roomId]`, слияние через `mergeMessages` (upsert по `id`, иначе дубли). DOM-узел сообщения — `[data-mid]` на обёртке `.msg-row`.
- Блок markdown в `app.js` между `// MD-START` / `// MD-END` — автономный, тестируется извлечением в node (см. `run_md_test.py` в истории).
- Версия `v0.X` дублируется в 4 местах: докстринг + `server_version` + баннер `main()` + `index.html` + `README.md`. Бампить все.
- Пользователю после правок фронта напоминать Ctrl+F5 (кеш статики + service worker).

## Безопасность (LAN-grade, честно)

Ники/токены/пароли комнат — от любопытных, не от атакующих. Не делать вид, что это production-auth.
