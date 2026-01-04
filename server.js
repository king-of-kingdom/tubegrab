const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== DETECT ENVIRONMENT ==========
const isWindows = process.platform === 'win32';
const isCloud = process.env.RENDER || process.env.RAILWAY || process.env.NODE_ENV === 'production';

console.log(`🖥️  Platform: ${isWindows ? 'Windows' : 'Linux'}`);
console.log(`☁️  Cloud: ${isCloud ? 'Yes' : 'No'}`);

// ========== DIRECTORIES ==========
let DOWNLOADS_DIR, BIN_DIR, YTDLP_PATH;

if (isCloud) {
    // Cloud (Render, Railway, etc.) - use /tmp
    DOWNLOADS_DIR = '/tmp/downloads';
    BIN_DIR = '/tmp/bin';
    YTDLP_PATH = '/tmp/bin/yt-dlp';
} else if (isWindows) {
    // Windows local
    DOWNLOADS_DIR = path.join(__dirname, 'downloads');
    BIN_DIR = path.join(__dirname, 'bin');
    YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp.exe');
} else {
    // Linux local
    DOWNLOADS_DIR = path.join(__dirname, 'downloads');
    BIN_DIR = path.join(__dirname, 'bin');
    YTDLP_PATH = path.join(BIN_DIR, 'yt-dlp');
}

// Create directories
try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });
    console.log('📁 Directories ready');
} catch (e) {
    console.log('📁 Directory note:', e.message);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== DOWNLOAD YT-DLP ==========
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        // Check if already exists
        if (fs.existsSync(YTDLP_PATH)) {
            console.log('✅ yt-dlp already exists');
            return resolve();
        }

        // Choose correct download URL
        const ytdlpUrl = isWindows
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

        console.log('📥 Downloading yt-dlp...');

        const file = fs.createWriteStream(YTDLP_PATH);

        const download = (url) => {
            https.get(url, (res) => {
                // Handle redirects
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return download(res.headers.location);
                }

                if (res.statusCode !== 200) {
                    return reject(new Error('Download failed: ' + res.statusCode));
                }

                const total = parseInt(res.headers['content-length'], 10);
                let downloaded = 0;

                res.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (total) {
                        const pct = Math.round((downloaded / total) * 100);
                        process.stdout.write(`\r   Progress: ${pct}%`);
                    }
                });

                res.pipe(file);

                file.on('finish', () => {
                    file.close();
                    console.log('\n✅ yt-dlp downloaded!');

                    // Make executable (Linux/Mac)
                    if (!isWindows) {
                        try {
                            fs.chmodSync(YTDLP_PATH, 0o755);
                            console.log('✅ Made executable');
                        } catch (e) {
                            console.log('⚠️ chmod note:', e.message);
                        }
                    }
                    resolve();
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

        download(ytdlpUrl);
    });
}

// ========== STORAGE ==========
const downloadProgress = new Map();
const requestCounts = new Map();

// ========== RATE LIMITER ==========
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

// ========== QUEUE SYSTEM ==========
const queue = [];
let activeJobs = 0;
const MAX_CONCURRENT = 2;

function addToQueue(job) {
    queue.push(job);
    processQueue();
}

function processQueue() {
    while (activeJobs < MAX_CONCURRENT && queue.length > 0) {
        activeJobs++;
        const job = queue.shift();
        runDownload(job).finally(() => {
            activeJobs--;
            processQueue();
        });
    }
}

// ========== HELPERS ==========
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitize(str) {
    if (!str) return 'video';
    return str.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().substring(0, 80) || 'video';
}

function formatDuration(sec) {
    if (!sec) return '0:00';
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
    return String(n);
}

function runCmd(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, {
            maxBuffer: 50 * 1024 * 1024,
            timeout: 300000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
        });
    });
}

function deleteFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
}

// ========== CLEANUP (Every 2 minutes) ==========
setInterval(() => {
    try {
        const now = Date.now();

        // Clean downloads folder
        if (fs.existsSync(DOWNLOADS_DIR)) {
            fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
                const p = path.join(DOWNLOADS_DIR, f);
                try {
                    if (now - fs.statSync(p).mtimeMs > 180000) { // 3 minutes
                        fs.unlinkSync(p);
                        console.log('🗑️ Cleaned:', f);
                    }
                } catch (e) { }
            });
        }

        // Clean progress map
        for (const [id, data] of downloadProgress.entries()) {
            if (now - data.timestamp > 300000) { // 5 minutes
                downloadProgress.delete(id);
            }
        }

        // Clean rate limit map
        for (const [ip, data] of requestCounts.entries()) {
            if (now > data.resetTime + 60000) {
                requestCounts.delete(ip);
            }
        }
    } catch (e) { }
}, 120000);

