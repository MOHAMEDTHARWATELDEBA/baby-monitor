// Parent side (GitHub Pages version) — raw WebRTC + PeerJS DataConnection signaling.
// موبايل الأب/الأم: مشاهدة + سماع + تحدث + تنبيهات حركة/صوت
//
// لماذا WebRTC خام وليس مكالمات PeerJS الجاهزة؟
// كان الصوت يصل والموشن يصل، لكن تراك الفيديو كان يضيع أحيانًا
// لأن عرض الأب (بلا ستريم) لم يكن يفاوض على فيديو صراحةً. هنا
// ننشئ RTCPeerConnection بأنفسنا ونضيف transceivers صريحة:
// فيديو recvonly + صوت recvonly، فيضمن التفاوض على الفيديو.
// PeerJS يُستخدم فقط كقناة إشارات لتبادل offer/answer/ICE.
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
if (!room) location.href = 'index.html';

document.getElementById('roomCode').textContent = room;

const BABY_PEER_ID = `bm-${room}-baby`;
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
let dataConn = null;
let pc = null;
let remoteStream = new MediaStream();
let micStream = null;
let micTrack = null;
let micAdded = false;
let talking = false;
let muted = false;
let retryTimer = null;
let videoTimeout = null;
let videoReceived = false;
let audioReceived = false;
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
function sendSignal(obj) {
  if (dataConn && dataConn.open) {
    try { dataConn.send(obj); } catch (e) { console.warn('signal send failed', e); }
  }
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

function createPC() {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  // transceivers صريحة: هذا هو الإصلاح الأساسي للفيديو
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  clog('تم إنشاء اتصال WebRTC — transceivers: فيديو recvonly + صوت recvonly');
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal({ type: 'ice', candidate: event.candidate });
  };
  pc.ontrack = (event) => {
    const track = event.track;
    clog(`📥 وصل تراك: ${track.kind} — enabled=${track.enabled} readyState=${track.readyState}`);
    if (!remoteStream.getTracks().find(t => t.id === track.id)) {
      remoteStream.addTrack(track);
    }
    if (track.kind === 'video') {
      videoReceived = true;
      if (videoTimeout) { clearTimeout(videoTimeout); videoTimeout = null; }
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    }
    if (track.kind === 'audio') audioReceived = true;
    remoteVideo.srcObject = remoteStream;
    remoteVideo.play()
      .then(() => {
        setTimeout(() => {
          clog(`عنصر الفيديو: ${remoteVideo.videoWidth}x${remoteVideo.videoHeight} readyState=${remoteVideo.readyState} paused=${remoteVideo.paused}`);
        }, 1000);
      })
      .catch((e) => clog('⚠️ تعذّر تشغيل الفيديو تلقائيًا: ' + e.message + ' — اضغط على الفيديو'));
    babyBadge.textContent = 'كاميرا البيبي: متصلة ✅';
    babyBadge.className = 'badge green';
    setStatus('✅ البث المباشر شغال', 'green');
  };
  pc.onconnectionstatechange = () => {
    clog('حالة اتصال WebRTC: ' + pc.connectionState);
    if (pc.connectionState === 'connected') setStatus('✅ البث المباشر شغال', 'green');
    else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      setStatus('⚠️ انقطع الاتصال — جاري إعادة المحاولة…', 'amber');
      babyBadge.textContent = 'كاميرا البيبي: غير متصلة';
      babyBadge.className = 'badge';
      resetPCAndRetry();
    }
  };
  return pc;
}

function resetPCAndRetry() {
  if (videoTimeout) { clearTimeout(videoTimeout); videoTimeout = null; }
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  videoReceived = false;
  audioReceived = false;
  micAdded = false;
  remoteStream = new MediaStream();
  scheduleRetry();
}

async function handleSignal(data) {
  if (!data || !data.type) return;
  try {
    if (data.type === 'offer') {
      clog('📨 وصل عرض (offer) من موبايل البيبي');
      createPC();
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer });
      clog('📤 تم إرسال الإجابة (answer)');
      armVideoTimeout();
    } else if (data.type === 'answer') {
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      clog('📨 وصلت إجابة على عرض إعادة التفاوض (التحدث)');
    } else if (data.type === 'ice' && data.candidate) {
      if (!pc) return;
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } else if (data.type === 'motion-alert') {
      addAlert('🏃', `حركة عند البيبي! (مستوى ${data.level || ''}%)`);
      showToast('⚠️ حركة عند البيبي!');
    } else if (data.type === 'sound-alert') {
      addAlert('🔊', `صوت عالي عند البيبي — ممكن يكون بيبكي (مستوى ${data.level || ''}%)`);
      showToast('🔊 صوت عالي عند البيبي!');
    }
  } catch (e) {
    console.warn('signal error', e);
    clog('⚠️ خطأ في الإشارات: ' + (e.message || e));
  }
}

