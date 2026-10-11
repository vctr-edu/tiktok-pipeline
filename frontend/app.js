
const API_BASE_URL = "https://YOUR-BACKEND-DOMAIN";

const caption = document.querySelector("#caption");
const counter = document.querySelector("#counter");
const file = document.querySelector("#videoFile");
const fileLabel = document.querySelector("#fileLabel");
const note = document.querySelector("#formNote");
const connectionButton = document.querySelector("#connectButton");
const connectionLabel = document.querySelector("#connectionLabel");

const apiConfigured =
  API_BASE_URL.startsWith("https://") &&
  !API_BASE_URL.includes("YOUR-BACKEND-DOMAIN");

caption.addEventListener("input", () => {
  counter.textContent = `${caption.value.length} / 2200`;
});

file.addEventListener("change", () => {
  if (file.files[0]) {
    fileLabel.textContent = file.files[0].name;
  }
});

document.querySelector("#hashtagButton").addEventListener("click", () => {
  const tags = "#brokenreflection #wavephonk #ambient";

  if (!caption.value.includes("#brokenreflection")) {
    caption.value += `${caption.value ? "\n\n" : ""}${tags}`;
  }

  caption.dispatchEvent(new Event("input"));
});

async function checkTikTokConnection() {
  if (!apiConfigured) {
    note.textContent =
      "Frontend online. Configure your backend URL to connect TikTok.";
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/api/tiktok/status`,
      { credentials: "include" }
    );

    if (!response.ok) {
      throw new Error("Status request failed");
    }

    const status = await response.json();

    if (status.connected) {
      connectionLabel.textContent = "TikTok connected";
      connectionButton.classList.add("connected");
      note.textContent = "TikTok account authorized.";
    } else {
      note.textContent = "Connect your TikTok account to continue.";
    }
  } catch {
    note.textContent =
      "Could not reach the backend. Check its availability and CORS settings.";
  }
}

connectionButton.addEventListener("click", () => {
  if (!apiConfigured) {
    note.textContent = "Configure your backend URL first.";
    return;
  }

  window.location.assign(
    `${API_BASE_URL}/api/tiktok/authorize`
  );
});

document.querySelector("#postForm").addEventListener("submit", (event) => {
  event.preventDefault();
  note.textContent =
    "Post prepared for review. Publishing is not connected yet.";
});

checkTikTokConnection();
