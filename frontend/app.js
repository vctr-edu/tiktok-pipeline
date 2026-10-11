const caption = document.querySelector('#caption');
const counter = document.querySelector('#counter');
const file = document.querySelector('#videoFile');
const fileLabel = document.querySelector('#fileLabel');
const note = document.querySelector('#formNote');

caption.addEventListener('input', () => { counter.textContent = `${caption.value.length} / 2200`; });
file.addEventListener('change', () => { if (file.files[0]) fileLabel.textContent = file.files[0].name; });
document.querySelector('#hashtagButton').addEventListener('click', () => {
  const tags = '#brokenreflection #wavephonk #ambient';
  if (!caption.value.includes('#brokenreflection')) caption.value = `${caption.value}${caption.value ? '\n\n' : ''}${tags}`;
  caption.dispatchEvent(new Event('input'));
});
const connectionButton = document.querySelector('#connectButton');
const connectionLabel = document.querySelector('#connectionLabel');

fetch('/api/tiktok/status')
  .then((response) => response.json())
  .then((status) => {
    if (status.connected) {
      connectionLabel.textContent = 'TikTok connected';
      connectionButton.classList.add('connected');
      note.textContent = 'TikTok account authorized locally.';
    }
  })
  .catch(() => { note.textContent = 'Start the local studio server to connect TikTok.'; });

connectionButton.addEventListener('click', () => { window.location.assign('/api/tiktok/authorize'); });
document.querySelector('#postForm').addEventListener('submit', (event) => { event.preventDefault(); note.textContent = 'Post prepared visually. Publishing is not connected yet.'; });
