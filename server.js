const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== DIRECTORIES (Use /tmp for cloud) ==========
const DOWNLOADS_DIR = '/tmp/downloads';
const BIN_DIR = '/tmp/bin';
const YTDLP_PATH = '/tmp/bin/yt-dlp';

// Create folders
try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });
} catch (e) { }

// ========== YT-DLP DOWNLOAD (Using Node.js HTTPS, NOT curl) ==========
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(YTDLP_PATH)) {
            console.log('✅ yt-dlp already exists');
            return resolve();
        }

        console.log('📥 Downloading yt-dlp using Node.js...');

        const file = fs.createWriteStream(YTDLP_PATH);

        https.get('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                https.get(res.headers.location, (res2) => {
                    res2.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        fs.chmodSync(YTDLP_PATH, '755');
                        console.log('✅ yt-dlp downloaded!');
                        resolve();
                    });
                });
            } else {
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    fs.chmodSync(YTDLP_PATH, '755');
                    console.log('✅ yt-dlp downloaded!');
                    resolve();
                });
            }
        }).on('error', reject);
    });
}

// ========== HELPERS ==========
const downloadProgress = new Map();

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitize(s) {
    return (s || 'video').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 80);
}

function formatDuration(sec) {
    if (!sec) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(n) {
    n = parseInt(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
}

function runCmd(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
        });
    });
}

// Cleanup every 2 min
setInterval(() => {
    try {
        const now = Date.now();
        fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
            const p = path.join(DOWNLOADS_DIR, f);
            if (now - fs.statSync(p).mtimeMs > 180000) fs.unlinkSync(p);
        });
        for (const [id, d] of downloadProgress) {
            if (now - d.timestamp > 300000) downloadProgress.delete(id);
        }
    } catch (e) { }
}, 120000);

// ========== QUEUE ==========
const queue = [];
let active = 0;

function addJob(job) {
    queue.push(job);
    runQueue();
}

function runQueue() {
    while (active < 2 && queue.length) {
        active++;
        const job = queue.shift();
        processJob(job).finally(() => { active--; runQueue(); });
    }
}

async function processJob(job) {
    const { id, url, format, quality } = job;
    const update = (p, m, s = 'processing') => {
        const d = downloadProgress.get(id);
        if (d) { d.progress = p; d.message = m; d.status = s; }
    };

    try {
        update(5, 'Starting...');

        let title = 'video';
        try {
            title = sanitize(await runCmd(`${YTDLP_PATH} --print title --no-playlist "${url}"`));
        } catch (e) { }

        update(15, 'Downloading...');

        const ext = format === 'mp3' ? 'mp3' : 'mp4';
        const outFile = path.join(DOWNLOADS_DIR, `${id}.${ext}`);

        let cmd;
        if (format === 'mp3') {
            cmd = `${YTDLP_PATH} -x --audio-format mp3 --audio-quality ${quality}K --no-playlist -o "${outFile}" "${url}"`;
        } else {
            cmd = `${YTDLP_PATH} -f "bestvideo[height<=${quality}]+bestaudio/best" --merge-output-format mp4 --no-playlist -o "${outFile}" "${url}"`;
        }

        await runCmd(cmd);

        let finalPath = outFile;
        if (!fs.existsSync(outFile)) {
            const match = fs.readdirSync(DOWNLOADS_DIR).find(f => f.startsWith(id));
            if (match) finalPath = path.join(DOWNLOADS_DIR, match);
        }

        if (!fs.existsSync(finalPath)) throw new Error('File not created');

        const size = fs.statSync(finalPath).size;
        const sizeMB = (size / 1024 / 1024).toFixed(2);

        update(100, `Ready! (${sizeMB} MB)`, 'completed');

        const d = downloadProgress.get(id);
        if (d) {
            d.filePath = finalPath;
            d.filename = `${title}.${ext}`;
            d.fileSize = size;
        }

        console.log('✅ Done:', title);

    } catch (e) {
        console.error('❌ Error:', e.message);
        update(0, 'Failed', 'error');
    }
}

// ========== ROUTES ==========

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', ytdlp: fs.existsSync(YTDLP_PATH) });
});

app.get('/api/info', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const out = await runCmd(`${YTDLP_PATH} --dump-json --no-playlist "${url}"`);
        const info = JSON.parse(out);

        res.json({
            success: true,
            data: {
                id: info.id,
                title: info.title || 'Video',
                author: info.uploader || info.channel || 'Unknown',
                thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
                duration: formatDuration(info.duration),
                views: formatViews(info.view_count)
            }
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to get info' });
    }
});

app.post('/api/convert', (req, res) => {
    const { url, format, quality } = req.body;
    if (!url || !format) return res.status(400).json({ error: 'Missing fields' });

    const id = genId();
    downloadProgress.set(id, {
        status: 'queued',
        progress: 0,
        message: 'Queued...',
        timestamp: Date.now(),
        filePath: null,
        filename: null,
        fileSize: 0
    });

    addJob({ id, url, format, quality: quality || (format === 'mp3' ? '192' : '720') });
    res.json({ success: true, downloadId: id });
});

app.get('/api/progress/:id', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');

    const send = () => {
        const d = downloadProgress.get(req.params.id);
        res.write(`data: ${JSON.stringify(d || { status: 'not_found' })}\n\n`);
        if (!d || d.status === 'completed' || d.status === 'error') {
            clearInterval(iv);
            res.end();
        }
    };

    const iv = setInterval(send, 500);
    send();
    req.on('close', () => clearInterval(iv));
});

app.get('/api/download/:id', (req, res) => {
    const d = downloadProgress.get(req.params.id);
    if (!d || !d.filePath || !fs.existsSync(d.filePath)) {
        return res.status(404).json({ error: 'Not found' });
    }

    res.setHeader('Content-Type', d.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Length', d.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(d.filename)}"`);

    fs.createReadStream(d.filePath).pipe(res).on('close', () => {
        setTimeout(() => {
            try { fs.unlinkSync(d.filePath); } catch (e) { }
            downloadProgress.delete(req.params.id);
        }, 5000);
    });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== START ==========
async function start() {
    console.log('');
    console.log('🚀 TubeGrab Starting...');

    try {
        await downloadYtDlp();
    } catch (e) {
        console.log('⚠️ yt-dlp error:', e.message);
    }

    app.listen(PORT, () => {
        console.log('');
        console.log('╔═══════════════════════════════════╗');
        console.log('║   🎵 TUBEGRAB READY!              ║');
        console.log(`║   🌐 Port: ${PORT}                   ║`);
        console.log('╚═══════════════════════════════════╝');
        console.log('');
    });
}

start();