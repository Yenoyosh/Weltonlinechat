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

// Für Audio‑Call Sessions: für jeden Raum ein offener Call
const audioCalls = {}; // roomName → { initiatorId, participants: Set<socket.id> }

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

// Wenn ein Audio‑Call lief dort, rausnehmen
if (audioCalls[prevRoom]) {
audioCalls[prevRoom].participants.delete(uid);
io.to(prevRoom).emit("system", `${user.name} hat den Audio-Call verlassen.`);
if (audioCalls[prevRoom].participants.size === 0) {
delete audioCalls[prevRoom];
io.to(prevRoom).emit("system", `Der offene Audio-Call wurde beendet (kein Teilnehmer mehr).`);
}
}

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

socket.on("message", (raw) => {
const msg = (raw ?? "").toString().trim();
if (!msg) return;

// --- /name <Name> ---
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

// --- /msg <Name> <Text> ---
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

// --- /main ---
if (msg === "/main") {
joinRoom(socket, DEFAULT_ROOM);
return;
}

// --- /online ---
if (msg === "/online") {
const total = Object.keys(users).length;
socket.emit("system", `Online: ${total} Benutzer`);
return;
}

// --- /members ---
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

// --- /help ---
if (msg === "/help") {
socket.emit("system",
"Befehle:\n" +
"/name <Name> - Deinen Namen ändern\n" +
"/msg <Name> <Text> - Flüstern an einen Benutzer\n" +
"/main - Zurück in den Global-Raum wechseln\n" +
"/online - Zeigt, wie viele Nutzer gerade online sind\n" +
"/members - Zeigt alle Mitglieder im aktuellen Raum\n" +
"/help - Diese Hilfe anzeigen\n" +
"/call <Name> - Audio-Call mit Nutzer starten\n" +
"/opencall - Offenen Audio-Call für den Raum starten\n" +
"/joincall - Offenen Audio-Call im Raum beitreten\n" +
"/leavecall - Verlasse den offenen Audio-Call (wenn du drin bist)"
);
return;
}

// --- /call <Name> ---
if (msg.startsWith("/call ")) {
const targetName = escapeHTML(msg.slice(6).trim());
if (!targetName) {
socket.emit("system", "Nutzung: /call <Name>");
return;
}

const targetId = Object.keys(users).find(
id => users[id].name.toLowerCase() === targetName.toLowerCase()
);
if (!targetId) {
socket.emit("system", `Kein Benutzer mit dem Namen "${targetName}" gefunden.`);
return;
}

socket.emit("system", `Starte Audio-Call mit ${targetName}...`);
io.to(targetId).emit("incoming-call", {
fromId: socket.id,
fromName: users[socket.id].name,
});
return;
}

// --- /opencall ---
if (msg === "/opencall") {
const user = users[socket.id];
if (!user?.room) {
socket.emit("system", "Du bist in keinem Raum.");
return;
}
const room = user.room;
if (audioCalls[room]) {
socket.emit("system", "Ein offener Audio-Call läuft in diesem Raum bereits.");
return;
}

audioCalls[room] = {
initiatorId: socket.id,
participants: new Set([socket.id]),
};

socket.join("callroom-" + room);
io.to(room).emit("system", `${user.name} hat einen offenen Audio-Call gestartet. Nutze /joincall zum Beitreten.`);
return;
}

// --- /joincall ---
if (msg === "/joincall") {
const user = users[socket.id];
if (!user?.room) {
socket.emit("system", "Du bist in keinem Raum.");
return;
}
const room = user.room;
if (!audioCalls[room]) {
socket.emit("system", "Kein offener Audio-Call in diesem Raum aktiv.");
return;
}
if (audioCalls[room].participants.has(socket.id)) {
socket.emit("system", "Du bist bereits Teil des Audio-Calls.");
return;
}

audioCalls[room].participants.add(socket.id);
socket.join("callroom-" + room);
io.to(room).emit("system", `${user.name} ist dem offenen Audio-Call beigetreten.`);
return;
}

// --- /leavecall ---
if (msg === "/leavecall") {
const user = users[socket.id];
if (!user?.room) {
socket.emit("system", "Du bist in keinem Raum.");
return;
}
const room = user.room;
const call = audioCalls[room];
if (!call) {
socket.emit("system", "Kein aktiver Audio-Call in diesem Raum.");
return;
}
if (!call.participants.has(socket.id)) {
socket.emit("system", "Du bist nicht Teil des Audio-Calls.");
return;
}

call.participants.delete(socket.id);
socket.leave("callroom-" + room);
io.to(room).emit("system", `${user.name} hat den Audio-Call verlassen.`);
if (call.participants.size === 0) {
delete audioCalls[room];
io.to(room).emit("system", `Der offene Audio-Call wurde beendet (kein Teilnehmer mehr).`);
}
return;
}

// --- normale Chatnachricht ---
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

// WebRTC Signalisierungsnachrichten weiterleiten
socket.on("call-offer", ({ to, offer }) => {
io.to(to).emit("call-offer", { from: socket.id, offer });
});
socket.on("call-answer", ({ to, answer }) => {
io.to(to).emit("call-answer", { from: socket.id, answer });
});
socket.on("ice-candidate", ({ to, candidate }) => {
io.to(to).emit("ice-candidate", { from: socket.id, candidate });
});

socket.on("disconnect", () => {
const user = users[socket.id];
if (user) {
const { name, room } = user;

// Wenn Teil eines Audio-Calls, rausnehmen
if (room && audioCalls[room]) {
const call = audioCalls[room];
call.participants.delete(socket.id);
io.to(room).emit("system", `${name} hat den Audio-Call verlassen.`);
if (call.participants.size === 0) {
delete audioCalls[room];
io.to(room).emit("system", `Der offene Audio-Call wurde beendet (kein Teilnehmer mehr).`);
}
}

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
console.log(`Server läuft auf http://${HOST}:${PORT}`);
});
