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

// ============ DIRECTORIES ============
// Use /tmp for cloud hosting (Render, Railway, etc.)
const DOWNLOADS_DIR = '/tmp/downloads';
const BIN_DIR = '/tmp/bin';
const YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');

// Create directories
try {
    if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log('📁 Directories created');
} catch (e) {
    console.log('📁 Directory error:', e.message);
}

// ============ DOWNLOAD YT-DLP USING NODE.JS (NOT CURL) ============
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        // Check if already exists
        if (fs.existsSync(YTDLP_PATH)) {
            console.log('✅ yt-dlp exists at:', YTDLP_PATH);
            return resolve(YTDLP_PATH);
        }

        console.log('📥 Downloading yt-dlp...');

        const file = fs.createWriteStream(YTDLP_PATH);

        const download = (url) => {
            https.get(url, (response) => {
                // Handle redirect
                if (response.statusCode === 301 || response.statusCode === 302) {
                    console.log('   Redirecting...');
                    return download(response.headers.location);
                }

                if (response.statusCode !== 200) {
                    return reject(new Error('Download failed: ' + response.statusCode));
                }

                const total = parseInt(response.headers['content-length'], 10);
                let downloaded = 0;

                response.on('data', (chunk) => {
                    downloaded += chunk.length;
                    const pct = total ? Math.round((downloaded / total) * 100) : 0;
                    process.stdout.write(`\r   Downloading: ${pct}%`);
                });

                response.pipe(file);

                file.on('finish', () => {
                    file.close();
                    console.log('\n✅ yt-dlp downloaded!');

                    // Make executable
                    try {
                        fs.chmodSync(YTDLP_PATH, 0o755);
                        console.log('✅ yt-dlp is executable');
                    } catch (e) {
                        console.log('⚠️ chmod error:', e.message);
                    }

                    resolve(YTDLP_PATH);
                });

                file.on('error', (err) => {
                    fs.unlink(YTDLP_PATH, () => { });
                    reject(err);
                });

            }).on('error', (err) => {
                fs.unlink(YTDLP_PATH, () => { });
                reject(err);
            });
        };

        download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');
    });
}

// ============ STORAGE ============
const downloadProgress = new Map();
const requestCounts = new Map();

// ============ RATE LIMITER ============
function rateLimiter(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const windowMs = 60000;
    const maxRequests = 10;

    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, { count: 1, resetTime: now + windowMs });
        return next();
    }

    const data = requestCounts.get(ip);
    if (now > data.resetTime) {
        data.count = 1;
        data.resetTime = now + windowMs;
        return next();
    }

    if (data.count >= maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Wait 1 minute.' });
    }

    data.count++;
    next();
}

// ============ QUEUE ============
const queue = [];
let processing = 0;
const MAX_CONCURRENT = 2;

function addToQueue(job) {
    queue.push(job);
    processQueue();
}

function processQueue() {
    while (processing < MAX_CONCURRENT && queue.length > 0) {
        const job = queue.shift();
        processing++;

        runDownload(job)
            .finally(() => {
                processing--;
                processQueue();
            });
    }
}

// ============ HELPERS ============
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function sanitize(str) {
    if (!str) return 'video';
    return str.replace(/[<>:"/\\|?*]/g, '').trim().substring(0, 80) || 'video';
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
    return n.toString();
}

// ============ CLEANUP ============
setInterval(() => {
    try {
        const now = Date.now();

        // Clean downloads
        if (fs.existsSync(DOWNLOADS_DIR)) {
            fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
                const p = path.join(DOWNLOADS_DIR, f);
                try {
                    if (now - fs.statSync(p).mtimeMs > 180000) {
                        fs.unlinkSync(p);
                    }
                } catch (e) { }
            });
        }

        // Clean progress map
        for (const [id, data] of downloadProgress.entries()) {
            if (now - data.timestamp > 300000) {
                downloadProgress.delete(id);
            }
        }

        // Clean rate limits
        for (const [ip, data] of requestCounts.entries()) {
            if (now > data.resetTime + 60000) {
                requestCounts.delete(ip);
            }
        }
    } catch (e) { }
}, 60000);

