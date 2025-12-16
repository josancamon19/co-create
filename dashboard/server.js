const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.db': 'application/octet-stream',
    '.sqlite': 'application/octet-stream',
    '.sqlite3': 'application/octet-stream'
};

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Proxy endpoint for fetching remote resources (databases, bucket listings, etc.)
    if (pathname === '/proxy') {
        const targetUrl = parsedUrl.query.url;
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        console.log(`Proxying request to: ${targetUrl}`);

        const protocol = targetUrl.startsWith('https') ? https : http;
        protocol.get(targetUrl, (proxyRes) => {
            // Get the content type from the response, or default based on URL
            let contentType = proxyRes.headers['content-type'] || 'application/octet-stream';

            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                // Handle redirects
                protocol.get(proxyRes.headers.location, (redirectRes) => {
                    const redirectContentType = redirectRes.headers['content-type'] || 'application/octet-stream';
                    res.writeHead(redirectRes.statusCode, {
                        'Content-Type': redirectContentType
                    });
                    redirectRes.pipe(res);
                }).on('error', (err) => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err.message }));
                });
            } else {
                res.writeHead(proxyRes.statusCode, {
                    'Content-Type': contentType
                });
                proxyRes.pipe(res);
            }
        }).on('error', (err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        });
        return;
    }

    // Serve static files
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            // Try serving index.html for SPA routing
            const indexPath = path.join(__dirname, 'index.html');
            fs.readFile(indexPath, (err, content) => {
                if (err) {
                    res.writeHead(404);
                    res.end('Not Found');
                } else {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(content);
                }
            });
            return;
        }

        const ext = path.extname(filePath);
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500);
                res.end('Internal Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        });
    });
});

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      Co-Create Dashboard                      ║
╠══════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                    ║
║                                                              ║
║  Pages:                                                      ║
║  • Home:          http://localhost:${PORT}                      ║
║  • Contributions: http://localhost:${PORT}/contributions.html   ║
║  • Viewer:        http://localhost:${PORT}/viewer.html          ║
║                                                              ║
║  The proxy endpoint bypasses CORS for GCP bucket access.     ║
╚══════════════════════════════════════════════════════════════╝
`);
});
