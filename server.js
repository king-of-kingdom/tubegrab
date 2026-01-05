const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== SETUP ==========
const DOWNLOADS_DIR = '/tmp/downloads';
const YTDLP_PATH = '/tmp/yt-dlp';

// Create downloads folder
try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
        fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }
} catch (e) {
    console.log('Folder error:', e.message);
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== DOWNLOAD YT-DLP ==========
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(YTDLP_PATH)) {
            console.log('✅ yt-dlp already exists');
            return resolve();
        }

        console.log('📥 Downloading yt-dlp...');

        const file = fs.createWriteStream(YTDLP_PATH);
        const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

        const download = (downloadUrl) => {
            https.get(downloadUrl, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return download(res.headers.location);
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    fs.chmodSync(YTDLP_PATH, 0o755);
                    console.log('✅ yt-dlp downloaded!');
                    resolve();
                });
            }).on('error', (err) => {
                console.log('❌ Download error:', err.message);
                reject(err);
            });
        };

        download(url);
    });
}

// ========== HELPERS ==========
const downloadProgress = new Map();

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitize(str) {
    return (str || 'video').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 80) || 'video';
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

// Run command with timeout
function runCmd(cmd, timeout = 120000) {
    return new Promise((resolve, reject) => {
        console.log('🔧 Command:', cmd.slice(0, 80) + '...');

        exec(cmd, {
            maxBuffer: 50 * 1024 * 1024,
            timeout: timeout
        }, (err, stdout, stderr) => {
            if (err) {
                console.log('❌ Error:', stderr || err.message);
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

// Cleanup old files
setInterval(() => {
    try {
        const now = Date.now();
        if (fs.existsSync(DOWNLOADS_DIR)) {
            fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
                try {
                    const p = path.join(DOWNLOADS_DIR, f);
                    if (now - fs.statSync(p).mtimeMs > 300000) {
                        fs.unlinkSync(p);
                        console.log('🗑️ Deleted:', f);
                    }
                } catch (e) { }
            });
        }

        for (const [id, data] of downloadProgress.entries()) {
            if (now - data.timestamp > 600000) {
                downloadProgress.delete(id);
            }
        }
    } catch (e) { }
}, 120000);

// ========== QUEUE ==========
const queue = [];
let activeJobs = 0;

function addJob(job) {
    queue.push(job);
    processQueue();
}

function processQueue() {
    while (activeJobs < 2 && queue.length > 0) {
        activeJobs++;
        const job = queue.shift();
        processDownload(job).finally(() => {
            activeJobs--;
            processQueue();
        });
    }
}

// ========== PROCESS DOWNLOAD ==========
async function processDownload(job) {
    const { id, url, format, quality } = job;

    console.log('🎬 Processing:', id, format, quality);

    const update = (progress, message, status = 'processing') => {
        const data = downloadProgress.get(id);
        if (data) {
            data.progress = progress;
            data.message = message;
            data.status = status;
        }
    };

    try {
        update(10, 'Getting video info...');

        // Get title
        let title = 'video';
        try {
            const titleCmd = `${YTDLP_PATH} --print title --no-playlist "${url}" 2>/dev/null`;
            title = sanitize(await runCmd(titleCmd, 30000));
            console.log('📝 Title:', title);
        } catch (e) {
            console.log('⚠️ Title error, using default');
        }

        update(20, 'Starting download...');

        const ext = format === 'mp3' ? 'mp3' : 'mp4';
        const outputFile = path.join(DOWNLOADS_DIR, `${id}.${ext}`);
        const filename = `${title}.${ext}`;

        let cmd;
        if (format === 'mp3') {
            cmd = `${YTDLP_PATH} -x --audio-format mp3 --audio-quality ${quality}K --no-playlist -o "${outputFile}" "${url}" 2>&1`;
        } else {
            cmd = `${YTDLP_PATH} -f "bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best" --merge-output-format mp4 --no-playlist -o "${outputFile}" "${url}" 2>&1`;
        }

        // Simulate progress
        let progress = 20;
        const progressTimer = setInterval(() => {
            if (progress < 80) {
                progress += 5;
                update(progress, 'Downloading...');
            }
        }, 3000);

        try {
            await runCmd(cmd, 300000);
        } finally {
            clearInterval(progressTimer);
        }

        update(90, 'Almost done...');

        // Find output file
        let finalPath = null;

        if (fs.existsSync(outputFile)) {
            finalPath = outputFile;
        } else {
            // Look for file with our ID
            const files = fs.readdirSync(DOWNLOADS_DIR);
            const match = files.find(f => f.startsWith(id));
            if (match) {
                finalPath = path.join(DOWNLOADS_DIR, match);
            }
        }

        if (!finalPath || !fs.existsSync(finalPath)) {
            throw new Error('File was not created');
        }

        const stats = fs.statSync(finalPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        const actualExt = path.extname(finalPath).slice(1) || ext;

        console.log('✅ Complete:', filename, sizeMB + ' MB');

        update(100, `Ready! (${sizeMB} MB)`, 'completed');

        const data = downloadProgress.get(id);
        if (data) {
            data.filePath = finalPath;
            data.filename = `${title}.${actualExt}`;
            data.fileSize = stats.size;
        }

    } catch (err) {
        console.log('❌ Job error:', err.message);
        update(0, 'Download failed', 'error');

        // Cleanup
        try {
            fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => f.startsWith(id))
                .forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
        } catch (e) { }
    }
}

// ========== API ROUTES ==========

// Health
app.get('/api/health', (req, res) => {
    console.log('💓 Health check');
    res.json({
        status: 'ok',
        ytdlp: fs.existsSync(YTDLP_PATH),
        queue: queue.length,
        active: activeJobs
    });
});

// Get video info
app.get('/api/info', async (req, res) => {
    const { url } = req.query;

    console.log('📥 Info request:', url);

    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    try {
        const cmd = `${YTDLP_PATH} --dump-json --no-playlist "${url}" 2>&1`;
        const output = await runCmd(cmd, 60000);

        let info;
        try {
            info = JSON.parse(output);
        } catch (e) {
            console.log('❌ JSON parse error:', output.slice(0, 200));
            throw new Error('Could not parse video info');
        }

        console.log('✅ Info success:', info.title);

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

    } catch (err) {
        console.log('❌ Info error:', err.message);
        res.status(500).json({ error: 'Failed to get video info' });
    }
});

// Start download
app.post('/api/convert', (req, res) => {
    const { url, format, quality } = req.body;

    console.log('🚀 Convert request:', url?.slice(0, 50), format, quality);

    if (!url || !format) {
        return res.status(400).json({ error: 'URL and format required' });
    }

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

    addJob({
        id,
        url,
        format,
        quality: quality || (format === 'mp3' ? '192' : '720')
    });

    console.log('✅ Job added:', id);

    res.json({ success: true, downloadId: id });
});

// Progress SSE
app.get('/api/progress/:id', (req, res) => {
    const { id } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = () => {
        const data = downloadProgress.get(id);
        const response = data || { status: 'not_found', progress: 0, message: 'Not found' };
        res.write(`data: ${JSON.stringify(response)}\n\n`);

        if (!data || data.status === 'completed' || data.status === 'error') {
            clearInterval(interval);
            setTimeout(() => res.end(), 500);
        }
    };

    const interval = setInterval(send, 1000);
    send();

    req.on('close', () => clearInterval(interval));
});

// Download file
app.get('/api/download/:id', (req, res) => {
    const { id } = req.params;
    const data = downloadProgress.get(id);

    console.log('📥 Download request:', id);

    if (!data || data.status !== 'completed') {
        return res.status(404).json({ error: 'File not ready' });
    }

    if (!data.filePath || !fs.existsSync(data.filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    console.log('📤 Sending:', data.filename);

    const ext = path.extname(data.filename).toLowerCase();
    const mime = ext === '.mp3' ? 'audio/mpeg' : 'video/mp4';

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', data.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.filename)}"`);

    const stream = fs.createReadStream(data.filePath);
    stream.pipe(res);

    stream.on('close', () => {
        console.log('✅ File sent');
        setTimeout(() => {
            try { fs.unlinkSync(data.filePath); } catch (e) { }
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
        res.send('<h1>TubeGrab Running!</h1>');
    }
});

// ========== START ==========
async function start() {
    console.log('');
    console.log('🚀 TubeGrab Starting...');

    try {
        await downloadYtDlp();
    } catch (err) {
        console.log('⚠️ yt-dlp setup failed:', err.message);
    }

    app.listen(PORT, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════╗');
        console.log('║   🎵 TUBEGRAB IS LIVE!               ║');
        console.log(`║   🌐 Port: ${PORT}                      ║`);
        console.log('╚═══════════════════════════════════════╝');
        console.log('');
    });
}

start();