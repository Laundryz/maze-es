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

// HTML要素
const video = document.getElementById("cameraPreview");
const canvas = document.getElementById("scanCanvas");
const canvasContext = canvas ? canvas.getContext("2d", { willReadFrequently: true }) : null;
const timeElement = document.getElementById("time");
const statusElement = document.getElementById("gameStatus");
const cameraErrorElement = document.getElementById("cameraError");
const startCameraButton = document.getElementById("startCameraBtn");
const stopCameraButton = document.getElementById("stopCameraBtn");
const cameraPlaceholder = document.getElementById("cameraPlaceholder");
const submitArea = document.getElementById("submitArea");
const submitButton = document.getElementById("submitBtn");

function setStatus(message) {
  if (statusElement) statusElement.textContent = message || "";
}

function setCameraError(message) {
  if (cameraErrorElement) cameraErrorElement.textContent = message || "";
}

// カメラ映像と停止中メッセージの表示を切り替える
function setCameraPreviewVisible(visible) {
  if (!cameraPlaceholder || !video) return;

  cameraPlaceholder.hidden = false;
  cameraPlaceholder.classList.toggle("is-active", Boolean(visible));
  video.style.visibility = visible ? "visible" : "hidden";
  video.style.opacity = visible ? "1" : "0";
}

function waitForVideoReady(timeoutMs = 10000) {
  if (
    video.videoWidth > 0 &&
    video.videoHeight > 0 &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeEventListener("loadedmetadata", check);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("canplay", check);
      video.removeEventListener("error", onError);
    };
    const check = () => {
      if (
        video.videoWidth > 0 &&
        video.videoHeight > 0 &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        cleanup();
        resolve();
      }
    };
    const onError = () => {
      cleanup();
      reject(new Error("カメラを読み込めませんでした。"));
    };

    video.addEventListener("loadedmetadata", check);
    video.addEventListener("loadeddata", check);
    video.addEventListener("canplay", check);
    video.addEventListener("error", onError);
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("カメラは取得できましたが、映像の準備が10秒以内に完了しませんでした。"));
    }, timeoutMs);
    check();
  });
}

// QR読み取り方式を選択。jsQRが使えなければChrome標準APIを試す
async function prepareQrScanner() {
  if (typeof window.jsQR === "function") return "jsQR";

  if ("BarcodeDetector" in window) {
    try {
      nativeBarcodeDetector = new window.BarcodeDetector({ formats: ["qr_code"] });
      return "BarcodeDetector";
    } catch (error) {
      nativeBarcodeDetector = null;
    }
  }

  return "preview-only";
}

// カメラを起動
async function startScanner() {
  setCameraError("");
  setStatus("カメラを確認しています...");

  if (mediaStream) {
    setStatus("カメラ起動中。QRコードを映してください。");
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCameraError("このページではカメラを利用できません。");
    setStatus("カメラを起動できませんでした。");
    return;
  }

  startCameraButton.disabled = true;
  startCameraButton.textContent = "カメラ起動中...";

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = mediaStream;

    setStatus("カメラを取得しました。映像を準備しています...");
    await video.play();
    await waitForVideoReady();

    setCameraPreviewVisible(true);
    stopCameraButton.disabled = false;
    startCameraButton.textContent = "カメラ起動中";

    const scannerMode = await prepareQrScanner();
    if (scannerMode === "jsQR") {
      setStatus(gameState === "running"
        ? "カメラ映像を表示中です。ゴール用QRコードを読み取ってください。"
        : "カメラ映像を表示中です。スタート用QRコードを読み取ってください。");
      scanInterval = window.setInterval(scanFrame, 140);
    } else if (scannerMode === "BarcodeDetector") {
      setStatus("カメラ映像を表示中です。Chrome標準機能でQRコードを読み取ります。");
      scanInterval = window.setInterval(scanFrame, 250);
    } else {
      setStatus("カメラ映像は表示されています。");
      setCameraError("QR読み取りライブラリを読み込めませんでした。");
    }

    const track = mediaStream.getVideoTracks()[0];
    if (track) {
      track.addEventListener("ended", () => {
        if (mediaStream) stopScanner();
        setCameraError("カメラ映像が終了しました。もう一度起動してください。");
      }, { once: true });
    }
  } catch (error) {
    releaseCamera();
    setCameraPreviewVisible(false);
    startCameraButton.disabled = false;
    startCameraButton.textContent = "カメラを起動";
    setCameraError(cameraErrorMessage(error) + "（" + (error.name || "UnknownError") + (error.message ? ": " + error.message : "") + "）");
    setStatus("カメラを起動できませんでした。表示されたエラーを確認してください。");
  }
}

