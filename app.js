// MegaChat666 v0.11 — WebSocket push + fallback polling + ответы/реакции/эмодзи
// Оглавление (монолит осознанно, см. AGENTS.md):
//   состояние → вход → WebSocket → чаты → «печатает...» → уведомления → закрепы
//   → пересылка → опросы → тема → рендер (markdown автономен: MD-START/MD-END)
//   → ответы → редактирование → реакции → эмодзи → отправка (файлы, DnD)
//   → голосовые → комнаты → профиль → поиск → модалка картинок
// ---------- состояние и хелперы ----------
let username = localStorage.getItem("megachat_name") || "";
let authToken = localStorage.getItem("megachat_token") || "";
let chatFilterQ = "";
let bottomPending = 0;
const DRAFTS_KEY = "megachat_drafts";
let drafts = {};
try { drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}"); } catch { drafts = {}; }
let draftTimer = null;
function persistDrafts() { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch {} }
function saveDraft() {
  const v = $("textInput").value;
  if (v) drafts[current.id] = v;
  else delete drafts[current.id];
  persistDrafts();
}
let myProfile = { bio: "", emoji: "" };
let rooms = [], onlineUsers = [], profiles = {};
let current = { type: "room", id: "general", title: "Общий чат" };
let cache = {};      // roomId -> {msgs: [], lastId: 0}
let readState = {};    // roomId -> {user: last_read_id} (галочки)
let unread = {};     // roomId -> count
let replyTo = null;  // сообщение, на которое отвечаем
let pinnedRooms = {};  // roomId -> {id, username, text}
let fwdMsg = null;     // сообщение для пересылки
let adminsList = [];
let mutedMap = {};
let unlockedRooms = {};
try { unlockedRooms = JSON.parse(localStorage.getItem("megachat_unlocked") || "{}"); } catch { unlockedRooms = {}; }
function persistUnlocked() { try { localStorage.setItem("megachat_unlocked", JSON.stringify(unlockedRooms)); } catch {} }
function amAdmin() { return adminsList.includes(username); }
let ws = null, wsOk = false, hbTimer = null, pollTimer = null, reconnectTimer = null;
let soundOn = localStorage.getItem("megachat_sound") !== "off";
let searchTimer = null;
let typingTimers = {};  // room -> {user -> timeoutId}
let lastTypingSent = 0;
const BASE_TITLE = "MegaChat666 — локальный чат";

// Наборы эмодзи (встроенные, без внешних библиотек)
const EMOJI_GRID = ("😀 😁 😂 🤣 😊 😍 😘 😎 🤔 😐 🙄 😴 🤯 🥳 😢 😭 😡 👍 👎 👏 🙏 💪 🤝 ✌️ 🤞 👌 " +
  "❤️ 💔 💯 🔥 🎉 🎁 ⚽ 🏆 🚀 🌙 ☀️ 🌧 ❄️ 🍕 🍔 ☕ 🍺 🐱 🐶 🌸 🌵 💡 📌 📎 ✅ ❌ ❓ ❗ 💤 🎵 📷").split(" ");
const QUICK_REACT = ["❤️", "👍", "😂", "😮", "😢", "🔥", "👏", "👎"];

const $ = (id) => document.getElementById(id);
const messagesDiv = $("messages");

const COLORS = [["#ff845e","#d45246"],["#5aa9e6","#2e7cc4"],["#72d66a","#31a24c"],["#e6a85a","#c47e2e"],["#b47ae6","#7a4cc4"],["#e67ad6","#b44cc4"]];
function colorFor(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 997; return COLORS[h % COLORS.length]; }
function esc(s) { return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function dmRoom(a, b) { const p = [a, b].sort(); return `dm:${p[0]}|${p[1]}`; }
function avatarLabel(name) { const p = profiles[name]; return (p && p.emoji) ? p.emoji : name[0].toUpperCase(); }
function avatarInner(name) {
  const p = (name === username ? myProfile : profiles[name]) || {};
  if (p.avatar) return `<img class="av-pic" src="${esc(p.avatar)}" alt="">`;
  return esc(name === username ? (myProfile.emoji || username[0].toUpperCase()) : avatarLabel(name));
}
function fmtSize(n) { if (n < 1024) return n + " Б"; if (n < 1048576) return (n/1024).toFixed(1) + " КБ"; return (n/1048576).toFixed(1) + " МБ"; }

// ---------- вход ----------
// сразу показываем, сколько людей онлайн — дружелюбнее пустого экрана
fetch("/api/online").then(r => r.json()).then(d => {
  const n = (d.online || []).length;
  $("loginOnline").textContent = n ? `Сейчас онлайн: ${n} — присоединяйтесь!` : "Пока никого нет — будете первым!";
}).catch(() => { $("loginOnline").textContent = "Локальный чат без регистрации"; });
if (username) { $("nameInput").value = username; }
$("joinBtn").onclick = tryJoin;
$("nameInput").onkeydown = (e) => { if (e.key === "Enter") tryJoin(); };

async function tryJoin() {
  const name = $("nameInput").value.trim();
  if (name.length < 2) { $("loginError").textContent = "Введите имя (мин. 2 символа)"; return; }
  try {
    const r = await fetch("/api/join", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({username: name, token: authToken}) });
    const d = await r.json();
    if (!d.ok) {
      if (r.status === 409 && d.suggest) {
        $("nameInput").value = d.suggest;
        $("loginError").textContent = `Ник занят, предложен свободный: ${d.suggest}`;
      } else $("loginError").textContent = d.error || "Ошибка";
      return;
    }
    username = d.username;
    authToken = d.token || authToken;
    myProfile = d.profile || myProfile;
    localStorage.setItem("megachat_name", username);
    localStorage.setItem("megachat_token", authToken);
    ensureAudio();
    // разрешение на десктоп-уведомления (нужен жест пользователя — клик «Войти» подходит)
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch {}
    enterApp();
  } catch { $("loginError").textContent = "Нет связи с сервером"; }
}

async function enterApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderMe();
  try {
    const s = await (await fetch(`/api/state?username=${encodeURIComponent(username)}`)).json();
    rooms = s.rooms || []; onlineUsers = s.online || []; profiles = s.profiles || {};
    if (s.read) readState = s.read;
    pinnedRooms = s.pinned || {};
    adminsList = s.admins || [];
    mutedMap = s.muted || {};
    myProfile = profiles[username] || myProfile;
  } catch {}
  renderMe(); renderRooms(); renderOnline(); renderDMs();
  openChat("room", "general", "Общий чат");
  applySoundBtn();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { updateTitle(); sendRead(false); } });
  connectWS();
  $("textInput").focus();
}

// ---------- WebSocket ----------
function setConn(on, text) {
  $("connDot").className = "dot" + (on ? " on" : (text === "polling" ? "" : " off"));
  $("connText").textContent = on ? "в сети · WS" : (text === "polling" ? "polling…" : text);
}

