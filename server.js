const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpegStatic = require('ffmpeg-static');
const YTDlpWrap = require('yt-dlp-wrap').default;

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const TMP = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP);

const YTDLP_BIN = path.join(__dirname, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
let ytDlp;

async function getYtDlp() {
  if (ytDlp) return ytDlp;
  if (!fs.existsSync(YTDLP_BIN)) {
    console.log('yt-dlp not found, downloading...');
    await YTDlpWrap.downloadFromGithub(YTDLP_BIN);
  }
  ytDlp = new YTDlpWrap(YTDLP_BIN);
  return ytDlp;
}

function downloadVideo(url, outPath) {
  return new Promise(async (resolve, reject) => {
    const yt = await getYtDlp();
    const args = [
      url,
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outPath,
      '--no-playlist',
      '--socket-timeout', '30',
    ];
    const proc = yt.execStream(args);
    let stderr = '';
    proc.on('ytDlpEvent', (type, data) => {
      if (type === 'error') stderr += data;
    });
    proc.on('error', err => reject(new Error(err.message)));
    proc.on('close', code => {
      if (code === 0 || fs.existsSync(outPath)) resolve();
      else reject(new Error('Download thất bại: ' + stderr.slice(-300)));
    });
  });
}

function mergeVideos(files, outPath) {
  return new Promise((resolve, reject) => {
    // Tạo concat list
    const listPath = outPath.replace('output.mp4', 'list.txt');
    fs.writeFileSync(listPath, files.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));

    // Thử copy stream trước (nhanh, không re-encode)
    const proc = spawn(ffmpegStatic, [
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      '-y', outPath
    ]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
        return resolve();
      }
      // Fallback: re-encode để đảm bảo khớp format
      console.log('Copy failed, re-encoding...');
      const n = files.length;
      const inputs = files.flatMap(f => ['-i', f]);
      const filterParts = files.map((_, i) =>
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1[v${i}];[${i}:a]aresample=44100[a${i}]`
      );
      const concatInputs = files.map((_, i) => `[v${i}][a${i}]`).join('');
      const filter = filterParts.join(';') + `;${concatInputs}concat=n=${n}:v=1:a=1[vout][aout]`;

      const proc2 = spawn(ffmpegStatic, [
        ...inputs,
        '-filter_complex', filter,
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-y', outPath
      ]);
      let stderr2 = '';
      proc2.stderr.on('data', d => stderr2 += d.toString());
      proc2.on('close', code2 => {
        if (code2 === 0) resolve();
        else reject(new Error('Ghép thất bại: ' + stderr2.slice(-300)));
      });
    });
  });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/merge', async (req, res) => {
  const { urls } = req.body || {};
  const validUrls = (urls || []).map(u => String(u).trim()).filter(Boolean);

  if (!validUrls.length || validUrls.length > 3) {
    return res.status(400).json({ error: 'Cần 1–3 link video' });
  }

  const jobId = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir);

  try {
    console.log(`[${jobId}] Downloading ${validUrls.length} videos...`);
    const files = [];
    for (let i = 0; i < validUrls.length; i++) {
      const out = path.join(jobDir, `v${i}.mp4`);
      console.log(`[${jobId}] Downloading ${i + 1}/${validUrls.length}: ${validUrls[i]}`);
      await downloadVideo(validUrls[i], out);
      files.push(out);
    }

    const outFile = path.join(jobDir, 'output.mp4');
    if (files.length === 1) {
      fs.copyFileSync(files[0], outFile);
    } else {
      console.log(`[${jobId}] Merging ${files.length} videos...`);
      await mergeVideos(files, outFile);
    }

    console.log(`[${jobId}] Done. Sending file...`);
    res.download(outFile, 'merged.mp4', err => {
      if (err) console.error('Send error:', err.message);
      setTimeout(() => fs.rmSync(jobDir, { recursive: true, force: true }), 10000);
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// Dọn tmp files cũ hơn 1 giờ mỗi 30 phút
setInterval(() => {
  try {
    const dirs = fs.readdirSync(TMP);
    dirs.forEach(d => {
      const full = path.join(TMP, d);
      const stat = fs.statSync(full);
      if (Date.now() - stat.mtimeMs > 3600000) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    });
  } catch (_) {}
}, 1800000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Video Merger running on http://localhost:${PORT}`));
