import RFB from "/novnc/core/rfb.js?v=upstream1";

const screen = document.querySelector("#screen");
const errorBanner = document.querySelector("#errorBanner");
screen.tabIndex = 0;

let rfb;
let refreshInFlight = false;
let remoteClipboardText = "";

refresh();
setInterval(refresh, 5000);

screen.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

screen.addEventListener("mousedown", () => {
  screen.focus();
});

async function sendClipboardToRemote(text) {
  if (!rfb || !text) {
    return false;
  }

  remoteClipboardText = text;
  rfb.clipboardPasteFrom(text);
  return true;
}

async function readBrowserClipboard() {
  if (!navigator.clipboard?.readText) {
    return "";
  }

  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}

document.addEventListener("paste", async (event) => {
  if (!rfb) {
    return;
  }

  const pastedText = event.clipboardData?.getData("text/plain") || "";
  if (!pastedText) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  await sendClipboardToRemote(pastedText);
}, true);

document.addEventListener("keydown", async (event) => {
  if (!rfb) {
    return;
  }

  const isPasteShortcut =
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === "v";

  if (!isPasteShortcut) {
    return;
  }

  try {
    const pastedText = await readBrowserClipboard();
    if (!(await sendClipboardToRemote(pastedText))) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  } catch {
    // Fall back to the browser's normal paste event path.
  }
}, true);

window.addEventListener("copy", async (event) => {
  if (!remoteClipboardText) {
    return;
  }

  event.clipboardData?.setData("text/plain", remoteClipboardText);
  event.preventDefault();
});

window.addEventListener("cut", async (event) => {
  if (!remoteClipboardText) {
    return;
  }

  event.clipboardData?.setData("text/plain", remoteClipboardText);
  event.preventDefault();
});

async function refresh() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;

  let payload;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/login");
      return;
    }
    if (!response.ok) {
      throw new Error(`Status request failed: ${response.status}`);
    }
    payload = await response.json();
  } catch {
    showError("Viewer status check failed.");
    refreshInFlight = false;
    return;
  }

  if (payload.status === "running") {
    clearError();
    connectVnc();
  } else {
    disconnectVnc();
    if (payload.lastError) {
      showError(payload.lastError);
    }
  }

  refreshInFlight = false;
}

function connectVnc() {
  if (rfb) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${window.location.host}/websockify`;

  rfb = new RFB(screen, url, {
    credentials: {},
    shared: true,
  });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = "#000000";
  rfb.clipViewport = false;
  rfb.focusOnClick = true;
  rfb.addEventListener("connect", () => {
    clearError();
  });
  rfb.addEventListener("clipboard", async (event) => {
    remoteClipboardText = event.detail?.text || "";
    if (!remoteClipboardText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(remoteClipboardText);
    } catch {
      // Browser clipboard access is best-effort; keyboard copy still works.
    }
  });
  rfb.addEventListener("disconnect", (event) => {
    rfb = null;
    remoteClipboardText = "";
    if (!event.detail?.clean) {
      showError("VNC connection dropped.");
    }
  });
  rfb.addEventListener("securityfailure", (event) => {
    showError(event.detail?.reason || "VNC security failure.");
  });
  rfb.addEventListener("credentialsrequired", () => {
    showError("VNC requested credentials unexpectedly.");
  });
}

function disconnectVnc() {
  if (!rfb) {
    return;
  }
  rfb.disconnect();
  rfb = null;
  remoteClipboardText = "";
  screen.innerHTML = "";
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}