function connectWS() {
  clearTimeout(reconnectTimer);
  try { if (ws) ws.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  ws = new WebSocket(proto + location.host + "/ws?username=" + encodeURIComponent(username) + "&token=" + encodeURIComponent(authToken));
  ws.onopen = () => {
    wsOk = true; setConn(true); stopPolling();
    clearInterval(hbTimer);
    hbTimer = setInterval(() => { try { ws.send(JSON.stringify({t:"hb"})); } catch {} }, 10000);
  };
  ws.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.t === "init") { rooms = d.rooms || rooms; onlineUsers = d.users || []; profiles = d.profiles || profiles; if (d.read) readState = d.read; renderRooms(); renderOnline(); renderDMs(); renderMe(); refreshTicks(); }
    else if (d.t === "muted") { mutedMap = d.muted || {}; renderOnline(); applyMuteState(); }
    else if (d.t === "msg") onIncoming(d.m);
    else if (d.t === "msg_update") onMsgUpdate(d.m);
    else if (d.t === "msg_delete") onMsgDelete(d.room, d.id);
    else if (d.t === "typing") onTyping(d.user, d.room);
    else if (d.t === "pin") { if (d.room) { pinnedRooms[d.room] = d.pin; if (d.room === current.id) renderPin(); } }
    else if (d.t === "online") { onlineUsers = d.users || []; profiles = d.profiles || profiles; renderOnline(); renderDMs(); }
    else if (d.t === "read") onRead(d.room, d.user, d.id);
    else if (d.t === "rooms") { rooms = d.rooms; renderRooms(); }
  };
  ws.onclose = () => {
    wsOk = false; setConn(false, "polling"); clearInterval(hbTimer);
    startPolling(); // fallback
    reconnectTimer = setTimeout(connectWS, 3000);
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

// fallback polling, только если WS мёртв
async function pollOnce() {
  if (wsOk) return;
  try {
    const s = await (await fetch(`/api/state?username=${encodeURIComponent(username)}`)).json();
    rooms = s.rooms || rooms; onlineUsers = s.online || []; profiles = s.profiles || profiles;
    if (s.pinned) { pinnedRooms = s.pinned; renderPin(); }
    if (s.admins) adminsList = s.admins;
    if (s.muted) { mutedMap = s.muted; applyMuteState(); }
    if (s.read) { readState = s.read; refreshTicks(); }
    renderRooms(); renderOnline(); renderDMs();
    // heartbeat держит онлайн и сбрасывает WS-grace; тянем свежие + typing
    fetch("/api/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) }).catch(() => {});
    // тянем свежие + обновления реакций (у реакций нет новых id, поэтому берём хвост)
    const c = cache[current.id] || { lastId: 0 };
    const [rh, tp] = await Promise.all([
      fetch(`/api/messages?room=${encodeURIComponent(current.id)}&since=0&username=${encodeURIComponent(username)}`),
      fetch("/api/typing"),
    ]);
    mergeMessages((await rh.json()).messages || [], c.lastId);
    applyTypingSnapshot((await tp.json()).typing || {});
  } catch {}
}
function startPolling() { stopPolling(); setConn(false, "polling"); pollTimer = setInterval(pollOnce, 2500); pollOnce(); }
function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

// ---------- чаты ----------
function lastId() { return (cache[current.id] || {lastId: 0}).lastId; }

function openChat(type, id, title) {
  const lockedRoom = type === "room" && (rooms.find(x => x.id === id) || {}).locked;
  if (lockedRoom && !unlockedRooms[id] && !amAdmin()) {
    const pw = prompt(`Комната «${title}» закрыта 🔒\nВведите пароль:`);
    if (pw === null) return;
    fetch("/api/room_unlock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, room: id, password: pw }) })
      .then(r => r.json()).then(d => {
        if (d.ok) { unlockedRooms[id] = true; persistUnlocked(); openChat(type, id, title); }
        else showToast("⚠️ Неверный пароль");
      }).catch(() => showToast("⚠️ Нет связи"));
    return;
  }
  current = { type, id, title };
  unread[id] = 0;
  cancelReply();
  document.querySelector(".sidebar").classList.remove("open");
  renderPin();
  $("chatTitle").textContent = title;
  $("chatAvatar").innerHTML = type === "room" ? "#" : avatarInner(title);
  messagesDiv.innerHTML = "";
  $("mediaPanel").classList.add("hidden");
  const c = cache[id] || { msgs: [], lastId: 0 };
  cache[id] = c;
  c.lastDay = null;
  if (!c.msgs.length) addSys(type === "room" ? `Вы в комнате «${esc(title)}»` : `Личка с ${esc(title)}`);
  c.msgs.forEach(addMessage);
  updateChatSub(); renderRooms(); renderDMs();
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  bottomPending = 0;
  renderToBottom();
  // черновик этой комнаты
  if (drafts[id]) { $("textInput").value = drafts[id]; autogrow(); }
  else { $("textInput").value = ""; autogrow(); }
  // догрузить историю
  fetch(`/api/messages?room=${encodeURIComponent(id)}&since=${c.lastId}&username=${encodeURIComponent(username)}`)
    .then(r => r.json()).then(d => {
      if (d.messages) mergeMessages(d.messages || [], true);
      else if (d.error) { delete unlockedRooms[id]; persistUnlocked(); showToast("⚠️ " + d.error); }
    })
    .catch(() => {});
  sendRead(true);
}

// Слияние входящих: новые — в конец, изменённые (реакции) — перерисовать на месте
function mergeMessages(list, silent) {
  for (const m of list) {
    let c = cache[m.room];
    if (!c) c = cache[m.room] = { msgs: [], lastId: 0 };
    const old = c.msgs.find(x => x.id === m.id);
    if (old) { Object.assign(old, m); refreshMessageNode(m); continue; }
    c.msgs.push(m);
    c.lastId = Math.max(c.lastId, m.id);
    if (m.room === current.id) addMessage(m);
    else if (!silent) { unread[m.room] = (unread[m.room] || 0) + 1; renderRooms(); renderDMs(); }
    if (!silent && m.username !== username) notifyMessage(m);
  }
  updateChatSub();
}

function onIncoming(m, silent) { mergeMessages([m], !!silent); }

function onMsgUpdate(m) {
  const c = cache[m.room];
  if (c) {
    const old = c.msgs.find(x => x.id === m.id);
    if (old) Object.assign(old, m);
    else { c.msgs.push(m); c.lastId = Math.max(c.lastId, m.id); }
  } else cache[m.room] = { msgs: [m], lastId: m.id };
  if (m.room === current.id) refreshMessageNode(m);
}

// ---------- галочки прочтения ----------
function tickSuffix(m) {
  if (!m || m.username !== username) return "";
  const readers = readState[m.room] || {};
  if (m.room.startsWith("dm:")) {
    const parts = m.room.slice(3).split("|");
    const peer = parts[0] === username ? parts[1] : parts[0];
    return (readers[peer] || 0) >= m.id ? " ✓✓" : " ✓";
  }
  const n = Object.keys(readers).filter(u => u !== username && (readers[u] || 0) >= m.id).length;
  return n > 0 ? ` 👁 ${n}` : " ✓";
}
function onRead(room, user, id) {
  if (!room || !user || !(id > 0)) return;
  const rmap = readState[room] || (readState[room] = {});
  if (id <= (rmap[user] || 0)) return;
  rmap[user] = id;
  if (room === current.id) refreshTicks();
}
function refreshTicks() {
  const c = cache[current.id];
  if (!c) return;
  for (const m of c.msgs) {
    if (m.username !== username) continue;
    const node = messagesDiv.querySelector(`[data-mid="${m.id}"]`);
    if (node && !node.querySelector(".edit-input")) refreshMessageNode(m);
  }
}
let lastReadSent = 0;
function sendRead(force) {
  const c = cache[current.id];
  if (!c || !c.msgs.length) return;
  const now = Date.now();
  if (!force && now - lastReadSent < 2000) return;
  lastReadSent = now;
  const last = c.msgs[c.msgs.length - 1].id;
  fetch("/api/read", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, room: current.id, id: last }) }).catch(() => {});
}

function onMsgDelete(room, id) {
  const c = cache[room];
  if (c) c.msgs = c.msgs.filter(x => x.id !== id);
  if (room === current.id) {
    const node = messagesDiv.querySelector(`[data-mid="${id}"]`);
    if (node) node.remove();
  }
  const pin = pinnedRooms[room];
  if (pin && pin.id === id) { pinnedRooms[room] = null; if (room === current.id) renderPin(); }
}

