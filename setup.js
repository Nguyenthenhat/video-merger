const YTDlpWrap = require('yt-dlp-wrap').default;
const path = require('path');
const fs = require('fs');

const bin = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
if (fs.existsSync(bin)) { console.log('yt-dlp already exists'); process.exit(0); }

console.log('Downloading yt-dlp...');
YTDlpWrap.downloadFromGithub(bin)
  .then(() => console.log('yt-dlp ready at', bin))
  .catch(e => console.error('yt-dlp download error (will retry on first use):', e.message));
