/* =========================================================
   脱出迷宮：ローカルブラウザ版
   1) GAS_WEB_APP_URL にGASウェブアプリの /exec URLを設定
   2) START_QR_VALUE / GOAL_QR_VALUE はQR印刷ページと共通の値
   ========================================================= */

const GAS_WEB_APP_URL = "ここにGASウェブアプリの_exec_URLを貼り付ける";
const START_QR_VALUE = "MAZE_START_V1";
const GOAL_QR_VALUE = "MAZE_GOAL_V1";
const LIMIT_TIME = 8 * 60 * 1000;

let gameState = "ready"; // ready / running / finished / expired / saved
let startTime = null;
let timerInterval = null;
let mediaStream = null;
let scanInterval = null;
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

// QRコードを画面に作成する
function createQrCodes() {
  if (typeof QRCode === "undefined") {
    document.getElementById("startQr").textContent = "QRコード生成ライブラリを読み込めませんでした。インターネット接続を確認してください。";
    document.getElementById("goalQr").textContent = "QRコード生成ライブラリを読み込めませんでした。";
    return;
  }

  new QRCode(document.getElementById("startQr"), {
    text: START_QR_VALUE,
    width: 220,
    height: 220,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });

  new QRCode(document.getElementById("goalQr"), {
    text: GOAL_QR_VALUE,
    width: 220,
    height: 220,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
}

// カメラを起動（ボタン操作から呼び出す）
async function startScanner() {
  cameraErrorElement.textContent = "";
  statusElement.textContent = "カメラ起動処理を開始しました。";

  if (mediaStream) {
    statusElement.textContent = "カメラはすでに起動しています。QRコードを映してください。";
    return;
  }
  if (!window.isSecureContext) {
    cameraErrorElement.textContent = "このページはカメラを使える安全な接続ではありません。HTTPSまたはlocalhostで開いてください。現在のURL: " + location.protocol;
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    cameraErrorElement.textContent = "Chromeからカメラ機能を利用できません（navigator.mediaDevices がありません）。ページのURLと学校の管理設定を確認してください。";
    return;
  }
  if (!canvasContext) {
    cameraErrorElement.textContent = "QR読み取り用のcanvasを準備できませんでした。index.htmlのscanCanvasを確認してください。";
    return;
  }
  if (typeof window.jsQR !== "function") {
    cameraErrorElement.textContent = "QRコード読み取りライブラリ(jsQR)を読み込めませんでした。学校のネットワークでCDNへの接続が制限されている可能性があります。";
    return;
  }

  startCameraButton.disabled = true;
  startCameraButton.textContent = "カメラ起動中...";

  try {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false
      });
    } catch (firstError) {
      // Chromebookのカメラがenvironment指定に対応しない場合の再試行
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }

    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = mediaStream;
    await video.play();

    // 映像の準備ができたらプレースホルダーを隠してプレビューを表示
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => reject(new Error("カメラ映像の読み込みがタイムアウトしました。")), 8000);
        video.addEventListener("loadeddata", () => {
          window.clearTimeout(timeoutId);
          resolve();
        }, { once: true });
      });
    }
    cameraPlaceholder.hidden = true;
    if (videoFrame) videoFrame.classList.add("is-active");
    stopCameraButton.disabled = false;
    startCameraButton.textContent = "カメラ起動中";
    statusElement.textContent = gameState === "running"
      ? "ゴール用QRコードを読み取ってください。"
      : "スタート用QRコードを読み取ってください。";

    scanInterval = window.setInterval(scanFrame, 140);
  } catch (error) {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
    mediaStream = null;
    video.pause();
    video.srcObject = null;
    cameraPlaceholder.hidden = false;
    if (videoFrame) videoFrame.classList.remove("is-active");
    startCameraButton.disabled = false;
    startCameraButton.textContent = "カメラを起動";
    cameraErrorElement.textContent = cameraErrorMessage(error) +
      "（" + (error && error.name ? error.name : "UnknownError") +
      (error && error.message ? ": " + error.message : "") + "）";
  }
}

function cameraErrorMessage(error) {
  if (error && error.name === "NotAllowedError") {
    return "カメラへのアクセスが拒否されました。Chromeの権限、Chromebookのカメラ設定、学校管理者のカメラ制限を確認してください。";
  }
  if (error && error.name === "NotFoundError") {
    return "利用できるカメラが見つかりません。Chromebookのカメラアプリでカメラが動くか確認してください。";
  }
  if (error && error.name === "NotReadableError") {
    return "カメラを起動できません。ほかのアプリがカメラを使用中でないか確認してください。";
  }
  if (error && error.name === "SecurityError") {
    return "ブラウザまたは学校の管理ポリシーによってカメラ利用が制限されている可能性があります。";
  }
  return "カメラを起動できませんでした。Chromeのカメラ権限と学校の管理設定を確認してください。";
}

