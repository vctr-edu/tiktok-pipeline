
const API_BASE_URL = "https://broken-reflection-api.onrender.com";
const postForm = document.querySelector("#postForm");
const file = document.querySelector("#videoFile");
const caption = document.querySelector("#caption");
const fileLabel = document.querySelector("#fileLabel");
const hashtagButton = document.querySelector("#hashtagButton");
const counter = document.querySelector("#counter");

hashtagButton.addEventListener("click", () => {
  const tags = "#brokenreflection #wavephonk #ambient";

  const existingTags = caption.value.includes("#brokenreflection");

  if (!existingTags) {
    caption.value += `${caption.value.trim() ? "\n\n" : ""}${tags}`;
  }

  caption.dispatchEvent(new Event("input", { bubbles: true }));

  if (counter) {
    counter.textContent = `${caption.value.length} / 2200`;
  }
});

file.addEventListener("change", () => {
  const selectedFile = file.files[0];

  fileLabel.textContent = selectedFile
    ? selectedFile.name
    : "Choose a finished video";
});

// These controls are created in JavaScript to avoid requiring HTML changes.

const publishingPanel = document.createElement("section");
publishingPanel.id = "publishingPanel";

publishingPanel.style.cssText = `
  display: grid;
  gap: 14px;
  margin-top: 0;
  margin-bottom: 24px;
  padding: 20px;
  border: 1px solid rgba(159,194,255,.16);
  border-radius: 14px;
  background: rgba(4,11,20,.35);
  color: #eef5ff;
  font: 12px Manrope, Arial, sans-serif;
`;

publishingPanel.innerHTML = `
  <h3 style="margin:0">TikTok publishing</h3>
  <label>
    Dashboard password
    <input id="dashboardPassword" type="password"
      autocomplete="current-password"
      style="display:block;width:100%;box-sizing:border-box;margin-top:6px">
  </label>
  <button id="dashboardLogin" type="button">Sign in</button>
  <p id="dashboardStatus" role="status" aria-live="polite">
    Sign in to load TikTok publishing settings.
  </p>
  <label>
    Privacy
    <select id="privacySelect" disabled
      style="display:block;width:100%;margin-top:6px"></select>
  </label>
  <label><input id="allowComments" type="checkbox" disabled> Allow comments</label>
  <label><input id="allowDuet" type="checkbox" disabled> Allow Duet</label>
  <label><input id="allowStitch" type="checkbox" disabled> Allow Stitch</label>
  <label>
    <input id="publishConsent" type="checkbox">
    I confirm that I own or have permission to publish this video and want to send it to TikTok.
  </label>
`;

const composerHeading = postForm.querySelector(".section-label");
composerHeading.insertAdjacentElement("afterend", publishingPanel);
publishingPanel.style.marginTop = "0";
publishingPanel.style.marginBottom = "24px";

const dashboardPassword = document.querySelector("#dashboardPassword");
const dashboardLogin = document.querySelector("#dashboardLogin");
const dashboardStatus = document.querySelector("#dashboardStatus");
const privacySelect = document.querySelector("#privacySelect");
const allowComments = document.querySelector("#allowComments");
const allowDuet = document.querySelector("#allowDuet");
const allowStitch = document.querySelector("#allowStitch");
const publishConsent = document.querySelector("#publishConsent");

let dashboardToken = sessionStorage.getItem("br_dashboard_token");
let creatorSettings = null;
let currentPublishId = null;

function setDashboardStatus(message) {
  dashboardStatus.textContent = message;
}

function setPublishingControlsEnabled(enabled) {
  privacySelect.disabled = !enabled;
  allowComments.disabled = !enabled || creatorSettings?.commentDisabled;
  allowDuet.disabled = !enabled || creatorSettings?.duetDisabled;
  allowStitch.disabled = !enabled || creatorSettings?.stitchDisabled;
}