function armVideoTimeout() {
  if (videoTimeout) clearTimeout(videoTimeout);
  videoTimeout = setTimeout(() => {
    if (!videoReceived) {
      if (audioReceived) {
        clog('⚠️ وصل الصوت فقط، ولم يصل تراك فيديو خلال 10 ثوانٍ — جاري إعادة الاتصال من جديد');
        addAlert('⚠️', 'وصل الصوت بس مفيش فيديو — جاري إعادة الاتصال…');
      } else {
        clog('⏱️ لم يصل أي تراك خلال 10 ثوانٍ — جاري إعادة الاتصال');
      }
      resetPCAndRetry();
      // أرسل join من جديد ليطلب عرضًا جديدًا من البيبي
      sendSignal({ type: 'join', role: 'parent' });
    }
  }, 10000);
}

function connectData() {
  if (!peer || peer.destroyed) return;
  if (dataConn && dataConn.open) { sendSignal({ type: 'join', role: 'parent' }); return; }
  attempt++;
  clog(`محاولة اتصال رقم ${attempt} بموبايل البيبي (${BABY_PEER_ID})…`);
  setStatus('⏳ بانتظار موبايل البيبي… (محاولة ' + attempt + ')', 'red');
  try {
    dataConn = peer.connect(BABY_PEER_ID, { reliable: true });
  } catch (e) {
    clog('❌ فشل فتح قناة الإشارات: ' + (e.message || e));
    scheduleRetry();
    return;
  }
  dataConn.on('open', () => {
    clog('✅ قناة الإشارات مفتوحة مع موبايل البيبي');
    sendSignal({ type: 'join', role: 'parent' });
  });
  dataConn.on('data', handleSignal);
  dataConn.on('error', (err) => clog('⚠️ خطأ في قناة الإشارات: ' + (err.type || err)));
  dataConn.on('close', () => {
    clog('⚠️ أُغلقت قناة الإشارات — جاري إعادة الاتصال…');
    dataConn = null;
    scheduleRetry();
  });
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    if (peer && !peer.destroyed) connectData();
  }, 3000);
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
    connectData();
  });
  peer.on('error', (err) => {
    console.warn('PeerJS error', err);
    clog('⚠️ خطأ PeerJS: ' + (err.type || err.message || err));
  });
  peer.on('disconnected', () => {
    clog('⚠️ انقطع الاتصال بسيرفر PeerJS — جاري إعادة الاتصال…');
    try { peer.reconnect(); } catch (e) {}
  });
}

// ---------- التحدث: إضافة تراك المايك للاتصال الحالي + إعادة تفاوض ----------
talkBtn.onclick = async () => {
  if (talking) {
    talking = false;
    if (micTrack) micTrack.enabled = false;
    talkBtn.textContent = '🎙️ اضغط للتحدث مع البيبي';
    talkBtn.classList.remove('talking');
    clog('⏸️ أوقفت التحدث (المايك مكتوم، الاتصال مستمر)');
    return;
  }
  const stream = await prepareMic();
  if (!micTrack) {
    alert('للتحدث مع البيبي لازم تسمح بالمايك على موبايلك. المشاهدة هتشتغل عادي من غيره.');
    return;
  }
  if (!pc) {
    alert('لسه مفيش اتصال بموبايل البيبي — استنى الفيديو يظهر الأول.');
    return;
  }
  talking = true;
  micTrack.enabled = true;
  talkBtn.textContent = '🔴 أنت بتتكلم الآن — اضغط للإيقاف';
  talkBtn.classList.add('talking');
  clog('🎙️ بدأت التحدث مع البيبي');
  addAlert('🎙️', 'بدأت التحدث مع البيبي');
  try {
    if (!micAdded) {
      pc.addTrack(micTrack, micStream);
      micAdded = true;
      clog('أُضيف تراك المايك للاتصال — جاري إعادة التفاوض…');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: offer });
    }
  } catch (e) {
    clog('❌ فشل إعادة التفاوض للتحدث: ' + (e.message || e));
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