// ============ DOWNLOAD FUNCTION ============
async function runDownload(job) {
    const { id, url, format, quality } = job;

    const update = (progress, message, status = 'processing') => {
        const data = downloadProgress.get(id);
        if (data) {
            data.progress = progress;
            data.message = message;
            data.status = status;
        }
    };

    try {
        update(5, 'Starting...');

        // Get title
        let title = 'video';
        try {
            const titleCmd = await runCommand(`"${YTDLP_PATH}" --print title --no-warnings --no-playlist "${url}"`);
            title = sanitize(titleCmd);
        } catch (e) {
            console.log('Title fetch failed, using default');
        }

        update(10, 'Downloading...');

        const ext = format === 'mp3' ? 'mp3' : 'mp4';
        const filename = `${title}.${ext}`;
        const outputFile = path.join(DOWNLOADS_DIR, `${id}.${ext}`);

        // Build command
        let cmd;
        if (format === 'mp3') {
            cmd = `"${YTDLP_PATH}" -x --audio-format mp3 --audio-quality ${quality}K --no-playlist --no-warnings -o "${outputFile}" "${url}"`;
        } else {
            cmd = `"${YTDLP_PATH}" -f "bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best" --merge-output-format mp4 --no-playlist --no-warnings -o "${outputFile}" "${url}"`;
        }

        console.log('🎬 Processing:', title);

        // Run download
        await runCommand(cmd, (progress) => {
            update(10 + progress * 0.85, `Downloading: ${progress}%`);
        });

        // Find file
        let finalPath = outputFile;
        if (!fs.existsSync(outputFile)) {
            const files = fs.readdirSync(DOWNLOADS_DIR);
            const match = files.find(f => f.startsWith(id));
            if (match) finalPath = path.join(DOWNLOADS_DIR, match);
        }

        if (!fs.existsSync(finalPath)) {
            throw new Error('File not created');
        }

        const stats = fs.statSync(finalPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        console.log('✅ Complete:', filename, `(${sizeMB} MB)`);

        update(100, `Ready! (${sizeMB} MB)`, 'completed');

        const data = downloadProgress.get(id);
        if (data) {
            data.filePath = finalPath;
            data.filename = filename;
            data.fileSize = stats.size;
        }

    } catch (err) {
        console.error('❌ Error:', err.message);
        update(0, 'Download failed', 'error');
    }
}

function runCommand(cmd, onProgress) {
    return new Promise((resolve, reject) => {
        const proc = exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 300000 });

        let output = '';

        proc.stdout.on('data', (data) => {
            output += data;
            const match = data.toString().match(/(\d+\.?\d*)%/);
            if (match && onProgress) {
                onProgress(Math.round(parseFloat(match[1])));
            }
        });

        proc.stderr.on('data', (data) => {
            const match = data.toString().match(/(\d+\.?\d*)%/);
            if (match && onProgress) {
                onProgress(Math.round(parseFloat(match[1])));
            }
        });

        proc.on('close', (code) => {
            if (code === 0) resolve(output.trim());
            else reject(new Error(`Exit code: ${code}`));
        });

        proc.on('error', reject);
    });
}

// ============ API ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        ytdlp: fs.existsSync(YTDLP_PATH),
        queue: queue.length,
        processing: processing
    });
});

// Get video info
app.get('/api/info', rateLimiter, async (req, res) => {
    try {
        const { url } = req.query;

        if (!url) {
            return res.status(400).json({ error: 'URL required' });
        }

        if (!/youtube\.com|youtu\.be/i.test(url)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const cmd = `"${YTDLP_PATH}" --dump-json --no-warnings --no-playlist "${url}"`;
        const output = await runCommand(cmd);
        const info = JSON.parse(output);

        res.json({
            success: true,
            data: {
                id: info.id,
                title: info.title || 'Unknown',
                author: info.uploader || info.channel || 'Unknown',
                thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
                duration: formatDuration(info.duration),
                views: formatViews(info.view_count)
            }
        });

    } catch (err) {
        console.error('Info error:', err.message);
        res.status(500).json({ error: 'Failed to get video info' });
    }
});

// Start download
app.post('/api/convert', rateLimiter, (req, res) => {
    const { url, format, quality } = req.body;

    if (!url || !format) {
        return res.status(400).json({ error: 'URL and format required' });
    }

    if (queue.length >= 20) {
        return res.status(503).json({ error: 'Server busy, try later' });
    }

    const id = generateId();

    downloadProgress.set(id, {
        status: 'queued',
        progress: 0,
        message: 'Queued...',
        timestamp: Date.now(),
        filePath: null,
        filename: null,
        fileSize: 0
    });

    addToQueue({
        id,
        url,
        format,
        quality: quality || (format === 'mp3' ? '192' : '720')
    });

    res.json({ success: true, downloadId: id });
});

// Progress stream
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
                res.end();
            }
        } else {
            res.write(`data: {"status":"not_found"}\n\n`);
            clearInterval(interval);
            res.end();
        }
    };

    const interval = setInterval(send, 500);
    send();

    req.on('close', () => clearInterval(interval));
});

// Download file
app.get('/api/download/:id', (req, res) => {
    const { id } = req.params;
    const data = downloadProgress.get(id);

    if (!data || !data.filePath || !fs.existsSync(data.filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(data.filename);
    const mime = ext === '.mp3' ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', data.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.filename)}"`);

    const stream = fs.createReadStream(data.filePath);
    stream.pipe(res);

    stream.on('close', () => {
        setTimeout(() => {
            try { fs.unlinkSync(data.filePath); } catch (e) { }
            downloadProgress.delete(id);
        }, 5000);
    });
});

// Serve frontend
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START SERVER ============
async function start() {
    console.log('');
    console.log('🚀 Starting TubeGrab...');
    console.log('');

    // Download yt-dlp
    try {
        await downloadYtDlp();
    } catch (err) {
        console.error('❌ yt-dlp download failed:', err.message);
        console.log('⚠️ Will retry on first request');
    }

    // Start server
    app.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════════╗');
        console.log('║                                          ║');
        console.log('║   🎵 TUBEGRAB IS LIVE!                  ║');
        console.log('║                                          ║');
        console.log(`║   🌐 Port: ${PORT}                          ║`);
        console.log('║   ✅ Ready for downloads                ║');
        console.log('║                                          ║');
        console.log('╚══════════════════════════════════════════╝');
        console.log('');
    });
}

start();    