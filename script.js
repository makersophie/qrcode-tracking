const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

// BarcodeDetector finds every QR code in the full frame in a single call, at
// any size, so no tiling or size hints are needed. Browsers with a native
// implementation (Chrome/Edge/Android/Safari) use hardware-backed code; others
// fall back to the zxing-wasm based polyfill.
const POLYFILL_URL = 'https://cdn.jsdelivr.net/npm/barcode-detector@3.2.2/+esm';

const MEDIAPIPE_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const HAND_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MAX_HANDS = 2;

let detector;
let isDetecting = false;
let handLandmarker;
let handConnections = [];
let lastVideoTime = -1;

// Latest results from each tracker, redrawn together on every frame.
let barcodes = [];
let hands = [];

async function createDetector() {
  const formats = ['qr_code'];
  if ('BarcodeDetector' in window) {
    const supported = await BarcodeDetector.getSupportedFormats();
    if (supported.includes('qr_code')) {
      return new BarcodeDetector({ formats });
    }
  }
  const { BarcodeDetector: Polyfill } = await import(POLYFILL_URL);
  return new Polyfill({ formats });
}

// Hand tracking is loaded in the background so a failure to fetch MediaPipe
// never blocks QR tracking.
async function createHandLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(`${MEDIAPIPE_URL}/+esm`);
  const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);
  handConnections = HandLandmarker.HAND_CONNECTIONS;
  const create = (delegate) => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: MAX_HANDS,
  });
  return create('GPU').catch(() => create('CPU'));
}

navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  .then((stream) => {
    video.srcObject = stream;
  })
  .catch((error) => {
    console.error('Unable to access webcam:', error);
  });

video.addEventListener('loadedmetadata', async () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  detector = await createDetector();
  requestAnimationFrame(tick);

  createHandLandmarker()
    .then((landmarker) => { handLandmarker = landmarker; })
    .catch((error) => console.error('Unable to load hand tracking:', error));
});

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    // Detection is async; skip frames while one is in flight rather than queue.
    if (!isDetecting) {
      isDetecting = true;
      detector.detect(video)
        .then((results) => { barcodes = results; })
        .catch((error) => console.error('Detection failed:', error))
        .finally(() => { isDetecting = false; });
    }

    // Hand detection is synchronous and only needs to run once per new frame.
    if (handLandmarker && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      hands = handLandmarker.detectForVideo(video, performance.now()).landmarks;
    }
  }

  render();
  requestAnimationFrame(tick);
}

function render() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  for (const barcode of barcodes) {
    const location = toLocation(barcode.cornerPoints);
    drawBox(location);
    drawLabel(location, barcode.rawValue);
  }
  for (const landmarks of hands) {
    drawHand(landmarks);
  }
}

// cornerPoints are ordered top-left, top-right, bottom-right, bottom-left.
function toLocation([topLeft, topRight, bottomRight, bottomLeft]) {
  return {
    topLeftCorner: topLeft,
    topRightCorner: topRight,
    bottomRightCorner: bottomRight,
    bottomLeftCorner: bottomLeft,
  };
}

function drawBox(location) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = '#00ff00';
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function drawLabel(location, text) {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(text, x, y);
}

// Landmarks are normalized to [0, 1], so scale them to the overlay.
function drawHand(landmarks) {
  overlayCtx.strokeStyle = '#ff0000';
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.004);
  overlayCtx.lineCap = 'round';
  overlayCtx.beginPath();
  for (const { start, end } of handConnections) {
    overlayCtx.moveTo(landmarks[start].x * overlay.width, landmarks[start].y * overlay.height);
    overlayCtx.lineTo(landmarks[end].x * overlay.width, landmarks[end].y * overlay.height);
  }
  overlayCtx.stroke();
}
