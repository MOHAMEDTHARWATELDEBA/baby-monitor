// Baby side — موبايل البيبي: كاميرا + مايك + كشف حركة وصوت + استقبال صوت الأب/الأم
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
if (!room) location.href = '/';

document.getElementById('roomCode').textContent = room;

const socket = io();
const video = document.getElementById('localVideo');
const parentAudio = document.getElementById('parentAudio');
const statusBadge = document.getElementById('statusBadge');
const parentBadge = document.getElementById('parentBadge');
const motionBadge = document.getElementById('motionBadge');
const logEl = document.getElementById('log');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

let pc = null;
let localStream = null;
let facingMode = 'environment'; // الكاميرا الخلفية افتراضيًا
let wakeLock = null;

// ---------- سجل ----------
function log(msg) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="time">${new Date().toLocaleTimeString('ar-EG')}</span> — ${msg}`;
  logEl.prepend(li);
}
function setStatus(text, cls) {
  statusBadge.textContent = text;
  statusBadge.className = 'badge ' + (cls || '');
}

// ---------- إبقاء الشاشة مفتوحة ----------
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

// ---------- تشغيل الكاميرا ----------
async function startCamera() {
  try {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    video.srcObject = localStream;
    setStatus('✅ الكاميرا شغالة — بانتظار الأب/الأم', 'green');
    log('الكاميرا والمايك شغالين');
    await requestWakeLock();
    startSoundDetection();
    startMotionDetection();
  } catch (err) {
    setStatus('❌ لازم تسمح بالكاميرا والمايك', 'red');
    log('خطأ في الكاميرا/المايك: ' + err.name + ' — افتح الصفحة من HTTPS واسمح بالأذونات');
    alert('لازم تسمح بالكاميرا والمايك عشان المراقبة تشتغل. ولو بتجرّب من الموبايل، لازم الرابط يكون HTTPS أو localhost.');
  }
}

// ---------- WebRTC ----------
function createPeerConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // صوت الأب/الأم اللي جاي لنا
  pc.ontrack = (event) => {
    if (event.track.kind === 'audio') {
      parentAudio.srcObject = event.streams[0];
      parentAudio.play().catch(() => {});
      log('وصل صوت الأب/الأم 🔊');
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit('signal', { type: 'ice', candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('✅ متصل بالأب/الأم — البث شغال', 'green');
      log('اتصال WebRTC ناجح ✅');
    } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      setStatus('⚠️ انقطع الاتصال — جاري إعادة المحاولة…', 'amber');
    }
  };
  return pc;
}

async function makeOffer() {
  if (!localStream) return;
  createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { type: 'offer', sdp: offer });
}

socket.on('connect', () => {
  socket.emit('join-room', { room, role: 'baby' });
});
socket.on('joined', () => log('انضممت للغرفة ' + room));
socket.on('peer-joined', ({ role }) => {
  if (role === 'parent') {
    parentBadge.textContent = 'الأب/الأم: متصل ✅';
    parentBadge.className = 'badge green';
    log('الأب/الأم دخل الغرفة — جاري إنشاء البث…');
    makeOffer();
  }
});
socket.on('peer-left', ({ role }) => {
  if (role === 'parent') {
    parentBadge.textContent = 'الأب/الأم: غير متصل';
    parentBadge.className = 'badge';
    setStatus('✅ الكاميرا شغالة — بانتظار الأب/الأم', 'green');
    log('الأب/الأم خرج من الغرفة');
  }
});
socket.on('signal', async (data) => {
  if (!pc) return;
  try {
    if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice' && data.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (e) { console.warn('signal error', e); }
});
socket.on('replaced', (msg) => alert(msg));

// ---------- كشف الحركة (مقارنة فريمات) ----------
const canvas = document.getElementById('motionCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
let prevFrame = null;
let lastMotionAt = 0;
let sensitivity = 2; // 1 أقل حساسية، 3 أعلى حساسية

const sensInput = document.getElementById('sensitivity');
const sensVal = document.getElementById('sensVal');
sensInput.oninput = () => {
  sensitivity = Number(sensInput.value);
  sensVal.textContent = sensitivity === 1 ? 'منخفضة' : sensitivity === 2 ? 'متوسطة' : 'عالية';
};

function startMotionDetection() {
  setInterval(() => {
    if (!video.videoWidth || video.readyState < 2) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!prevFrame) { prevFrame = frame.slice(0); return; }

    // قارن كل 4 بكسل لتوفير المعالجة
    let diff = 0, checked = 0;
    for (let i = 0; i < frame.length; i += 16) {
      const d = Math.abs(frame[i] - prevFrame[i]) + Math.abs(frame[i + 1] - prevFrame[i + 1]) + Math.abs(frame[i + 2] - prevFrame[i + 2]);
      if (d > 60) diff++;
      checked++;
    }
    const ratio = diff / checked;
    // العتبة حسب الحساسية: 1 → 0.08 ، 2 → 0.04 ، 3 → 0.015
    const threshold = sensitivity === 1 ? 0.08 : sensitivity === 2 ? 0.04 : 0.015;
    prevFrame = frame.slice(0);

    const now = Date.now();
    if (ratio > threshold && now - lastMotionAt > 5000) {
      lastMotionAt = now;
      const level = Math.min(100, Math.round(ratio * 500));
      motionBadge.textContent = '⚠️ حركة الآن!';
      motionBadge.className = 'badge amber';
      document.getElementById('lastMotion').textContent = new Date().toLocaleTimeString('ar-EG');
      socket.emit('motion-alert', { level, message: 'تم رصد حركة عند البيبي' });
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

    setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
      const level = Math.round((sum / data.length / 128) * 100);
      levelEl.textContent = level + '%';
      const now = Date.now();
      // صوت عالي ومستمر (أعلى من 25%) — غالبًا بكاء أو استيقاظ
      if (level > 25 && now - lastSoundAt > 8000) {
        lastSoundAt = now;
        socket.emit('sound-alert', { level, message: 'صوت عالي عند البيبي — ممكن يكون بيبكي' });
        log(`🔊 صوت عالي! (مستوى ${level}%)`);
      }
    }, 500);
  } catch (e) { console.warn('sound detection unavailable', e); }
}

// ---------- أدوات مساعدة ----------
// تهويدة بسيطة بـ Web Audio (لحن هادئ متكرر)
let lullabyTimer = null, lullabyCtx = null, lullabyOn = false;
document.getElementById('lullabyBtn').onclick = (e) => {
  lullabyOn = !lullabyOn;
  e.target.textContent = lullabyOn ? '⏸️ إيقاف التهويدة' : '🎵 تشغيل تهويدة';
  if (!lullabyOn) { clearInterval(lullabyTimer); return; }
  if (!lullabyCtx) lullabyCtx = new (window.AudioContext || window.webkitAudioContext)();
  const notes = [523.25, 587.33, 659.25, 783.99, 659.25, 587.33, 523.25, 0]; // C5 D5 E5 G5 E5 D5 C5
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

// إضاءة ليلية: شاشة بيضاء خافتة
let lightOn = false;
document.getElementById('lightBtn').onclick = (e) => {
  lightOn = !lightOn;
  e.target.textContent = lightOn ? '🌑 إطفاء الإضاءة' : '💡 إضاءة ليلية';
  document.body.style.background = lightOn ? '#fef9c3' : '';
  document.body.style.color = lightOn ? '#111' : '';
};

// تبديل الكاميرا أمامية/خلفية
document.getElementById('flipBtn').onclick = async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  await startCamera();
  if (pc) makeOffer();
  log('تم تبديل الكاميرا');
};

startCamera();
