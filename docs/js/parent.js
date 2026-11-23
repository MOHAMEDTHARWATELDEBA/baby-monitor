// Parent side (GitHub Pages version) — PeerJS, no own server needed.
// موبايل الأب/الأم: مشاهدة + سماع + تحدث + تنبيهات حركة/صوت
// مكالمة المشاهدة تتم بدون مايك إطلاقًا، حتى لا يمنع إذن المايك
// وصول الفيديو. التحدث مكالمة ثانية منفصلة تُفتح فقط عند الضغط
// على زر التحدث. أُضيف TURN مجاني لأن شبكات الموبايل كثيرًا ما
// تفشل مع STUN وحده، وإعادة محاولة تلقائية مع مهلة 10 ثوانٍ.
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
if (!room) location.href = 'index.html';

document.getElementById('roomCode').textContent = room;

const BABY_PEER_ID = `bm-${room}-baby`;
// معرّف عشوائي للأب/الأم حتى لا يتعارض مع تبويب آخر مفتوح بنفس الغرفة
const MY_PEER_ID = `bm-${room}-parent-${Math.floor(Math.random() * 100000)}`;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
const remoteVideo = document.getElementById('remoteVideo');
const statusBadge = document.getElementById('statusBadge');
const babyBadge = document.getElementById('babyBadge');
const alertsEl = document.getElementById('alerts');
const connLogEl = document.getElementById('connLog');
const toast = document.getElementById('toast');
const talkBtn = document.getElementById('talkBtn');
const muteBtn = document.getElementById('muteBtn');

let peer = null;
let mediaCall = null;
let talkCall = null;
let dataConn = null;
let micStream = null;
let micTrack = null;
let talking = false;
let muted = false;
let retryTimer = null;
let streamTimeout = null;
let streamReceived = false;
let attempt = 0;

setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('ar-EG');
}, 1000);

function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (cls || '');
}
function clog(msg) {
  if (!connLogEl) return;
  const li = document.createElement('li');
  li.innerHTML = `<span class="time">${new Date().toLocaleTimeString('ar-EG')}</span> — ${msg}`;
  connLogEl.prepend(li);
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
    console.warn('mic not available', e);
    return null;
  }
}

function initPeer() {
  if (peer) return;
  if (typeof Peer === 'undefined') {
    setStatus('❌ مكتبة PeerJS لم تُحمّل — تأكد من الإنترنت وأعد تحميل الصفحة', 'red');
    clog('❌ مكتبة PeerJS لم تُحمّل');
    return;
  }
  clog('جاري التسجيل في شبكة PeerJS…');
  peer = new Peer(MY_PEER_ID, { config: { iceServers: ICE_SERVERS } });

  peer.on('open', (id) => {
    clog('✅ تم التسجيل في PeerJS — ' + id);
    addAlert('ℹ️', 'انضممت للغرفة ' + room + ' — بانتظار موبايل البيبي…');
    connectToBaby();
  });

  peer.on('error', (err) => {
    console.warn('PeerJS error', err);
    clog('⚠️ خطأ PeerJS: ' + (err.type || err.message || err));
    if (err.type === 'network' || err.type === 'server-error') {
      setStatus('⚠️ مشكلة في شبكة PeerJS — جرّب إعادة تحميل الصفحة', 'amber');
    }
  });

  peer.on('disconnected', () => {
    clog('⚠️ انقطع الاتصال بسيرفر PeerJS — جاري إعادة الاتصال…');
    try { peer.reconnect(); } catch (e) {}
  });
}

