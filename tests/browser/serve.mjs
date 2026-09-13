#!/usr/bin/env node
/*
 * Serves the browser harnesses: the real static tree at the URLs the pages and
 * any worker expect, the harness pages themselves, and -- where one is given
 * -- a recording at /recording.guac.
 *
 * Over HTTP rather than from a file, because a worker cannot be started from a
 * file:// page at all -- which is the whole thing being tested.
 *
 * Usage: node tests/browser/serve.mjs [recording.guac] [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, resolve, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/* The recording is optional: the pointer harness needs no session, only the
 * static tree and a page. */
const recording = process.argv[2] ? resolve(process.argv[2]) : null;
const port = parseInt(process.argv[3] || '8099', 10);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js'  : 'text/javascript; charset=utf-8',
    '.css' : 'text/css; charset=utf-8',
    '.guac': 'text/plain; charset=utf-8'
};

createServer(async (req, res) => {

    const url = new URL(req.url, 'http://localhost');
    let file;

    if (url.pathname === '/recording.guac' && recording)
        file = recording;
    else if (url.pathname === '/' || url.pathname.endsWith('.html'))
        file = join(root, 'tests/browser',
                url.pathname === '/' ? 'replay.html'
                                     : url.pathname.replace(/^\//, ''));
    else {
        /* Only ever out of the static tree, and never up out of it. */
        const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
        file = join(root, 'static', rel);
        if (!file.startsWith(join(root, 'static'))) {
            res.writeHead(403).end('no');
            return;
        }
    }

    try {
        const info = await stat(file);
        res.writeHead(200, {
            'content-type'   : TYPES[extname(file)] || 'application/octet-stream',
            'content-length' : info.size,
            /* Nothing here is cached: the point is to serve what is on disk. */
            'cache-control'  : 'no-store'
        });
        createReadStream(file).pipe(res);
    } catch (e) {
        res.writeHead(404).end('not found: ' + url.pathname);
    }

}).listen(port, '127.0.0.1', () => {
    console.log(`replay harness on http://127.0.0.1:${port}/`);
    console.log(`  recording: ${recording || '(none given)'}`);
});
