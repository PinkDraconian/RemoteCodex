import RFB from "/novnc/core/rfb.js?v=upstream1";

const screen = document.querySelector("#screen");
const errorBanner = document.querySelector("#errorBanner");

let rfb;
let refreshInFlight = false;

refresh();
setInterval(refresh, 5000);

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
  rfb.addEventListener("connect", () => {
    clearError();
  });
  rfb.addEventListener("disconnect", (event) => {
    rfb = null;
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
