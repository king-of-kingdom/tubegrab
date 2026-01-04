const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Directories
const DOWNLOADS_DIR = '/tmp/downloads';
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// yt-dlp path (Linux)
const YTDLP = '/usr/local/bin/yt-dlp';

// Download progress storage
const downloadProgress = new Map();

// ===================== RATE LIMITING =====================
const requestCounts = new Map();
const RATE_LIMIT = 5; // requests per minute per IP
const RATE_WINDOW = 60 * 1000;

function rateLimiter(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const now = Date.now();

    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
        return next();
    }

    const data = requestCounts.get(ip);

    if (now > data.resetTime) {
        data.count = 1;
        data.resetTime = now + RATE_WINDOW;
        return next();
    }

    if (data.count >= RATE_LIMIT) {
        return res.status(429).json({
            error: 'Too many requests. Please wait 1 minute.'
        });
    }

    data.count++;
    next();
}

// Clean rate limit entries
setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of requestCounts.entries()) {
        if (now > data.resetTime + RATE_WINDOW) {
            requestCounts.delete(ip);
        }
    }
}, 60000);

// ===================== QUEUE SYSTEM =====================
const downloadQueue = [];
const MAX_CONCURRENT = 2;
let processingCount = 0;

function addToQueue(job) {
    return new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
        downloadQueue.push(job);
        processQueue();
    });
}

function processQueue() {
    while (processingCount < MAX_CONCURRENT && downloadQueue.length > 0) {
        const job = downloadQueue.shift();
        processingCount++;

        processDownload(job.downloadId, job.url, job.format, job.quality, job.timestamp)
            .then(() => {
                processingCount--;
                job.resolve();
                processQueue();
            })
            .catch((err) => {
                processingCount--;
                job.reject(err);
                processQueue();
            });
    }
}

// ===================== HELPERS =====================
function formatDuration(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(n) {
    n = parseInt(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return n.toString();
}

function sanitize(name) {
    if (!name) return 'video';
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim().substring(0, 80) || 'video';
}

function deleteFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Cleanup every 2 minutes
setInterval(() => {
    try {
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const now = Date.now();

        files.forEach(f => {
            const p = path.join(DOWNLOADS_DIR, f);
            try {
                const stats = fs.statSync(p);
                if (now - stats.mtimeMs > 3 * 60 * 1000) {
                    fs.unlinkSync(p);
                    console.log('🗑️ Cleaned:', f);
                }
            } catch (e) { }
        });

        // Clean progress entries
        for (const [id, data] of downloadProgress.entries()) {
            if (now - data.timestamp > 5 * 60 * 1000) {
                downloadProgress.delete(id);
            }
        }
    } catch (e) { }
}, 2 * 60 * 1000);

// ===================== SETUP yt-dlp =====================
async function setupYtDlp() {
    return new Promise((resolve) => {
        exec('which yt-dlp', (err, stdout) => {
            if (stdout && stdout.trim()) {
                console.log('✅ yt-dlp found at:', stdout.trim());
                resolve();
            } else {
                console.log('📥 Installing yt-dlp...');
                exec('curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp', (err) => {
                    if (err) console.error('yt-dlp install error:', err.message);
                    else console.log('✅ yt-dlp installed');
                    resolve();
                });
            }
        });
    });
}

// ===================== API ROUTES =====================

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        queue: downloadQueue.length,
        active: processingCount
    });
});

