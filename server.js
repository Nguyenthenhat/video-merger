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

async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_BIN)) return;
  console.log('Downloading yt-dlp...');
  await YTDlpWrap.downloadFromGithub(YTDLP_BIN);
  try { fs.chmodSync(YTDLP_BIN, '755'); } catch(_){}
  console.log('yt-dlp ready');
}

function cleanUrl(url) {
  // Giữ lại path, bỏ query params gây lỗi với Facebook/TikTok
  try {
    const u = new URL(url);
    // Facebook: giữ nguyên path, bỏ locale
    if (u.hostname.includes('facebook.com')) {
      return u.origin + u.pathname;
    }
    // TikTok: giữ nguyên
    return url;
  } catch(_) { return url; }
}

function downloadVideo(url, outPath) {
  return new Promise((resolve, reject) => {
    const clean = cleanUrl(url);
    console.log('Downloading:', clean);

    const args = [
      clean,
      '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outPath,
      '--no-playlist',
      '--socket-timeout', '60',
      '--retries', '3',
      '--no-check-certificates',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];

    const proc = spawn(YTDLP_BIN, args);
    let stderr = '';

    proc.stdout.on('data', d => process.stdout.write(d));
    proc.stderr.on('data', d => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    proc.on('error', err => reject(new Error('yt-dlp binary error: ' + err.message)));

    proc.on('close', code => {
      // Kiểm tra file tồn tại và có dung lượng
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
        resolve();
      } else {
        // Lấy dòng lỗi cuối trong stderr
        const lines = stderr.split('\n').filter(l => l.includes('ERROR') || l.includes('error'));
        const msg = lines.slice(-3).join(' ') || stderr.slice(-400) || 'yt-dlp exit code ' + code;
        reject(new Error(msg));
      }
    });
  });
}

function mergeVideos(files, outPath) {
  return new Promise((resolve, reject) => {
    const listPath = outPath.replace('output.mp4', 'list.txt');
    fs.writeFileSync(listPath, files.map(f => `file '${f}'`).join('\n'));

    // Thử copy stream trước (nhanh)
    const proc = spawn(ffmpegStatic, [
      '-f', 'concat', '-safe', '0',
      '-i', listPath, '-c', 'copy', '-y', outPath
    ]);
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 10000) {
        return resolve();
      }
      // Fallback: re-encode
      console.log('Concat copy failed, re-encoding...');
      const n = files.length;
      const inputs = files.flatMap(f => ['-i', f]);
      const vf = files.map((_, i) =>
        `[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1[v${i}];[${i}:a]aresample=44100[a${i}]`
      ).join(';');
      const concat = files.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${n}:v=1:a=1[vout][aout]`;

      const proc2 = spawn(ffmpegStatic, [
        ...inputs,
        '-filter_complex', `${vf};${concat}`,
        '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-y', outPath
      ]);
      let stderr2 = '';
      proc2.stderr.on('data', d => stderr2 += d.toString());
      proc2.on('close', code2 => {
        if (code2 === 0 && fs.existsSync(outPath)) resolve();
        else reject(new Error('Ghép thất bại: ' + stderr2.slice(-300)));
      });
    });
  });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/merge', async (req, res) => {
  const { urls } = req.body || {};
  const validUrls = (urls || []).map(u => String(u).trim()).filter(Boolean);
  if (!validUrls.length || validUrls.length > 3)
    return res.status(400).json({ error: 'Cần 1–3 link video' });

  const jobId = uuidv4().slice(0, 8);
  const jobDir = path.join(TMP, jobId);
  fs.mkdirSync(jobDir);

  try {
    await ensureYtDlp();

    const files = [];
    for (let i = 0; i < validUrls.length; i++) {
      const out = path.join(jobDir, `v${i}.mp4`);
      console.log(`[${jobId}] ${i + 1}/${validUrls.length}: ${validUrls[i]}`);
      await downloadVideo(validUrls[i], out);
      files.push(out);
    }

    const outFile = path.join(jobDir, 'output.mp4');
    if (files.length === 1) {
      fs.copyFileSync(files[0], outFile);
    } else {
      console.log(`[${jobId}] Merging...`);
      await mergeVideos(files, outFile);
    }

    console.log(`[${jobId}] Done!`);
    res.download(outFile, 'merged.mp4', err => {
      if (err) console.error('Send error:', err.message);
      setTimeout(() => fs.rmSync(jobDir, { recursive: true, force: true }), 10000);
    });

  } catch (err) {
    console.error(`[${jobId}] ERROR:`, err.message);
    fs.rmSync(jobDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

setInterval(() => {
  try {
    fs.readdirSync(TMP).forEach(d => {
      const full = path.join(TMP, d);
      if (Date.now() - fs.statSync(full).mtimeMs > 3600000)
        fs.rmSync(full, { recursive: true, force: true });
    });
  } catch(_) {}
}, 1800000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Video Merger running on http://localhost:${PORT}`);
  // Tải yt-dlp ngay khi khởi động nếu chưa có
  try { await ensureYtDlp(); } catch(e) { console.error('yt-dlp init error:', e.message); }
});
