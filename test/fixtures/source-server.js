import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function sourceServer(statePath) {
    const server = http.createServer(async (req, res) => {
        try {
            const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
            let result = { status: 'ok' };
            const id = /\/videos\/([^/]+)\.json/.exec(req.url)?.[1];
            let video;
            if (req.method === 'POST') {
                if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end('{}'); return; }
                let body = '';
                for await (const chunk of req) body += chunk;
                const input = JSON.parse(body);
                const videoId = new URL(input.url).searchParams.get('v') || 'abcdefghijk';
                state.calls.push(['add', input.url, input]);
                video = state.videos[videoId];
                result.skipped = !input.force && video?.status === 'downloaded';
                result.existed = Boolean(video);
                if (!result.skipped) video = state.videos[videoId] = { videoId, platform: 'youtube', status: 'queued', quality: input.quality, canonicalUrl: input.url, subs: {}, autoComplete: true };
            } else if (id) {
                state.calls.push(['get', id]);
                video = state.videos[id];
                if (!video) { res.writeHead(404).end('{}'); return; }
                if (video.autoComplete && !state.keepQueued) { video.status = state.failDownload ? 'failed' : 'downloaded'; delete video.autoComplete; }
            }
            if (video) {
                if (video.status === 'downloaded') {
                    const dir = path.join(state.libraryDir, 'videos', video.videoId);
                    await fs.mkdir(path.join(dir, 'subs'), { recursive: true });
                    await fs.writeFile(path.join(dir, 'video.mp4'), 'media');
                    await fs.writeFile(path.join(dir, 'thumb.jpg'), 'thumb');
                    await fs.writeFile(path.join(dir, 'subs/en.vtt'), 'WEBVTT\n');
                }
                const { videoPath, thumbPath, sha256, autoComplete, ...metadata } = video;
                result.video = metadata;
            }
            await fs.writeFile(statePath, JSON.stringify(state));
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { baseUrl: `http://127.0.0.1:${server.address().port}/video/api/v1/`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
