const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// Detect environment
const isWindows = process.platform === 'win32';
const isCloud = process.env.RENDER || process.env.RAILWAY || process.env.NODE_ENV === 'production';

console.log(`🖥️  Platform: ${isWindows ? 'Windows' : 'Linux'}`);
console.log(`☁️  Cloud: ${isCloud}`);

// Directories
const DOWNLOADS_DIR = isCloud ? '/tmp/downloads' : path.join(__dirname, 'downloads');
const BIN_DIR = isCloud ? '/tmp/bin' : path.join(__dirname, 'bin');
const YTDLP_PATH = isCloud
    ? '/tmp/bin/yt-dlp'
    : (isWindows ? path.join(BIN_DIR, 'yt-dlp.exe') : path.join(BIN_DIR, 'yt-dlp'));

// Create directories
try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    fs.mkdirSync(BIN_DIR, { recursive: true });
} catch (e) { }

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== DOWNLOAD YT-DLP ==========
function downloadYtDlp() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(YTDLP_PATH)) {
            console.log('✅ yt-dlp exists');
            return resolve();
        }

        const url = isWindows
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

        console.log('📥 Downloading yt-dlp...');

        const file = fs.createWriteStream(YTDLP_PATH);

        const download = (downloadUrl) => {
            https.get(downloadUrl, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                    return download(res.headers.location);
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    if (!isWindows) {
                        try { fs.chmodSync(YTDLP_PATH, 0o755); } catch (e) { }
                    }
                    console.log('✅ yt-dlp downloaded!');
                    resolve();
                });
            }).on('error', reject);
        };

        download(url);
    });
}

// ========== STORAGE & QUEUE ==========
const downloadProgress = new Map();
const queue = [];
let activeJobs = 0;

function addToQueue(job) {
    queue.push(job);
    processQueue();
}

function processQueue() {
    while (activeJobs < 2 && queue.length > 0) {
        activeJobs++;
        const job = queue.shift();
        runDownload(job).finally(() => {
            activeJobs--;
            processQueue();
        });
    }
}

// ========== HELPERS ==========
function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitize(str) {
    return (str || 'video').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim().slice(0, 80) || 'video';
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

function runCmd(cmd, timeout = 300000) {
    return new Promise((resolve, reject) => {
        console.log('🔧 Running:', cmd.substring(0, 100) + '...');
        exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
            if (err) {
                console.error('❌ Command error:', stderr || err.message);
                reject(new Error(stderr || err.message));
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

// Cleanup every 2 min
setInterval(() => {
    try {
        const now = Date.now();
        if (fs.existsSync(DOWNLOADS_DIR)) {
            fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
                const p = path.join(DOWNLOADS_DIR, f);
                try {
                    if (now - fs.statSync(p).mtimeMs > 180000) fs.unlinkSync(p);
                } catch (e) { }
            });
        }
        for (const [id, data] of downloadProgress.entries()) {
            if (now - data.timestamp > 300000) downloadProgress.delete(id);
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
        update(5, 'Getting video info...');
        console.log('🎬 Starting download for:', url);

        // Get title
        let title = 'video';
        try {
            const titleCmd = `${YTDLP_PATH} --print title --no-playlist --no-warnings "${url}"`;
            title = sanitize(await runCmd(titleCmd, 30000));
            console.log('📝 Title:', title);
        } catch (e) {
            console.log('⚠️ Could not get title, using default');
        }

        update(15, 'Downloading...');

        const ext = format === 'mp3' ? 'mp3' : 'mp4';
        const filename = `${title}.${ext}`;
        const outputFile = path.join(DOWNLOADS_DIR, `${id}.${ext}`);

        let cmd;
        if (format === 'mp3') {
            // For MP3: Use best audio and let yt-dlp handle conversion
            // If FFmpeg not available, it will download best audio format available
            cmd = `${YTDLP_PATH} -f "bestaudio" --extract-audio --audio-format mp3 --audio-quality ${quality}K --no-playlist --no-warnings --no-check-certificates -o "${outputFile}" "${url}"`;
        } else {
            // For MP4: Get best video+audio combo
            cmd = `${YTDLP_PATH} -f "bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best" --merge-output-format mp4 --no-playlist --no-warnings --no-check-certificates -o "${outputFile}" "${url}"`;
        }

        console.log('⬇️ Download command ready');

        // Run download with progress simulation
        const downloadPromise = runCmd(cmd, 600000);

        // Simulate progress updates
        let progress = 15;
        const progressInterval = setInterval(() => {
            if (progress < 85) {
                progress += Math.random() * 10;
                update(Math.min(progress, 85), 'Downloading...');
            }
        }, 2000);

        try {
            await downloadPromise;
            clearInterval(progressInterval);
        } catch (downloadError) {
            clearInterval(progressInterval);
            console.error('❌ Download failed:', downloadError.message);

            // Try fallback for MP3 - just get audio without conversion
            if (format === 'mp3') {
                console.log('🔄 Trying fallback audio download...');
                update(50, 'Trying alternative method...');

                const fallbackCmd = `${YTDLP_PATH} -f "bestaudio" --no-playlist --no-warnings --no-check-certificates -o "${path.join(DOWNLOADS_DIR, id)}.%(ext)s" "${url}"`;
                await runCmd(fallbackCmd, 600000);
            } else {
                throw downloadError;
            }
        }

        update(90, 'Finalizing...');

        // Find output file
        let finalPath = null;
        const files = fs.readdirSync(DOWNLOADS_DIR);

        // Look for our file
        const matchingFile = files.find(f => f.startsWith(id));
        if (matchingFile) {
            finalPath = path.join(DOWNLOADS_DIR, matchingFile);
        } else if (fs.existsSync(outputFile)) {
            finalPath = outputFile;
        }

        if (!finalPath || !fs.existsSync(finalPath)) {
            throw new Error('File was not created');
        }

        const stats = fs.statSync(finalPath);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        // Update filename with correct extension
        const actualExt = path.extname(finalPath).slice(1) || ext;
        const finalFilename = `${title}.${actualExt}`;

        console.log('✅ Download complete:', finalFilename, `(${sizeMB} MB)`);

        update(100, `Ready! (${sizeMB} MB)`, 'completed');

        const data = downloadProgress.get(id);
        if (data) {
            data.filePath = finalPath;
            data.filename = finalFilename;
            data.fileSize = stats.size;
        }

    } catch (err) {
        console.error('❌ Download error:', err.message);
        update(0, 'Download failed: ' + err.message.substring(0, 50), 'error');

        // Cleanup
        try {
            fs.readdirSync(DOWNLOADS_DIR)
                .filter(f => f.startsWith(id))
                .forEach(f => fs.unlinkSync(path.join(DOWNLOADS_DIR, f)));
        } catch (e) { }
    }
}

// ========== API ROUTES ==========

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        platform: isWindows ? 'windows' : 'linux',
        cloud: String(isCloud),
        ytdlp: fs.existsSync(YTDLP_PATH),
        queue: queue.length,
        active: activeJobs
    });
});

app.get('/api/info', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).json({ error: 'URL required' });

        console.log('📥 Getting info for:', url);

        const cmd = `${YTDLP_PATH} --dump-json --no-playlist --no-warnings --no-check-certificates "${url}"`;
        const output = await runCmd(cmd, 60000);
        const info = JSON.parse(output);

        console.log('✅ Info received for:', info.title);

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
        console.error('❌ Info error:', err.message);
        res.status(500).json({ error: 'Failed to get video info. Please check the URL.' });
    }
});

