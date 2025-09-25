// call.js
const socket = io();

// NEU – möglichst weit oben
const remoteAudio = document.getElementById('remoteAudio');
let localStream;
const peers = {};
let isInCall = false;

async function startAudioStream() {
try {
localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
return true;
} catch (err) {
alert("❌ Mikrofon-Zugriff fehlgeschlagen.\nBitte Mikrofon aktivieren und Seite neu laden.");
console.error("Mikrofonzugriff verweigert:", err);
return false;
}
}

function joinOpenCall(room) {
if (!localStream) return;

if (isInCall) {
alert("⚠️ Du bist bereits in einem Call.");
return;
}

isInCall = true;
socket.emit("message", "/joincall");
socket.emit("ready-for-call", { room });
}

socket.on("incoming-call", ({ fromId }) => {
createPeerConnection(fromId, true);
});

socket.on("call-offer", async ({ from, offer }) => {
const pc = createPeerConnection(from, false);
await pc.setRemoteDescription(new RTCSessionDescription(offer));
const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);
socket.emit("call-answer", { to: from, answer });
});

socket.on("call-answer", async ({ from, answer }) => {
const pc = peers[from];
if (!pc) return;
await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on("ice-candidate", async ({ from, candidate }) => {
const pc = peers[from];
if (pc && candidate) {
try {
await pc.addIceCandidate(new RTCIceCandidate(candidate));
} catch (err) {
console.error("ICE-Kandidat Fehler:", err);
}
}
});

function createPeerConnection(peerId, isInitiator) {
const pc = new RTCPeerConnection({
iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
});
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  } else {
    console.warn("Kein localStream vorhanden – addTrack übersprungen.");
 }

pc.onicecandidate = (event) => {
if (event.candidate) {
socket.emit("ice-candidate", { to: peerId, candidate: event.candidate });
}
};

pc.ontrack = (event) => {
   if (event.streams && event.streams[0]) {
     remoteAudio.srcObject = event.streams[0];
   } else {
     const ms = new MediaStream();
     ms.addTrack(event.track);
     remoteAudio.srcObject = ms;
   }
   // Falls Autoplay vorher blockiert war, jetzt nochmal versuchen:
   remoteAudio.play().catch(() => {});
 };

if (isInitiator) {
pc.onnegotiationneeded = async () => {
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
socket.emit("call-offer", { to: peerId, offer });
};
}

peers[peerId] = pc;
return pc;
}

window.initCall = async function(room) {
const ok = await startAudioStream();
if (!ok) return;
joinOpenCall(room);
};
