import { createReadStream, existsSync, statSync } from 'fs';
import { createServer } from 'http';
import { dirname, extname, normalize, resolve } from 'path';
import { fileURLToPath } from 'url';

const host = process.env.PWA_DEV_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.PWA_DEV_PORT || '4173', 10);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
	console.error(`Invalid PWA_DEV_PORT: ${process.env.PWA_DEV_PORT || ''}`);
	process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pwaRoot = resolve(scriptDir, '..', 'pwa');

if (!existsSync(pwaRoot)) {
	console.error(`PWA directory not found: ${pwaRoot}`);
	process.exit(1);
}

const mimeByExtension = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
};

function isPathInsideRoot(filePath) {
	return filePath === pwaRoot || filePath.startsWith(`${pwaRoot}/`);
}

function decodePathname(urlPathname) {
	try {
		return decodeURIComponent(urlPathname);
	} catch {
		return '/';
	}
}

function resolveStaticPath(urlPathname) {
	const decodedPath = decodePathname(urlPathname);
	const requestPath = decodedPath === '/' ? '/index.html' : decodedPath;
	const normalizedPath = normalize(requestPath).replace(/^[/\\]+/, '');
	const absolutePath = resolve(pwaRoot, normalizedPath);

	if (!isPathInsideRoot(absolutePath)) {
		return undefined;
	}

	if (existsSync(absolutePath) && statSync(absolutePath).isFile()) {
		return absolutePath;
	}

	if (!extname(normalizedPath)) {
		const fallback = resolve(pwaRoot, 'index.html');
		if (existsSync(fallback) && statSync(fallback).isFile()) {
			return fallback;
		}
	}

	return undefined;
}

function getContentType(filePath) {
	const extension = extname(filePath).toLowerCase();
	return mimeByExtension[extension] || 'application/octet-stream';
}

const server = createServer((request, response) => {
	if (!request.url) {
		response.statusCode = 400;
		response.end('Bad Request');
		return;
	}

	const url = new URL(request.url, 'http://localhost');
	const targetPath = resolveStaticPath(url.pathname);
	if (!targetPath) {
		response.statusCode = 404;
		response.setHeader('Content-Type', 'text/plain; charset=utf-8');
		response.end('Not Found');
		return;
	}

	response.statusCode = 200;
	response.setHeader('Content-Type', getContentType(targetPath));
	createReadStream(targetPath).pipe(response);
});

server.listen(port, host, () => {
	console.log(`PWA dev server running at http://${host}:${port}/`);
	console.log(`Serving: ${pwaRoot}`);
	console.log('Set COPILOT_PWA_DEV_URL to this URL before launching the extension host.');
});
