const GAS_WEB_APP_URL = "https://script.google.com/a/macros/g.bears.ed.jp/s/AKfycbz_VGhmY-b_UQli7bDT9_MiCrVtTh2gU_qMDfw8X0H9xyCd-wfzy2-0AxErL8iuHcVA/exec";
const START_QR_VALUE = "MAZE_START_V1";
const GOAL_QR_VALUE = "MAZE_GOAL_V1";
const LIMIT_TIME = 8 * 60 * 1000;

let gameState = "ready"; // ready / running / finished / expired / saved
let startTime = null;
let timerInterval = null;
let mediaStream = null;
let scanInterval = null;
let scanBusy = false;
let nativeBarcodeDetector = null;
let lastQrAt = 0;
let finalTimeMs = 0;
let finalDisplayTime = "";
let pendingRequestId = null;
let pendingTimeout = null;

const video = document.getElementById("cameraPreview");
const canvas = document.getElementById("scanCanvas");
const canvasContext = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;
const timeElement = document.getElementById("time");
const statusElement = document.getElementById("gameStatus");
const cameraErrorElement = document.getElementById("cameraError");
const startCameraButton = document.getElementById("startCameraBtn");
const stopCameraButton = document.getElementById("stopCameraBtn");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");
const videoFrame = document.getElementById("videoFrame");
const submitArea = document.getElementById("submitArea");
const submitButton = document.getElementById("submitBtn");

function createQrCodes() {
  const startQr = document.getElementById("startQr");
  const goalQr = document.getElementById("goalQr");
  if (typeof window.QRCode === "undefined") {
    if (startQr) startQr.textContent = "QR生成ライブラリを読み込めません。";
    if (goalQr) goalQr.textContent = "QR生成ライブラリを読み込めません。";
    return;
  }

  new QRCode(startQr, {
    text: START_QR_VALUE, width: 220, height: 220,
    colorDark: "#000000", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
  new QRCode(goalQr, {
    text: GOAL_QR_VALUE, width: 220, height: 220,
    colorDark: "#000000", colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

function setCameraPreviewVisible(visible) {
  if (!cameraPlaceholder || !video) return;

  // 親要素は隠さず、停止中メッセージと映像だけを切り替える
  cameraPlaceholder.hidden = false;
  cameraPlaceholder.classList.toggle("is-active", Boolean(visible));

  if (visible) {
    video.style.setProperty("visibility", "visible", "important");
    video.style.setProperty("opacity", "1", "important");
  } else {
    video.style.setProperty("visibility", "hidden", "important");
    video.style.setProperty("opacity", "0", "important");
  }
}
async function waitForVideoReady(timeoutMs = 10000) {
  if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  await new Promise((resolve, reject) => {
    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
      video.removeEventListener("error", onError);
    };
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("video要素でカメラ映像を読み込めませんでした。"));
    };

    video.addEventListener("loadedmetadata", check);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    video.addEventListener("error", onError);
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("カメラは取得できましたが、映像の準備が10秒以内に完了しませんでした。"));
    }, timeoutMs);
    check();
  });
}

async function prepareQrScanner() {
  if (typeof window.jsQR === "function") {
    return "jsQR";
  }

  // CDNからjsQRを読み込めない場合、Chrome標準APIを代替として試す
  if ("BarcodeDetector" in window) {
    try {
      nativeBarcodeDetector = new BarcodeDetector({ formats: ["qr_code"] });
      return "BarcodeDetector";
    } catch (error) {
      nativeBarcodeDetector = null;
    }
  }

  return "preview-only";
}