async function dashboardFetch(path, options = {}) {
  if (!dashboardToken) {
    throw new Error("Sign in to continue.");
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${dashboardToken}`
    }
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401) {
    dashboardToken = null;
    sessionStorage.removeItem("br_dashboard_token");
    throw new Error("Session expired. Sign in again.");
  }

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

async function loadCreatorSettings() {
  setDashboardStatus("Loading TikTok creator settings...");

  creatorSettings = await dashboardFetch("/api/tiktok/creator-info");

  privacySelect.replaceChildren();

  for (const privacy of creatorSettings.privacyOptions || []) {
    const option = document.createElement("option");
    option.value = privacy;
    option.textContent = privacy;
    privacySelect.appendChild(option);
  }

  // Sandbox should only use private visibility.
  if ([...privacySelect.options].some(option => option.value === "SELF_ONLY")) {
    privacySelect.value = "SELF_ONLY";
  }

  allowComments.checked = !creatorSettings.commentDisabled;
  allowDuet.checked = !creatorSettings.duetDisabled;
  allowStitch.checked = !creatorSettings.stitchDisabled;

  setPublishingControlsEnabled(privacySelect.options.length > 0);

  setDashboardStatus(
    `Settings loaded for ${creatorSettings.nickname || creatorSettings.username || "your TikTok account"}.`
  );
}

dashboardLogin.addEventListener("click", async () => {
  const password = dashboardPassword.value;

  if (!password) {
    setDashboardStatus("Enter your dashboard password.");
    return;
  }

  dashboardLogin.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/dashboard/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Sign-in failed.");
    }

    dashboardToken = data.token;
    sessionStorage.setItem("br_dashboard_token", dashboardToken);
    dashboardPassword.value = "";

    await loadCreatorSettings();
  } catch (error) {
    setDashboardStatus(error.message);
  } finally {
    dashboardLogin.disabled = false;
  }
});

async function checkPublishStatus(publishId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    const data = await dashboardFetch("/api/tiktok/publish-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publishId })
    });

    setDashboardStatus(`TikTok status: ${data.status}`);

    if (data.status === "PUBLISH_COMPLETE") {
      setDashboardStatus("TikTok reports that publishing is complete.");
      return;
    }

    if (data.status === "FAILED") {
      setDashboardStatus(
        `TikTok publishing failed: ${data.failReason || "Unknown reason"}`
      );
      return;
    }

    if (data.status === "SEND_TO_USER_INBOX") {
      setDashboardStatus(
        "Video sent to TikTok. Open TikTok to finish the post in your inbox."
      );
      return;
    }
  }

  setDashboardStatus(
    `Still processing. Use publish ID ${publishId} to check again later.`
  );
}

postForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!dashboardToken) {
    setDashboardStatus("Sign in before publishing.");
    return;
  }

  const selectedFile = file.files[0];

  if (!selectedFile) {
    setDashboardStatus("Choose a video first.");
    return;
  }

  if (!publishConsent.checked) {
    setDashboardStatus("Confirm your consent before publishing.");
    return;
  }

  if (!privacySelect.value) {
    setDashboardStatus("Load and choose an allowed privacy setting.");
    return;
  }

  const formData = new FormData();
  formData.append("video", selectedFile);
  formData.append("caption", caption.value);
  formData.append("privacy", privacySelect.value);
  formData.append("consent", "true");
  formData.append("disableComment", String(!allowComments.checked));
  formData.append("disableDuet", String(!allowDuet.checked));
  formData.append("disableStitch", String(!allowStitch.checked));

  
  const submitButton = postForm.querySelector('[type="submit"]');
  if (submitButton) submitButton.disabled = true;

  try {
    setDashboardStatus("Uploading video to the backend...");

    // XMLHttpRequest exposes browser-to-backend upload progress.
    // The backend then uploads the file to TikTok.
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/api/tiktok/publish`);
      xhr.setRequestHeader("Authorization", `Bearer ${dashboardToken}`);

      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          const percent = Math.round(event.loaded / event.total * 100);
          setDashboardStatus(`Sending video to backend: ${percent}%`);
        }
      };

      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {}

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(data.error || "Upload failed."));
        }
      };

      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.send(formData);
    });

    currentPublishId = result.publishId;
    setDashboardStatus(
      `Video sent to TikTok. Publish ID: ${currentPublishId}. Checking status...`
    );

    await checkPublishStatus(currentPublishId);
  } catch (error) {
    setDashboardStatus(error.message);
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
});

// A token in sessionStorage is short-lived, but still clear it when the tab closes.
if (dashboardToken) {
  loadCreatorSettings().catch(error => {
    setDashboardStatus(error.message);
  });
}

// Connect TikTok button
const connectionButton = document.querySelector("#connectButton");

if (connectionButton) {
  connectionButton.addEventListener("click", () => {
    window.location.href = `${API_BASE_URL}/tiktok/authorize`;
  });
}

// Restore TikTok connection status on page load
async function loadTikTokProfile() {
  const connectionLabel = document.querySelector("#connectionLabel");
  const connectionButton = document.querySelector("#connectButton");

  try {
    const response = await fetch(`${API_BASE_URL}/api/tiktok/profile`);
    if (!response.ok) throw new Error("Profile request failed");

    const data = await response.json();

    if (data.connected && data.profileAvailable && data.profile) {
      connectionLabel.textContent =
        data.profile.displayName || "TikTok connected";

      connectionButton.classList.add("connected");

      const icon = connectionButton.querySelector(".tiktok-mark");

      if (icon && data.profile.avatarUrl) {
        const avatar = document.createElement("img");
        avatar.src = data.profile.avatarUrl;
        avatar.alt = "TikTok profile";
        avatar.style.cssText =
          "width:28px;height:28px;border-radius:50%;object-fit:cover;";

        icon.replaceWith(avatar);
      }
    }
  } catch (error) {
    console.error("Could not restore TikTok connection:", error);
  }
}

loadTikTokProfile();
