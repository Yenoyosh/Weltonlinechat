const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

// Userliste (socket.id -> Name)
let users = {};

app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

io.on("connection", (socket) => {
  console.log("Verbunden:", socket.id);
  users[socket.id] = `Gast-${socket.id.slice(0, 4)}`;

  socket.emit("system", `Willkommen, dein Name ist ${users[socket.id]}. Ändere ihn mit /name <deinName>`);

  socket.on("message", (msg) => {
    const trimmed = msg.trim();

    // Name ändern
    if (trimmed.startsWith("/name ")) {
      const newName = trimmed.slice(6).trim();
      if (newName) {
        const oldName = users[socket.id];
        users[socket.id] = newName;
        socket.emit("system", `Dein Name ist jetzt: ${newName}`);
        socket.broadcast.emit("system", `${oldName} heißt jetzt ${newName}`);
      }
      return;
    }

    // Private Nachricht
    if (trimmed.startsWith("/msg ")) {
      const parts = trimmed.split(" ");
      const targetName = parts[1];
      const text = parts.slice(2).join(" ");

      const targetId = Object.keys(users).find((id) => users[id] === targetName);
      if (targetId) {
        io.to(targetId).emit("private", {
          from: users[socket.id],
          text,
        });
        socket.emit("system", `Flüstern an ${targetName}: ${text}`);
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
    console.log("Getrennt:", socket.id);
    io.emit("system", `${users[socket.id]} hat den Chat verlassen.`);
    delete users[socket.id];
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