function refreshMessageNode(m) {
  const node = messagesDiv.querySelector(`[data-mid="${m.id}"]`);
  if (!node) return;
  const fresh = buildMessageNode(m);
  node.replaceWith(fresh);
}

function updateChatSub() {
  const typers = getTypers(current.id);
  if (typers.length) {
    $("chatSub").innerHTML = `<span class="typing-anim">✍️ ${esc(typers.slice(0, 2).join(", "))} печатает</span>`;
  } else if (current.type === "room") {
    const n = onlineUsers.length;
    const bio = current.id === "general" ? "" : "";
    $("chatSub").textContent = `${n} онлайн ${wsOk ? "· live" : "· polling"} ${bio}`;
  } else {
    const on = onlineUsers.includes(current.title);
    const p = profiles[current.title];
    $("chatSub").textContent = (on ? "в сети" : "не в сети") + (p && p.bio ? " · " + p.bio : "") + (wsOk ? "" : " · polling");
  }
  $("onlineCount").textContent = onlineUsers.length;
  updateTitle();
  applyMuteState();
}

function applyMuteState() {
  const until = mutedMap[username];
  const inp = $("textInput");
  if (until && until * 1000 > Date.now()) {
    const t = new Date(until * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    inp.disabled = true;
    inp.placeholder = `Мут до ${t} 🔇`;
  } else {
    inp.disabled = false;
    inp.placeholder = "Написать сообщение... (Enter — отправить, Shift+Enter — новая строка)";
  }
}

async function muteUser(u) {
  const isMut = mutedMap[u] && mutedMap[u] * 1000 > Date.now();
  let minutes = 0;
  if (!isMut) {
    const v = prompt(`Мут ${u} (минут, Enter — 10):`, "10");
    if (v === null) return;
    minutes = Math.max(0, parseInt(v || "10", 10) || 0);
  }
  try {
    const r = await fetch("/api/mute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ admin: username, user: u, minutes }) });
    const d = await r.json();
    if (d.ok) { mutedMap = d.muted; renderOnline(); applyMuteState(); showToast(isMut ? "Мут снят" : `Мут ${u} на ${minutes} мин`); }
    else showToast("⚠️ " + (d.error || "Нет прав"));
  } catch { showToast("⚠️ Нет связи"); }
}
function totalUnread() { return Object.values(unread).reduce((a, b) => a + (b || 0), 0); }
function updateTitle() {
  const n = totalUnread();
  document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

// ---------- «печатает...» ----------
function onTyping(user, room) {
  if (!user || user === username || !room) return;
  let m = typingTimers[room];
  if (!m) m = typingTimers[room] = {};
  clearTimeout(m[user]);
  m[user] = setTimeout(() => { delete m[user]; renderRooms(); renderDMs(); updateChatSub(); }, 3500);
  renderRooms(); renderDMs(); updateChatSub();
}
function applyTypingSnapshot(grouped) {
  for (const room of Object.keys(grouped)) {
    for (const u of grouped[room]) if (u !== username) onTyping(u, room);
  }
}
function getTypers(room) { return Object.keys(typingTimers[room] || {}); }
function typingNote(room) {
  const t = getTypers(room).filter(u => u !== username);
  return t.length ? `✍️ ${t.slice(0, 2).join(", ")}…` : "";
}
function sendTyping() {
  const now = Date.now();
  if (now - lastTypingSent < 2000) return;
  lastTypingSent = now;
  if (wsOk && ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify({ t: "typing", room: current.id })); } catch {}
  } else {
    fetch("/api/typing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, room: current.id }) }).catch(() => {});
  }
}

// ---------- уведомления ----------
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}
function beep() {
  if (!soundOn) return;
  try {
    ensureAudio();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; o.type = "sine";
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.start(t); o.stop(t + 0.25);
  } catch {}
}
function notifyMessage(m) {
  const mentioned = (m.text || "").includes("@" + username);
  const background = document.hidden || m.room !== current.id;
  if (!background && !mentioned) return;
  beep();
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const roomLabel = m.room.startsWith("dm:") ? "Личка" : ((rooms.find(r => r.id === m.room) || {}).name || m.room);
    const n = new Notification(`${m.username} · ${roomLabel}`, { body: (m.text || "").slice(0, 120), tag: "megachat-" + m.id });
    n.onclick = () => { try { window.focus(); } catch {} openChatForMessage(m.room, m.id); n.close(); };
  } catch {}
}
function applySoundBtn() {
  $("soundBtn").textContent = soundOn ? "🔔" : "🔕";
  $("soundBtn").classList.toggle("off", !soundOn);
  $("soundBtn").title = soundOn ? "Звук уведомлений вкл (нажмите чтобы выкл)" : "Звук уведомлений выкл (нажмите чтобы вкл)";
}
$("soundBtn").onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem("megachat_sound", soundOn ? "on" : "off");
  applySoundBtn();
  if (soundOn) beep();
};

// Честный оффлайн при закрытии вкладки (beacon долетает даже при выгрузке страницы)
window.addEventListener("pagehide", () => {
  try { saveDraft(); } catch {}
  if (!username) return;
  try {
    const blob = new Blob([JSON.stringify({ username, token: authToken })], { type: "application/json" });
    navigator.sendBeacon("/api/leave", blob);
  } catch {}
});

// Мобильный drawer
$("menuBtn").onclick = () => document.querySelector(".sidebar").classList.toggle("open");

// На тачскринах ховера нет: тап по пузырю показывает/прячет кнопки действий
messagesDiv.addEventListener("click", (e) => {
  if (window.innerWidth > 700) return;
  if (e.target.closest("button, a")) return;
  const m = e.target.closest(".msg");
  if (!m) return;
  const was = m.classList.contains("show-actions");
  messagesDiv.querySelectorAll(".msg.show-actions").forEach(x => x.classList.remove("show-actions"));
  if (!was) m.classList.add("show-actions");
});
// доскроллил до низа — отмечаем прочитанным (троттлится внутри sendRead)
messagesDiv.addEventListener("scroll", () => { if (isNearBottom()) sendRead(false); });

// ---------- закрепы ----------
function renderPin() {
  const pin = pinnedRooms[current.id];
  const bar = $("pinBanner");
  if (!pin) { bar.classList.add("hidden"); return; }
  $("pinText").innerHTML = `📌 <b>${esc(pin.username)}</b> · ${esc((pin.text || "").slice(0, 80))}`;
  bar.classList.remove("hidden");
}
$("pinBanner").onclick = (e) => {
  if (e.target.id === "pinUnpin") return;
  const pin = pinnedRooms[current.id];
  if (pin) jumpToMessage(pin.id);
};
$("pinUnpin").onclick = async () => {
  const pin = pinnedRooms[current.id];
  if (!pin) return;
  await togglePin(current.id, pin.id);
};
async function togglePin(roomId, msgId) {
  try {
    const r = await fetch("/api/pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, room: roomId, id: msgId }) });
    const d = await r.json();
    if (d.ok) { pinnedRooms[roomId] = d.pin; if (roomId === current.id) renderPin(); }
  } catch {}
}

// ---------- пересылка ----------
function dmPeers() {
  const peers = new Set(onlineUsers.filter(u => u !== username));
  for (const id of Object.keys(cache)) {
    if (id.startsWith("dm:")) {
      const parts = id.slice(3).split("|");
      const peer = parts[0] === username ? parts[1] : parts[0];
      if (peer) peers.add(peer);
    }
  }
  return [...peers].sort();
}
function openForward(m) {
  fwdMsg = m;
  $("fwdPreview").textContent = `${m.username}: ${(m.text || "").slice(0, 100)}`;
  const ul = $("fwdList");
  ul.innerHTML = "";
  for (const r of rooms) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="mini" style="background:linear-gradient(135deg,#7b8af4,#4a5fd1)">#</div><div class="t">${esc((r.locked ? "🔒 " : "") + r.name)}</div>`;
    li.onclick = () => doForward("room", r.id, r.name);
    ul.appendChild(li);
  }
  for (const p of dmPeers()) {
    const [c1, c2] = colorFor(p);
    const li = document.createElement("li");
    li.innerHTML = `<div class="mini" style="background:linear-gradient(135deg, ${c1}, ${c2})">${avatarInner(p)}</div><div class="t">${esc(p)}</div>`;
    li.onclick = () => doForward("dm", dmRoom(username, p), p);
    ul.appendChild(li);
  }
  $("fwdModal").classList.remove("hidden");
}
$("fwdClose").onclick = () => $("fwdModal").classList.add("hidden");