app.get('/api/info', rateLimiter, async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL required' });
        if (!/youtube\.com|youtu\.be/i.test(url)) return res.status(400).json({ error: 'Invalid URL' });

        const output = await new Promise((resolve, reject) => {
            exec(`yt-dlp --dump-json --no-warnings --no-playlist "${url}"`,
                { maxBuffer: 50 * 1024 * 1024, timeout: 30000 },
                (err, stdout, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve(stdout);
                });
        });

        const info = JSON.parse(output);
        res.json({
            success: true,
            data: {
                id: info.id || '',
                title: info.title || 'Unknown',
                author: info.uploader || info.channel || 'Unknown',
                thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
                duration: formatDuration(info.duration),
                views: formatViews(info.view_count)
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get video info' });
    }
});

app.post('/api/convert', rateLimiter, async (req, res) => {
    const { url, format, quality } = req.body;

    if (!url) return res.status(400).json({ error: 'URL required' });
    if (!format) return res.status(400).json({ error: 'Format required' });

    if (downloadQueue.length >= 20) {
        return res.status(503).json({ error: 'Server busy. Try again later.' });
    }

    const downloadId = generateId();
    const timestamp = Date.now();

    downloadProgress.set(downloadId, {
        status: 'queued',
        progress: 0,
        message: `Queued (${downloadQueue.length + 1})`,
        timestamp,
        filePath: null,
        filename: null
    });

    res.json({ success: true, downloadId });

    addToQueue({
        downloadId,
        url,
        format,
        quality: quality || (format === 'mp3' ? '192' : '720'),
        timestamp
    }).catch(() => { });
});

async function processDownload(downloadId, url, format, quality, timestamp) {
    const update = (progress, message, status = 'processing') => {
        const data = downloadProgress.get(downloadId);
        if (data) {
            data.progress = progress;
            data.message = message;
            data.status = status;
        }
    };

    try {
        update(5, 'Starting...');

        let title = 'download';
        try {
            const out = await new Promise((resolve, reject) => {
                exec(`yt-dlp --print title --no-warnings --no-playlist "${url}"`,
                    { timeout: 20000 },
                    (err, stdout) => err ? reject(err) : resolve(stdout.trim()));
            });
            title = sanitize(out);
        } catch (e) { }

        update(10, 'Downloading...');

        const ext = format === 'mp3' ? 'mp3' : 'mp4';
        const filename = `${title}.${ext}`;
        const outputPath = path.join(DOWNLOADS_DIR, `${timestamp}_${downloadId}.${ext}`);

        let args = [];
        if (format === 'mp3') {
            args = ['-x', '--audio-format', 'mp3', '--audio-quality', `${quality}K`, '--no-playlist', '--no-warnings', '--newline', '-o', outputPath, url];
        } else {
            const fmt = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
            args = ['-f', fmt, '--merge-output-format', 'mp4', '--no-playlist', '--no-warnings', '--newline', '-o', outputPath, url];
        }

        await new Promise((resolve, reject) => {
            const proc = spawn('yt-dlp', args);

            proc.stdout.on('data', (data) => {
                const match = data.toString().match(/(\d+\.?\d*)%/);
                if (match) {
                    const pct = parseFloat(match[1]);
                    update(Math.min(10 + pct * 0.85, 95), `Downloading: ${Math.round(pct)}%`);
                }
            });

            proc.stderr.on('data', (data) => {
                const match = data.toString().match(/(\d+\.?\d*)%/);
                if (match) {
                    const pct = parseFloat(match[1]);
                    update(Math.min(10 + pct * 0.85, 95), `Downloading: ${Math.round(pct)}%`);
                }
            });

            proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
            proc.on('error', reject);
        });

        let finalPath = outputPath;
        if (!fs.existsSync(outputPath)) {
            const files = fs.readdirSync(DOWNLOADS_DIR);
            const match = files.find(f => f.includes(`${timestamp}_${downloadId}`));
            if (match) finalPath = path.join(DOWNLOADS_DIR, match);
        }

        if (!fs.existsSync(finalPath)) throw new Error('File not created');

        const stats = fs.statSync(finalPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        update(100, `Ready! (${sizeMB} MB)`, 'completed');

        const data = downloadProgress.get(downloadId);
        if (data) {
            data.filePath = finalPath;
            data.filename = filename;
            data.fileSize = stats.size;
        }

        console.log(`✅ Done: ${filename}`);

    } catch (err) {
        console.error('❌ Error:', err.message);
        update(0, 'Failed. Try again.', 'error');

        try {
            const files = fs.readdirSync(DOWNLOADS_DIR);
            files.filter(f => f.includes(downloadId)).forEach(f => deleteFile(path.join(DOWNLOADS_DIR, f)));
        } catch (e) { }
    }
}

app.get('/api/progress/:id', (req, res) => {
    const { id } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = () => {
        const data = downloadProgress.get(id);
        if (data) {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            if (data.status === 'completed' || data.status === 'error') {
                clearInterval(interval);
                setTimeout(() => res.end(), 500);
            }
        } else {
            res.write(`data: ${JSON.stringify({ status: 'not_found' })}\n\n`);
            clearInterval(interval);
            res.end();
        }
    };

    send();
    const interval = setInterval(send, 500);
    req.on('close', () => clearInterval(interval));
});

app.get('/api/download/:id', (req, res) => {
    const { id } = req.params;
    const data = downloadProgress.get(id);

    if (!data || data.status !== 'completed' || !fs.existsSync(data.filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(data.filename).toLowerCase();
    res.setHeader('Content-Type', ext === '.mp3' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Length', data.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.filename)}"`);

    const stream = fs.createReadStream(data.filePath);
    stream.pipe(res);
    stream.on('end', () => {
        setTimeout(() => {
            deleteFile(data.filePath);
            downloadProgress.delete(id);
        }, 5000);
    });
});

app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.send('<h1>Server Running</h1>');
});

// ===================== START =====================
async function start() {
    console.log('🔧 Setting up...');
    await setupYtDlp();

    app.listen(PORT, () => {
        console.log('');
        console.log('╔════════════════════════════════════════════╗');
        console.log('║   🎵 YOUTUBE DOWNLOADER - READY!          ║');
        console.log('╠════════════════════════════════════════════╣');
        console.log(`║   🌐 Port: ${PORT}                            ║`);
        console.log('║   ✅ Free tier optimized                  ║');
        console.log('╚════════════════════════════════════════════╝');
        console.log('');
    });
}

start();