function connectToBaby() {
  if (mediaCall || !peer || peer.destroyed) return;
  attempt++;
  clog(`محاولة اتصال رقم ${attempt} بموبايل البيبي (${BABY_PEER_ID})…`);
  setStatus('⏳ بانتظار موبايل البيبي… (محاولة ' + attempt + ')', 'red');
  try {
    // مكالمة مشاهدة بدون أي ستريم من طرفنا — المايك ليس مطلوبًا هنا
    mediaCall = peer.call(BABY_PEER_ID, undefined, { metadata: { purpose: 'view' } });
  } catch (e) {
    console.warn('call failed', e);
    clog('❌ فشل إنشاء المكالمة: ' + (e.message || e));
    mediaCall = null;
    scheduleRetry();
    return;
  }

  // لو لم يصل أي ستريم خلال 10 ثوانٍ، أغلق وحاول من جديد
  if (streamTimeout) clearTimeout(streamTimeout);
  streamTimeout = setTimeout(() => {
    if (!streamReceived && mediaCall) {
      clog('⏱️ لم يصل فيديو خلال 10 ثوانٍ — إعادة المحاولة (قد تكون الشبكة بطيئة أو موبايل البيبي غير متصل بعد)');
      try { mediaCall.close(); } catch (e) {}
      mediaCall = null;
      scheduleRetry();
    }
  }, 10000);

  mediaCall.on('stream', (remoteStream) => {
    streamReceived = true;
    if (streamTimeout) { clearTimeout(streamTimeout); streamTimeout = null; }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play().catch((e) => clog('⚠️ تعذّر تشغيل الفيديو تلقائيًا: ' + e.message + ' — اضغط على الفيديو'));
    babyBadge.textContent = 'كاميرا البيبي: متصلة ✅';
    babyBadge.className = 'badge green';
    setStatus('✅ البث المباشر شغال', 'green');
    clog('✅ وصل بث الفيديو من موبايل البيبي');
    addAlert('📷', 'موبايل البيبي متصل — البث شغال');
  });

  mediaCall.on('error', (err) => {
    console.warn('call error', err);
    clog('❌ خطأ في المكالمة: ' + (err.type || err.message || err) + ' — تأكد أن موبايل البيبي مفتوح على نفس الكود');
    if (streamTimeout) { clearTimeout(streamTimeout); streamTimeout = null; }
    mediaCall = null;
    scheduleRetry();
  });
  mediaCall.on('close', () => {
    if (streamTimeout) { clearTimeout(streamTimeout); streamTimeout = null; }
    const wasStreaming = streamReceived;
    mediaCall = null;
    streamReceived = false;
    babyBadge.textContent = 'كاميرا البيبي: غير متصلة';
    babyBadge.className = 'badge';
    setStatus('⏳ بانتظار موبايل البيبي…', 'red');
    if (wasStreaming) {
      clog('⚠️ انقطع البث — جاري إعادة الاتصال…');
      addAlert('⚠️', 'انقطع الاتصال بموبايل البيبي — جاري إعادة المحاولة…');
    }
    scheduleRetry();
  });

  // قناة بيانات للتنبيهات
  try {
    dataConn = peer.connect(BABY_PEER_ID, { reliable: true });
    dataConn.on('open', () => clog('✅ قناة التنبيهات متصلة'));
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
    dataConn.on('error', (err) => clog('⚠️ خطأ في قناة التنبيهات: ' + (err.type || err)));
  } catch (e) { console.warn('data connection failed', e); }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    if (!mediaCall && peer && !peer.destroyed) connectToBaby();
  }, 3000);
}

// ---------- التحدث: مكالمة ثانية منفصلة، تُفتح فقط عند الضغط ----------
talkBtn.onclick = async () => {
  if (talking) {
    talking = false;
    if (micTrack) micTrack.enabled = false;
    if (talkCall) { try { talkCall.close(); } catch (e) {} talkCall = null; }
    talkBtn.textContent = '🎙️ اضغط للتحدث مع البيبي';
    talkBtn.classList.remove('talking');
    clog('⏸️ أوقفت التحدث');
    return;
  }
  const stream = await prepareMic();
  if (!micTrack) {
    alert('للتحدث مع البيبي لازم تسمح بالمايك على موبايلك. المشاهدة هتشتغل عادي من غيره.');
    return;
  }
  talking = true;
  micTrack.enabled = true;
  talkBtn.textContent = '🔴 أنت بتتكلم الآن — اضغط للإيقاف';
  talkBtn.classList.add('talking');
  clog('🎙️ بدأت التحدث مع البيبي');
  addAlert('🎙️', 'بدأت التحدث مع البيبي');
  try {
    talkCall = peer.call(BABY_PEER_ID, stream, { metadata: { purpose: 'talk' } });
    talkCall.on('error', (err) => clog('⚠️ خطأ في مكالمة التحدث: ' + (err.type || err)));
    talkCall.on('close', () => { talkCall = null; });
  } catch (e) {
    clog('❌ فشل فتح مكالمة التحدث: ' + (e.message || e));
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
