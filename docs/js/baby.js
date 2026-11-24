// Baby side (GitHub Pages version) — raw WebRTC + PeerJS DataConnection signaling.
// موبايل البيبي: كاميرا + مايك + كشف حركة وصوت + استقبال صوت الأب/الأم
//
// لماذا WebRTC خام وليس مكالمات PeerJS الجاهزة؟
// في النسخة السابقة كان الصوت يصل والموشن يصل، لكن تراك الفيديو
// كان يضيع أحيانًا لأن عرض الأب (بلا ستريم) لم يكن يفاوض على
// فيديو صراحةً. هنا ننشئ RTCPeerConnection بأنفسنا ونضيف تراكي
// الفيديو والصوت صراحةً، و PeerJS يُستخدم فقط كقناة إشارات
// (DataConnection) لتبادل offer/answer/ICE والتنبيهات.
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
if (!room) location.href = 'index.html';

document.getElementById('roomCode').textContent = room;

const PEER_ID = `bm-${room}-baby`;
// سيرفرات ICE: STUN من Google وCloudflare + TURN من Metered بنظام
// المصادقة المؤقتة (TURN REST auth) — تُحسب محليًا في المتصفح.
// بيانات openrelayproject القديمة توقفت عن إنتاج أي مرشح relay
// (السجل على صفحة الأب أظهر relay: 0 ثم ICE failed).
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
const video = document.getElementById('localVideo');
const parentAudio = document.getElementById('parentAudio');
const statusBadge = document.getElementById('statusBadge');
const parentBadge = document.getElementById('parentBadge');
const motionBadge = document.getElementById('motionBadge');
const logEl = document.getElementById('log');

let peer = null;
let dataConn = null;
let pc = null;
let pendingCandidates = [];
let localStream = null;
let facingMode = 'environment';
let wakeLock = null;
let soundTimer = null;
let motionTimer = null;

