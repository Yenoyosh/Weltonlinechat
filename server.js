import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: (process.env.CORS_ORIGIN?.split(",") || ["*"]) }
});

app.get("/", (_, res) => res.send("Chat server running"));

io.on("connection", (socket) => {
  socket.on("join", ({ room, name }) => {
    socket.data.name = (name || "Gast").trim();
    socket.join(room);
    io.to(room).emit("system", `${socket.data.name} ist beigetreten.`);
  });

  socket.on("message", ({ room, text }) => {
    const msg = {
      from: socket.data.name || "Gast",
      text: String(text || "").slice(0, 2000),
      ts: Date.now()
    };
    io.to(room).emit("message", msg);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Chat listening on :${PORT}`));
