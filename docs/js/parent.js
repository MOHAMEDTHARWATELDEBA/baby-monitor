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
// سيرفرات ICE: STUN من Google وCloudflare + TURN من Metered بنظام
// المصادقة المؤقتة (TURN REST auth): اسم المستخدم = وقت انتهاء،
// وكلمة المرور = base64(HMAC-SHA1(secret, username)) — تُحسب محليًا
// في المتصفح بدون سيرفر. بيانات openrelayproject القديمة توقفت عن
// إنتاج أي مرشح relay (السجل أظهر relay: 0 ثم ICE failed)، لذلك
// استُبدلت بهذه الطريقة الموثقة من Metered نفسه (staticauth).
let ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
async function buildIceServers() {
  try {
    const secret = 'openrelayprojectsecret';
    const username = String(Math.floor(Date.now() / 1000) + 86400);
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(username));
    const password = btoa(String.fromCharCode(...new Uint8Array(sig)));
    ICE_SERVERS = ICE_SERVERS.concat([
      { urls: 'turn:staticauth.openrelay.metered.ca:80', username, credential: password },
      { urls: 'turn:staticauth.openrelay.metered.ca:443', username, credential: password },
      { urls: 'turn:staticauth.openrelay.metered.ca:443?transport=tcp', username, credential: password },
      { urls: 'turns:staticauth.openrelay.metered.ca:443?transport=tcp', username, credential: password },
    ]);
  } catch (e) {
    console.warn('TURN credentials unavailable, STUN only', e);
  }
}
const iceReady = buildIceServers();
const remoteVideo = document.getElementById('remoteVideo');
const statusBadge = document.getElementById('statusBadge');
const babyBadge = document.getElementById('babyBadge');
const alertsEl = document.getElementById('alerts');
const connLogEl = document.getElementById('connLog');
const toast = document.getElementById('toast');
const talkBtn = document.getElementById('talkBtn');
const muteBtn = document.getElementById('muteBtn');
const playBtn = document.getElementById('playBtn');

// التشغيل التلقائي بالصوت ممنوع في متصفحات الموبايل بدون لمسة
// من المستخدم، لذلك نبدأ مكتومين (التشغيل المكتوم مسموح) ونترك
// تشغيل الصوت للمسة المستخدم على زر التشغيل أو على الفيديو نفسه.
remoteVideo.muted = true;
remoteVideo.playsInline = true;

let peer = null;
let dataConn = null;
let pc = null;
let remoteStream = new MediaStream();
let micStream = null;
let micTrack = null;
let micAdded = false;
let talking = false;
let muted = true;
let playStarted = false;
let retryTimer = null;
let videoTimeout = null;
let videoReceived = false;
let audioReceived = false;
let relayCandidates = 0;
let iceReceived = 0;
let pendingCandidates = [];
let iceWatchdog = null;
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
  relayCandidates = 0;
  iceReceived = 0;
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const type = event.candidate.candidate.split(' ')[7] || '?';
      if (type === 'relay') relayCandidates++;
      clog(`مرشح ICE محلي: ${type} (${event.candidate.protocol})`);
      sendSignal({ type: 'ice', candidate: event.candidate });
    } else {
      clog(`انتهى تجميع مرشحات ICE — relay: ${relayCandidates}`);
    }
  };
  pc.oniceconnectionstatechange = () => {
    clog('حالة ICE: ' + pc.iceConnectionState);
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
      // التراك "live" لا يعني وصول فريمات: لو بعد 5 ثوانٍ لسه
      // مفيش أبعاد للفيديو، يبقى الوسائط (ICE) موصلتش أصلًا
      setTimeout(() => {
        if (remoteVideo.videoWidth === 0) {
          clog(`⚠️ التراك واصل لكن مفيش فريمات فيديو بعد 5 ثوانٍ — اتصال: ${pc ? pc.connectionState : '؟'} — ICE: ${pc ? pc.iceConnectionState : '؟'}`);
        }
      }, 5000);
    }
    if (track.kind === 'audio') audioReceived = true;
    // عيّن الستريم وشغّل مرة واحدة فقط: استدعاء play() مع كل تراك
    // (فيديو ثم صوت) كان يلغي الاستدعاء السابق بخطأ Aborted.
    if (remoteVideo.srcObject !== remoteStream) {
      remoteVideo.srcObject = remoteStream;
    }
    if (!playStarted) {
      playStarted = true;
      // مكتوم أولًا: التشغيل المكتوم مسموح تلقائيًا، والصوت يُشغَّل بلمسة
      remoteVideo.muted = true;
      muted = true;
      attemptPlay(0);
    }
    babyBadge.textContent = 'كاميرا البيبي: متصلة ✅';
    babyBadge.className = 'badge green';
    setStatus('✅ البث المباشر شغال', 'green');
  };
  pc.onconnectionstatechange = () => {
    clog('حالة اتصال WebRTC: ' + pc.connectionState + ' — ICE: ' + pc.iceConnectionState);
    if (pc.connectionState === 'connected') {
      if (iceWatchdog) { clearTimeout(iceWatchdog); iceWatchdog = null; }
      setStatus('✅ البث المباشر شغال', 'green');
    }
    else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      setStatus('⚠️ انقطع الاتصال — جاري إعادة المحاولة…', 'amber');
      babyBadge.textContent = 'كاميرا البيبي: غير متصلة';
      babyBadge.className = 'badge';
      resetPCAndRetry();
    }
  };
  return pc;
}

