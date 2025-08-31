const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ===== Nutzer & Räume =====
const RESERVED_NAMES = new Set(["owner"]); // case-insensitive Vergleich
let users = {};                 // socket.id -> { name, room }
let nameToId = {};              // name(lower) -> socket.id (für /msg und Duplikat-Check)
let rooms = { Global: new Set() }; // room -> Set(socket.id)

// ===== Helper =====
function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeName(n) {
  return n.trim().toLowerCase();
}

function isValidName(n) {
  // 2–20 sichtbare Zeichen, keine nur-Spaces
  return typeof n === "string" && n.trim().length >= 2 && n.trim().length <= 20;
}

function isValidRoom(r) {
  // 1–32, nur Buchstaben/Ziffern/_/-, keine Spaces
  return /^[A-Za-z0-9_-]{1,32}$/.test(r);
}

function ensureRoom(room) {
  if (!rooms[room]) rooms[room] = new Set();
}

function joinRoom(socket, room) {
  const cur = users[socket.id]?.room;
  if (cur === room) return;

  // aus altem Raum raus
  if (cur) {
    rooms[cur]?.delete(socket.id);
    socket.leave(cur);
    maybeDeleteRoom(cur);
  }

  ensureRoom(room);
  rooms[room].add(socket.id);
  users[socket.id].room = room;
  socket.join(room);

  socket.emit("system", `Du bist jetzt in Raum: ${room}`);
  socket.to(room).emit("system", `${users[socket.id].name} ist dem Raum beigetreten.`);
}

function maybeDeleteRoom(room) {
  if (room && room !== "Global" && rooms[room] && rooms[room].size === 0) {
    delete rooms[room];
  }
}

function listRooms() {
  return Object.keys(rooms).map(r => `${r} (${rooms[r].size})`).join(", ");
}

// ===== Static =====
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ===== Socket =====
io.on("connection", (socket) => {
  // Gastname generieren (kollisionsfrei)
  let base = `Gast-${socket.id.slice(0, 4)}`;
  let nm = base;
  let i = 1;
  while (nameToId[normalizeName(nm)] || RESERVED_NAMES.has(normalizeName(nm))) {
    nm = `${base}-${i++}`;
  }

  users[socket.id] = { name: nm, room: null };
  nameToId[normalizeName(nm)] = socket.id;

  socket.emit("system", `Willkommen, dein Name ist ${nm}. Ändere ihn mit /name <deinName>`);
  joinRoom(socket, "Global");

  socket.on("message", (msgRaw) => {
    const raw = (msgRaw ?? "").toString();
    const trimmed = raw.trim();

    // HTML/JS neutralisieren
    const msg = escapeHTML(trimmed);

    // ----- Befehle -----
    if (msg.startsWith("/name ")) {
      const desired = msg.slice(6).trim();
      const desiredSafe = escapeHTML(desired);

      if (!isValidName(desiredSafe)) {
        socket.emit("system", "Ungültiger Name (2–20 Zeichen).");
        return;
      }
      const desiredNorm = normalizeName(desiredSafe);

      if (RESERVED_NAMES.has(desiredNorm)) {
        socket.emit("system", `Der Name "${desiredSafe}" ist reserviert.`);
        return;
      }
      if (nameToId[desiredNorm] && nameToId[desiredNorm] !== socket.id) {
        socket.emit("system", `Der Name "${desiredSafe}" ist bereits vergeben.`);
        return;
      }

      const oldName = users[socket.id].name;
      // alte Zuordnung löschen
      delete nameToId[normalizeName(oldName)];
      // neue setzen
      users[socket.id].name = desiredSafe;
      nameToId[desiredNorm] = socket.id;

      socket.emit("system", `Dein Name ist jetzt: ${desiredSafe}`);
      socket.to(users[socket.id].room).emit("system", `${oldName} heißt jetzt ${desiredSafe}`);
      return;
    }

    if (msg.startsWith("/msg ")) {
      const parts = msg.split(" ");
      const targetName = (parts[1] || "").trim();
      const text = parts.slice(2).join(" ").trim();

      if (!targetName || !text) {
        socket.emit("system", `Verwendung: /msg <Name> <Nachricht>`);
        return;
      }

      const targetId = nameToId[normalizeName(targetName)];
      if (targetId && users[targetId]) {
        const safeText = escapeHTML(text);
        io.to(targetId).emit("private", { from: users[socket.id].name, text: safeText });
        socket.emit("system", `Flüstern an ${users[targetId].name}: ${safeText}`);
      } else {
        socket.emit("system", `Kein Benutzer mit dem Namen "${targetName}" gefunden.`);
      }
      return;
    }

    if (msg.startsWith("/join ")) {
      const room = msg.slice(6).trim();
      if (!isValidRoom(room)) {
        socket.emit("system", `Ungültiger Raumname. Erlaubt: Buchstaben/Ziffern/_/- (max. 32).`);
        return;
      }
      joinRoom(socket, room);
      return;
    }

    if (msg === "/leave") {
      joinRoom(socket, "Global");
      return;
    }

    if (msg === "/rooms") {
      socket.emit("system", `Räume: ${listRooms()}`);
      return;
    }

    // ----- „Einfacher Raumwechsel“ durch einzelnes Token -----
    // Wenn Nachricht EIN einziges Token ist (keine Leerzeichen) und wie ein Raumname aussieht,
    // dann als Raumwechsel interpretieren (falls nicht identisch mit aktuellem Raum)
    if (!msg.startsWith("/") && isValidRoom(msg) && users[socket.id]?.room !== msg) {
      joinRoom(socket, msg);
      return;
    }

    // ----- Normale Nachricht in aktuellen Raum -----
    const room = users[socket.id].room || "Global";
    io.to(room).emit("chat", {
      from: users[socket.id].name,
      text: msg,
      ts: Date.now(),
      room
    });
  });

  socket.on("disconnect", () => {
    const info = users[socket.id];
    if (info) {
      const { name, room } = info;
      if (room && rooms[room]) {
        rooms[room].delete(socket.id);
        socket.to(room).emit("system", `${name} hat den Chat verlassen.`);
        maybeDeleteRoom(room);
      }
      delete nameToId[normalizeName(name)];
      delete users[socket.id];
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