async function startScanner() {
  cameraErrorElement.textContent = "";
  statusElement.textContent = "カメラを確認しています...";

  if (mediaStream) {
    statusElement.textContent = "カメラは起動中です。QRコードを映してください。";
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraErrorElement.textContent = "カメラの権限を確認";
    return;
  }

  startCameraButton.disabled = true;
  startCameraButton.textContent = "カメラ起動中...";

  try {
    // Chromebookの内蔵カメラを取得。背面カメラ指定は行わない。
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("muted", "");
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    video.srcObject = mediaStream;

    statusElement.textContent = "カメラを取得しました。映像を準備しています...";
    await video.play();
    await waitForVideoReady();

    // cameraPlaceholder全体は残し、内部の停止中メッセージだけを隠して映像を表示
    setCameraPreviewVisible(true);
    stopCameraButton.disabled = false;
    startCameraButton.textContent = "カメラ起動中";

    const scannerMode = await prepareQrScanner();
    if (scannerMode === "jsQR") {
      statusElement.textContent = gameState === "running"
        ? "カメラ映像を表示中です。ゴール用QRコードを読み取ってください。"
        : "カメラ映像を表示中です。スタート用QRコードを読み取ってください。";
      scanInterval = window.setInterval(scanFrame, 140);
    } else (scannerMode === "BarcodeDetector") {
      statusElement.textContent = "カメラ映像を表示中です。Chrome標準機能でQRコードを読み取ります。";
      scanInterval = window.setInterval(scanFrame, 250);

    const track = mediaStream.getVideoTracks()[0];
    if (track) {
      track.addEventListener("ended", () => {
        if (mediaStream) stopScanner();
        cameraErrorElement.textContent = "カメラ映像が終了しました。もう一度起動してください。";
      }, { once: true });
    }
  } catch (error) {
    releaseCamera();
    setCameraPreviewVisible(false);
    startCameraButton.disabled = false;
    startCameraButton.textContent = "カメラを起動";
    cameraErrorElement.textContent = cameraErrorMessage(error) +
      "（" + (error && error.name ? error.name : "UnknownError") +
      (error && error.message ? ": " + error.message : "") + "）";
    statusElement.textContent = "カメラを起動できませんでした。表示されたエラーを確認してください。";
  }
}

function cameraErrorMessage(error) {
  if (error && error.name === "NotAllowedError") {
    return "カメラへのアクセスが拒否されました。";
  }
  if (error && error.name === "NotFoundError") {
    return "カメラが見つかりません。";
  }
  if (error && error.name === "NotReadableError") {
    return "カメラを使用できません。";
  }
  return "カメラを起動できませんでした。";
}

function releaseCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  if (video) {
    video.pause();
    video.srcObject = null;
  }
}

function stopScanner() {
  if (scanInterval !== null) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  releaseCamera();
  setCameraPreviewVisible(false);
  startCameraButton.disabled = ["finished", "expired", "saved"].includes(gameState);
  startCameraButton.textContent = "カメラを起動";
  stopCameraButton.disabled = true;
}

async function scanFrame() {
  if (!mediaStream || scanBusy || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return;
  scanBusy = true;

  try {
    let decodedValue = "";
    if (typeof window.jsQR === "function" && canvasContext) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
      const qr = window.jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert"
      });
      if (qr && qr.data) decodedValue = qr.data.trim();
    } else if (nativeBarcodeDetector) {
      const codes = await nativeBarcodeDetector.detect(video);
      if (codes && codes.length > 0 && codes[0].rawValue) decodedValue = codes[0].rawValue.trim();
    }

    if (decodedValue) {
      const now = Date.now();
      if (now - lastQrAt > 1200) {
        lastQrAt = now;
        handleQrCode(decodedValue);
      }
    }
  } catch (error) {
    // 1フレームの読み取り失敗ではカメラを停止しない
  } finally {
    scanBusy = false;
  }
}

function handleQrCode(value) {
  if (value === START_QR_VALUE) {
    if (gameState === "ready") startGame();
    return;
  }
  if (value === GOAL_QR_VALUE) {
    if (gameState === "running") finishGame();
    else if (gameState === "ready") statusElement.textContent = "先にスタートQRコードを読み取ってください。";
    return;
  }
  statusElement.textContent = "登録されていないQRコードです。";
}

function startGame() {
  if (gameState !== "ready") return;
  gameState = "running";
  startTime = Date.now();
  timeElement.textContent = formatTime(LIMIT_TIME);
  statusElement.textContent = "スタートしました！ゴールQRコードを読み取ってください。";
  timerInterval = window.setInterval(updateTimer, 30);
}

function updateTimer() {
  if (gameState !== "running" || startTime === null) return;
  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, LIMIT_TIME - elapsed);
  timeElement.textContent = formatTime(remaining);
  if (remaining <= 0) expireGame();
}