// تشغيل الفيديو مع إعادة محاولة تلقائية: لمسة المستخدم على
// أزرار التحكم المدمجة في الفيديو كانت تنادي pause() وتقطع
// طلب play() المعلق ("interrupted by a call to pause()")،
// لذلك أُزيلت الأزرار المدمجة ويُعاد التشغيل تلقائيًا حتى 3 مرات.
function attemptPlay(n) {
  remoteVideo.play()
    .then(() => {
      clog('✅ الفيديو شغال (مكتوم مؤقتًا) — اضغط زر التشغيل لسماع الصوت');
      if (playBtn) playBtn.style.display = 'block';
      setTimeout(() => {
        clog(`عنصر الفيديو: ${remoteVideo.videoWidth}x${remoteVideo.videoHeight} readyState=${remoteVideo.readyState} paused=${remoteVideo.paused}`);
      }, 1000);
    })
    .catch((e) => {
      if (n < 3) {
        clog(`⚠️ تعذّر تشغيل الفيديو: ${e.message} — إعادة المحاولة…`);
        setTimeout(() => { if (pc && remoteVideo.srcObject === remoteStream) attemptPlay(n + 1); }, 800);
      } else {
        playStarted = false;
        clog('⚠️ تعذّر تشغيل الفيديو تلقائيًا: ' + e.message + ' — اضغط زر التشغيل أو على الفيديو نفسه');
        if (playBtn) playBtn.style.display = 'block';
      }
    });
}

function resetPCAndRetry() {
  if (videoTimeout) { clearTimeout(videoTimeout); videoTimeout = null; }
  if (iceWatchdog) { clearTimeout(iceWatchdog); iceWatchdog = null; }
  pendingCandidates = [];
  if (pc) { try { pc.close(); } catch (e) {} pc = null; }
  videoReceived = false;
  audioReceived = false;
  playStarted = false;
  micAdded = false;
  remoteStream = new MediaStream();
  scheduleRetry();
}

// زر التشغيل: لمسة المستخدم تسمح بتشغيل الصوت (وهي أيضًا تشغّل الفيديو)
async function unmuteAndPlay() {
  try {
    remoteVideo.muted = false;
    muted = false;
    muteBtn.textContent = '🔊 صوت البيبي: شغال';
    await remoteVideo.play();
    if (playBtn) playBtn.style.display = 'none';
    clog('✅ تم تشغيل الفيديو والصوت بلمسة المستخدم');
  } catch (e) {
    clog('⚠️ تعذّر التشغيل باللمسة: ' + e.message + ' — إعادة المحاولة…');
    setTimeout(async () => {
      if (!pc) return;
      try {
        await remoteVideo.play();
        if (playBtn) playBtn.style.display = 'none';
        clog('✅ تم تشغيل الفيديو والصوت بلمسة المستخدم');
      } catch (e2) {
        clog('⚠️ تعذّر التشغيل باللمسة مرة أخرى: ' + e2.message);
      }
    }, 600);
  }
}
if (playBtn) playBtn.onclick = unmuteAndPlay;
remoteVideo.addEventListener('click', () => {
  if (remoteVideo.paused || remoteVideo.muted) unmuteAndPlay();
});

async function handleSignal(data) {
  if (!data || !data.type) return;
  try {
    if (data.type === 'offer') {
      clog('📨 وصل عرض (offer) من موبايل البيبي');
      createPC();
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      // المرشحات التي وصلت قبل إنشاء الاتصال كانت تُحذف صامتة —
      // أضفها الآن بعد أن أصبح الاتصال موجودًا
      if (pendingCandidates.length) {
        const n = pendingCandidates.length;
        for (const c of pendingCandidates.splice(0)) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); iceReceived++; } catch (e) {}
        }
        clog(`تمت إضافة ${n} مرشح ICE مبكر من البيبي`);
      }
      sendSignal({ type: 'answer', sdp: answer });
      clog('📤 تم إرسال الإجابة (answer)');
      armVideoTimeout();
      armIceWatchdog();
    } else if (data.type === 'answer') {
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      clog('📨 وصلت إجابة على عرض إعادة التفاوض (التحدث)');
    } else if (data.type === 'ice' && data.candidate) {
      if (!pc) {
        // الاتصال لسه متعملش (العرض لسه موصلش) — احفظ المرشح بدل حذفه
        pendingCandidates.push(data.candidate);
        return;
      }
      iceReceived++;
      if (iceReceived === 1) {
        const parts = (data.candidate.candidate || '').split(' ');
        clog('وصل مرشح ICE من البيبي: ' + (parts[7] || '?'));
      }
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

function armIceWatchdog() {
  if (iceWatchdog) clearTimeout(iceWatchdog);
  iceWatchdog = setTimeout(() => {
    if (pc && pc.connectionState !== 'connected') {
      clog(`⚠️ اتصال WebRTC لسه مش متصل بعد 15 ثانية (اتصال: ${pc.connectionState} — ICE: ${pc.iceConnectionState}) — جاري إعادة الاتصال من جديد`);
      resetPCAndRetry();
      sendSignal({ type: 'join', role: 'parent' });
    }
  }, 15000);
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
  if (muted) {
    unmuteAndPlay();
  } else {
    muted = true;
    remoteVideo.muted = true;
    muteBtn.textContent = '🔇 صوت البيبي: مكتوم — اضغط للتشغيل';
  }
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

// انتظر تجهيز بيانات TURN قبل التسجيل في PeerJS
iceReady.then(() => initPeer());
