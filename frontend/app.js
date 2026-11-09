const API_BASE_URL = "https://broken-reflection-api.onrender.com";
const $ = selector => document.querySelector(selector);

const postForm = $("#postForm");
const videoInput = $("#videoFile");
const videoPreview = $("#videoPreview");
const previewPlaceholder = $("#previewPlaceholder");
const videoMeta = $("#videoMeta");
const caption = $("#caption");
const privacySelect = $("#privacySelect");
const allowComments = $("#allowComments");
const allowDuet = $("#allowDuet");
const allowStitch = $("#allowStitch");
const publishConsent = $("#publishConsent");
const dashboardPassword = $("#dashboardPassword");
const dashboardLogin = $("#dashboardLogin");
const dashboardLogout = $("#dashboardLogout");
const dashboardStatus = $("#dashboardStatus");
const postStatus = $("#postStatus");
const publishButton = $("#publishButton");
const commercialDisclosure = $("#commercialDisclosure");
const commercialOptions = $("#commercialOptions");
const brandOrganic = $("#brandOrganic");
const brandContent = $("#brandContent");
const disclosureNotice = $("#disclosureNotice");
const brandedPrivacyNote = $("#brandedPrivacyNote");
const brandedConsent = $("#brandedConsent");
const interactionGroup = $("#interactionGroup");
const disclosureGroup = $("#disclosureGroup");
const accountSelect = $("#accountSelect");

let dashboardToken = sessionStorage.getItem("br_dashboard_token");
let selectedAccountKey = sessionStorage.getItem("br_tiktok_account") || "tsr_music";
let creatorSettings = null;
let selectedVideoUrl = null;
let videoDuration = null;

const params = new URLSearchParams(window.location.search);
if (params.get("tiktok") === "connected") sessionStorage.setItem("br_tiktok_connected", "true");
if (["tsr_music", "broken_reflection"].includes(params.get("account"))) {
  selectedAccountKey = params.get("account");
  sessionStorage.setItem("br_tiktok_account", selectedAccountKey);
}
accountSelect.value = selectedAccountKey;
if (params.has("tiktok")) window.history.replaceState({}, document.title, window.location.pathname);

function setDashboardStatus(message) { dashboardStatus.textContent = message; }
function setPostStatus(message) { postStatus.textContent = message || ""; }

