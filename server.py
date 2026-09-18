#!/usr/bin/env python3
"""MegaChat666 v0.10 — чат для локальной сети.
Только стандартная библиотека Python. WebSocket реализован вручную.
Запуск: python server.py [--host 0.0.0.0] [--port 8000]
HTTPS:  python server.py --tls --cert cert.pem --key key.pem

Возможности: общий чат + комнаты + личные сообщения + файлы + голосовые
+ профили + ответы/цитаты + реакции + редактирование + опросы + поиск
+ уведомления + typing + закрепы + пересылка + WebSocket push.
"""
import base64
import hashlib
import json
import mimetypes
import os
import re
import socket
import struct
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(BASE_DIR, "messages.json")
PROFILES_FILE = os.path.join(BASE_DIR, "profiles.json")
ROOMS_FILE = os.path.join(BASE_DIR, "rooms.json")
SESSIONS_FILE = os.path.join(BASE_DIR, "sessions.json")
PINNED_FILE = os.path.join(BASE_DIR, "pinned.json")
ADMINS_FILE = os.path.join(BASE_DIR, "admins.json")
MUTED_FILE = os.path.join(BASE_DIR, "muted.json")
GRANTS_FILE = os.path.join(BASE_DIR, "grants.json")
FILES_MANIFEST = os.path.join(BASE_DIR, "files.json")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

MAX_TEXT_LEN = 2000
MAX_NAME_LEN = 30
MAX_ROOM_LEN = 30
MAX_BIO_LEN = 200
ONLINE_TIMEOUT = 30
HISTORY_LIMIT = 300
MAX_ROOMS = 30
MAX_FILE_BYTES = 15 * 1024 * 1024  # 15 МБ на файл
MAX_UPLOADS_BYTES = 200 * 1024 * 1024  # 200 МБ на все файлы
MAX_DEVICES = 5  # токенов/устройств на один ник
UPLOAD_TTL_DAYS = 7  # файлы старше — автоудаление

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

state_lock = threading.Lock()
messages = []   # {id, room, username, text, time, ts, file?, reply?, reactions?}
profiles = {}   # username -> {bio, emoji}
rooms = [{"id": "general", "name": "Общий чат", "creator": "system"}]
online = {}     # username -> last_seen
typing_state = {}  # username -> (room, ts)
ws_gone = {}       # username -> ts разрыва WS (grace перед оффлайном)
sessions = {}      # username -> [tokens] (мульти-девайс, до MAX_DEVICES)
pinned = {}        # room -> {id, username, text} (закреп, один на комнату)
admins = []        # ники администраторов
muted = {}         # username -> until_ts (мут)
grants = {}        # "room|user" -> True (доступ в закрытую комнату)
file_mimes = {}    # stored_name -> mime (точные типы для /files/)
TYPING_TTL = 4  # секунд «печатает...» живёт без продления
WS_GRACE = 8  # секунд после разрыва WS до пометки оффлайн
_next_id = 1

ws_lock = threading.Lock()
ws_clients = []  # [{conn, username, send_lock}]
_last_online_snapshot = []


# ---------- helpers ----------
def clean_name(name):
    name = (name or "").strip()
    name = " ".join(name.split())
    return name[:MAX_NAME_LEN]


def clean_text(t):
    return ((t or "").strip())[:MAX_TEXT_LEN]


def clean_bio(b):
    return ((b or "").strip())[:MAX_BIO_LEN]


def dm_room(a, b):
    pair = sorted([a, b])
    return f"dm:{pair[0]}|{pair[1]}"


