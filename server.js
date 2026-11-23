/**
 * Baby Monitor — Signaling Server
 * --------------------------------
 * سيرفر بسيط بـ Express + Socket.io.
 * وظيفته الوحيدة: توصيل موبايل البيبي بموبايل الأب/الأم،
 * وتمرير رسائل WebRTC (offer / answer / ICE) والتنبيهات بينهم.
 * الفيديو والصوت نفسهم يمشوا مباشرة Peer-to-Peer عبر WebRTC،
 * مش بيعدّوا على السيرفر، فالجودة أعلى والتأخير أقل.
 *
 * ملاحظة مهمة:
 * - getUserMedia يتطلب HTTPS (أو localhost للتجربة المحلية).
 * - للاتصال من أي مكان: انشر السيرفر على Render / Railway / Fly.io
 *   وافتح الرابط الـ HTTPS الناتج من الموبايلين.
 * - STUN المجاني من Google يكفي في أغلب الشبكات المنزلية.
 *   لو شبكتك صارمة (CGNAT / فايروول)، أضف TURN مدفوع/مجاني في
 *   rtcConfig داخل ملفات public/js.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// roomId -> { baby: socketId | null, parent: socketId | null, createdAt }
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { baby: null, parent: null, createdAt: Date.now() });
  }
  return rooms.get(roomId);
}

function otherSocket(room, role) {
  const target = role === 'baby' ? room.parent : room.baby;
  return target ? io.sockets.sockets.get(target) : null;
}

io.on('connection', (socket) => {
  let roomId = null;
  let role = null;

  socket.on('join-room', ({ room, role: r }) => {
    roomId = String(room || '').trim().toUpperCase();
    role = r === 'parent' ? 'parent' : 'baby';
    if (!roomId) return socket.emit('error-msg', 'كود الغرفة مطلوب');

    const roomObj = getOrCreateRoom(roomId);

    // لو الدور ده محجوز من جهاز تاني، طرده واستبدله (إعادة اتصال)
    if (roomObj[role] && roomObj[role] !== socket.id) {
      const old = io.sockets.sockets.get(roomObj[role]);
      if (old) old.emit('replaced', 'تم الاتصال من جهاز آخر بنفس الدور');
    }
    roomObj[role] = socket.id;
    socket.join(roomId);

    socket.emit('joined', { room: roomId, role });

    // بلّغ الطرف التاني إنك موجود
    const other = otherSocket(roomObj, role);
    if (other) {
      other.emit('peer-joined', { role });
      socket.emit('peer-joined', { role: role === 'baby' ? 'parent' : 'baby' });
    }
    console.log(`[${roomId}] ${role} joined (${socket.id})`);
  });

  // تمرير أي رسالة إشارة WebRTC للطرف الآخر في نفس الغرفة
  socket.on('signal', (data) => {
    if (!roomId) return;
    const roomObj = rooms.get(roomId);
    if (!roomObj) return;
    const other = otherSocket(roomObj, role);
    if (other) other.emit('signal', { ...data, from: role });
  });

  // تمرير التنبيهات (حركة / صوت) من موبايل البيبي للأب/الأم
  socket.on('motion-alert', (data) => {
    if (!roomId) return;
    socket.to(roomId).emit('motion-alert', { ...data, at: new Date().toISOString() });
  });
  socket.on('sound-alert', (data) => {
    if (!roomId) return;
    socket.to(roomId).emit('sound-alert', { ...data, at: new Date().toISOString() });
  });

  // حالة موبايل البيبي (بطارية؟ شاشة؟) — اختياري
  socket.on('baby-status', (data) => {
    if (!roomId) return;
    socket.to(roomId).emit('baby-status', data);
  });

  socket.on('disconnect', () => {
    if (!roomId) return;
    const roomObj = rooms.get(roomId);
    if (!roomObj) return;
    if (roomObj[role] === socket.id) roomObj[role] = null;
    socket.to(roomId).emit('peer-left', { role });
    if (!roomObj.baby && !roomObj.parent) rooms.delete(roomId);
    console.log(`[${roomId}] ${role} left`);
  });
});

server.listen(PORT, () => {
  console.log(`👶 Baby Monitor running at http://localhost:${PORT}`);
  console.log(`   افتح الرابط من الموبايلين (لازم HTTPS خارج localhost)`);
});