function log(msg) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="time">${new Date().toLocaleTimeString('ar-EG')}</span> — ${msg}`;
  logEl.prepend(li);
}
function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (cls || '');
}
function sendSignal(obj) {
  if (dataConn && dataConn.open) {
    try { dataConn.send(obj); } catch (e) { console.warn('signal send failed', e); }
  }
}
function sendAlert(data) { sendSignal(data); }

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      log('تم تفعيل منع إطفاء الشاشة 🔒');
    }
  } catch (e) { /* بعض المتصفحات ترفض — مش مشكلة */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

async function startCamera() {
  await iceReady;
  try {
    if (localStream) {
      // لو الكاميرا اتبدلت وكان في اتصال شغال، استبدل التراكات بدل إيقافها
      const oldTracks = localStream.getTracks();
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (pc) {
        for (const track of newStream.getTracks()) {
          const sender = pc.getSenders().find(s => s.track && s.track.kind === track.kind);
          if (sender) await sender.replaceTrack(track);
        }
      }
      oldTracks.forEach(t => t.stop());
      localStream = newStream;
    } else {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    }
    video.srcObject = localStream;
    const v = localStream.getVideoTracks()[0];
    const a = localStream.getAudioTracks()[0];
    log(`الكاميرا والمايك شغالين — فيديو: ${v ? v.label + ' (' + v.readyState + ')' : 'مفقود!'}، صوت: ${a ? a.readyState : 'مفقود!'}`);
    if (!v) setStatus('❌ تراك الفيديو مفقود من الكاميرا — جرّب إعادة تحميل الصفحة', 'red');
    else setStatus('✅ الكاميرا شغالة — بانتظار الأب/الأم', 'green');
    await requestWakeLock();
    if (!soundTimer) startSoundDetection();
    if (!motionTimer) startMotionDetection();
    initPeer();
  } catch (err) {
    setStatus('❌ لازم تسمح بالكاميرا والمايك', 'red');
    log('خطأ في الكاميرا/المايك: ' + err.name + ' — افتح الصفحة من HTTPS واسمح بالأذونات');
    alert('لازم تسمح بالكاميرا والمايك عشان المراقبة تشتغل.');
  }
}

function createPC() {
  if (pc) { try { pc.close(); } catch (e) {} }
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
    log(`أُضيف تراك للإرسال: ${track.kind} — ${track.label} (${track.readyState})`);
  });
  pc.onicecandidate = (event) => {
    if (event.candidate) sendSignal({ type: 'ice', candidate: event.candidate });
  };
  pc.oniceconnectionstatechange = () => {
    log('حالة ICE: ' + pc.iceConnectionState);
  };
  pc.ontrack = (event) => {
    // صوت الأب/الأم عند التحدث (إعادة تفاوض من طرف الأب)
    if (event.track.kind === 'audio') {
      parentAudio.srcObject = event.streams[0];
      parentAudio.play().catch(() => {});
      log('وصل صوت الأب/الأم 🔊');
    }
  };
  pc.onconnectionstatechange = () => {
    log('حالة اتصال WebRTC: ' + pc.connectionState);
    if (pc.connectionState === 'connected') {
      parentBadge.textContent = 'الأب/الأم: متصل ✅';
      parentBadge.className = 'badge green';
      setStatus('✅ متصل بالأب/الأم — البث شغال', 'green');
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      parentBadge.textContent = 'الأب/الأم: غير متصل';
      parentBadge.className = 'badge';
      setStatus('⚠️ انقطع الاتصال — بانتظار الأب/الأم', 'amber');
    }
  };
  return pc;
}

async function handleSignal(data) {
  if (!data || !data.type) return;
  try {
    if (data.type === 'join') {
      log('الأب/الأم طلب الاتصال — جاري إنشاء عرض الفيديو…');
      createPC();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pendingCandidates.length) {
        const n = pendingCandidates.length;
        for (const c of pendingCandidates.splice(0)) {
          try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
        }
        log(`تمت إضافة ${n} مرشح ICE مبكر من الأب/الأم`);
      }
      sendSignal({ type: 'offer', sdp: offer });
      log('تم إرسال العرض (offer) — فيديو + صوت');
    } else if (data.type === 'answer') {
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      log('تم استقبال الإجابة (answer) من الأب/الأم');
    } else if (data.type === 'offer') {
      // إعادة تفاوض من الأب (مثلًا عند بدء التحدث)
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: answer });
      log('تم الرد على عرض إعادة التفاوض');
    } else if (data.type === 'ice' && data.candidate) {
      if (!pc) { pendingCandidates.push(data.candidate); return; }
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (e) {
    console.warn('signal error', e);
    log('⚠️ خطأ في الإشارات: ' + (e.message || e));
  }
}

function initPeer() {
  if (peer) return;
  if (typeof Peer === 'undefined') {
    setStatus('❌ مكتبة PeerJS لم تُحمّل — تأكد من الإنترنت وأعد تحميل الصفحة', 'red');
    return;
  }
  peer = new Peer(PEER_ID, { config: { iceServers: ICE_SERVERS } });

  peer.on('open', (id) => {
    log('تم التسجيل في شبكة PeerJS بالمعرّف ' + id);
    setStatus('✅ الكاميرا شغالة — بانتظار الأب/الأم', 'green');
  });

  peer.on('error', (err) => {
    console.warn('PeerJS error', err);
    if (err.type === 'unavailable-id') {
      setStatus('❌ كود الغرفة ده مستخدم بالفعل — اعمل غرفة جديدة', 'red');
      alert('كود الغرفة ده مستخدم بالفعل من موبايل بيبي تاني. ارجع واعمل غرفة جديدة.');
    } else {
      setStatus('⚠️ مشكلة في الاتصال بـ PeerJS — جاري المحاولة…', 'amber');
      log('خطأ PeerJS: ' + (err.type || err.message || err));
    }
  });

  peer.on('connection', (conn) => {
    dataConn = conn;
    conn.on('open', () => log('قناة الإشارات/التنبيهات مفتوحة مع الأب/الأم'));
    conn.on('data', handleSignal);
    conn.on('close', () => {
      if (dataConn === conn) dataConn = null;
      if (pc) { try { pc.close(); } catch (e) {} pc = null; }
      parentBadge.textContent = 'الأب/الأم: غير متصل';
      parentBadge.className = 'badge';
      setStatus('✅ الكاميرا شغالة — بانتظار الأب/الأم', 'green');
      log('الأب/الأم أغلق قناة الإشارات');
    });
  });
}

// ---------- كشف الحركة (مقارنة فريمات) ----------
const canvas = document.getElementById('motionCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let prevFrame = null;
let lastMotionAt = 0;
let sensitivity = 2;

const sensInput = document.getElementById('sensitivity');
const sensVal = document.getElementById('sensVal');
sensInput.oninput = () => {
  sensitivity = Number(sensInput.value);
  sensVal.textContent = sensitivity === 1 ? 'منخفضة' : sensitivity === 2 ? 'متوسطة' : 'عالية';
};

function startMotionDetection() {
  motionTimer = setInterval(() => {
    if (!video.videoWidth || video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!prevFrame) { prevFrame = frame.slice(0); return; }

    let diff = 0, checked = 0;
    for (let i = 0; i < frame.length; i += 16) {
      const d = Math.abs(frame[i] - prevFrame[i]) + Math.abs(frame[i + 1] - prevFrame[i + 1]) + Math.abs(frame[i + 2] - prevFrame[i + 2]);
      if (d > 60) diff++;
      checked++;
    }
    const ratio = diff / checked;
    const threshold = sensitivity === 1 ? 0.08 : sensitivity === 2 ? 0.04 : 0.015;
    prevFrame = frame.slice(0);

    const now = Date.now();
    if (ratio > threshold && now - lastMotionAt > 5000) {
      lastMotionAt = now;
      const level = Math.min(100, Math.round(ratio * 500));
      motionBadge.textContent = '⚠️ حركة الآن!';
      motionBadge.className = 'badge amber';
      document.getElementById('lastMotion').textContent = new Date().toLocaleTimeString('ar-EG');
      sendAlert({ type: 'motion-alert', level, message: 'تم رصد حركة عند البيبي' });
      log(`⚠️ حركة! (مستوى ${level}%)`);
      setTimeout(() => { motionBadge.textContent = 'لا توجد حركة'; motionBadge.className = 'badge'; }, 4000);
    }
  }, 500);
}

// ---------- كشف الصوت (بكاء / صوت عالي) ----------
let lastSoundAt = 0;
function startSoundDetection() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(localStream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const levelEl = document.getElementById('audioLevel');

    soundTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
      const level = Math.round((sum / data.length / 128) * 100);
      levelEl.textContent = level + '%';
      const now = Date.now();
      if (level > 25 && now - lastSoundAt > 8000) {
        lastSoundAt = now;
        sendAlert({ type: 'sound-alert', level, message: 'صوت عالي عند البيبي — ممكن يكون بيبكي' });
        log(`🔊 صوت عالي! (مستوى ${level}%)`);
      }
    }, 500);
  } catch (e) { console.warn('sound detection unavailable', e); }
}

// ---------- أدوات مساعدة ----------
let lullabyTimer = null, lullabyCtx = null, lullabyOn = false;
document.getElementById('lullabyBtn').onclick = (e) => {
  lullabyOn = !lullabyOn;
  e.target.textContent = lullabyOn ? '⏸️ إيقاف التهويدة' : '🎵 تشغيل تهويدة';
  if (!lullabyOn) { clearInterval(lullabyTimer); return; }
  if (!lullabyCtx) lullabyCtx = new (window.AudioContext || window.webkitAudioContext)();
  const notes = [523.25, 587.33, 659.25, 783.99, 659.25, 587.33, 523.25, 0];
  let i = 0;
  const playNote = () => {
    const freq = notes[i % notes.length]; i++;
    if (!freq) return;
    const osc = lullabyCtx.createOscillator();
    const gain = lullabyCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, lullabyCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, lullabyCtx.currentTime + 0.9);
    osc.connect(gain).connect(lullabyCtx.destination);
    osc.start(); osc.stop(lullabyCtx.currentTime + 1);
  };
  playNote();
  lullabyTimer = setInterval(playNote, 700);
  log('تم تشغيل التهويدة 🎵');
};

let lightOn = false;
document.getElementById('lightBtn').onclick = (e) => {
  lightOn = !lightOn;
  e.target.textContent = lightOn ? '🌑 إطفاء الإضاءة' : '💡 إضاءة ليلية';
  document.body.style.background = lightOn ? '#fef9c3' : '';
  document.body.style.color = lightOn ? '#111' : '';
};

document.getElementById('flipBtn').onclick = async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  await startCamera();
  log('تم تبديل الكاميرا');
};

startCamera();