// ---------- опросы ----------
function renderPoll(m) {
  const opts = ((m.poll || {}).options) || [];
  const all = new Set();
  opts.forEach(o => (o.votes || []).forEach(u => all.add(u)));
  const total = all.size || 1;
  return `<div class="poll">` + opts.map((o, i) => {
    const v = (o.votes || []).length;
    const pct = Math.round((v / total) * 100);
    const mine = (o.votes || []).includes(username);
    return `<button class="poll-opt${mine ? " mine" : ""}" data-vote="${i}" title="${esc((o.votes || []).join(", ") || "пока никто")}">` +
      `<span class="poll-bar" style="width:${pct}%"></span>` +
      `<span class="poll-text">${esc(o.text)}</span>` +
      `<span class="poll-count">${v}</span></button>`;
  }).join("") + `</div><div class="poll-total">📊 Голосов: ${all.size} · повторный клик снимает голос</div>`;
}

async function vote(id, option) {
  if (wsOk && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "vote", id, option }));
  } else {
    try {
      const r = await fetch("/api/vote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, id, option }) });
      const d = await r.json();
      if (d.ok) onMsgUpdate(d.message);
    } catch {}
  }
}

$("pollBtn").onclick = () => {
  $("pollQuestion").value = "";
  document.querySelectorAll("#pollOptions .poll-opt").forEach(i => i.value = "");
  $("pollError").textContent = "";
  $("pollModal").classList.remove("hidden");
  $("pollQuestion").focus();
};
$("pollClose").onclick = () => $("pollModal").classList.add("hidden");
$("pollCreate").onclick = async () => {
  const question = $("pollQuestion").value.trim();
  const options = [...document.querySelectorAll("#pollOptions .poll-opt")].map(i => i.value.trim()).filter(Boolean);
  if (question.length < 2) { $("pollError").textContent = "Введите вопрос"; return; }
  if (options.length < 2) { $("pollError").textContent = "Нужно минимум 2 варианта"; return; }
  try {
    const r = await fetch("/api/polls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, room: current.id, question, options }) });
    const d = await r.json();
    if (d.ok) { $("pollModal").classList.add("hidden"); if (!wsOk) onIncoming(d.message, true); }
    else $("pollError").textContent = d.error || "Ошибка";
  } catch { $("pollError").textContent = "Нет связи"; }
};
async function doForward(type, roomId, title) {
  if (!fwdMsg) return;
  try {
    const r = await fetch("/api/forward", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, id: fwdMsg.id, room: roomId }) });
    const d = await r.json();
    if (d.ok) { $("fwdModal").classList.add("hidden"); openChat(type, roomId, title); }
    else showToast("⚠️ " + (d.error || "Не удалось переслать"));
  } catch { showToast("⚠️ Нет связи"); }
}

// ---------- тема ----------
function initTheme() {
  const light = localStorage.getItem("megachat_theme") === "light";
  document.body.classList.toggle("light", light);
  $("themeBtn").textContent = light ? "☀️" : "🌙";
}
$("themeBtn").onclick = (e) => {
  e.stopPropagation();
  const light = !document.body.classList.contains("light");
  document.body.classList.toggle("light", light);
  localStorage.setItem("megachat_theme", light ? "light" : "dark");
  $("themeBtn").textContent = light ? "☀️" : "🌙";
};
initTheme();

// PWA: кешируем статику для установки на телефон
if ("serviceWorker" in navigator && (location.protocol === "http:" || location.protocol === "https:")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

// ---------- рендер ----------
function renderMe() {
  $("myName").textContent = username + (amAdmin() ? " 👑" : "");
  $("myAvatar").innerHTML = avatarInner(username);
  const [c1, c2] = colorFor(username);
  if (!myProfile.emoji) $("myAvatar").style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  else $("myAvatar").style.background = "#2b5278";
}

function renderRooms() {
  const ul = $("roomList"); ul.innerHTML = "";
  const q = chatFilterQ.toLowerCase();
  for (const r of rooms) {
    if (q && !(r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q))) continue;
    const li = document.createElement("li");
    if (current.id === r.id) li.className = "active";
    li.innerHTML = `<div class="mini" style="background:linear-gradient(135deg,#7b8af4,#4a5fd1)">#</div>
      <div class="t">${esc((r.locked ? "🔒 " : "") + r.name)}<div class="sub">${esc(typingNote(r.id) || r.id)}</div></div>
      ${unread[r.id] ? `<span class="badge">${unread[r.id]}</span>` : ""}`;
    li.onclick = () => openChat("room", r.id, r.name);
    ul.appendChild(li);
  }
}

function renderDMs() {
  const ul = $("dmList"); ul.innerHTML = "";
  // кандидаты: все онлайн + те, с кем уже есть переписка
  const peers = dmPeers();
  if (!peers.length) { ul.innerHTML = `<li style="cursor:default;color:#7f91a4">кликните по человеку из «онлайн» ↓</li>`; return; }
  const q = chatFilterQ.toLowerCase();
  let shown = 0;
  for (const p of peers) {
    if (q && !p.toLowerCase().includes(q)) continue;
    shown++;
    const id = dmRoom(username, p);
    const [c1, c2] = colorFor(p);
    const li = document.createElement("li");
    if (current.id === id) li.className = "active";
    li.innerHTML = `<div class="mini" style="background:linear-gradient(135deg, ${c1}, ${c2})">${avatarInner(p)}</div>
      <div class="t">${esc(p)}<div class="sub">${esc(typingNote(id) || (onlineUsers.includes(p) ? "в сети" : "оффлайн"))}</div></div>
      ${unread[id] ? `<span class="badge">${unread[id]}</span>` : ""}`;
    li.onclick = () => openChat("dm", id, p);
    ul.appendChild(li);
  }
  if (q && !shown) ul.innerHTML = `<li style="cursor:default;color:#7f91a4">ничего не найдено</li>`;
}

function renderOnline() {
  const ul = $("onlineList"); ul.innerHTML = "";
  const others = onlineUsers.filter(u => u !== username);
  ul.innerHTML = `<li data-u="${esc(username)}"><div class="mini" style="background:#2b5278">${avatarInner(username)}</div><div class="t">${esc(username)}<div class="sub">это вы</div></div></li>`;
  for (const u of others.sort()) {
    const [c1, c2] = colorFor(u);
    const li = document.createElement("li");
    const mut = mutedMap[u] && mutedMap[u] * 1000 > Date.now();
    li.innerHTML = `<div class="mini" style="background:linear-gradient(135deg, ${c1}, ${c2})">${avatarInner(u)}</div>
      <div class="t">${esc(u)}${u !== username && adminsList.includes(u) ? " 👑" : ""}<div class="sub">${esc((profiles[u]||{}).bio || "нажмите — личка")}</div></div>
      ${amAdmin() && u !== username ? `<button class="mute-btn" title="${mut ? "Снять мут" : "Мут"}">${mut ? "▶" : "⏸"}</button>` : ""}`;
    li.onclick = () => openChat("dm", dmRoom(username, u), u);
    li.ondblclick = () => openProfile(u, false);
    li.title = "Клик — личка, двойной клик — профиль";
    const mb = li.querySelector(".mute-btn");
    if (mb) mb.onclick = (e) => { e.stopPropagation(); muteUser(u); };
    ul.appendChild(li);
  }
  if (!others.length) ul.innerHTML += `<li style="cursor:default;color:#7f91a4">пока никого нет</li>`;
  updateChatSub();
}

