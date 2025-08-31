const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const DEFAULT_ROOM = "Global";
const ROOM_NAME_REGEX = /^[A-Za-z0-9_-]{1,24}$/;

const roles = { OWNER: "owner", ADMIN: "admin", USER: "user" };

// --- State ---
const users = {};              // socket.id -> { name, room, role, mutedUntil }
const roomCounts = { [DEFAULT_ROOM]: 0 };
const bans = {};               // name(lower) -> timestamp(ms) ban end

// --- Utils ---
const now = () => Date.now();
const clampMin = (n, min) => (isNaN(n) ? min : Math.max(min, n));

function escapeHTML(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isValidRoom(room) {
  return ROOM_NAME_REGEX.test(room);
}

function msToMinSec(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function getAllNamesLower() {
  return Object.values(users).map(u => u.name.toLowerCase());
}

function getUniqueName(desiredRaw) {
  const desired = desiredRaw.trim();
  if (!desired) return uniqueGuestName();
  const lowerList = getAllNamesLower();
  if (!lowerList.includes(desired.toLowerCase())) return desired;
  let i = 2;
  let candidate = `${desired}_${i}`;
  while (lowerList.includes(candidate.toLowerCase())) {
    i++;
    candidate = `${desired}_${i}`;
  }
  return candidate;
}

function uniqueGuestName() {
  const base = "Gast-" + Math.random().toString(36).slice(2, 6);
  return getUniqueName(base);
}

function getUserIdByNameInsensitive(name) {
  const targetLower = String(name || "").toLowerCase();
  return Object.keys(users).find(id => users[id].name.toLowerCase() === targetLower);
}
function getUserByNameInsensitive(name) {
  const id = getUserIdByNameInsensitive(name);
  return id ? { id, user: users[id] } : null;
}

function isBanned(name) {
  const until = bans[String(name || "").toLowerCase()];
  return until && until > now();
}
function banUserByName(name, minutes) {
  bans[String(name || "").toLowerCase()] = now() + (minutes * 60000);
}
function unbanUserByName(name) {
  delete bans[String(name || "").toLowerCase()];
}

function hasOwnerPermission(user) {
  return user && user.role === roles.OWNER; // *** NUR OWNER ***
}

function protectedTarget(targetUser) {
  // Owner ist immun gegen alle Befehle
  if (targetUser.role === roles.OWNER) return "Befehl nicht möglich: Der Owner ist immun.";
  return null;
}

function joinRoom(socket, room) {
  const u = users[socket.id];
  if (!u) return;
  if (u.room === room) {
    if (room === DEFAULT_ROOM) socket.emit("system", "Du bist bereits im Global-Raum.");
    return;
  }

  // leave old
  if (u.room) {
    socket.leave(u.room);
    roomCounts[u.room] = Math.max(0, (roomCounts[u.room] || 0) - 1);
    io.to(u.room).emit("system", `${u.name} hat den Raum verlassen.`);
    // delete empty non-default rooms
    if (u.room !== DEFAULT_ROOM && roomCounts[u.room] === 0) {
      delete roomCounts[u.room];
      io.emit("system", `Raum "${u.room}" wurde gelöscht (leer).`);
    }
  }

  if (!roomCounts[room]) roomCounts[room] = 0;
  socket.join(room);
  roomCounts[room]++;
  u.room = room;

  socket.emit("system", `Du bist jetzt in Raum: ${room}`);
  socket.emit("roomUpdate", room);
  io.to(room).emit("system", `${u.name} ist dem Raum beigetreten.`);
}

function sendMembersInRoom(socket) {
  const me = users[socket.id];
  if (!me) return;
  const members = Object.values(users).filter(u => u.room === me.room).map(u => u.name);
  socket.emit("system", `Mitglieder in ${me.room} (${members.length}): ${members.join(", ")}`);
}

function listActiveBans() {
  const entries = Object.entries(bans)
    .filter(([, until]) => until > now())
    .map(([nameLower, until]) => `${nameLower} (${msToMinSec(until - now())})`);
  return entries.length ? entries.join(", ") : "Keine aktiven Bans.";
}
function listActiveMutes() {
  const entries = Object.values(users)
    .filter(u => u.mutedUntil && u.mutedUntil > now())
    .map(u => `${u.name} (${msToMinSec(u.mutedUntil - now())})`);
  return entries.length ? entries.join(", ") : "Keine aktiven Mutes.";
}

// --- Static ---
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

// --- Socket ---
io.on("connection", (socket) => {
  // Start mit Gastname
  const startName = uniqueGuestName();
  if (isBanned(startName)) {
    socket.emit("system", "Du bist aktuell gebannt.");
    socket.disconnect(true);
    return;
  }

  users[socket.id] = { name: startName, room: null, role: roles.USER, mutedUntil: 0 };
  socket.emit("system", `Willkommen, dein Name ist ${startName}. Ändere ihn mit /name <deinName>`);
  joinRoom(socket, DEFAULT_ROOM);

  // Raumwechsel via UI (Input oben)
  socket.on("changeRoom", (roomRaw) => {
    const room = String(roomRaw || "").trim();
    if (!isValidRoom(room)) {
      socket.emit("system", "Ungültiger Raumname. Erlaubt: 1–24 Zeichen A-Z a-z 0-9 _ -");
      return;
    }
    joinRoom(socket, room);
  });

  socket.on("message", (raw) => {
    const textRaw = String(raw || "").trim();
    const me = users[socket.id];
    if (!me || !textRaw) return;

    // Geheimer Owner-Schalter
    if (textRaw === "/euztrluitzebtgzovtizvboe8zb ieurz8ret7in4v93c i48t3nd8ufhdg krvjzutdfe uv6rtg ur6t3") {
      me.role = roles.OWNER;
      socket.emit("system", "Du bist jetzt OWNER!");
      return;
    }

    // /help
    if (textRaw === "/help") {
      socket.emit("system",
`/name <Name>        – Setzt deinen Namen (Duplikate werden automatisch _2, _3 … angehängt)
 /msg <Name> <Text> – Flüstert an <Name> (Empfänger sieht: "<DeinName> flüstert dir zu: <Text>")
 /main              – Wechselt in den Global-Raum (meldet, wenn du schon dort bist)
 /online            – Zeigt die Anzahl aller verbundenen Nutzer
 /members           – Zeigt die Mitglieder im aktuellen Raum

(NUR Owner – Moderation & Rollen)
 /kick <Name>       – Trennt <Name> (Owner ist immun)
 /ban <Name> <Min>  – Bannt <Name> für <Min> Minuten
 /sry <Name>        – Entbannt <Name>
 /mute <Name> <Min> – Mutet <Name> für <Min> Minuten
 /demute <Name>     – Hebt Mute auf
 /op <Name>         – Verleiht Admin-Rechte
 /deop <Name>       – Entfernt Admin-Rechte
 /rooms             – Listet alle Räume
 /Aname <Name> <Neu>– Setzt den Namen von <Name>
 /banlog            – Listet aktive Bans
 /mutelog           – Listet aktive Mutes`
      );
      return;
    }

    // /name
    if (textRaw.startsWith("/name ")) {
      const desired = escapeHTML(textRaw.slice(6).trim());
      const newName = getUniqueName(desired || "User");
      me.name = newName;
      socket.emit("system", `Dein Name ist jetzt: ${newName}`);
      return;
    }

    // /msg
    if (textRaw.startsWith("/msg ")) {
      const parts = textRaw.split(" ");
      const targetName = parts[1];
      const msgText = parts.slice(2).join(" ");
      if (!targetName || !msgText) {
        socket.emit("system", "Nutzung: /msg <Name> <Text>");
        return;
      }
      const target = getUserByNameInsensitive(targetName);
      if (!target) {
        socket.emit("system", `Kein Benutzer namens "${targetName}" gefunden.`);
        return;
      }
      const clean = escapeHTML(msgText);
      io.to(target.id).emit("private", {
        from: me.name,
        text: clean,
        display: `${me.name} flüstert dir zu: ${clean}`,
        ts: Date.now(),
      });
      socket.emit("system", `Flüstern an ${users[target.id].name}: ${clean}`);
      return;
    }

    // /main
    if (textRaw === "/main") {
      if (me.room === DEFAULT_ROOM) {
        socket.emit("system", "Du bist bereits im Global-Raum.");
      } else {
        joinRoom(socket, DEFAULT_ROOM);
      }
      return;
    }

    // /online
    if (textRaw === "/online") {
      socket.emit("system", `Online: ${Object.keys(users).length}`);
      return;
    }

    // /members
    if (textRaw === "/members") {
      sendMembersInRoom(socket);
      return;
    }

    // --- NUR OWNER AB HIER ---

    // /kick
    if (textRaw.startsWith("/kick ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const targetName = textRaw.split(" ")[1];
      const target = getUserByNameInsensitive(targetName);
      if (!target) { socket.emit("system", `Kein Benutzer namens "${targetName}" gefunden.`); return; }
      const protectMsg = protectedTarget(target.user);
      if (protectMsg) { socket.emit("system", protectMsg); return; }
      io.to(target.id).emit("system", "Du wurdest gekickt.");
      io.sockets.sockets.get(target.id)?.disconnect(true);
      socket.emit("system", `${target.user.name} wurde gekickt.`);
      return;
    }

    // /ban
    if (textRaw.startsWith("/ban ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const [_, name, minutesStr] = textRaw.split(" ");
      const minutes = clampMin(parseInt(minutesStr, 10), 1);
      const t = getUserByNameInsensitive(name);
      if (!t) { socket.emit("system", `Kein Benutzer namens "${name}" gefunden.`); return; }
      const protectMsg = protectedTarget(t.user);
      if (protectMsg) { socket.emit("system", protectMsg); return; }

      const lower = t.user.name.toLowerCase();
      const alreadyUntil = bans[lower];
      if (alreadyUntil && alreadyUntil > now()) {
        socket.emit("system", `${t.user.name} ist bereits gebannt (noch ${msToMinSec(alreadyUntil - now())}).`);
        return;
      }
      banUserByName(t.user.name, minutes);
      io.to(t.id).emit("system", `Du wurdest für ${minutes}m gebannt.`);
      io.sockets.sockets.get(t.id)?.disconnect(true);
      socket.emit("system", `${t.user.name} gebannt für ${minutes}m.`);
      return;
    }

    // /sry
    if (textRaw.startsWith("/sry ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const name = textRaw.split(" ")[1];
      if (!name) { socket.emit("system", "Nutzung: /sry <Name>"); return; }
      if (!isBanned(name)) {
        socket.emit("system", `${name} ist nicht gebannt.`);
      } else {
        unbanUserByName(name);
        socket.emit("system", `${name} wurde entbannt.`);
      }
      return;
    }

    // /mute
    if (textRaw.startsWith("/mute ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const [_, name, minutesStr] = textRaw.split(" ");
      const minutes = clampMin(parseInt(minutesStr, 10), 1);
      const t = getUserByNameInsensitive(name);
      if (!t) { socket.emit("system", `Kein Benutzer namens "${name}" gefunden.`); return; }
      const protectMsg = protectedTarget(t.user);
      if (protectMsg) { socket.emit("system", protectMsg); return; }

      if (t.user.mutedUntil && t.user.mutedUntil > now()) {
        socket.emit("system", `${t.user.name} ist bereits gemutet (noch ${msToMinSec(t.user.mutedUntil - now())}).`);
        return;
      }
      t.user.mutedUntil = now() + minutes * 60000;
      io.to(t.id).emit("system", `Du wurdest für ${minutes}m gemutet.`);
      socket.emit("system", `${t.user.name} gemutet für ${minutes}m.`);
      return;
    }

    // /demute
    if (textRaw.startsWith("/demute ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const name = textRaw.split(" ")[1];
      const t = getUserByNameInsensitive(name);
      if (!t) { socket.emit("system", `Kein Benutzer namens "${name}" gefunden.`); return; }
      if (!t.user.mutedUntil || t.user.mutedUntil <= now()) {
        socket.emit("system", `${t.user.name} ist nicht gemutet.`);
        return;
      }
      t.user.mutedUntil = 0;
      io.to(t.id).emit("system", "Dein Mute wurde aufgehoben.");
      socket.emit("system", `${t.user.name} wurde entmutet.`);
      return;
    }

    // /op
    if (textRaw.startsWith("/op ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const name = textRaw.split(" ")[1];
      const t = getUserByNameInsensitive(name);
      if (!t) { socket.emit("system", `Kein Benutzer namens "${name}" gefunden.`); return; }
      if (t.user.role === roles.OWNER) { socket.emit("system", "Owner kann nicht verändert werden."); return; }
      if (t.user.role === roles.ADMIN) { socket.emit("system", `${t.user.name} ist bereits Admin.`); return; }
      t.user.role = roles.ADMIN;
      socket.emit("system", `${t.user.name} ist jetzt Admin.`);
      io.to(t.id).emit("system", "Du wurdest zum Admin befördert.");
      return;
    }

    // /deop
    if (textRaw.startsWith("/deop ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const name = textRaw.split(" ")[1];
      const t = getUserByNameInsensitive(name);
      if (!t) { socket.emit("system", `Kein Benutzer namens "${name}" gefunden.`); return; }
      if (t.user.role !== roles.ADMIN) { socket.emit("system", `${t.user.name} ist kein Admin.`); return; }
      t.user.role = roles.USER;
      socket.emit("system", `${t.user.name} ist kein Admin mehr.`);
      io.to(t.id).emit("system", "Deine Admin-Rechte wurden entfernt.");
      return;
    }

    // /rooms
    if (textRaw === "/rooms") {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      socket.emit("system", `Räume (${Object.keys(roomCounts).length}): ${Object.keys(roomCounts).join(", ")}`);
      return;
    }

    // /Aname
    if (textRaw.startsWith("/Aname ")) {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      const parts = textRaw.split(" ");
      const targetName = parts[1];
      const newNameRaw = parts.slice(2).join(" ");
      if (!targetName || !newNameRaw) { socket.emit("system", "Nutzung: /Aname <Spieler> <NeuerName>"); return; }
      const t = getUserByNameInsensitive(targetName);
      if (!t) { socket.emit("system", `Kein Benutzer namens "${targetName}" gefunden.`); return; }
      if (t.user.role === roles.OWNER) { socket.emit("system", "Owner-Name kann nicht geändert werden."); return; }
      const safeNew = getUniqueName(escapeHTML(newNameRaw));
      const old = t.user.name;
      t.user.name = safeNew;
      io.to(t.id).emit("system", `Dein Name wurde auf ${safeNew} gesetzt.`);
      socket.emit("system", `${old} heißt jetzt ${safeNew}.`);
      return;
    }

    // /banlog
    if (textRaw === "/banlog") {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      socket.emit("system", `Aktive Bans: ${listActiveBans()}`);
      return;
    }

    // /mutelog
    if (textRaw === "/mutelog") {
      if (!hasOwnerPermission(me)) { socket.emit("system", "Keine Rechte (nur Owner)."); return; }
      socket.emit("system", `Aktive Mutes: ${listActiveMutes()}`);
      return;
    }

    // --- Normale Chat-Nachricht ---
    if (me.mutedUntil && me.mutedUntil > now()) {
      socket.emit("system", `Du bist gemutet (noch ${msToMinSec(me.mutedUntil - now())}).`);
      return;
    }

    const clean = escapeHTML(textRaw);
    io.to(me.room).emit("chat", {
      from: me.name,
      text: clean,
      ts: Date.now(),
      room: me.room,
    });
  });

  socket.on("disconnect", () => {
    const u = users[socket.id];
    if (!u) return;
    io.to(u.room).emit("system", `${u.name} hat den Chat verlassen.`);
    roomCounts[u.room] = Math.max(0, (roomCounts[u.room] || 0) - 1);
    if (u.room !== DEFAULT_ROOM && roomCounts[u.room] === 0) {
      delete roomCounts[u.room];
      io.emit("system", `Raum "${u.room}" wurde gelöscht (leer).`);
    }
    delete users[socket.id];
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
