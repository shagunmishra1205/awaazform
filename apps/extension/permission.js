document.getElementById('go').addEventListener('click', async () => {
  const out = document.getElementById('out');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    out.textContent = 'Microphone allowed. You can close this tab.';
  } catch {
    out.textContent = 'The microphone was blocked. Allow it in the browser’s site settings for this extension.';
  }
});