function addSys(text) {
  const div = document.createElement("div");
  div.className = "sys"; div.innerHTML = text;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function fullDate(ts) {
  try {
    const d = new Date((ts || 0) * 1000);
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + ", " + d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}
function dayKey(ts) {
  const d = new Date((ts || 0) * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts) {
  const d = new Date((ts || 0) * 1000);
  const today = new Date(), yest = new Date(Date.now() - 864e5);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return "Сегодня";
  if (same(d, yest)) return "Вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

// MD-START — markdown-lite (автономный блок, тестируется в node)
function mdEsc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function renderMarkdown(src, myName) {
  const PH_CODE = "\uE010", PH_MENTION = "\uE001";
  const codes = [];
  let s = String(src ?? "");
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    codes.push(`<div class="md-pre">${mdEsc(code.replace(/\n$/, ""))}</div>`);
    return PH_CODE + (codes.length - 1) + " ";
  });
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code class="md-code">${mdEsc(code)}</code>`);
    return PH_CODE + (codes.length - 1) + " ";
  });
  s = mdEsc(s);
  if (myName) s = s.split("@" + mdEsc(myName)).join(PH_MENTION);
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(>"'])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/(https?:\/\/[^\s<]+)/g, (u) => {
    const clean = u.replace(/[.,!?;:]+$/, "");
    return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${u.slice(clean.length)}`;
  });
  s = s.replace(new RegExp(PH_CODE + "(\\d+) ", "g"), (_, i) => codes[+i] ?? "");
  if (myName) s = s.split(PH_MENTION).join(`<b class="mention">@${mdEsc(myName)}</b>`);
  return s;
}
// MD-END

function buildMessageNode(m) {
  const own = m.username === username;
  const row = document.createElement("div");
  row.className = "msg-row" + (own ? " own" : "");
  row.dataset.mid = m.id;
  const div = document.createElement("div");
  div.className = "msg" + (own ? " own" : "");
  const [c1, c2] = colorFor(m.username);
  let html = `<div class="msg-actions"><button data-act="reply" title="Ответить">↩️</button><button data-act="react" title="Реакция">🙂</button><button data-act="copy" title="Скопировать текст">📋</button><button data-act="fwd" title="Переслать">⏩</button><button data-act="pin" title="Закрепить">📌</button>${own ? `<button data-act="edit" title="Редактировать">✏️</button>` : ""}${own || amAdmin() ? `<button data-act="del" title="Удалить">🗑</button>` : ""}</div>`;
  html += own ? "" : `<div class="author" style="color:${c1}">${esc(m.username)}</div>`;
  if (m.fwd) {
    html += `<div class="fwd-label">⏩ Переслано от <b>${esc(m.fwd.username)}</b></div>`;
  }
  if (m.reply) {
    html += `<div class="reply-quote" data-jump="${m.reply.id}"><b>${esc(m.reply.username)}</b><span>${esc(m.reply.text || "")}</span></div>`;
  }
  html += `<div class="text">${renderMarkdown(m.text, username)}</div>`;
  if (m.poll) html += renderPoll(m);
  if (m.file) {
    const f = m.file;
    if ((f.mime || "").startsWith("image/")) html += `<img class="attached" src="${esc(f.url)}" data-full="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" title="Нажмите, чтобы увеличить">`;
    else if ((f.mime || "").startsWith("audio/")) html += `<audio class="msg-audio" controls preload="none" src="${esc(f.url)}"></audio>`;
    html += `<a class="file-link" href="${esc(f.url)}" target="_blank">📎 ${esc(f.name)} · ${fmtSize(f.size || 0)}</a>`;
  }
  const reacts = m.reactions || {};
  const keys = Object.keys(reacts).filter(k => (reacts[k] || []).length);
  if (keys.length) {
    html += `<div class="reactions">` + keys.map(k => {
      const users = reacts[k] || [];
      const mine = users.includes(username);
      return `<button class="react-chip${mine ? " mine" : ""}" data-react="${esc(k)}" title="${esc(users.join(", "))}">${esc(k)} ${users.length}</button>`;
    }).join("") + `</div>`;
  }
  html += `<div class="msg-time" title="${esc(fullDate(m.ts))}">${esc(m.time || "")}${m.edited ? " · изм." : ""}${tickSuffix(m)}</div>`;
  div.innerHTML = html;
  div.querySelector('[data-act="reply"]').onclick = (e) => { e.stopPropagation(); startReply(m); };
  div.querySelector('[data-act="react"]').onclick = (e) => { e.stopPropagation(); openReactPicker(m, e.currentTarget); };
  div.querySelector('[data-act="copy"]').onclick = (e) => { e.stopPropagation(); copyText(m.text || ""); };
  div.querySelector('[data-act="fwd"]').onclick = (e) => { e.stopPropagation(); openForward(m); };
  div.querySelector('[data-act="pin"]').onclick = (e) => { e.stopPropagation(); togglePin(m.room, m.id); };
  const eb = div.querySelector('[data-act="edit"]');
  if (eb) eb.onclick = (e) => { e.stopPropagation(); startEdit(row, m); };
  const db = div.querySelector('[data-act="del"]');
  if (db) db.onclick = (e) => { e.stopPropagation(); deleteMsg(m); };
  div.querySelectorAll("[data-vote]").forEach(b => b.onclick = (e) => { e.stopPropagation(); vote(m.id, +b.dataset.vote); });
  div.querySelectorAll("[data-react]").forEach(b => b.onclick = () => toggleReact(m.id, b.dataset.react));
  const q = div.querySelector("[data-jump]");
  if (q) q.onclick = () => jumpToMessage(m.reply.id);
  const att = div.querySelector("img.attached");
  if (att) att.onclick = (e) => { e.stopPropagation(); openImage(att.dataset.full || att.src, att.alt); };
  if (!own) {
    const av = document.createElement("div");
    av.className = "row-avatar";
    av.innerHTML = avatarInner(m.username);
    av.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
    av.title = m.username;
    av.onclick = () => openChat("dm", dmRoom(username, m.username), m.username);
    row.appendChild(av);
  }
  row.appendChild(div);
  return row;
}

function isNearBottom() {
  return messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 120;
}

function addMessage(m) {
  const c = cache[current.id];
  const dk = dayKey(m.ts);
  if (c && c.lastDay !== dk) {
    c.lastDay = dk;
    const dv = document.createElement("div");
    dv.className = "day-divider";
    dv.innerHTML = `<span>${esc(dayLabel(m.ts))}</span>`;
    messagesDiv.appendChild(dv);
  }
  messagesDiv.appendChild(buildMessageNode(m));
  if (isNearBottom()) {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    bottomPending = 0;
  } else bottomPending++;
  renderToBottom();
}

function renderToBottom() {
  const b = $("toBottom");
  const dist = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight;
  if (dist > 300) {
    b.classList.remove("hidden");
    b.textContent = bottomPending > 0 ? `↓ ${bottomPending}` : "↓";
  } else {
    b.classList.add("hidden");
    bottomPending = 0;
  }
}
messagesDiv.addEventListener("scroll", renderToBottom);
$("toBottom").onclick = () => {
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  bottomPending = 0;
  renderToBottom();
};

async function copyText(t) {
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = t;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
  showToast("Текст скопирован 📋");
}