function finishGame() {
  if (gameState !== "running" || startTime === null) return;
  const elapsed = Date.now() - startTime;
  if (elapsed >= LIMIT_TIME) {
    expireGame();
    return;
  }

  clearInterval(timerInterval);
  timerInterval = null;
  gameState = "finished";
  finalTimeMs = Math.round(elapsed);
  finalDisplayTime = formatTime(finalTimeMs);
  timeElement.textContent = finalDisplayTime;
  statusElement.textContent = "ユーザー名を入力して記録してください。";
  document.getElementById("resultTime").textContent = "クリア時間：" + finalDisplayTime;
  submitArea.hidden = false;
  stopScanner();
}

function expireGame() {
  if (gameState !== "running") return;
  clearInterval(timerInterval);
  timerInterval = null;
  gameState = "expired";
  timeElement.textContent = "00:00.000";
  statusElement.textContent = "時間切れです。";
  stopScanner();
  document.getElementById("resultHeading").textContent = "時間切れです";
  submitArea.hidden = true;
}

function formatTime(milliseconds) {
  const ms = Math.max(0, Math.floor(milliseconds));
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const remainder = ms % 1000;
  return String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0") + "." +
    String(remainder).padStart(3, "0");
}

window.addEventListener("message", function(event) {
  const allowedOrigin = event.origin === "https://script.google.com" ||
    event.origin === "https://googleusercontent.com" ||
    event.origin.endsWith(".googleusercontent.com");
  if (!allowedOrigin) return;

  const data = event.data;
  if (!data || data.type !== "MAZE_SAVE_RESULT" || data.requestId !== pendingRequestId) return;

  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  if (data.ok) {
    gameState = "saved";
    submitButton.disabled = true;
    document.getElementById("submitStatus").textContent = data.message || "登録が完了しました。";
    statusElement.textContent = "ランキングへの登録が完了しました。";
  } else {
    submitButton.disabled = false;
    document.getElementById("submitStatus").textContent = "登録できませんでした：" + (data.message || "原因不明のエラー");
  }
  pendingRequestId = null;
});

function submitRecord() {
  if (gameState !== "finished" || !finalTimeMs) return;

  const name = document.getElementById("playerName").value.trim() || "名無しプレイヤー";
  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  pendingRequestId = requestId;
  submitButton.disabled = true;
  document.getElementById("submitStatus").textContent = "送信中...";

  const form = document.createElement("form");
  form.method = "POST";
  form.action = GAS_WEB_APP_URL;
  form.target = "gasResultFrame";
  form.acceptCharset = "UTF-8";
  form.style.display = "none";

  const values = { action: "saveRecord", requestId, name, timeMs: String(finalTimeMs) };
  Object.entries(values).forEach(([key, value]) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.appendChild(input);
  });
  document.body.appendChild(form);
  form.submit();
  window.setTimeout(() => form.remove(), 2000);

  pendingTimeout = window.setTimeout(() => {
    if (pendingRequestId === requestId) {
      document.getElementById("submitStatus").textContent =
        "GASから完了通知を受け取れませんでした。再送信前にスプレッドシートを確認してください。";
      submitButton.disabled = false;
      pendingRequestId = null;
      pendingTimeout = null;
    }
  }, 25000);
}

function initializeMazeApp() {
  if (!startCameraButton || !stopCameraButton || !submitButton || !statusElement || !cameraErrorElement) {
    if (statusElement) statusElement.textContent = "HTMLの一部が見つかりません。index.htmlを最新版にしてください。";
    return;
  }

  setCameraPreviewVisible(false);
  statusElement.textContent = "準備完了です。「カメラを起動」を押してください。";
  startCameraButton.addEventListener("click", startScanner);
  stopCameraButton.addEventListener("click", stopScanner);
  submitButton.addEventListener("click", submitRecord);

  const printButton = document.getElementById("printQrBtn");
  if (printButton) printButton.addEventListener("click", () => window.print());
  createQrCodes();
}

window.addEventListener("error", function(event) {
  if (cameraErrorElement) {
    cameraErrorElement.textContent = "JavaScriptエラー: " + (event.message || "スクリプトを実行できませんでした。");
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMazeApp, { once: true });
} else {
  initializeMazeApp();
}
