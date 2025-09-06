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

const users = {}; // socket.id -> { name, room }
const roomCounts = { [DEFAULT_ROOM]: 0 };

// ---------------- Hilfsfunktionen ----------------
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

// erzeugt eindeutige Namen mit _2, _3 usw.
function getUniqueName(desired) {
  const lowerDesired = desired.trim().toLowerCase();
  const currentNames = Object.values(users).map(u => u.name.toLowerCase());

  if (!currentNames.includes(lowerDesired)) return desired;

  let counter = 2;
  let newName;
  do {
    newName = `${desired}_${counter}`;
    counter++;
  } while (currentNames.includes(newName.toLowerCase()));

  return newName;
}

function uniqueGuestName() {
  const base = "Gast-" + Math.random().toString(36).slice(2, 6);
  return getUniqueName(base);
}

function joinRoom(socket, nextRoom) {
  const uid = socket.id;
  const user = users[uid];
  if (!user) return;

  const prevRoom = user.room;
  if (prevRoom === nextRoom) return;

  // alten Raum verlassen
  if (prevRoom) {
    socket.leave(prevRoom);
    roomCounts[prevRoom] = Math.max(0, (roomCounts[prevRoom] || 0) - 1);
    io.to(prevRoom).emit("system", `${user.name} hat den Raum verlassen.`);
    sendRoomUserList(prevRoom);

    if (prevRoom !== DEFAULT_ROOM && roomCounts[prevRoom] === 0) {
      delete roomCounts[prevRoom];
      io.emit("system", `Raum "${prevRoom}" wurde gelöscht (leer).`);
    }
  }

  // neuen Raum betreten
  if (!roomCounts[nextRoom]) roomCounts[nextRoom] = 0;
  socket.join(nextRoom);
  roomCounts[nextRoom] += 1;
  users[uid].room = nextRoom;

  socket.emit("system", `Du bist jetzt in Raum: ${nextRoom}`);
  socket.emit("roomUpdate", nextRoom);
  io.to(nextRoom).emit("system", `${user.name} ist dem Raum beigetreten.`);
  sendRoomUserList(nextRoom);
}

function sendRoomUserList(room) {
  const members = Object.values(users)
    .filter(u => u.room === room)
    .map(u => u.name);
  io.to(room).emit("userlist", { room, users: members });
}

// ---------------- Static Files ----------------
app.use(express.static(path.join(__dirname)));
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------- Socket.IO ----------------
io.on("connection", (socket) => {
  const name = uniqueGuestName();
  users[socket.id] = { name, room: null };

  socket.emit("system", `Willkommen, dein Name ist ${name}. Ändere ihn mit /name <deinName>`);
  joinRoom(socket, DEFAULT_ROOM);

  socket.on("changeRoom", (roomName) => {
    if (!isValidRoom(roomName)) {
      socket.emit("system", "Ungültiger Raumname. Erlaubt: Buchstaben, Zahlen, -, _ (1–24 Zeichen).");
      return;
    }
    joinRoom(socket, roomName);
  });

  socket.on("message", (raw) => {
    const msg = (raw ?? "").toString().trim();
    if (!msg) return;

    // --- Name ändern ---
    if (msg.startsWith("/name ")) {
      const desired = escapeHTML(msg.slice(6).trim());
      if (!desired) {
        socket.emit("system", "Bitte gib einen Namen an: /name <deinName>");
        return;
      }
      const uniqueName = getUniqueName(desired);
      const oldName = users[socket.id].name;
      users[socket.id].name = uniqueName;
      socket.emit("system", `Dein Name ist jetzt: ${uniqueName}`);
      io.to(users[socket.id].room).emit("system", `${oldName} heißt jetzt ${uniqueName}`);
      sendRoomUserList(users[socket.id].room);
      return;
    }

    // --- Privatnachricht ---
    if (msg.startsWith("/msg ")) {
      const parts = msg.split(" ");
      const targetName = parts[1];
      const text = parts.slice(2).join(" ").trim();
      if (!targetName || !text) {
        socket.emit("system", "Nutzung: /msg <Name> <Text>");
        return;
      }
      const safeText = escapeHTML(text);

      const targetId = Object.keys(users).find(
        id => users[id].name.toLowerCase() === targetName.toLowerCase()
      );
      if (!targetId) {
        socket.emit("system", `Kein Benutzer mit dem Namen "${escapeHTML(targetName)}" gefunden.`);
        return;
      }

      io.to(targetId).emit("private", {
        from: users[socket.id].name,
        text: safeText,
        ts: Date.now(),
      });

      socket.emit("system", `Flüstern an ${escapeHTML(targetName)}: ${safeText}`);
      return;
    }

    // --- zurück in Main-Raum ---
    if (msg === "/main") {
      joinRoom(socket, DEFAULT_ROOM);
      return;
    }

    // --- Online-Benutzer zählen ---
    if (msg === "/online") {
      const total = Object.keys(users).length;
      socket.emit("system", `Online: ${total} Benutzer`);
      return;
    }

    // --- Mitglieder im aktuellen Raum ---
    if (msg === "/members") {
      const user = users[socket.id];
      if (!user?.room) {
        socket.emit("system", "Du bist in keinem Raum.");
        return;
      }
      const members = Object.values(users)
        .filter(u => u.room === user.room)
        .map(u => u.name);
      socket.emit("system", `Mitglieder in ${user.room} (${members.length}): ${members.join(", ")}`);
      return;
    }

    // --- Hilfe anzeigen ---
    if (msg === "/help") {
      socket.emit("system",
        "Befehle:\n" +
        "/name <Name> - Deinen Namen ändern\n" +
        "/msg <Name> <Text> - Flüstern an einen Benutzer\n" +
        "/main - Zurück in den Global-Raum wechseln\n" +
        "/online - Zeigt, wie viele Nutzer gerade online sind\n" +
        "/members - Zeigt alle Mitglieder im aktuellen Raum\n" +
        "/help - Diese Hilfe anzeigen"
      );
      return;
    }

    // --- Normale Nachricht ---
    const safe = escapeHTML(msg);
    const user = users[socket.id];
    if (!user?.room) {
      socket.emit("system", "Du bist in keinem Raum. Nutze das Feld oben, um einem Raum beizutreten.");
      return;
    }

    io.to(user.room).emit("chat", {
      from: user.name,
      room: user.room,
      text: safe,
      ts: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      const { name, room } = user;
      if (room) {
        roomCounts[room] = Math.max(0, (roomCounts[room] || 1) - 1);
        io.to(room).emit("system", `${name} hat den Chat verlassen.`);
        sendRoomUserList(room);
        if (room !== DEFAULT_ROOM && roomCounts[room] === 0) {
          delete roomCounts[room];
          io.emit("system", `Raum "${room}" wurde gelöscht (leer).`);
        }
      }
      delete users[socket.id];
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