async function dashboardFetch(path, options = {}) {
  if (!dashboardToken) throw new Error("Sign in to continue.");
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${dashboardToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    dashboardToken = null;
    sessionStorage.removeItem("br_dashboard_token");
    throw new Error("Session expired. Sign in again.");
  }
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function updateDisclosureUI() {
  const enabled = commercialDisclosure.checked;
  commercialOptions.hidden = !enabled;
  brandedConsent.hidden = !enabled || !brandContent.checked;
  const hasSelection = brandOrganic.checked || brandContent.checked;
  disclosureNotice.hidden = !enabled || !hasSelection;
  if (enabled && hasSelection) {
    const labels = [];
    if (brandOrganic.checked) labels.push("Promotional content");
    if (brandContent.checked) labels.push("Paid partnership");
    disclosureNotice.textContent = `TikTok will label this post as: ${labels.join(" and ")}.`;
  }
  brandedPrivacyNote.hidden = !brandContent.checked;
  updatePrivacyAvailability();
  updatePublishEligibility();
}

function updatePrivacyAvailability() {
  const branded = brandContent.checked && commercialDisclosure.checked;
  let selectedBecameUnavailable = false;
  for (const option of privacySelect.options) {
    const disabled = branded && option.value === "SELF_ONLY";
    if (disabled && option.selected) selectedBecameUnavailable = true;
    option.disabled = disabled;
  }
  if (selectedBecameUnavailable) privacySelect.value = "";
}

function updatePublishEligibility() {
  const hasFile = Boolean(videoInput.files?.[0]);
  const hasAccount = Boolean(creatorSettings && dashboardToken);
  const durationOkay = !hasFile || !videoDuration || !creatorSettings?.maxVideoDurationSec || videoDuration <= creatorSettings.maxVideoDurationSec;
  const disclosureOkay = !commercialDisclosure.checked || brandOrganic.checked || brandContent.checked;
  const canPublish = hasFile && hasAccount && Boolean(privacySelect.value) && publishConsent.checked && durationOkay && disclosureOkay;
  publishButton.disabled = !canPublish;

  if (!hasFile) {
    $("#qualityTitle").textContent = "Ready when you are";
    $("#qualityMessage").textContent = "Select a video and connect TikTok to review post settings.";
  } else if (!hasAccount) {
    $("#qualityTitle").textContent = "Connect your account";
    $("#qualityMessage").textContent = "Sign in and connect TikTok to load current account permissions.";
  } else if (!durationOkay) {
    $("#qualityTitle").textContent = "Video exceeds TikTok's limit";
    $("#qualityMessage").textContent = `This account can post videos up to ${creatorSettings.maxVideoDurationSec} seconds. Choose a shorter video.`;
  } else if (!privacySelect.value || !publishConsent.checked || !disclosureOkay) {
    $("#qualityTitle").textContent = "Review your post settings";
    $("#qualityMessage").textContent = !privacySelect.value
      ? "Choose who can watch, review the disclosure selection, and agree to the confirmations."
      : !disclosureOkay
        ? "Choose at least one commercial content type or turn disclosure off."
        : "Review the disclosure selection and agree to the confirmations before posting.";
  } else {
    $("#qualityTitle").textContent = "Ready to publish";
    $("#qualityMessage").textContent = `Your video is within TikTok's ${creatorSettings.maxVideoDurationSec || "allowed"} second limit. Check the preview and post settings.`;
  }
}

async function loadCreatorSettings() {
  setDashboardStatus("Loading current TikTok account settings...");
  creatorSettings = await dashboardFetch(`/api/tiktok/creator-info?accountKey=${encodeURIComponent(selectedAccountKey)}`);
  privacySelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose a privacy setting";
  privacySelect.appendChild(placeholder);
  for (const privacy of creatorSettings.privacyOptions || []) {
    const option = document.createElement("option");
    option.value = privacy;
    option.textContent = ({ PUBLIC_TO_EVERYONE: "Everyone", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Only you" })[privacy] || privacy;
    privacySelect.appendChild(option);
  }
  privacySelect.disabled = privacySelect.options.length <= 1;
  interactionGroup.disabled = false;
  disclosureGroup.disabled = false;
  allowComments.checked = false;
  allowDuet.checked = false;
  allowStitch.checked = false;
  allowComments.disabled = Boolean(creatorSettings.commentDisabled);
  allowDuet.disabled = Boolean(creatorSettings.duetDisabled);
  allowStitch.disabled = Boolean(creatorSettings.stitchDisabled);
  $("#creatorName").textContent = creatorSettings.nickname || creatorSettings.username || "TikTok creator";
  setDashboardStatus(`Settings loaded for ${creatorSettings.nickname || creatorSettings.username || "your TikTok account"}. Choose the post options yourself.`);
  updatePrivacyAvailability();
  updatePublishEligibility();
}

async function loadTikTokProfile() {
  if (!dashboardToken) return;
  const data = await dashboardFetch(`/api/tiktok/profile?accountKey=${encodeURIComponent(selectedAccountKey)}`, { cache: "no-store" });
  const label = $("#connectionLabel");
  const button = $("#connectButton");
  if (data.connected && data.profile) {
    label.textContent = data.profile.displayName || creatorSettings?.nickname || "TikTok connected";
    button.classList.add("connected");
    $("#connectionStatus").textContent = "Connected";
    const avatar = button.querySelector(".tiktok-mark");
    if (data.profile.avatarUrl && avatar && avatar.tagName !== "IMG") {
      const image = document.createElement("img");
      image.className = "tiktok-mark";
      image.alt = "";
      image.src = data.profile.avatarUrl;
      avatar.replaceWith(image);
    } else if (data.profile.avatarUrl && avatar?.tagName === "IMG") {
      avatar.src = data.profile.avatarUrl;
    }
  } else {
    label.textContent = "Connect TikTok";
    button.classList.remove("connected");
    $("#connectionStatus").textContent = "Connect";
  }
}

async function loadSelectedAccount() {
  if (!dashboardToken) return;
  try {
    const data = await dashboardFetch("/api/tiktok/accounts", { cache: "no-store" });
    const slots = new Map((data.accounts || []).map(account => [account.key, account]));
    for (const option of accountSelect.options) {
      const slot = slots.get(option.value);
      if (slot) option.textContent = `${slot.name}${slot.connected ? " · Connected" : " · Connect"}`;
    }
    const slot = slots.get(selectedAccountKey);
    if (!slot?.connected) {
      creatorSettings = null;
      privacySelect.disabled = true;
      privacySelect.replaceChildren(new Option("Connect this TikTok account first", ""));
      interactionGroup.disabled = true;
      disclosureGroup.disabled = true;
      $("#creatorName").textContent = `Connect ${slot?.name || "TikTok account"}`;
      $("#connectionLabel").textContent = slot?.name || "TikTok account";
      $("#connectionStatus").textContent = "Connect";
      $("#connectButton").classList.remove("connected");
      setDashboardStatus(`${slot?.name || "This account"} is not connected yet. Select Connect TikTok to authorize it.`);
      updatePublishEligibility();
      return;
    }
    await Promise.all([loadCreatorSettings(), loadTikTokProfile()]);
  } catch (error) {
    setDashboardStatus(error.message);
  }
}

videoInput.addEventListener("change", () => {
  const selectedFile = videoInput.files?.[0];
  $("#fileLabel").textContent = selectedFile?.name || "Choose a video";
  if (selectedVideoUrl) URL.revokeObjectURL(selectedVideoUrl);
  videoDuration = null;
  if (!selectedFile) {
    videoPreview.hidden = true;
    videoPreview.removeAttribute("src");
    previewPlaceholder.hidden = false;
    videoMeta.textContent = "No video selected";
    updatePublishEligibility();
    return;
  }
  selectedVideoUrl = URL.createObjectURL(selectedFile);
  videoPreview.src = selectedVideoUrl;
  videoPreview.hidden = false;
  previewPlaceholder.hidden = true;
  const sizeMb = (selectedFile.size / (1024 * 1024)).toFixed(1);
  videoMeta.textContent = `${sizeMb} MB · Reading video details…`;
  videoPreview.onloadedmetadata = () => {
    videoDuration = Number.isFinite(videoPreview.duration) ? videoPreview.duration : null;
    const durationText = videoDuration ? `${Math.ceil(videoDuration)} sec` : "Duration unavailable";
    const dimensions = videoPreview.videoWidth && videoPreview.videoHeight ? `${videoPreview.videoWidth} × ${videoPreview.videoHeight}` : "dimensions unavailable";
    videoMeta.textContent = `${durationText} · ${dimensions} · ${sizeMb} MB`;
    updatePublishEligibility();
  };
  videoPreview.onerror = () => {
    videoMeta.textContent = `${sizeMb} MB · Preview unavailable for this file`;
    updatePublishEligibility();
  };
  updatePublishEligibility();
});

caption.addEventListener("input", () => { $("#counter").textContent = `${caption.value.length} / 2200`; });
$("#hashtagButton").addEventListener("click", () => {
  const tags = "#brokenreflection #wavephonk #ambient";
  if (!caption.value.includes("#brokenreflection")) caption.value += `${caption.value.trim() ? "\n\n" : ""}${tags}`;
  caption.dispatchEvent(new Event("input", { bubbles: true }));
});

for (const control of [privacySelect, publishConsent, commercialDisclosure, brandOrganic, brandContent, allowComments, allowDuet, allowStitch]) {
  control.addEventListener("change", () => {
    if ([commercialDisclosure, brandOrganic, brandContent].includes(control)) updateDisclosureUI();
    else updatePublishEligibility();
  });
}

dashboardLogin.addEventListener("click", async () => {
  const password = dashboardPassword.value;
  if (!password) { setDashboardStatus("Enter your studio password."); return; }
  dashboardLogin.disabled = true;
  try {
    const response = await fetch(`${API_BASE_URL}/api/dashboard/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Sign-in failed.");
    dashboardToken = data.token;
    sessionStorage.setItem("br_dashboard_token", dashboardToken);
    dashboardPassword.value = "";
    dashboardPassword.hidden = true;
    dashboardLogin.hidden = true;
    dashboardLogout.hidden = false;
    await loadSelectedAccount();
  } catch (error) {
    setDashboardStatus(error.message);
  } finally { dashboardLogin.disabled = false; }
});

dashboardLogout.addEventListener("click", () => {
  dashboardToken = null;
  creatorSettings = null;
  sessionStorage.removeItem("br_dashboard_token");
  dashboardPassword.hidden = false;
  dashboardLogin.hidden = false;
  dashboardLogout.hidden = true;
  privacySelect.disabled = true;
  interactionGroup.disabled = true;
  disclosureGroup.disabled = true;
  privacySelect.replaceChildren(new Option("Connect TikTok to load available options", ""));
  $("#creatorName").textContent = "Connect a TikTok account";
  $("#connectionLabel").textContent = "Connect TikTok";
  $("#connectionStatus").textContent = "Connect";
  $("#connectButton").classList.remove("connected");
  setDashboardStatus("Signed out. Sign in to continue.");
  updatePublishEligibility();
});

async function checkPublishStatus(publishId, accountKey) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const data = await dashboardFetch("/api/tiktok/publish-status", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publishId, accountKey })
    });
    setPostStatus(`TikTok status: ${data.status}`);
    if (data.status === "PUBLISH_COMPLETE") { setPostStatus("TikTok reports that publishing is complete."); return; }
    if (data.status === "FAILED") { setPostStatus(`TikTok publishing failed: ${data.failReason || "Unknown reason"}`); return; }
    if (data.status === "SEND_TO_USER_INBOX") { setPostStatus("Video sent to TikTok. Open TikTok to finish the post in your inbox."); return; }
  }
  setPostStatus(`Still processing. Publish ID: ${publishId}`);
}

postForm.addEventListener("submit", async event => {
  event.preventDefault();
  setPostStatus("");
  if (!dashboardToken || !creatorSettings) { setDashboardStatus("Sign in and load TikTok settings before publishing."); return; }
  const selectedFile = videoInput.files?.[0];
  if (!selectedFile) { setPostStatus("Choose a video first."); return; }
  if (!privacySelect.value) { setPostStatus("Choose who can watch this video."); return; }
  if (!publishConsent.checked) { setPostStatus("Agree to the TikTok confirmation before publishing."); return; }
  if (commercialDisclosure.checked && !brandOrganic.checked && !brandContent.checked) { setPostStatus("Choose at least one commercial content type, or turn disclosure off."); return; }
  if (creatorSettings.maxVideoDurationSec && videoDuration && videoDuration > creatorSettings.maxVideoDurationSec) { setPostStatus(`This account can post videos up to ${creatorSettings.maxVideoDurationSec} seconds.`); return; }

  const formData = new FormData();
  formData.append("video", selectedFile);
  formData.append("accountKey", selectedAccountKey);
  formData.append("caption", caption.value);
  formData.append("privacy", privacySelect.value);
  formData.append("consent", "true");
  formData.append("allowComments", String(allowComments.checked));
  formData.append("allowDuet", String(allowDuet.checked));
  formData.append("allowStitch", String(allowStitch.checked));
  formData.append("durationSeconds", String(videoDuration || 0));
  formData.append("brandOrganic", String(commercialDisclosure.checked && brandOrganic.checked));
  formData.append("brandContent", String(commercialDisclosure.checked && brandContent.checked));

  publishButton.disabled = true;
  try {
    setDashboardStatus("Uploading your video to TikTok...");
    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE_URL}/api/tiktok/publish`);
      xhr.setRequestHeader("Authorization", `Bearer ${dashboardToken}`);
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) setPostStatus(`Uploading video: ${Math.round(event.loaded / event.total * 100)}%`);
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || "Upload failed."));
      };
      xhr.onerror = () => reject(new Error("Network error during upload."));
      xhr.send(formData);
    });
    setDashboardStatus("TikTok received the video. Checking its publishing status...");
    await checkPublishStatus(result.publishId, selectedAccountKey);
  } catch (error) { setPostStatus(error.message); }
  finally { updatePublishEligibility(); }
});