app.post('/api/convert', (req, res) => {
    const { url, format, quality } = req.body;

    console.log('🎯 Convert request:', { url: url?.substring(0, 50), format, quality });

    if (!url || !format) {
        return res.status(400).json({ error: 'URL and format required' });
    }

    if (queue.length >= 10) {
        return res.status(503).json({ error: 'Server busy. Please try again.' });
    }

    const id = genId();

    downloadProgress.set(id, {
        status: 'queued',
        progress: 0,
        message: 'Starting...',
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

    console.log('✅ Job queued:', id);

    res.json({ success: true, downloadId: id });
});

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

app.get('/api/download/:id', (req, res) => {
    const { id } = req.params;
    const data = downloadProgress.get(id);

    console.log('📥 Download request for:', id);

    if (!data) {
        console.log('❌ Download not found:', id);
        return res.status(404).json({ error: 'Download not found' });
    }

    if (data.status !== 'completed') {
        console.log('❌ Download not ready:', id, data.status);
        return res.status(400).json({ error: 'Download not ready yet' });
    }

    if (!data.filePath || !fs.existsSync(data.filePath)) {
        console.log('❌ File not found:', data.filePath);
        return res.status(404).json({ error: 'File not found' });
    }

    const ext = path.extname(data.filename).toLowerCase();
    const mime = ['.mp3', '.m4a', '.webm', '.opus'].includes(ext) ? 'audio/mpeg' : 'video/mp4';

    console.log('📤 Sending file:', data.filename);

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', data.fileSize);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(data.filename)}"`);

    const stream = fs.createReadStream(data.filePath);
    stream.pipe(res);

    stream.on('close', () => {
        console.log('✅ File sent successfully');
        setTimeout(() => {
            try { fs.unlinkSync(data.filePath); } catch (e) { }
            downloadProgress.delete(id);
        }, 5000);
    });

    stream.on('error', (err) => {
        console.error('❌ Stream error:', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Download failed' });
        }
    });
});

app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send('<h1>TubeGrab Server Running!</h1><p><a href="/api/health">Check Health</a></p>');
    }
});

// ========== START ==========
async function start() {
    console.log('');
    console.log('🚀 TubeGrab Starting...');

    try {
        await downloadYtDlp();
    } catch (err) {
        console.error('⚠️ yt-dlp error:', err.message);
    }

    app.listen(PORT, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════╗');
        console.log('║   🎵 TUBEGRAB READY!                 ║');
        console.log(`║   🌐 Port: ${PORT}                      ║`);
        console.log(`║   💻 ${isWindows ? 'Windows' : 'Linux'} | Cloud: ${isCloud}        ║`);
        console.log('╚═══════════════════════════════════════╝');
        console.log('');
    });
}

start();