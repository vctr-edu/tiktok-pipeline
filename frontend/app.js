
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
  note.textContent =
    "TikTok authorization is not implemented yet.";
});

document.querySelector("#postForm").addEventListener("submit", (event) => {
  event.preventDefault();
  note.textContent =
    "Post prepared visually. Publishing is not connected yet.";
});