// ========== DOWNLOAD PROCESSOR ==========
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

        // Get video title
        let title = 'video';
        try {
            const cmd = isWindows
                ? `"${YTDLP_PATH}" --print title --no-playlist --no-warnings "${url}"`
                : `${YTDLP_PATH} --print title --no-playlist --no-warnings "${url}"`;
            title = sanitize(await runCmd(cmd));
        } catch (e) {
            console.log('   Title fetch failed, using default');
        }

        update(10, 'Downloading...');

        const ext = format === 'mp3' ? 'mp3' : 'mp4';
        const filename = `${title}.${ext}`;
        const outputFile = path.join(DOWNLOADS_DIR, `${id}.${ext}`);

        console.log('🎬 Processing:', title);

        // Build command based on format
        let cmd;
        if (format === 'mp3') {
            cmd = isWindows
                ? `"${YTDLP_PATH}" -x --audio-format mp3 --audio-quality ${quality}K --no-playlist --no-warnings -o "${outputFile}" "${url}"`
                : `${YTDLP_PATH} -x --audio-format mp3 --audio-quality ${quality}K --no-playlist --no-warnings -o "${outputFile}" "${url}"`;
        } else {
            const formatStr = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
            cmd = isWindows
                ? `"${YTDLP_PATH}" -f "${formatStr}" --merge-output-format mp4 --no-playlist --no-warnings -o "${outputFile}" "${url}"`
                : `${YTDLP_PATH} -f "${formatStr}" --merge-output-format mp4 --no-playlist --no-warnings -o "${outputFile}" "${url}"`;
        }

        // Run download with progress tracking
        await new Promise((resolve, reject) => {
            const proc = exec(cmd, {
                maxBuffer: 100 * 1024 * 1024,
                timeout: 600000,
                windowsHide: true
            });

            proc.stdout.on('data', (data) => {
                const match = data.toString().match(/(\d+\.?\d*)%/);
                if (match) {
                    const pct = Math.round(parseFloat(match[1]));
                    update(10 + pct * 0.85, `Downloading: ${pct}%`);
                }
            });

            proc.stderr.on('data', (data) => {
                const match = data.toString().match(/(\d+\.?\d*)%/);
                if (match) {
                    const pct = Math.round(parseFloat(match[1]));
                    update(10 + pct * 0.85, `Downloading: ${pct}%`);
                }
            });

            proc.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Exit code: ${code}`));
            });

            proc.on('error', reject);
        });

        // Find the output file
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

        // Cleanup any partial files
        try {
            const files = fs.readdirSync(DOWNLOADS_DIR);
            files.filter(f => f.startsWith(id)).forEach(f => {
                deleteFile(path.join(DOWNLOADS_DIR, f));
            });
        } catch (e) { }
    }
}

// ========== API ROUTES ==========

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        platform: isWindows ? 'windows' : 'linux',
        cloud: isCloud,
        ytdlp: fs.existsSync(YTDLP_PATH),
        queue: queue.length,
        active: activeJobs
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

        const cmd = isWindows
            ? `"${YTDLP_PATH}" --dump-json --no-playlist --no-warnings "${url}"`
            : `${YTDLP_PATH} --dump-json --no-playlist --no-warnings "${url}"`;

        const output = await runCmd(cmd);
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
        return res.status(503).json({ error: 'Server busy. Try again later.' });
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

// Progress stream (SSE)
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

    const ext = path.extname(data.filename).toLowerCase();
    const mime = ext === '.mp3' ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', data.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.filename)}"`);

    const stream = fs.createReadStream(data.filePath);
    stream.pipe(res);

    stream.on('close', () => {
        // Delete file after download
        setTimeout(() => {
            deleteFile(data.filePath);
            downloadProgress.delete(id);
        }, 5000);
    });
});

// Serve frontend
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <html>
            <body style="font-family:system-ui;background:#0f172a;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
                <div style="text-align:center">
                    <h1>🎵 TubeGrab Server Running!</h1>
                    <p>Create public/index.html for the UI</p>
                    <p><a href="/api/health" style="color:#60a5fa">Check Health</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// ========== START SERVER ==========
async function start() {
    console.log('');
    console.log('🚀 Starting TubeGrab...');
    console.log('');

    // Download yt-dlp
    try {
        await downloadYtDlp();
    } catch (err) {
        console.error('⚠️ yt-dlp download error:', err.message);
    }

    // Start listening
    app.listen(PORT, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════════════╗');
        console.log('║                                               ║');
        console.log('║   🎵 TUBEGRAB IS READY!                      ║');
        console.log('║                                               ║');
        console.log('╠═══════════════════════════════════════════════╣');
        console.log('║                                               ║');
        console.log(`║   🌐 Port: ${PORT}                              ║`);
        console.log(`║   💻 Platform: ${isWindows ? 'Windows' : 'Linux'}                      ║`);
        console.log(`║   ☁️  Cloud: ${isCloud ? 'Yes' : 'No'}                             ║`);
        console.log('║                                               ║');
        console.log('║   ✅ MP3 Downloads                           ║');
        console.log('║   ✅ MP4 Downloads                           ║');
        console.log('║   ✅ Real-time Progress                      ║');
        console.log('║                                               ║');
        console.log('╚═══════════════════════════════════════════════╝');
        console.log('');
    });
}

start();

// Handle shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down...');
    process.exit(0);
});