const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// ------ Konfiguration ------
const DEFAULT_ROOM = "Global";
const RESERVED_NAMES = new Set(["owner", "admin", "system", "moderator"]); // alles klein schreiben
const ROOM_NAME_REGEX = /^[A-Za-z0-9_-]{1,24}$/; // erlaubte Räume

// ------ State ------
/** users[socket.id] = { name: string, room: string } */
const users = {};
/** roomCounts[room] = Anzahl der Sockets im Raum (wir pflegen das selbst) */
const roomCounts = { [DEFAULT_ROOM]: 0 };

// ------ Utils ------
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

function nameTaken(nameCandidate) {
  const n = nameCandidate.toLowerCase();
  if (RESERVED_NAMES.has(n)) return true;
  return Object.values(users).some(u => u.name.toLowerCase() === n);
}

function uniqueGuestName() {
  while (true) {
    const g = "Gast-" + Math.random().toString(36).slice(2, 6);
    if (!nameTaken(g)) return g;
  }
}

function joinRoom(socket, nextRoom) {
  const uid = socket.id;
  const user = users[uid];
  if (!user) return;

  const prevRoom = user.room;

  // Nichts tun, wenn gleich
  if (prevRoom === nextRoom) return;

  // Alten Raum verlassen
  if (prevRoom) {
    socket.leave(prevRoom);
    roomCounts[prevRoom] = Math.max(0, (roomCounts[prevRoom] || 0) - 1);

    // Info an den alten Raum
    io.to(prevRoom).emit("system", `${user.name} hat den Raum verlassen.`);
    sendRoomUserList(prevRoom);

    // Leeren, nicht-Globalen Raum entfernen
    if (prevRoom !== DEFAULT_ROOM && roomCounts[prevRoom] === 0) {
      delete roomCounts[prevRoom];
      // Optional: allen melden, dass der Raum entfernt wurde (nur Info)
      io.emit("room-removed", prevRoom);
    }
  }

  // Neuen Raum betreten (bei Bedarf „anlegen“)
  if (!roomCounts[nextRoom]) roomCounts[nextRoom] = 0;
  socket.join(nextRoom);
  roomCounts[nextRoom] += 1;
  users[uid].room = nextRoom;

  socket.emit("system", `Du bist jetzt in Raum: ${nextRoom}`);
  io.to(nextRoom).emit("system", `${user.name} ist dem Raum beigetreten.`);
  sendRoomUserList(nextRoom);
}

function sendRoomUserList(room) {
  const members = [];
  for (const [id, info] of Object.entries(users)) {
    if (info.room === room) members.push(info.name);
  }
  io.to(room).emit("userlist", { room, users: members });
}

// ------ Static ------
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ------ Socket.IO ------
io.on("connection", (socket) => {
  // User anlegen
  const name = uniqueGuestName();
  users[socket.id] = { name, room: null };

  socket.emit("system", `Willkommen, dein Name ist ${name}. Ändere ihn mit /name <deinName>`);
  // Standardraum
  joinRoom(socket, DEFAULT_ROOM);

  socket.on("message", (raw) => {
    const msg = (raw ?? "").toString().trim();

    // leer -> ignorieren
    if (!msg) return;

    // --- Commands ---
    if (msg.startsWith("/")) {
      const [cmd, ...rest] = msg.split(" ");
      const arg = rest.join(" ").trim();

      switch (cmd.toLowerCase()) {
        case "/help": {
          socket.emit(
            "system",
            "Befehle: /name <neu>, /join <Raum>, /msg <Name> <Text>, /help"
          );
          return;
        }

        case "/name": {
          const desired = escapeHTML(arg);
          if (!desired) {
            socket.emit("system", "Bitte gib einen Namen an: /name <deinName>");
            return;
          }
          if (desired.length > 24) {
            socket.emit("system", "Namen sind max. 24 Zeichen lang.");
            return;
          }
          if (nameTaken(desired)) {
            socket.emit("system", `Der Name "${desired}" ist reserviert oder bereits vergeben.`);
            return;
          }
          const old = users[socket.id].name;
          users[socket.id].name = desired;
          socket.emit("system", `Dein Name ist jetzt: ${desired}`);
          io.to(users[socket.id].room).emit("system", `${old} heißt jetzt ${desired}`);
          sendRoomUserList(users[socket.id].room);
          return;
        }

        case "/join": {
          const requestedRoom = arg;
          if (!requestedRoom) {
            socket.emit("system", "Nutzung: /join <Raum>");
            return;
          }
          if (!isValidRoom(requestedRoom)) {
            socket.emit(
              "system",
              "Ungültiger Raumname. Erlaubt: A–Z, a–z, 0–9, _ und - (1–24 Zeichen)."
            );
            return;
          }
          joinRoom(socket, requestedRoom);
          return;
        }

        case "/msg": {
          const parts = rest;
          const targetName = parts.shift();
          const text = parts.join(" ").trim();
          if (!targetName || !text) {
            socket.emit("system", "Nutzung: /msg <Name> <Text>");
            return;
          }
          const safeText = escapeHTML(text);

          const targetId = Object.keys(users).find(
            (id) => users[id].name.toLowerCase() === targetName.toLowerCase()
          );
          if (!targetId) {
            socket.emit("system", `Kein Benutzer mit dem Namen "${escapeHTML(targetName)}" gefunden.`);
            return;
          }
          // Private Nachricht (raumunabhängig)
          io.to(targetId).emit("private", {
            from: users[socket.id].name,
            text: safeText,
            ts: Date.now(),
          });
          socket.emit("system", `Flüstern an ${escapeHTML(targetName)}: ${safeText}`);
          return;
        }

        default:
          socket.emit("system", "Unbekannter Befehl. Tipp: /help");
          return;
      }
    }

    // --- Normale Nachricht: in aktuellen Raum senden ---
    const safe = escapeHTML(msg);
    const { name, room } = users[socket.id];
    if (!room) {
      socket.emit("system", "Du bist in keinem Raum. Nutze /join <Raum>.");
      return;
    }
    io.to(room).emit("chat", {
      from: name,
      room,
      text: safe,
      ts: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    const info = users[socket.id];
    if (info) {
      const { name, room } = info;
      // Aus Raum austragen
      if (room) {
        roomCounts[room] = Math.max(0, (roomCounts[room] || 1) - 1);
        io.to(room).emit("system", `${name} hat den Chat verlassen.`);
        sendRoomUserList(room);

        // temporäre Räume wegräumen
        if (room !== DEFAULT_ROOM && roomCounts[room] === 0) {
          delete roomCounts[room];
          io.emit("room-removed", room);
        }
      }
      delete users[socket.id];
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
