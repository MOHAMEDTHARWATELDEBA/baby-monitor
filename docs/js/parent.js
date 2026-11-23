// Parent side (GitHub Pages version) — PeerJS, no own server needed.
// موبايل الأب/الأم: مشاهدة + سماع + تحدث + تنبيهات حركة/صوت
// بيتصل بموبايل البيبي عبر PeerJS Cloud، ويعيد المحاولة كل 3 ثوانٍ
// لحد ما موبايل البيبي يبقى متصل.
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
if (!room) location.href = 'index.html';

document.getElementById('roomCode').textContent = room;

const BABY_PEER_ID = `bm-${room}-baby`;
const MY_PEER_ID = `bm-${room}-parent`;
const remoteVideo = document.getElementById('remoteVideo');
const statusBadge = document.getElementById('statusBadge');
const babyBadge = document.getElementById('babyBadge');
const alertsEl = document.getElementById('alerts');
const toast = document.getElementById('toast');
const talkBtn = document.getElementById('talkBtn');
const muteBtn = document.getElementById('muteBtn');

let peer = null;
let mediaCall = null;
let dataConn = null;
let micStream = null;
let micTrack = null;
let talking = false;
let muted = false;
let retryTimer = null;
let connectedOnce = false;

setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('ar-EG');
}, 1000);

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (cls || '');
}
function addAlert(icon, msg) {
  if (alertsEl.children.length === 1 && alertsEl.textContent.includes('لا توجد تنبيهات')) {
    alertsEl.innerHTML = '';
  }
  const li = document.createElement('li');
  li.innerHTML = `${icon} ${msg} <span class="time">${new Date().toLocaleTimeString('ar-EG')}</span>`;
  alertsEl.prepend(li);
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

async function prepareMic() {
  if (micStream) return micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    micTrack = micStream.getAudioTracks()[0];
    micTrack.enabled = false;
    return micStream;
  } catch (e) {
    console.warn('mic not available yet', e);
    return null;
  }
}

function initPeer() {
  if (peer) return;
  if (typeof Peer === 'undefined') {
    setStatus('❌ مكتبة PeerJS لم تُحمّل — تأكد من الإنترنت وأعد تحميل الصفحة', 'red');
    return;
  }
  peer = new Peer(MY_PEER_ID, {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]},
  });

  peer.on('open', () => {
    addAlert('ℹ️', 'انضممت للغرفة ' + room + ' — بانتظار موبايل البيبي…');
    connectToBaby();
  });

  peer.on('error', (err) => {
    console.warn('PeerJS error', err);
    if (err.type === 'unavailable-id') {
      // صفحة أب/أم تانية مفتوحة بنفس الغرفة — عادي، أنشئ معرّف عشوائي
      peer.destroy();
      peer = null;
      peer = new Peer(`bm-${room}-parent-${Math.floor(Math.random() * 10000)}`, {
        config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      });
      peer.on('open', () => connectToBaby());
      peer.on('error', (e2) => console.warn('PeerJS retry error', e2));
    }
  });
}

async function connectToBaby() {
  if (mediaCall) return;
  // جهّز المايك (مكتوم) عشان يتبعت مع المكالمة من الأول
  const stream = await prepareMic();
  try {
    mediaCall = peer.call(BABY_PEER_ID, stream || undefined, {
      metadata: { role: 'parent' },
    });
  } catch (e) {
    mediaCall = null;
    scheduleRetry();
    return;
  }

  mediaCall.on('stream', (remoteStream) => {
    connectedOnce = true;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play().catch(() => {});
    babyBadge.textContent = 'كاميرا البيبي: متصلة ✅';
    babyBadge.className = 'badge green';
    setStatus('✅ البث المباشر شغال', 'green');
    addAlert('📷', 'موبايل البيبي متصل — البث شغال');
  });

  mediaCall.on('error', () => {
    mediaCall = null;
    scheduleRetry();
  });
  mediaCall.on('close', () => {
    mediaCall = null;
    babyBadge.textContent = 'كاميرا البيبي: غير متصلة';
    babyBadge.className = 'badge';
    setStatus('⏳ بانتظار موبايل البيبي…', 'red');
    addAlert('⚠️', 'انقطع الاتصال بموبايل البيبي — جاري إعادة المحاولة…');
    scheduleRetry();
  });

  // قناة بيانات للتنبيهات
  try {
    dataConn = peer.connect(BABY_PEER_ID, { reliable: true });
    dataConn.on('open', () => addAlert('🔔', 'قناة التنبيهات متصلة'));
    dataConn.on('data', (data) => {
      if (!data || !data.type) return;
      if (data.type === 'motion-alert') {
        addAlert('🏃', `حركة عند البيبي! (مستوى ${data.level || ''}%)`);
        showToast('⚠️ حركة عند البيبي!');
      } else if (data.type === 'sound-alert') {
        addAlert('🔊', `صوت عالي عند البيبي — ممكن يكون بيبكي (مستوى ${data.level || ''}%)`);
        showToast('🔊 صوت عالي عند البيبي!');
      }
    });
    dataConn.on('error', () => {});
  } catch (e) { console.warn('data connection failed', e); }
}

function scheduleRetry() {
  if (retryTimer || connectedOnce) return;
  setStatus('⏳ بانتظار موبايل البيبي…', 'red');
  retryTimer = setInterval(() => {
    if (!mediaCall) connectToBaby();
  }, 3000);
}

talkBtn.onclick = async () => {
  const stream = await prepareMic();
  if (!micTrack) {
    alert('للتحدث مع البيبي لازم تسمح بالمايك على موبايلك. المشاهدة هتشتغل عادي من غيره.');
    return;
  }
  talking = !talking;
  micTrack.enabled = talking;
  talkBtn.textContent = talking ? '🔴 أنت بتتكلم الآن — اضغط للإيقاف' : '🎙️ اضغط للتحدث مع البيبي';
  talkBtn.classList.toggle('talking', talking);
  if (talking) addAlert('🎙️', 'بدأت التحدث مع البيبي');
  // ملاحظة: تراك المايك اتبعت مع المكالمة من الأول وهو مكتوم،
  // فتفعيله هنا يوصّل صوتك فورًا من غير إعادة اتصال.
  // لو المكالمة اتعملت قبل تجهيز المايك، أعد الاتصال:
  if (talking && mediaCall && !mediaCall.peerConnection) {
    // لا شيء — PeerJS يتعامل مع التراك المضاف مسبقًا
  }
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

initPeer();
