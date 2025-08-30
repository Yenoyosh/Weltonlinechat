// server.js
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// CORS locker lassen (Render / gleiche Origin ist damit ok)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Statisches Hosting (liefert index.html & Assets aus dem Projekt-Ordner)
app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Simple Chat-Logik
io.on("connection", (socket) => {
  console.log("Client verbunden:", socket.id);

  socket.on("join", (room) => {
    if (room) {
      socket.join(room);
      socket.to(room).emit("message", { system: true, text: `↪ ${socket.id} hat den Raum betreten` });
    }
  });

  socket.on("message", ({ room, text }) => {
    const payload = { id: socket.id, text, ts: Date.now() };
    if (room) {
      io.to(room).emit("message", payload);
    } else {
      io.emit("message", payload);
    }
  });

  socket.on("disconnect", () => {
    console.log("Client getrennt:", socket.id);
  });
});

// Wichtig für Render: PORT aus Umgebungsvariable; 0.0.0.0 binden
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Chat-Server läuft auf http://localhost:${PORT}`);
});