async function deleteMsg(m) {
  const adminDel = m.username !== username;
  if (!confirm(adminDel ? `Удалить ЧУЖОЕ сообщение (админ)?\n${m.username}: «${(m.text || "").slice(0, 80)}»` : `Удалить сообщение?\n\n«${(m.text || "").slice(0, 80)}»`)) return;
  try {
    const r = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, id: m.id }) });
    const d = await r.json();
    if (d.ok) { onMsgDelete(d.room, d.id); showToast("Сообщение удалено"); }
    else showToast("⚠️ " + (d.error || "Не удалось удалить"));
  } catch { showToast("⚠️ Нет связи с сервером"); }
}

// Тосты для короткой обратной связи
let toastTimer = null;
function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function jumpToMessage(id) {
  const node = messagesDiv.querySelector(`[data-mid="${id}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.style.outline = "2px solid #3390ec";
  setTimeout(() => node.style.outline = "", 1200);
}

// ---------- ответы ----------
function startReply(m) {
  replyTo = m;
  $("replyAuthor").textContent = m.username;
  $("replyText").textContent = (m.text || "").slice(0, 80);
  $("replyBar").classList.remove("hidden");
  $("textInput").focus();
}
function cancelReply() { replyTo = null; $("replyBar").classList.add("hidden"); }
$("replyCancel").onclick = cancelReply;

// ---------- редактирование своих сообщений ----------
function startEdit(node, m) {
  const textDiv = node.querySelector(".text");
  if (!textDiv || node.querySelector(".edit-input")) return;
  const orig = m.text || "";
  textDiv.innerHTML = "";
  const inp = document.createElement("input");
  inp.className = "edit-input";
  inp.value = orig;
  inp.maxLength = 2000;
  const hint = document.createElement("div");
  hint.className = "edit-hint";
  hint.textContent = "Enter — сохранить · Esc — отмена";
  textDiv.appendChild(inp);
  textDiv.appendChild(hint);
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  const done = () => { refreshMessageNode(m); };
  inp.onkeydown = async (e) => {
    if (e.key === "Enter") {
      const v = inp.value.trim();
      if (!v || v === orig) { done(); return; }
      inp.disabled = true;
      try {
        const r = await fetch("/api/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, id: m.id, text: v }) });
        const d = await r.json();
        if (d.ok) onMsgUpdate(d.message);
        else { addSys("⚠️ " + esc(d.error || "Не удалось сохранить")); done(); }
      } catch { addSys("⚠️ Нет связи с сервером"); done(); }
    } else if (e.key === "Escape") done();
  };
}

// ---------- реакции ----------
async function toggleReact(id, emoji) {
  closeReactPicker();
  if (wsOk && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "react", id, emoji }));
  } else {
    try {
      const r = await fetch("/api/react", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, id, emoji }) });
      const d = await r.json();
      if (d.ok) onMsgUpdate(d.message);
    } catch {}
  }
}

function openReactPicker(m, anchor) {
  closeReactPicker();
  const box = $("reactPicker");
  box.innerHTML = "";
  for (const e of QUICK_REACT) {
    const b = document.createElement("button");
    b.textContent = e;
    b.onclick = () => toggleReact(m.id, e);
    box.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  box.style.left = Math.max(8, Math.min(innerWidth - 300, r.left - 120)) + "px";
  box.style.top = Math.max(8, r.top - 52) + "px";
  box.classList.remove("hidden");
  setTimeout(() => document.addEventListener("click", closeReactPicker, { once: true }), 0);
}
function closeReactPicker() { $("reactPicker").classList.add("hidden"); }

// ---------- эмодзи-панель ----------
let emojiBuilt = false;
$("emojiBtn").onclick = () => {
  const p = $("emojiPanel");
  if (!emojiBuilt) {
    for (const e of EMOJI_GRID) {
      const b = document.createElement("button");
      b.textContent = e;
      b.onclick = () => insertEmoji(e);
      p.appendChild(b);
    }
    emojiBuilt = true;
  }
  p.classList.toggle("hidden");
};
function insertEmoji(e) {
  const inp = $("textInput");
  const s = inp.selectionStart ?? inp.value.length, en = inp.selectionEnd ?? s;
  inp.value = inp.value.slice(0, s) + e + inp.value.slice(en);
  inp.focus();
  inp.selectionStart = inp.selectionEnd = s + e.length;
  autogrow();
}

// ---------- отправка ----------
function autogrow() {
  const inp = $("textInput");
  inp.style.height = "auto";
  inp.style.height = Math.min(inp.scrollHeight, 130) + "px";
}
$("textInput").addEventListener("input", () => {
  autogrow();
  if ($("textInput").value.trim()) sendTyping();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
});
$("textInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("sendForm").requestSubmit(); }
});
$("sendForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("textInput").value.trim();
  if (!text) return;
  const rid = replyTo ? replyTo.id : null;
  $("textInput").value = "";
  autogrow();
  delete drafts[current.id];
  persistDrafts();
  cancelReply();
  $("emojiPanel").classList.add("hidden");
  if (wsOk && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ t: "send", room: current.id, text, reply_to: rid }));
  } else {
    try {
      const r = await fetch("/api/messages", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({username, room: current.id, text, reply_to: rid}) });
      const d = await r.json();
      if (d.ok) onIncoming(d.message, true);
      else if (d.error) showToast("⚠️ " + d.error);
    } catch { addSys("⚠️ Нет связи с сервером"); }
  }
};

// файлы: base64 -> POST /api/upload (сообщение создаётся на сервере и приходит по WS)
$("fileInput").onchange = async () => {
  const f = $("fileInput").files[0];
  $("fileInput").value = "";
  if (!f) return;
  await uploadBlob(f, f.name, f.type || "");
};

// drag'n'drop файлов в чат (кидаем на область сообщений)
let dragDepth = 0;
const dropZone = $("messages");
function dropActive() { return dropZone.classList.contains("drag-over"); }
window.addEventListener("dragenter", (e) => {
  if (!username || !current || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  dropZone.classList.add("drag-over");
});
window.addEventListener("dragover", (e) => { if (dropActive()) e.preventDefault(); });
window.addEventListener("dragleave", (e) => {
  if (!dropActive()) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropZone.classList.remove("drag-over");
});
window.addEventListener("drop", async (e) => {
  if (!dropActive()) return;
  e.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove("drag-over");
  if (!username || !current) return;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    await uploadBlob(f, f.name, f.type || "", files.length > 1 ? `${i + 1}/${files.length}` : "");
  }
});

async function uploadBlob(blob, filename, mime, counter) {
  if (blob.size > 15 * 1024 * 1024) { addSys("⚠️ Файл больше 15 МБ"); return; }
  const bar = $("uploadStatus");
  bar.classList.remove("hidden");
  bar.classList.add("uploading");
  bar.innerHTML = "";
  bar.appendChild(document.createTextNode(`Отправка${counter ? " " + counter : ""} · `));
  const nm = document.createElement("span");
  nm.className = "up-name";
  nm.textContent = filename;
  bar.appendChild(nm);
  try {
    const buf = await blob.arrayBuffer();
    const r = await fetch("/api/upload", { method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({username, room: current.id, filename, mime, data: b64encode(buf), reply_to: replyTo ? replyTo.id : null}) });
    const d = await r.json();
    if (d.ok) { cancelReply(); if (!wsOk) onIncoming(d.message, true); }
    else addSys("⚠️ " + esc(d.error || "Ошибка загрузки"));
  } catch { addSys("⚠️ Нет связи с сервером"); }
  bar.classList.add("hidden");
  bar.classList.remove("uploading");
}

function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}

// ---------- голосовые сообщения ----------
let recorder = null, recChunks = [], recStart = 0, recTimer = null, recMime = "";
const MAX_VOICE_MS = 5 * 60 * 1000; // 5 минут
function fmtDur(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

$("micBtn").onclick = () => { if (recorder) stopVoice(true); else startVoice(); };

async function startVoice() {
  if (!window.MediaRecorder || !navigator.mediaDevices) { addSys("⚠️ Этот браузер не умеет записывать аудио"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    addSys("⚠️ Нет доступа к микрофону. Учтите: браузеры разрешают микрофон только через localhost или HTTPS — с телефона по http://IP запись может блокироваться.");
    return;
  }
  recMime = ["audio/webm", "audio/mp4", "audio/ogg"].find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || "";
  recChunks = [];
  try {
    recorder = recMime ? new MediaRecorder(stream, { mimeType: recMime }) : new MediaRecorder(stream);
  } catch {
    addSys("⚠️ Не удалось начать запись"); stream.getTracks().forEach(t => t.stop()); recorder = null; return;
  }
  recMime = recorder.mimeType || recMime;
  recorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(recChunks, { type: recMime || "audio/webm" });
    const dur = Date.now() - recStart;
    const mustSend = recorder && recorder._send;
    recorder = null;
    $("micBtn").classList.remove("recording");
    $("micBtn").textContent = "🎤";
    $("uploadStatus").classList.add("hidden");
    if (mustSend && blob.size > 0) sendVoice(blob, dur);
  };
  recorder.start();
  recStart = Date.now();
  $("micBtn").classList.add("recording");
  $("micBtn").textContent = "⏹";
  const bar = $("uploadStatus");
  bar.classList.remove("hidden");
  bar.innerHTML = "";
  const span = document.createElement("span");
  span.id = "recTimer";
  const cancel = document.createElement("button");
  cancel.textContent = "Отмена";
  cancel.onclick = () => stopVoice(false);
  bar.appendChild(document.createTextNode("🔴 Запись "));
  bar.appendChild(span);
  bar.appendChild(document.createTextNode(" · нажмите ⏹ чтобы отправить · "));
  bar.appendChild(cancel);
  clearInterval(recTimer);
  recTimer = setInterval(() => {
    const el = $("recTimer");
    if (el) el.textContent = fmtDur(Date.now() - recStart);
    if (Date.now() - recStart > MAX_VOICE_MS) stopVoice(true);
  }, 500);
}

function stopVoice(send) {
  clearInterval(recTimer);
  if (recorder && recorder.state !== "inactive") {
    recorder._send = send;
    recorder.stop();
  } else recorder = null;
}

async function sendVoice(blob, dur) {
  const ext = (recMime.includes("mp4")) ? "m4a" : (recMime.includes("ogg") ? "ogg" : "webm");
  const label = `🎤 Голосовое · ${fmtDur(dur)}`;
  // кладём подпись в текст, чтобы было видно и в поиске/цитатах
  const prevReply = replyTo;
  try {
    const buf = await blob.arrayBuffer();
    $("uploadStatus").classList.remove("hidden");
    $("uploadStatus").textContent = "Отправка голосового...";
    const r = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, room: current.id, filename: `voice_${Date.now()}.${ext}`, mime: recMime || "audio/webm", data: b64encode(buf), text: label, reply_to: prevReply ? prevReply.id : null }) });
    const d = await r.json();
    if (d.ok) { cancelReply(); if (!wsOk) onIncoming(d.message, true); }
    else addSys("⚠️ " + esc(d.error || "Ошибка загрузки"));
  } catch { addSys("⚠️ Нет связи с сервером"); }
  $("uploadStatus").classList.add("hidden");
}

// ---------- комнаты ----------
$("addRoomBtn").onclick = async () => {
  const name = prompt("Название новой комнаты:");
  if (!name || name.trim().length < 2) return;
  const password = prompt("Пароль комнаты (пусто — открытая):") || "";
  try {
    const r = await fetch("/api/rooms", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({username, name: name.trim(), password: password.trim()}) });
    const d = await r.json();
    if (d.ok) {
      rooms = [...rooms.filter(x => x.id !== d.room.id), d.room];
      if (d.room.locked) { unlockedRooms[d.room.id] = true; persistUnlocked(); }
      renderRooms(); openChat("room", d.room.id, d.room.name);
    }
    else alert(d.error || "Ошибка");
  } catch { alert("Нет связи"); }
};

// ---------- профиль ----------
let profileViewUser = null;
function openProfile(user, editable) {
  profileViewUser = user;
  $("profileTitle").textContent = editable ? "Мой профиль" : "Профиль: " + user;
  $("profileName").textContent = user;
  const p = user === username ? myProfile : (profiles[user] || {bio:"", emoji:""});
  $("emojiInput").value = p.emoji || "";
  $("bioInput").value = p.bio || "";
  $("emojiInput").disabled = !editable;
  $("bioInput").disabled = !editable;
  $("profileSave").style.display = editable ? "" : "none";
  $("avatarBtns").style.display = editable ? "" : "none";
  $("profileAvatarPrev").innerHTML = avatarInner(user);
  $("avatarStatus").textContent = "";
  $("profileError").textContent = "";
  $("profileModal").classList.remove("hidden");
}
$("profileBtn").onclick = (e) => { e.stopPropagation(); openProfile(username, true); };
$("myHeader").onclick = (e) => { if (e.target.closest("button")) return; openProfile(username, true); };
$("profileClose").onclick = () => $("profileModal").classList.add("hidden");
$("profileSave").onclick = async () => {
  try {
    const r = await fetch("/api/profile", { method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({username, emoji: $("emojiInput").value.trim(), bio: $("bioInput").value.trim()}) });
    const d = await r.json();
    if (d.ok) { myProfile = d.profile; profiles[username] = d.profile; renderMe(); renderRooms(); renderDMs(); renderOnline(); $("profileModal").classList.add("hidden"); }
    else $("profileError").textContent = d.error || "Ошибка";
  } catch { $("profileError").textContent = "Нет связи"; }
};

// ---------- фото-аватар ----------
function refreshAvatarUI() {
  renderMe(); renderRooms(); renderDMs(); renderOnline();
  if (current.type === "dm" && current.title === username) $("chatAvatar").innerHTML = avatarInner(username);
  if (profileViewUser === username) $("profileAvatarPrev").innerHTML = avatarInner(username);
}
$("avatarInput").onchange = async () => {
  const f = $("avatarInput").files[0];
  $("avatarInput").value = "";
  if (!f) return;
  if (!f.type.startsWith("image/")) { $("avatarStatus").textContent = "Нужна картинка"; return; }
  if (f.size > 2 * 1024 * 1024) { $("avatarStatus").textContent = "Аватар до 2 МБ"; return; }
  $("avatarStatus").textContent = "Загрузка...";
  try {
    const buf = await f.arrayBuffer();
    const r = await fetch("/api/avatar", { method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({username, filename: f.name, mime: f.type, data: b64encode(buf)}) });
    const d = await r.json();
    if (d.ok) {
      myProfile = d.profile; profiles[username] = d.profile;
      $("avatarStatus").textContent = "";
      refreshAvatarUI();
    } else $("avatarStatus").textContent = d.error || "Ошибка";
  } catch { $("avatarStatus").textContent = "Нет связи"; }
};
$("avatarRemove").onclick = async () => {
  $("avatarStatus").textContent = "Убираем...";
  try {
    const r = await fetch("/api/avatar", { method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({username, data: ""}) });
    const d = await r.json();
    if (d.ok) {
      myProfile = d.profile; profiles[username] = d.profile;
      $("avatarStatus").textContent = "";
      refreshAvatarUI();
    } else $("avatarStatus").textContent = d.error || "Ошибка";
  } catch { $("avatarStatus").textContent = "Нет связи"; }
};

// ---------- поиск ----------
$("chatFilter").oninput = () => {
  chatFilterQ = $("chatFilter").value.trim();
  renderRooms(); renderDMs();
};
$("searchBtn").onclick = () => {
  const bar = $("searchBar");
  bar.classList.toggle("hidden");
  if (bar.classList.contains("hidden")) { $("searchResults").classList.add("hidden"); return; }
  $("searchInput").value = "";
  $("searchInput").focus();
};
$("searchClose").onclick = () => { $("searchBar").classList.add("hidden"); $("searchResults").classList.add("hidden"); };

// ---------- медиа чата: фото/файлы/аудио/ссылки из кэша (сервер не дёргаем) ----------
let mediaFilter = "all";
$("mediaBtn").onclick = () => {
  const p = $("mediaPanel");
  p.classList.toggle("hidden");
  if (!p.classList.contains("hidden")) renderMedia();
};
$("mediaFilter").querySelectorAll("[data-mf]").forEach(b => b.onclick = () => {
  mediaFilter = b.dataset.mf;
  $("mediaFilter").querySelectorAll("[data-mf]").forEach(x => x.classList.toggle("on", x === b));
  renderMedia();
});
$("mediaFilter").querySelector("[data-mf-x]").onclick = () => $("mediaPanel").classList.add("hidden");
function mediaKind(m) {
  const mime = (m.file && m.file.mime) || "";
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("audio/")) return "audio";
  if (m.file) return "file";
  if (/https?:\/\/\S+/.test(m.text || "")) return "links";
  return "";
}
function renderMedia() {
  const box = $("mediaList"); box.innerHTML = "";
  const c = cache[current.id];
  const items = ((c && c.msgs) || []).filter(m => {
    const k = mediaKind(m);
    return mediaFilter === "all" ? !!k : k === mediaFilter;
  }).slice(-100).reverse();
  if (!items.length) { box.innerHTML = `<div class="search-empty">Пока пусто</div>`; return; }
  for (const m of items) {
    const div = document.createElement("div");
    div.className = "media-hit";
    const k = mediaKind(m);
    let inner = "";
    if (k === "photo") inner = `<img src="${esc(m.file.url)}" alt="" loading="lazy"><span>${esc(m.file.name)}</span>`;
    else if (k === "audio") inner = `<span>🎤 ${esc(m.text || m.file.name)}</span>`;
    else if (k === "file") inner = `<span>📎 ${esc(m.file.name)} · ${fmtSize(m.file.size || 0)}</span>`;
    else inner = `<span>🔗 ${esc((m.text || "").match(/https?:\/\/\S+/)[0].slice(0, 80))}</span>`;
    div.innerHTML = `${inner}<span class="sh-meta">${esc(m.username)} · ${esc(m.time || "")}</span>`;
    div.onclick = () => { $("mediaPanel").classList.add("hidden"); jumpToMessage(m.id); };
    box.appendChild(div);
  }
}
$("searchInput").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
};
$("searchInput").onkeydown = (e) => { if (e.key === "Escape") $("searchClose").onclick(); };

function roomLabel(id) {
  if (id.startsWith("dm:")) {
    const parts = id.slice(3).split("|");
    const peer = parts[0] === username ? parts[1] : parts[0];
    return "Личка · " + (peer || id);
  }
  return (rooms.find(r => r.id === id) || {}).name || id;
}

async function runSearch() {
  const q = $("searchInput").value.trim();
  const box = $("searchResults");
  if (q.length < 2) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}&username=${encodeURIComponent(username)}`);
    const d = await r.json();
    const res = (d.results || []).slice().reverse(); // сначала новые
    if (!res.length) { box.innerHTML = `<div class="search-empty">Ничего не найдено</div>`; }
    else {
      const nq = esc(q);
      box.innerHTML = "";
      for (const m of res) {
        const div = document.createElement("div");
        div.className = "search-hit";
        const snippet = esc((m.text || "").slice(0, 120)).split(nq).join(`<mark>${nq}</mark>`);
        div.innerHTML = `<div class="sh-meta">${esc(roomLabel(m.room))} · <b>${esc(m.username)}</b> · ${esc(m.time || "")}</div><div>${snippet}</div>`;
        div.onclick = () => openChatForMessage(m.room, m.id);
        box.appendChild(div);
      }
    }
    box.classList.remove("hidden");
  } catch {}
}

