
const API_BASE_URL = "https://broken-reflection-api.onrender.com";

const caption = document.querySelector("#caption");
const counter = document.querySelector("#counter");
const file = document.querySelector("#videoFile");
const fileLabel = document.querySelector("#fileLabel");
const note = document.querySelector("#formNote");

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

const connectionButton = document.querySelector("#connectButton");
const connectionLabel = document.querySelector("#connectionLabel");


async function loadTikTokProfile() {
  try {
    const response = await fetch(
      `${API_BASE_URL}/api/tiktok/profile`
    );

    const data = await response.json();

    if (!response.ok || !data.profileAvailable) {
      connectionLabel.textContent = "TikTok not connected";
      return;
    }

    connectionLabel.textContent =
      `Connected: ${data.profile.displayName}`;

    let profileCard = document.querySelector("#tiktokProfileCard");

    if (!profileCard) {
      profileCard = document.createElement("div");
      profileCard.id = "tiktokProfileCard";
      profileCard.style.cssText =
        "display:flex;align-items:center;gap:12px;margin:12px 0;padding:12px;border:1px solid #444;border-radius:12px;";

      connectionLabel.insertAdjacentElement("afterend", profileCard);
    }

    profileCard.replaceChildren();

    if (data.profile.avatarUrl) {
      const avatar = document.createElement("img");
      avatar.src = data.profile.avatarUrl;
      avatar.alt = "TikTok profile picture";
      avatar.width = 48;
      avatar.height = 48;
      avatar.style.cssText =
        "border-radius:50%;object-fit:cover;";
      profileCard.appendChild(avatar);
    }

    const details = document.createElement("div");
    const name = document.createElement("strong");
    const status = document.createElement("div");

    name.textContent = data.profile.displayName;
    status.textContent = "TikTok account connected";
    status.style.cssText = "font-size:13px;opacity:0.7;margin-top:4px;";

    details.append(name, status);
    profileCard.appendChild(details);
  } catch {
    connectionLabel.textContent =
      "Could not check TikTok connection";
  }
}

loadTikTokProfile();


// Check whether the Render backend is reachable.
fetch(`${API_BASE_URL}/api/health`)
  .then((response) => {
    if (!response.ok) {
      throw new Error("Backend health check failed");
    }
    return response.json();
  })
  .then((data) => {
    note.textContent = `Backend connected: ${data.status}`;
  })
  .catch(() => {
    note.textContent =
      "Backend unavailable. It may be starting up; try again shortly.";
  });

// TikTok OAuth will be connected after we implement its backend routes.
connectionButton.addEventListener("click", () => {
  window.location.href = `${API_BASE_URL}/tiktok/authorize`;
});

document.querySelector("#postForm").addEventListener("submit", (event) => {
  event.preventDefault();
  note.textContent =
    "Post prepared visually. Publishing is not connected yet.";
});