$("#connectButton").addEventListener("click", () => {
  setDashboardStatus("Redirecting to TikTok authorization...");
  window.location.assign(`${API_BASE_URL}/tiktok/authorize?account=${encodeURIComponent(selectedAccountKey)}`);
});

accountSelect.addEventListener("change", () => {
  selectedAccountKey = accountSelect.value;
  sessionStorage.setItem("br_tiktok_account", selectedAccountKey);
  creatorSettings = null;
  updatePublishEligibility();
  if (dashboardToken) {
    loadSelectedAccount();
    return;
  }
  const accountName = accountSelect.selectedOptions[0]?.textContent.replace(/ · (Connected|Connect)$/, "") || "TikTok account";
  $("#creatorName").textContent = `Connect ${accountName}`;
  $("#connectionLabel").textContent = "Sign in to view account";
  setDashboardStatus(`Sign in, then connect ${accountName}.`);
});

function initializeSession() {
  if (!dashboardToken) return;
  dashboardPassword.hidden = true;
  dashboardLogin.hidden = true;
  dashboardLogout.hidden = false;
  loadSelectedAccount().catch(error => {
    dashboardToken = null;
    sessionStorage.removeItem("br_dashboard_token");
    dashboardPassword.hidden = false;
    dashboardLogin.hidden = false;
    dashboardLogout.hidden = true;
    creatorSettings = null;
    setDashboardStatus(error.message);
    updatePublishEligibility();
  });
}

initializeSession();
updateDisclosureUI();
