// Parent side — موبايل الأب/الأم: مشاهدة + سماع + تحدث + تنبيهات حركة/صوت
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
if (!room) location.href = '/';

document.getElementById('roomCode').textContent = room;

const socket = io();
const remoteVideo = document.getElementById('remoteVideo');
const statusBadge = document.getElementById('statusBadge');
const babyBadge = document.getElementById('babyBadge');
const alertsEl = document.getElementById('alerts');
const toast = document.getElementById('toast');
const talkBtn = document.getElementById('talkBtn');
const muteBtn = document.getElementById('muteBtn');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let pc = null;
let micStream = null;
let micTrack = null;
let talking = false;
let muted = false;

// ساعة
setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('ar-EG');
}, 1000);

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (cls || '');
}
function addAlert(icon, msg) {
  // امسح رسالة "لا توجد تنبيهات" أول مرة
  if (alertsEl.children.length === 1 && alertsEl.textContent.includes('لا توجد تنبيهات')) {
    alertsEl.innerHTML = '';
  }
  const li = document.createElement('li');
  li.innerHTML = `${icon} ${msg} <span class="time">${new Date().toLocaleTimeString('ar-EG')}</span>`;
  alertsEl.prepend(li);
  // اهتزاز + تنبيه صوتي خفيف
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880; gain.gain.value = 0.08;
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}
function showToast(msg) {
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 4000);
}

// ---------- WebRTC ----------
// جهّز مايك التحدث من البداية (مكتوم) عشان إضافته للاتصال لا تحتاج إعادة تفاوض
async function prepareMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    micTrack = micStream.getAudioTracks()[0];
    micTrack.enabled = false;
  } catch (e) {
    console.warn('mic not available yet', e);
    alert('للتحدث مع البيبي لازم تسمح بالمايك على موبايلك. المشاهدة هتشتغل عادي من غيره.');
  }
}

function createPeerConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(rtcConfig);

  // أضف تراك المايك (مكتوم افتراضيًا) — عشان التحدث يشتغل فورًا
  if (micTrack) pc.addTrack(micTrack, micStream);

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteVideo.play().catch(() => {});
    babyBadge.textContent = 'كاميرا البيبي: متصلة ✅';
    babyBadge.className = 'badge green';
    setStatus('✅ البث المباشر شغال', 'green');
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('signal', { type: 'ice', candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('✅ البث المباشر شغال', 'green');
    else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      setStatus('⚠️ انقطع الاتصال — جاري إعادة المحاولة…', 'amber');
      babyBadge.textContent = 'كاميرا البيبي: غير متصلة';
      babyBadge.className = 'badge';
    }
  };
  return pc;
}

socket.on('connect', () => {
  socket.emit('join-room', { room, role: 'parent' });
  prepareMic();
});
socket.on('joined', () => addAlert('ℹ️', 'انضممت للغرفة ' + room + ' — بانتظار موبايل البيبي…'));
socket.on('peer-joined', ({ role }) => {
  if (role === 'baby') {
    babyBadge.textContent = 'كاميرا البيبي: متصلة ✅';
    babyBadge.className = 'badge green';
    addAlert('📷', 'موبايل البيبي متصل — جاري استقبال البث…');
  }
});
socket.on('peer-left', ({ role }) => {
  if (role === 'baby') {
    babyBadge.textContent = 'كاميرا البيبي: غير متصلة';
    babyBadge.className = 'badge';
    setStatus('⏳ بانتظار موبايل البيبي…', 'red');
    addAlert('⚠️', 'موبايل البيبي خرج من الغرفة');
  }
});
socket.on('signal', async (data) => {
  try {
    if (data.type === 'offer') {
      createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer });
    } else if (data.type === 'ice' && data.candidate && pc) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (e) { console.warn('signal error', e); }
});
socket.on('replaced', (msg) => alert(msg));

// ---------- التنبيهات ----------
socket.on('motion-alert', (data) => {
  addAlert('🏃', `حركة عند البيبي! (مستوى ${data.level || ''}%)`);
  showToast('⚠️ حركة عند البيبي!');
});
socket.on('sound-alert', (data) => {
  addAlert('🔊', `صوت عالي عند البيبي — ممكن يكون بيبكي (مستوى ${data.level || ''}%)`);
  showToast('🔊 صوت عالي عند البيبي!');
});

// ---------- أزرار التحكم ----------
talkBtn.onclick = async () => {
  if (!micTrack) {
    await prepareMic();
    if (!micTrack) return;
    // لو الاتصال اتعمل قبل تجهيز المايك، أضفه وأعد التفاوض بسيطًا
    if (pc) { pc.addTrack(micTrack, micStream); }
  }
  talking = !talking;
  micTrack.enabled = talking;
  talkBtn.textContent = talking ? '🔴 أنت بتتكلم الآن — اضغط للإيقاف' : '🎙️ اضغط للتحدث مع البيبي';
  talkBtn.classList.toggle('talking', talking);
  if (talking) addAlert('🎙️', 'بدأت التحدث مع البيبي');
};

muteBtn.onclick = () => {
  muted = !muted;
  remoteVideo.muted = muted;
  muteBtn.textContent = muted ? '🔇 صوت البيبي: مكتوم' : '🔊 صوت البيبي: شغال';
};

document.getElementById('snapBtn').onclick = () => {
  if (!remoteVideo.videoWidth) return alert('لسه مفيش بث شغال عشان تلتقط صورة');
  const c = document.createElement('canvas');
  c.width = remoteVideo.videoWidth; c.height = remoteVideo.videoHeight;
  c.getContext('2d').drawImage(remoteVideo, 0, 0);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `baby-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  a.click();
  addAlert('📸', 'تم التقاط صورة وحفظها');
};

document.getElementById('fullBtn').onclick = () => {
  const el = document.getElementById('videoWrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
};

document.getElementById('reconnectBtn').onclick = () => location.reload();