// カメラを停止する
function stopScanner() {
  if (scanInterval !== null) {
    clearInterval(scanInterval);
    scanInterval = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  video.pause();
  video.srcObject = null;
  cameraPlaceholder.hidden = false;
  if (videoFrame) videoFrame.classList.remove("is-active");
  startCameraButton.disabled = gameState === "finished" || gameState === "expired" || gameState === "saved";
  startCameraButton.textContent = "カメラを起動";
  stopCameraButton.disabled = true;
}

// カメラ映像からQRコードを探す
function scanFrame() {
  if (!mediaStream || !canvasContext || video.readyState !== video.HAVE_ENOUGH_DATA || video.videoWidth === 0) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);

  const imageData = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
  const qr = window.jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "dontInvert"
  });

  if (qr && qr.data) {
    const now = Date.now();
    if (now - lastQrAt > 1200) {
      lastQrAt = now;
      handleQrCode(qr.data.trim());
    }
  }
}

// START / GOALを判定
function handleQrCode(value) {
  if (value === START_QR_VALUE) {
    if (gameState === "ready") {
      startGame();
    }
    return;
  }

  if (value === GOAL_QR_VALUE) {
    if (gameState === "running") {
      finishGame();
    } else if (gameState === "ready") {
      statusElement.textContent = "先にスタート用QRコードを読み取ってください。";
    }
    return;
  }

  statusElement.textContent = "登録されていないQRコードです。スタートまたはゴール用QRコードを読み取ってください。";
}

// スタートQR読み取り時
function startGame() {
  if (gameState !== "ready") return;

  gameState = "running";
  startTime = Date.now();
  timeElement.textContent = formatTime(LIMIT_TIME);
  statusElement.textContent = "スタートしました！ゴール用QRコードを読み取ってください。";
  timerInterval = window.setInterval(updateTimer, 30);
}

// タイマー更新
function updateTimer() {
  if (gameState !== "running" || startTime === null) return;

  const elapsed = Date.now() - startTime;
  const remaining = Math.max(0, LIMIT_TIME - elapsed);
  timeElement.textContent = formatTime(remaining);

  if (remaining <= 0) {
    expireGame();
  }
}

// GOAL QR読み取り時
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
  statusElement.textContent = "ゴールしました！ユーザー名を入力して記録してください。";
  document.getElementById("resultTime").textContent = "クリア時間：" + finalDisplayTime;
  submitArea.hidden = false;
  stopScanner();
}

// 8分経過
function expireGame() {
  if (gameState !== "running") return;

  clearInterval(timerInterval);
  timerInterval = null;
  gameState = "expired";
  timeElement.textContent = "00:00.000";
  statusElement.textContent = "時間切れです。今回の記録は登録できません。";
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

// GASのdoPostから返る結果を受け取る
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

// GASにフォーム形式でPOSTする（ブラウザのCORS制限を避ける方法）
function submitRecord() {
  if (gameState !== "finished" || !finalTimeMs) return;

  if (!GAS_WEB_APP_URL.startsWith("https://script.google.com/macros/s/") || !GAS_WEB_APP_URL.endsWith("/exec")) {
    document.getElementById("submitStatus").textContent = "app.jsのGAS_WEB_APP_URLに、デプロイしたウェブアプリの /exec URLを設定してください。";
    return;
  }

  const nameInput = document.getElementById("playerName");
  const name = nameInput.value.trim() || "名無しプレイヤー";
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
        "GASから完了通知を受け取れませんでした。スプレッドシートに記録が追加されていないか先に確認してください。記録がなければ、GASのデプロイ設定（実行ユーザー：自分／アクセスできるユーザー：学校で許可された範囲）、/exec URL、GASの「実行数」に doPost が記録されているかを確認してください。";
      submitButton.disabled = false;
      pendingRequestId = null;
      pendingTimeout = null;
    }
  }, 25000);
}

// JavaScriptが正常に読み込まれたことを画面に表示する
function initializeMazeApp() {
  if (!startCameraButton || !stopCameraButton || !submitButton || !statusElement || !cameraErrorElement) {
    const message = "アプリのHTML要素が見つかりません。index.htmlとapp.jsが同じ版か確認してください。";
    if (statusElement) statusElement.textContent = message;
    if (cameraErrorElement) cameraErrorElement.textContent = message;
    return;
  }

  statusElement.textContent = "JavaScriptの読み込みが完了しました。カメラを起動してください。";
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