def slug_room(name):
    s = (name or "").strip().lower().replace(" ", "_")[:MAX_ROOM_LEN]
    s = re.sub(r"[^a-z0-9_а-яё\-]", "", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "room"


def safe_filename(name):
    name = os.path.basename(name or "file")
    name = re.sub(r"[^\w\.\-]+", "_", name, flags=re.UNICODE)[:80]
    return name or "file"


def now_str():
    return datetime.now().strftime("%H:%M")


# ---------- persistence ----------
def load_all():
    global messages, profiles, rooms, sessions, pinned, file_mimes
    global admins, muted, grants, _next_id
    try:
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, list):
                    messages = d[-HISTORY_LIMIT:]
                    for m in messages:  # нормализация старых записей
                        m.setdefault("reactions", {})
                    if messages:
                        _next_id = max(m["id"] for m in messages) + 1
    except Exception as e:
        print(f"История не загружена: {e}")
    try:
        if os.path.exists(PROFILES_FILE):
            with open(PROFILES_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    profiles = d
    except Exception as e:
        print(f"Профили не загружены: {e}")
    try:
        if os.path.exists(ROOMS_FILE):
            with open(ROOMS_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, list) and d:
                    rooms = d
    except Exception as e:
        print(f"Комнаты не загружены: {e}")
    try:
        if os.path.exists(SESSIONS_FILE):
            with open(SESSIONS_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    # миграция со старого формата {user: token}
                    sessions = {u: (v if isinstance(v, list) else [v])
                                for u, v in d.items()}
    except Exception as e:
        print(f"Сессии не загружены: {e}")
    try:
        if os.path.exists(PINNED_FILE):
            with open(PINNED_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    pinned = d
    except Exception as e:
        print(f"Закрепы не загружены: {e}")
    try:
        if os.path.exists(FILES_MANIFEST):
            with open(FILES_MANIFEST, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    file_mimes = d
    except Exception as e:
        print(f"Манифест файлов не загружен: {e}")
    try:
        if os.path.exists(ADMINS_FILE):
            with open(ADMINS_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, list):
                    admins = d
    except Exception as e:
        print(f"Админы не загружены: {e}")
    try:
        if os.path.exists(MUTED_FILE):
            with open(MUTED_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    muted = d
    except Exception as e:
        print(f"Муты не загружены: {e}")
    try:
        if os.path.exists(GRANTS_FILE):
            with open(GRANTS_FILE, "r", encoding="utf-8") as f:
                d = json.load(f)
                if isinstance(d, dict):
                    grants = d
    except Exception as e:
        print(f"Доступы не загружены: {e}")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    prune_uploads()


def save_messages():
    try:
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(messages[-HISTORY_LIMIT:], f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"save messages: {e}")


def save_profiles():
    try:
        with open(PROFILES_FILE, "w", encoding="utf-8") as f:
            json.dump(profiles, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"save profiles: {e}")


def save_rooms():
    try:
        with open(ROOMS_FILE, "w", encoding="utf-8") as f:
            json.dump(rooms, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"save rooms: {e}")


def save_sessions():
    try:
        with open(SESSIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(sessions, f, ensure_ascii=False)
    except Exception as e:
        print(f"save sessions: {e}")


def save_pinned():
    try:
        with open(PINNED_FILE, "w", encoding="utf-8") as f:
            json.dump(pinned, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"save pinned: {e}")


def save_file_mimes():
    try:
        with open(FILES_MANIFEST, "w", encoding="utf-8") as f:
            json.dump(file_mimes, f, ensure_ascii=False)
    except Exception as e:
        print(f"save file_mimes: {e}")


def save_admins():
    try:
        with open(ADMINS_FILE, "w", encoding="utf-8") as f:
            json.dump(admins, f, ensure_ascii=False)
    except Exception as e:
        print(f"save admins: {e}")


def save_muted():
    try:
        with open(MUTED_FILE, "w", encoding="utf-8") as f:
            json.dump(muted, f, ensure_ascii=False)
    except Exception as e:
        print(f"save muted: {e}")


def save_grants():
    try:
        with open(GRANTS_FILE, "w", encoding="utf-8") as f:
            json.dump(grants, f, ensure_ascii=False)
    except Exception as e:
        print(f"save grants: {e}")


def is_admin(name):
    return name in admins


def is_muted(name):
    until = muted.get(name, 0)
    if until and until > time.time():
        return True
    if until:
        muted.pop(name, None)
        save_muted()
    return False


def public_rooms():
    with state_lock:
        return [{"id": r["id"], "name": r["name"], "creator": r.get("creator", ""),
                 "locked": bool(r.get("password"))} for r in rooms]


def can_access(room_id, username):
    # lock-free: читает редко меняющиеся структуры; вызывается и под state_lock
    if room_id.startswith("dm:"):
        return True
    r = next((x for x in rooms if x["id"] == room_id), None)
    if not r or not r.get("password"):
        return True
    if r.get("creator") == username or username in admins:
        return True
    return grants.get(f"{room_id}|{username}", False)


def uploads_size():
    total = 0
    try:
        for n in os.listdir(UPLOAD_DIR):
            p = os.path.join(UPLOAD_DIR, n)
            if os.path.isfile(p):
                total += os.path.getsize(p)
    except OSError:
        pass
    return total


def prune_uploads():
    """Удаляет файлы старше TTL. Возвращает число удалённых."""
    cutoff = time.time() - UPLOAD_TTL_DAYS * 86400
    n = 0
    try:
        for name in os.listdir(UPLOAD_DIR):
            p = os.path.join(UPLOAD_DIR, name)
            try:
                if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                    os.remove(p)
                    n += 1
            except OSError:
                pass
    except OSError:
        pass
    if n:
        print(f"prune uploads: удалено {n}")
    return n


def suggest_name(base):
    for i in range(2, 100):
        cand = f"{base}_{i}"[:MAX_NAME_LEN]
        if cand not in online or time.time() - online.get(cand, 0) > ONLINE_TIMEOUT:
            return cand
    return f"{base}_{int(time.time()) % 1000}"


def mute_until_str(name):
    until = muted.get(name, 0)
    if until and until > time.time():
        return datetime.fromtimestamp(until).strftime("%H:%M")
    return ""


def prune_online():
    now = time.time()
    with state_lock:
        dead = [u for u, ts in online.items()
                if now - ts > ONLINE_TIMEOUT
                or (u in ws_gone and now - ws_gone[u] > WS_GRACE)]
        for u in dead:
            del online[u]
            ws_gone.pop(u, None)
        cur = sorted(online.keys())
    return cur, bool(dead)


def get_online():
    with state_lock:
        return sorted(online.keys())


def touch(name):
    with state_lock:
        online[name] = time.time()
        ws_gone.pop(name, None)


def mark_left(name):
    with state_lock:
        online.pop(name, None)
        ws_gone.pop(name, None)
        typing_state.pop(name, None)


def mark_typing(name, room):
    with state_lock:
        typing_state[name] = (room[:64], time.time())
    ws_broadcast({"t": "typing", "user": name, "room": room[:64]})


def get_typing():
    now = time.time()
    with state_lock:
        dead = [u for u, (_, ts) in typing_state.items() if now - ts > TYPING_TTL]
        for u in dead:
            del typing_state[u]
        grouped = {}
        for u, (room, _) in typing_state.items():
            grouped.setdefault(room, []).append(u)
    return grouped


# ---------- WebSocket low-level ----------
def ws_send_frame(conn, payload: bytes, opcode=0x1):
    header = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header += struct.pack("!B", n)
    elif n < 65536:
        header = bytes([0x80 | opcode, 126]) + struct.pack("!H", n)
    else:
        header += bytes([127]) + struct.pack("!Q", n)
    conn.sendall(header + payload)


def ws_broadcast(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    with ws_lock:
        clients = list(ws_clients)
    for c in clients:
        try:
            with c["send_lock"]:
                ws_send_frame(c["conn"], data)
        except Exception:
            pass


def ws_send_one(client, obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    with client["send_lock"]:
        ws_send_frame(client["conn"], data)


def recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def ws_recv(conn):
    """Возвращает (opcode, payload). Бросает ConnectionError при разрыве."""
    hdr = recv_exact(conn, 2)
    b1, b2 = hdr[0], hdr[1]
    opcode = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(conn, 8))[0]
    mask = recv_exact(conn, 4) if masked else None
    payload = recv_exact(conn, length) if length else b""
    if masked and payload:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def broadcast_online():
    ws_broadcast({"t": "online", "users": get_online(), "profiles": profiles})


def add_message(username, room, text, file=None, reply_to=None, fwd=None,
                poll=None):
    global _next_id
    msg = {
        "id": _next_id,
        "room": room,
        "username": username,
        "text": clean_text(text),
        "time": now_str(),
        "ts": int(time.time()),
        "reactions": {},
    }
    if file:
        msg["file"] = file
    if poll:
        msg["poll"] = poll
    if fwd:
        msg["fwd"] = fwd
    if reply_to:
        try:
            rid = int(reply_to)
        except (TypeError, ValueError):
            rid = None
        if rid:
            with state_lock:
                target = next((m for m in messages if m["id"] == rid), None)
            if target:
                msg["reply"] = {
                    "id": target["id"],
                    "username": target.get("username", "?"),
                    "text": (target.get("text") or "")[:140],
                }
    _next_id += 1
    with state_lock:
        messages.append(msg)
        if len(messages) > HISTORY_LIMIT * 2:
            del messages[:len(messages) - HISTORY_LIMIT * 2]
        online[username] = time.time()
    save_messages()
    ws_broadcast({"t": "msg", "m": msg})
    return msg


def toggle_reaction(username, message_id, emoji):
    """Тогл реакции. Возвращает сообщение или None."""
    emoji = (emoji or "").strip()
    if not emoji or len(emoji) > 16:
        return None
    try:
        mid = int(message_id)
    except (TypeError, ValueError):
        return None
    with state_lock:
        msg = next((m for m in messages if m["id"] == mid), None)
        if not msg:
            return None
        users = msg.setdefault("reactions", {}).setdefault(emoji, [])
        if username in users:
            users.remove(username)
            if not users:
                del msg["reactions"][emoji]
        else:
            users.append(username)
        online[username] = time.time()
    save_messages()
    ws_broadcast({"t": "msg_update", "m": msg})
    return msg


def forward_message(username, message_id, room):
    with state_lock:
        src = next((m for m in messages if m["id"] == message_id), None)
    if not src:
        return None
    return add_message(
        username, room[:64],
        src.get("text", ""),
        file=src.get("file"),
        fwd={"username": src.get("username", "?"),
             "room": src.get("room", "general")},
    )


def toggle_pin(room, message_id):
    """Закреп/откреп. Возвращает (pinned_entry или None)."""
    try:
        mid = int(message_id)
    except (TypeError, ValueError):
        return "bad"
    with state_lock:
        if pinned.get(room, {}).get("id") == mid:
            del pinned[room]
            changed = None
        else:
            src = next((m for m in messages
                        if m["id"] == mid and m.get("room") == room), None)
            if not src:
                return "bad"
            changed = {"id": src["id"], "username": src.get("username", "?"),
                       "text": (src.get("text") or "")[:140]}
            pinned[room] = changed
    save_pinned()
    ws_broadcast({"t": "pin", "room": room, "pin": pinned.get(room)})
    return changed


def edit_message(username, message_id, text):
    """Правка своего сообщения. Возвращает msg / 'forbidden' / None."""
    text = clean_text(text)
    if not text:
        return None
    try:
        mid = int(message_id)
    except (TypeError, ValueError):
        return None
    with state_lock:
        msg = next((m for m in messages if m["id"] == mid), None)
        if not msg:
            return None
        if msg.get("username") != username:
            return "forbidden"
        msg["text"] = text
        msg["edited"] = True
        online[username] = time.time()
    save_messages()
    ws_broadcast({"t": "msg_update", "m": msg})
    return msg


def delete_message(username, message_id, allow_admin=False):
    """Удаление своего (или админом — любого). Возвращает (room, id) / 'forbidden' / None."""
    try:
        mid = int(message_id)
    except (TypeError, ValueError):
        return None
    with state_lock:
        idx = next((i for i, m in enumerate(messages) if m["id"] == mid), None)
        if idx is None:
            return None
        if messages[idx].get("username") != username and not allow_admin:
            return "forbidden"
        room = messages[idx].get("room", "general")
        del messages[idx]
        online[username] = time.time()
    save_messages()
    ws_broadcast({"t": "msg_delete", "room": room, "id": mid})
    return room, mid


def create_poll(username, room, question, options):
    """Создаёт сообщение-опрос. Возвращает msg или None."""
    question = clean_text(question)
    clean_opts = []
    for o in (options or [])[:8]:
        o = (o or "").strip()[:100]
        if o and o not in clean_opts:
            clean_opts.append(o)
    if not question or len(clean_opts) < 2:
        return None
    return add_message(
        username, room[:64], question,
        poll={"options": [{"text": o, "votes": []} for o in clean_opts]},
    )


def vote_poll(username, message_id, option):
    """Голос в опросе (один выбор, повторный клик снимает). Возвращает msg/None."""
    try:
        mid, opt = int(message_id), int(option)
    except (TypeError, ValueError):
        return None
    with state_lock:
        msg = next((m for m in messages if m["id"] == mid), None)
        if not msg or "poll" not in msg:
            return None
        opts = msg["poll"]["options"]
        if not (0 <= opt < len(opts)):
            return None
        if username in opts[opt]["votes"]:
            opts[opt]["votes"].remove(username)  # снять свой голос
        else:
            for o in opts:  # один выбор — снять остальные
                if username in o["votes"]:
                    o["votes"].remove(username)
            opts[opt]["votes"].append(username)
        online[username] = time.time()
    save_messages()
    ws_broadcast({"t": "msg_update", "m": msg})
    return msg


# ---------- HTTP handler ----------
class Handler(BaseHTTPRequestHandler):
    server_version = "MegaChat666/0.10"

    def log_message(self, fmt, *args):
        print(f"{self.client_address[0]} - {fmt % args}")

    # -- utils --
    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, filename, ctype, max_age=60):
        path = os.path.join(BASE_DIR, filename)
        if not os.path.exists(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", f"max-age={max_age}")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self, limit=200_000):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            return {}
        if length <= 0 or length > MAX_FILE_BYTES + 2_000_000:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    # -- WebSocket --
    def handle_ws(self, username):
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            self.send_error(400, "WS key missing")
            return
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()
        ).decode()
        conn = self.connection
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        )
        conn.sendall(resp.encode())
        conn.settimeout(60)

        client = {"conn": conn, "username": username, "send_lock": threading.Lock()}
        with ws_lock:
            ws_clients.append(client)
        print(f"WS connected: {username} ({self.client_address[0]})")
        touch(username)
        broadcast_online()
        try:
            ws_send_one(client, {"t": "init", "rooms": public_rooms(),
                                 "users": get_online(), "profiles": profiles})
            while True:
                try:
                    opcode, payload = ws_recv(conn)
                except socket.timeout:
                    # keepalive ping
                    try:
                        with client["send_lock"]:
                            ws_send_frame(conn, b"ping", opcode=0x9)
                    except Exception:
                        break
                    continue
                if opcode == 0x8:  # close
                    break
                if opcode == 0x9:  # ping -> pong
                    with client["send_lock"]:
                        ws_send_frame(conn, payload, opcode=0xA)
                    continue
                if opcode != 0x1:
                    continue
                try:
                    data = json.loads(payload.decode("utf-8"))
                except Exception:
                    continue
                t = data.get("t")
                if t == "hb":
                    touch(username)
                elif t == "send":
                    room = (data.get("room") or "general")[:64]
                    text = clean_text(data.get("text", ""))
                    if text and username and not is_muted(username) and can_access(room, username):
                        add_message(username, room, text,
                                    reply_to=data.get("reply_to"))
                elif t == "react":
                    toggle_reaction(username, data.get("id"), data.get("emoji"))
                elif t == "vote":
                    vote_poll(username, data.get("id"), data.get("option"))
                elif t == "typing":
                    mark_typing(username, data.get("room") or "general")
        except (ConnectionError, OSError, socket.timeout):
            pass
        finally:
            with ws_lock:
                if client in ws_clients:
                    ws_clients.remove(client)
                # grace: если это было последнее соединение юзера — засекаем время
                still = any(c["username"] == username for c in ws_clients)
            if not still:
                with state_lock:
                    ws_gone[username] = time.time()
            print(f"WS closed: {username}")
            # онлайн чистим по таймауту, но сразу шлём обновление
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass

    # -- GET --
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/ws":
            upg = (self.headers.get("Upgrade") or "").lower()
            if "websocket" not in upg:
                self.send_error(400, "Use WebSocket")
                return
            username = clean_name(qs.get("username", [""])[0])
            if len(username) < 2:
                self.send_error(400, "Bad username")
                return
            self.handle_ws(username)
            return

        if path == "/" or path == "/index.html":
            self.send_static("index.html", "text/html; charset=utf-8", 0)
        elif path == "/style.css":
            self.send_static("style.css", "text/css; charset=utf-8", 0)
        elif path == "/app.js":
            self.send_static("app.js", "application/javascript; charset=utf-8", 0)
        elif path == "/manifest.json":
            self.send_static("manifest.json", "application/manifest+json", 3600)
        elif path == "/sw.js":
            self.send_static("sw.js", "application/javascript; charset=utf-8", 0)
        elif path == "/icon.svg":
            self.send_static("icon.svg", "image/svg+xml", 3600)
        elif path == "/api/state":
            prune_online()
            now = time.time()
            with state_lock:
                active_muted = {u: t for u, t in muted.items() if t > now}
            self.send_json({"rooms": public_rooms(), "online": get_online(),
                            "profiles": profiles, "pinned": pinned,
                            "admins": admins, "muted": active_muted})
        elif path == "/api/rooms":
            self.send_json({"rooms": public_rooms()})
        elif path == "/api/online":
            prune_online()
            self.send_json({"online": get_online()})
        elif path == "/api/typing":
            self.send_json({"typing": get_typing()})
        elif path == "/api/profiles":
            self.send_json({"profiles": profiles})
        elif path == "/api/messages":
            room = qs.get("room", ["general"])[0][:64]
            me = clean_name(qs.get("username", [""])[0])
            try:
                since = int(qs.get("since", ["0"])[0])
            except ValueError:
                since = 0
            if not can_access(room, me):
                self.send_json({"ok": False, "error": "Комната закрыта"}, 403)
                return
            with state_lock:
                data = [m for m in messages if m.get("room", "general") == room and m["id"] > since]
            self.send_json({"messages": data[-HISTORY_LIMIT:]})
        elif path == "/api/search":
            #?q=&username=&room? — лички видны только участникам
            q = (qs.get("q", [""])[0] or "").strip().lower()[:100]
            me = clean_name(qs.get("username", [""])[0])
            only_room = (qs.get("room", [""])[0] or "")[:64]
            if len(q) < 2:
                self.send_json({"results": []})
                return
            with state_lock:
                out = []
                for m in messages:
                    room = m.get("room", "general")
                    if only_room and room != only_room:
                        continue
                    if room.startswith("dm:"):
                        parts = room[3:].split("|")
                        if me not in parts:
                            continue
                    elif not can_access(room, me):
                        continue
                    hay = ((m.get("text") or "") + " " + (m.get("username") or "")).lower()
                    if q in hay:
                        out.append(m)
            self.send_json({"results": out[-50:]})
        elif path.startswith("/files/"):
            name = os.path.basename(path[len("/files/"):])
            if not name or name.startswith("."):
                self.send_error(404)
                return
            fpath = os.path.join(UPLOAD_DIR, name)
            if not os.path.exists(fpath):
                self.send_error(404)
                return
            ctype = file_mimes.get(name)
            if not ctype:
                ctype, _ = mimetypes.guess_type(fpath)
            with open(fpath, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", f'inline; filename="{name}"')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    # -- POST --
    def do_POST(self):
        global rooms
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        big = (path == "/api/upload")
        data = self.read_json(limit=MAX_FILE_BYTES + 1_000_000 if big else 200_000)

        if path == "/api/join":
            name = clean_name(data.get("username", ""))
            token = (data.get("token") or "")[:64]
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Имя слишком короткое (мин. 2 символа)"}, 400)
                return
            with state_lock:
                toks = sessions.get(name, [])
                if token and token in toks:
                    pass  # своё устройство, возврат
                elif len(toks) >= MAX_DEVICES:
                    self.send_json({"ok": False, "error": "Ник занят (лимит устройств)",
                                    "suggest": suggest_name(name)}, 409)
                    return
                else:
                    token = os.urandom(12).hex()
                    toks.append(token)
                    sessions[name] = toks
                    save_sessions()
                if not admins:
                    admins.append(name)
                    save_admins()
                    print(f"Первый пользователь {name} стал админом")
            touch(name)
            with state_lock:
                if name not in profiles:
                    profiles[name] = {"bio": "", "emoji": ""}
            save_profiles()
            broadcast_online()
            self.send_json({"ok": True, "username": name, "token": token,
                            "profile": profiles.get(name, {}),
                            "admin": is_admin(name)})

        elif path == "/api/leave":
            name = clean_name(data.get("username", ""))
            if name:
                mark_left(name)
                broadcast_online()
            self.send_json({"ok": True})

        elif path == "/api/heartbeat":
            name = clean_name(data.get("username", ""))
            if name:
                touch(name)
            self.send_json({"ok": True})

        elif path == "/api/typing":
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "general")[:64]
            if len(name) < 2:
                self.send_json({"ok": False}, 400)
                return
            touch(name)
            mark_typing(name, room)
            self.send_json({"ok": True})

        elif path == "/api/profile":
            name = clean_name(data.get("username", ""))
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            bio = clean_bio(data.get("bio", ""))
            emoji = (data.get("emoji", "") or "").strip()[:8]
            with state_lock:
                profiles[name] = {"bio": bio, "emoji": emoji}
            save_profiles()
            broadcast_online()
            self.send_json({"ok": True, "profile": profiles[name]})

        elif path == "/api/rooms":
            name = clean_name(data.get("username", ""))
            title = (data.get("name", "") or "").strip()[:MAX_ROOM_LEN]
            password = (data.get("password", "") or "")[:64]
            if len(name) < 2 or len(title) < 2:
                self.send_json({"ok": False, "error": "Нужно имя и название комнаты (мин. 2)"}, 400)
                return
            rid = slug_room(title)
            with state_lock:
                if any(r["id"] == rid for r in rooms):
                    pub = next(p for p in public_rooms() if p["id"] == rid)
                    self.send_json({"ok": True, "room": pub})
                    return
                if len(rooms) >= MAX_ROOMS:
                    self.send_json({"ok": False, "error": "Слишком много комнат"}, 400)
                    return
                room = {"id": rid, "name": title, "creator": name}
                if password:
                    room["password"] = hashlib.sha256(password.encode()).hexdigest()
                    grants[f"{rid}|{name}"] = True
                rooms.append(room)
            save_rooms()
            if password:
                save_grants()
            ws_broadcast({"t": "rooms", "rooms": public_rooms()})
            pub = next(p for p in public_rooms() if p["id"] == rid)
            self.send_json({"ok": True, "room": pub})

        elif path == "/api/messages":
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "general")[:64]
            text = clean_text(data.get("text", ""))
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            if not text:
                self.send_json({"ok": False, "error": "Пустое сообщение"}, 400)
                return
            if is_muted(name):
                self.send_json({"ok": False, "error": f"Мут до {mute_until_str(name)}"}, 403)
                return
            if not can_access(room, name):
                self.send_json({"ok": False, "error": "Комната закрыта"}, 403)
                return
            msg = add_message(name, room, text, reply_to=data.get("reply_to"))
            self.send_json({"ok": True, "message": msg})

        elif path == "/api/react":
            name = clean_name(data.get("username", ""))
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            msg = toggle_reaction(name, data.get("id"), data.get("emoji"))
            if not msg:
                self.send_json({"ok": False, "error": "Сообщение или эмодзи неверны"}, 400)
                return
            self.send_json({"ok": True, "message": msg})

        elif path == "/api/pin":
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "general")[:64]
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            res = toggle_pin(room, data.get("id"))
            if res == "bad":
                self.send_json({"ok": False, "error": "Сообщение не найдено в этой комнате"}, 400)
                return
            self.send_json({"ok": True, "pin": res})

        elif path == "/api/forward":
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "general")[:64]
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            if is_muted(name):
                self.send_json({"ok": False, "error": f"Мут до {mute_until_str(name)}"}, 403)
                return
            if not can_access(room, name):
                self.send_json({"ok": False, "error": "Комната закрыта"}, 403)
                return
            try:
                mid = int(data.get("id"))
            except (TypeError, ValueError):
                self.send_json({"ok": False, "error": "Нет сообщения"}, 400)
                return
            msg = forward_message(name, mid, room)
            if not msg:
                self.send_json({"ok": False, "error": "Сообщение не найдено"}, 400)
                return
            self.send_json({"ok": True, "message": msg})

        elif path == "/api/edit":
            name = clean_name(data.get("username", ""))
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            res = edit_message(name, data.get("id"), data.get("text", ""))
            if res == "forbidden":
                self.send_json({"ok": False, "error": "Можно править только свои сообщения"}, 403)
                return
            if not res:
                self.send_json({"ok": False, "error": "Сообщение не найдено или пустой текст"}, 400)
                return
            self.send_json({"ok": True, "message": res})

        elif path == "/api/delete":
            name = clean_name(data.get("username", ""))
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            res = delete_message(name, data.get("id"), allow_admin=is_admin(name))
            if res == "forbidden":
                self.send_json({"ok": False, "error": "Можно удалять только свои сообщения"}, 403)
                return
            if not res:
                self.send_json({"ok": False, "error": "Сообщение не найдено"}, 400)
                return
            room, mid = res
            self.send_json({"ok": True, "room": room, "id": mid})

        elif path == "/api/polls":
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "general")[:64]
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            if is_muted(name):
                self.send_json({"ok": False, "error": f"Мут до {mute_until_str(name)}"}, 403)
                return
            if not can_access(room, name):
                self.send_json({"ok": False, "error": "Комната закрыта"}, 403)
                return
            msg = create_poll(name, room, data.get("question", ""),
                              data.get("options", []))
            if not msg:
                self.send_json({"ok": False, "error": "Нужен вопрос и минимум 2 варианта"}, 400)
                return
            self.send_json({"ok": True, "message": msg})

        elif path == "/api/vote":
            name = clean_name(data.get("username", ""))
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            msg = vote_poll(name, data.get("id"), data.get("option"))
            if not msg:
                self.send_json({"ok": False, "error": "Опрос не найден"}, 400)
                return
            self.send_json({"ok": True, "message": msg})

        elif path == "/api/mute":
            admin = clean_name(data.get("admin", ""))
            target = clean_name(data.get("user", ""))
            if not is_admin(admin):
                self.send_json({"ok": False, "error": "Только для админов"}, 403)
                return
            try:
                minutes = int(data.get("minutes", 0))
            except (TypeError, ValueError):
                minutes = 0
            with state_lock:
                if minutes > 0:
                    muted[target] = time.time() + min(minutes, 60 * 24 * 7) * 60
                else:
                    muted.pop(target, None)
            save_muted()
            now = time.time()
            with state_lock:
                active = {u: t for u, t in muted.items() if t > now}
            ws_broadcast({"t": "muted", "muted": active})
            self.send_json({"ok": True, "muted": active})

        elif path == "/api/room_unlock":
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "")[:64]
            password = (data.get("password", "") or "")[:64]
            with state_lock:
                r = next((x for x in rooms if x["id"] == room), None)
            if not r or not r.get("password"):
                self.send_json({"ok": True})
                return
            if hashlib.sha256(password.encode()).hexdigest() != r["password"]:
                self.send_json({"ok": False, "error": "Неверный пароль"}, 403)
                return
            with state_lock:
                grants[f"{room}|{name}"] = True
            save_grants()
            self.send_json({"ok": True})

        elif path == "/api/upload":
            # {username, room, filename, mime, data(base64), text?}
            name = clean_name(data.get("username", ""))
            room = (data.get("room") or "general")[:64]
            filename = safe_filename(data.get("filename", "file"))
            b64 = data.get("data", "")
            if len(name) < 2:
                self.send_json({"ok": False, "error": "Нет имени"}, 400)
                return
            if is_muted(name):
                self.send_json({"ok": False, "error": f"Мут до {mute_until_str(name)}"}, 403)
                return
            if not can_access(room, name):
                self.send_json({"ok": False, "error": "Комната закрыта"}, 403)
                return
            try:
                raw = base64.b64decode(b64, validate=True)
            except Exception:
                self.send_json({"ok": False, "error": "Битый файл"}, 400)
                return
            if not raw or len(raw) > MAX_FILE_BYTES:
                self.send_json({"ok": False, "error": "Файл пуст или больше 15 МБ"}, 400)
                return
            prune_uploads()
            if uploads_size() + len(raw) > MAX_UPLOADS_BYTES:
                self.send_json({"ok": False, "error": "Хранилище заполнено (лимит 200 МБ, старые файлы чистятся)"}, 413)
                return
            uniq = f"{int(time.time())}_{os.urandom(3).hex()}_{filename}"
            with open(os.path.join(UPLOAD_DIR, uniq), "wb") as f:
                f.write(raw)
            mime = (data.get("mime", "") or "")[:80]
            file_mimes[uniq] = mime or "application/octet-stream"
            save_file_mimes()
            finfo = {"name": filename, "stored": uniq,
                     "size": len(raw), "mime": mime,
                     "url": f"/files/{uniq}"}
            msg = add_message(name, room, clean_text(data.get("text", "")) or f"📎 {filename}", file=finfo,
                              reply_to=data.get("reply_to"))
            self.send_json({"ok": True, "message": msg, "file": finfo})
        else:
            self.send_error(404)


