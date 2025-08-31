const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// User-Liste (socket.id -> Name)
let users = {};

// Funktion zum Escapen von HTML/JS
function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

io.on("connection", (socket) => {
  users[socket.id] = `Gast-${socket.id.slice(0, 4)}`;
  socket.emit("system", `Willkommen, dein Name ist ${users[socket.id]}. Ändere ihn mit /name <deinName>`);

  socket.on("message", (msgRaw) => {
    const msg = escapeHTML(msgRaw.trim());

    // Name ändern
    if (msg.startsWith("/name ")) {
      const newName = msg.slice(6).trim();
      if (newName) {
        const safeName = escapeHTML(newName);
        const oldName = users[socket.id];
        users[socket.id] = safeName;
        socket.emit("system", `Dein Name ist jetzt: ${safeName}`);
        socket.broadcast.emit("system", `${oldName} heißt jetzt ${safeName}`);
      }
      return;
    }

    // Private Nachricht
    if (msg.startsWith("/msg ")) {
      const parts = msg.split(" ");
      const targetName = parts[1];
      const text = parts.slice(2).join(" ");
      const safeText = escapeHTML(text);

      const targetId = Object.keys(users).find((id) => users[id] === targetName);
      if (targetId) {
        io.to(targetId).emit("private", {
          from: users[socket.id],
          text: safeText,
        });
        socket.emit("system", `Flüstern an ${targetName}: ${safeText}`);
      } else {
        socket.emit("system", `Kein Benutzer mit dem Namen "${targetName}" gefunden.`);
      }
      return;
    }

    // Normale Nachricht
    io.emit("chat", {
      from: users[socket.id],
      text: msg,
      ts: Date.now(),
    });
  });

  socket.on("disconnect", () => {
    io.emit("system", `${users[socket.id]} hat den Chat verlassen.`);
    delete users[socket.id];
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
