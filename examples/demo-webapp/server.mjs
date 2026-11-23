#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 5899;

function createInitialState() {
  return {
    courses: [
      {
        id: 'course-open-101',
        title: 'Playwright Architecture & Test Agents',
        instructor: 'Dr. Rivera',
        seatsLeft: 10,
      },
      {
        id: 'course-last-seat',
        title: 'AI Quality Engineering (Last Seat)',
        instructor: 'Prof. Lin',
        seatsLeft: 1,
      },
      {
        id: 'course-sold-out',
        title: 'Legacy Manual QA Seminar (Sold Out)',
        instructor: 'Prof. Grant',
        seatsLeft: 0,
      },
    ],
    // Map<courseId, Set<username>>
    enrollments: new Map([
      ['course-open-101', new Set()],
      ['course-last-seat', new Set()],
      ['course-sold-out', new Set()],
    ]),
    // Map<token, { username, role }>
    sessions: new Map(),
  };
}

function isLoopbackAddress(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 64 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function renderCatalogHtml(courses) {
  const itemsHtml = courses
    .map((c) => {
      const soldOut = c.seatsLeft <= 0;
      const btnLabel = soldOut ? 'Sold Out' : `Enroll (${c.seatsLeft} seats left)`;
      return `
        <li class="course-card" data-course-id="${c.id}" data-title="${c.title.toLowerCase()}">
          <h2>${c.title}</h2>
          <p>Instructor: ${c.instructor} | Seats remaining: <span class="seats">${c.seatsLeft}</span></p>
          <button type="button" ${soldOut ? 'disabled' : ''} data-enroll="${c.id}">${btnLabel}</button>
        </li>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Smart Campus Course Portal</title>
  <style>
    body { font-family: system-ui, sans-serif; color: #111827; background: #ffffff; margin: 2rem; line-height: 1.5; }
    header, main { max-width: 780px; margin: 0 auto; }
    nav a { color: #1d4ed8; margin-right: 1rem; }
    .search-row { margin: 1.25rem 0; }
    input { padding: 0.5rem; border: 1px solid #374151; border-radius: 4px; width: 280px; color: #111827; background: #ffffff; }
    ul { list-style: none; padding: 0; }
    .course-card { border: 1px solid #d1d5db; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
    button { padding: 0.5rem 0.9rem; border-radius: 4px; border: 1px solid #1e40af; background: #1d4ed8; color: #ffffff; cursor: pointer; }
    button:disabled { background: #4b5563; border-color: #4b5563; color: #ffffff; cursor: not-allowed; }
  </style>
</head>
<body>
  <header>
    <nav aria-label="Main Navigation">
      <a href="/">Courses</a>
      <a href="/login">Sign In</a>
    </nav>
  </header>
  <main>
    <h1>Smart Campus Course Portal</h1>
    <div class="search-row">
      <label for="course-search">Search courses</label>
      <input id="course-search" name="q" type="search" placeholder="Filter by title..." />
    </div>
    <p id="feedback" role="status" aria-live="polite"></p>
    <ul id="course-list" aria-label="Available Courses">
      ${itemsHtml}
    </ul>
  </main>
  <script>
    const searchInput = document.getElementById('course-search');
    const cards = Array.from(document.querySelectorAll('.course-card'));
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      for (const card of cards) {
        const match = !q || card.dataset.title.includes(q);
        card.hidden = !match;
      }
    });
  </script>
</body>
</html>`;
}

function renderLoginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In — Smart Campus</title>
  <style>
    body { font-family: system-ui, sans-serif; color: #111827; background: #ffffff; margin: 2rem; }
    main { max-width: 420px; margin: 0 auto; }
    label { display: block; margin-top: 0.75rem; font-weight: 600; }
    input { width: 100%; padding: 0.5rem; margin-top: 0.25rem; border: 1px solid #374151; }
    button { margin-top: 1rem; padding: 0.5rem 1rem; background: #1d4ed8; color: #ffffff; border: none; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>QA Student Sign In</h1>
    <form id="login-form" aria-label="Student Login">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" autocomplete="username" required />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign In</button>
    </form>
    <p id="login-status" role="status"></p>
  </main>
</body>
</html>`;
}

function renderForbiddenHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>403 Forbidden</title>
</head>
<body>
  <main>
    <h1>403 Forbidden</h1>
    <p>Student accounts do not have permission to access the administrator console.</p>
  </main>
</body>
</html>`;
}

export function createDemoServer() {
  let state = createInitialState();

  function getSessionFromAuth(req) {
    const auth = req.headers.authorization || '';
    if (!auth.toLowerCase().startsWith('bearer ')) return null;
    const token = auth.slice(7).trim();
    return state.sessions.get(token) || null;
  }

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = parsedUrl.pathname;

    // Test-only state reset strictly restricted to loopback clients
    if (method === 'POST' && pathname === '/__test__/reset') {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'Reset endpoint is restricted to localhost' });
        return;
      }
      state = createInitialState();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', coursesCount: state.courses.length });
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      try {
        const body = await readJsonBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        if (!username) {
          sendJson(res, 400, { error: 'Username is required' });
          return;
        }
        const isAdmin = username === 'admin_qa' && password === 'admin-pass-123';
        const isStudent = password === 'qa-pass-123';
        if (!isAdmin && !isStudent) {
          sendJson(res, 401, { error: 'Invalid QA credentials' });
          return;
        }
        const role = isAdmin ? 'admin' : 'student';
        const token = `tok_${crypto.randomBytes(12).toString('hex')}`;
        const user = { username, role };
        state.sessions.set(token, user);
        sendJson(res, 200, { token, user });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/courses') {
      sendJson(res, 200, { courses: state.courses });
      return;
    }

    if (method === 'POST' && pathname === '/api/enroll') {
      const session = getSessionFromAuth(req);
      if (!session) {
        sendJson(res, 401, { error: 'Authentication required' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const courseId = String(body.courseId || '').trim();
        const course = state.courses.find((c) => c.id === courseId);
        if (!course) {
          sendJson(res, 404, { error: 'Course not found' });
          return;
        }
        const enrolledUsers = state.enrollments.get(courseId);
        if (enrolledUsers.has(session.username)) {
          sendJson(res, 409, { error: 'Duplicate enrollment is not allowed', code: 'DUPLICATE_ENROLLMENT' });
          return;
        }
        if (course.seatsLeft <= 0) {
          sendJson(res, 409, { error: 'Course has 0 remaining seats', code: 'SOLD_OUT' });
          return;
        }
        // Atomic synchronous seat decrement on Node single-threaded turn
        course.seatsLeft -= 1;
        enrolledUsers.add(session.username);
        sendJson(res, 201, {
          enrolled: true,
          courseId,
          username: session.username,
          seatsLeft: course.seatsLeft,
        });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (method === 'GET' && pathname === '/api/admin/audit') {
      const session = getSessionFromAuth(req);
      if (!session || session.role !== 'admin') {
        sendJson(res, 403, { error: 'Forbidden: admin role required' });
        return;
      }
      sendJson(res, 200, { logs: [] });
      return;
    }

    if (method === 'GET' && pathname === '/admin') {
      const session = getSessionFromAuth(req);
      if (!session || session.role !== 'admin') {
        sendHtml(res, 403, renderForbiddenHtml());
        return;
      }
      sendHtml(res, 200, '<!DOCTYPE html><html lang="en"><head><title>Admin</title></head><body><main><h1>Admin Console</h1></main></body></html>');
      return;
    }

    if (method === 'GET' && pathname === '/login') {
      sendHtml(res, 200, renderLoginHtml());
      return;
    }

    if (method === 'GET' && pathname === '/') {
      sendHtml(res, 200, renderCatalogHtml(state.courses));
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  return server;
}

export function startDemoServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = createDemoServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        baseURL: `http://${host}:${actualPort}`,
        close: () => new Promise((resClose) => server.close(() => resClose())),
      });
    });
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  let requestedPort = Number(process.env.DEMO_PORT ?? DEFAULT_PORT);
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && process.argv[portIdx + 1] !== undefined) {
    requestedPort = Number(process.argv[portIdx + 1]);
  }

  const started = await startDemoServer({ port: requestedPort, host: '127.0.0.1' });
  console.log(`READY ${started.baseURL}`);

  const shutdown = async () => {
    await started.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
