const {
  app, BrowserWindow, ipcMain, dialog, protocol, net, shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const { Readable } = require('stream');
const { spawn, execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const archiver = require('archiver');

let mainWindow = null;
const framesDir = path.join(app.getPath('temp'), 'frameforge-frames');

fs.mkdirSync(framesDir, { recursive: true });

/* ── Custom protocol for serving local media with range-request support ── */
protocol.registerSchemesAsPrivileged([{
  scheme: 'media',
  privileges: {
    bypassCSP: true, stream: true, supportFetchAPI: true,
    standard: false, secure: true, corsEnabled: false
  }
}]);

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.gif': 'image/gif'
};

function contentType(fp) {
  return MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560, height: 940, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0d0d0f',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    },
    show: false
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  /* ── Protocol handler with range-request support for video seeking ── */
  protocol.handle('media', async (request) => {
    let fp = decodeURIComponent(request.url.slice('media://'.length));
    try {
      const stat = fs.statSync(fp);
      const range = request.headers.get('range');
      const ct = contentType(fp);

      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          return new Response(
            Readable.toWeb(fs.createReadStream(fp, { start, end })),
            {
              status: 206,
              headers: {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': String(end - start + 1),
                'Content-Type': ct
              }
            }
          );
        }
      }
      return new Response(Readable.toWeb(fs.createReadStream(fp)), {
        status: 200,
        headers: {
          'Content-Length': String(stat.size),
          'Content-Type': ct,
          'Accept-Ranges': 'bytes'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch {}
});

/* ══════════════════════  IPC HANDLERS  ══════════════════════ */

// Open file dialog
ipcMain.handle('open-video', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Video',
    filters: [
      { name: 'Video', extensions: ['mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts','mts'] },
      { name: 'All', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

// Probe video metadata via ffmpeg
ipcMain.handle('get-video-info', (_e, filePath) => new Promise((resolve, reject) => {
  execFile(ffmpegPath, ['-i', filePath, '-hide_banner'], (err, stdout, stderr) => {
    const out = stderr;
    const vLine = out.split('\n').find(l => /Stream\s+#\d+:\d+.*Video/.test(l));
    if (!vLine) return reject(new Error('No video stream found'));

    let fps = 30;
    const fm = vLine.match(/(\d+(?:\.\d+)?)\s*fps/);
    const tb = vLine.match(/(\d+)\s*tbr/);
    if (fm) fps = parseFloat(fm[1]);
    else if (tb) fps = parseFloat(tb[1]);
    if (Math.abs(fps - 23.976) < 0.1) fps = 23.976;
    if (Math.abs(fps - 29.97)  < 0.1) fps = 29.97;
    if (Math.abs(fps - 59.94)  < 0.1) fps = 59.94;

    const rm = vLine.match(/(\d{3,5})x(\d{3,5})/);
    const width  = rm ? parseInt(rm[1]) : 0;
    const height = rm ? parseInt(rm[2]) : 0;

    const dm = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    let duration = 0;
    if (dm) duration = +dm[1]*3600 + +dm[2]*60 + +dm[3] + +dm[4]/100;

    resolve({ duration, fps, width, height, totalFrames: Math.floor(duration * fps), filePath });
  });
}));

// Extract a single frame via ffmpeg → PNG
ipcMain.handle('extract-frame', (_e, filePath, frameNumber, fps) => new Promise((resolve, reject) => {
  const ts = (frameNumber / fps).toFixed(6);
  const id = `frame_${String(frameNumber).padStart(8, '0')}`;
  const out = path.join(framesDir, `${id}.png`);

  if (fs.existsSync(out) && fs.statSync(out).size > 0)
    return resolve({ id, frameNumber, filePath: out });

  const proc = spawn(ffmpegPath, [
    '-ss', ts, '-i', filePath,
    '-frames:v', '1', '-q:v', '1',
    '-compression_level', '0', '-y', out
  ]);
  let errData = '';
  proc.stderr.on('data', d => errData += d);
  proc.on('close', code => {
    if (code !== 0) return reject(new Error(errData.slice(-300)));
    if (!fs.existsSync(out)) return reject(new Error('Output missing'));
    resolve({ id, frameNumber, filePath: out });
  });
  proc.on('error', reject);
}));

// Create ZIP on desktop named code.zip
ipcMain.handle('create-zip', (_e, frames) => new Promise((resolve, reject) => {
  const zipPath = path.join(app.getPath('desktop'), 'code.zip');
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 0 } }); // no compression for speed
  output.on('close', () => resolve({ path: zipPath, size: archive.pointer(), count: frames.length }));
  archive.on('error', reject);
  archive.pipe(output);
  for (const f of frames) {
    if (fs.existsSync(f.filePath)) archive.file(f.filePath, { name: `${f.id}.png` });
  }
  archive.finalize();
}));

// Delete a single extracted frame from disk
ipcMain.handle('delete-frame', (_e, fp) => {
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); return true; } catch { return false; }
});

// Reveal file in OS file manager
ipcMain.handle('show-in-folder', (_e, fp) => shell.showItemInFolder(fp));