// Открыть чат с сообщением (переключиться при нужде, догрузить, прыгнуть)
async function openChatForMessage(roomId, msgId) {
  $("searchResults").classList.add("hidden");
  let title = roomLabel(roomId);
  if (roomId.startsWith("dm:")) {
    const parts = roomId.slice(3).split("|");
    title = parts[0] === username ? parts[1] : parts[0];
    openChat("dm", roomId, title);
  } else {
    const r = rooms.find(x => x.id === roomId);
    openChat("room", roomId, r ? r.name : roomId);
  }
  try {
    const h = await (await fetch(`/api/messages?room=${encodeURIComponent(roomId)}&since=0&username=${encodeURIComponent(username)}`)).json();
    mergeMessages(h.messages || [], true);
  } catch {}
  jumpToMessage(msgId);
}

// Esc закрывает верхнее: пикер реакций, эмодзи, поиск, модалки
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("reactPicker").classList.contains("hidden")) { closeReactPicker(); return; }
  if (!$("emojiPanel").classList.contains("hidden")) { $("emojiPanel").classList.add("hidden"); return; }
  if (!$("mediaPanel").classList.contains("hidden")) { $("mediaPanel").classList.add("hidden"); return; }
  if (!$("searchBar").classList.contains("hidden")) { $("searchClose").onclick(); return; }
  for (const id of ["fwdModal", "profileModal", "roomModal", "imgModal"]) {
    if (!$(id).classList.contains("hidden")) { $(id).classList.add("hidden"); return; }
  }
  if (!$("replyBar").classList.contains("hidden")) cancelReply();
});
// клик по фону модалки тоже закрывает
for (const id of ["fwdModal", "profileModal", "roomModal", "imgModal"]) {
  $(id).addEventListener("click", (e) => { if (e.target.id === id) $(id).classList.add("hidden"); });
}