def online_pruner():
    global _last_online_snapshot
    while True:
        time.sleep(10)
        cur, changed = prune_online()
        if changed or cur != _last_online_snapshot:
            _last_online_snapshot = cur
            try:
                broadcast_online()
            except Exception:
                pass


def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    import argparse
    p = argparse.ArgumentParser(description="MegaChat666 v0.9")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--tls", action="store_true", help="HTTPS + WSS (нужны --cert и --key)")
    p.add_argument("--cert", default="cert.pem", help="Путь к TLS-сертификату (PEM)")
    p.add_argument("--key", default="key.pem", help="Путь к TLS-ключу (PEM)")
    p.add_argument("--admin", action="append", default=[], help="Ник администратора (можно несколько раз)")
    args = p.parse_args()

    load_all()
    for a in args.admin:
        a = clean_name(a)
        if a and a not in admins:
            admins.append(a)
    if args.admin:
        save_admins()
    threading.Thread(target=online_pruner, daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    scheme = "http"
    if args.tls:
        import ssl
        if not (os.path.exists(args.cert) and os.path.exists(args.key)):
            print(f"Нет {args.cert} или {args.key} — см. README раздел HTTPS.")
            raise SystemExit(1)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key)
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        scheme = "https"
    lan = get_lan_ip()
    print("=" * 55)
    print(" MegaChat666 v0.10 — мульти-девайс, админка, замки комнат, PWA" + (" + HTTPS" if scheme == "https" else ""))
    print(f" На этом ПК:      {scheme}://localhost:{args.port}")
    print(f" Для других в LAN: {scheme}://{lan}:{args.port}")
    print(" Остановка: Ctrl+C")
    print("=" * 55)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка...")


if __name__ == "__main__":
    main()