function cameraErrorMessage(error) {
  if (error && error.name === "NotAllowedError") return "カメラへのアクセスが拒否されました。Chromeのサイト設定を確認してください。";
  if (error && error.name === "NotFoundError") return "カメラが見つかりません。";
  if (error && error.name === "NotReadableError") return "カメラを使用できません。ほかのアプリがカメラを使用していないか確認してください。";
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

// カメラ映像の1フレームからQRコードを読み取る
async function scanFrame() {
  if (
    !mediaStream || scanBusy || !video ||
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth === 0
  ) return;

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
      if (codes && codes.length > 0 && codes[0].rawValue) {
        decodedValue = codes[0].rawValue.trim();
      }
    }

    if (decodedValue) {
      const now = Date.now();
      if (now - lastQrAt > 1200) {
        lastQrAt = now;
        handleQrCode(decodedValue);
      }
    }
  } catch (error) {
    // QRを認識できないフレームは読み飛ばす。連続エラーはコンソールに記録する。
    console.warn("QRフレーム読み取りエラー:", error);
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
    else if (gameState === "ready") setStatus("先にスタートQRコードを読み取ってください。");
    return;
  }
  setStatus("登録されていないQRコードです。");
}

// 残り時間に応じてタイマーの色を切り替える
function updateTimerColor(remainingMs) {
  if (!timeElement) return;

  // いったん通常色に戻し、該当する色だけを適用する
  timeElement.classList.remove("timer-warning", "timer-danger");

  if (remainingMs <= 60 * 1000) {
    // 残り1分以下：赤色
    timeElement.classList.add("timer-danger");
  } else if (remainingMs <= 3 * 60 * 1000) {
    // 残り3分以下：黄色
    timeElement.classList.add("timer-warning");
  }
}

function startGame() {
  if (gameState !== "ready") return;
  gameState = "running";
  startTime = Date.now();
  timeElement.textContent = formatTime(LIMIT_TIME);
  updateTimerColor(LIMIT_TIME);
  setStatus("スタートしました！ゴールQRコードを読み取ってください。");
  timerInterval = window.setInterval(updateTimer, 30);
}

function updateTimer() {
  if (gameState !== "running" || startTime === null) return;
  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, LIMIT_TIME - elapsed);
  timeElement.textContent = formatTime(remaining);
  updateTimerColor(remaining);
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
  // ゴール後は残り時間ではなくクリアタイムを表示するため通常色に戻す
  updateTimerColor(LIMIT_TIME);
  setStatus("ゴールしました！ユーザー名を入力して記録してください。");
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
  updateTimerColor(0);
  setStatus("時間切れです。");
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

// GASからの結果通知を受け取る
window.addEventListener("message", function(event) {
  const origin = event.origin || "";
  const allowedOrigin = origin === "https://script.google.com" ||
    origin === "https://googleusercontent.com" ||
    origin.endsWith(".googleusercontent.com");
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
    setStatus("ランキングへの登録が完了しました。");
  } else {
    submitButton.disabled = false;
    document.getElementById("submitStatus").textContent = "登録できませんでした：" + (data.message || "原因不明のエラー");
  }
  pendingRequestId = null;
});

// GASへフォーム形式でPOSTする
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

  const values = {
    action: "saveRecord",
    requestId: requestId,
    name: name,
    timeMs: String(finalTimeMs)
  };
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
  const required = [video, canvas, timeElement, statusElement, startCameraButton,
    stopCameraButton, cameraPlaceholder, submitArea, submitButton];
  if (required.some(element => !element)) {
    setStatus("HTMLの必要な要素が見つかりません。");
    setCameraError("HTMLの必要な要素が不足しているため、アプリを初期化できません。");
    return;
  }

  setCameraPreviewVisible(false);
  setStatus("準備完了。「カメラを起動」を押してください。");
  startCameraButton.addEventListener("click", startScanner);
  stopCameraButton.addEventListener("click", stopScanner);
  submitButton.addEventListener("click", submitRecord);
}

// 同一サイト内のJavaScriptエラーは、詳細情報を表示する。
// 外部CDNのエラーはブラウザ仕様で「Script error.」だけになる場合がある。
window.addEventListener("error", function(event) {
  if (!cameraErrorElement) return;

  if (event.message === "Script error." || !event.message) {
    setCameraError("外部スクリプトエラー");
    return;
  }

  const location = event.filename
    ? "（" + event.filename.split("/").pop() + ":" + (event.lineno || "?") + "）"
    : "";
  setCameraError("JavaScriptエラー: " + event.message + location);
});

window.addEventListener("unhandledrejection", function(event) {
  if (!cameraErrorElement) return;
  const reason = event.reason;
  setCameraError("非同期処理エラー: " + (reason && reason.message ? reason.message : String(reason)));
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeMazeApp, { once: true });
} else {
  initializeMazeApp();
}