// Инфо о комнате/чате по клику на шапку
document.querySelector(".chat-header").addEventListener("click", (e) => {
  if (e.target.closest("button")) return;
  openRoomInfo();
});
function openRoomInfo() {
  $("roomInfoTitle").textContent = current.title;
  const box = $("roomInfoBody");
  if (current.type === "dm") {
    const p = profiles[current.title] || {};
    const on = onlineUsers.includes(current.title);
    box.innerHTML = `Ник: <b>${esc(current.title)}</b><br>Статус: ${on ? "🟢 в сети" : "⚪ не в сети"}<br>О себе: ${esc(p.bio || "—")}<br><br><i>Клик по аватару человека тоже открывает личку 🙂</i>`;
  } else {
    const r = rooms.find(x => x.id === current.id) || {};
    const pin = pinnedRooms[current.id];
    box.innerHTML = `Комната: <b>${esc(current.title)}</b><br>ID: <code>${esc(current.id)}</code><br>Создал: ${esc(r.creator || "—")}<br>Онлайн всего: ${onlineUsers.length}<br>${pin ? `Закреп: «${esc((pin.text || "").slice(0, 60))}»` : "Закрепов нет"}`;
  }
  $("roomModal").classList.remove("hidden");
}
$("roomInfoClose").onclick = () => $("roomModal").classList.add("hidden");

// ---------- просмотр картинок в модалке ----------
function openImage(url, name) {
  const pic = $("imgModalPic");
  pic.src = url;
  pic.alt = name || "Картинка";
  $("imgModalLink").href = url;
  $("imgModal").classList.remove("hidden");
}
function closeImage() {
  $("imgModalPic").removeAttribute("src");
  $("imgModal").classList.add("hidden");
}
$("imgModalClose").onclick = closeImage;
