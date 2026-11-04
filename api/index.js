// Adapter for Vercel Node.js Functions.
// The existing createApp() remains the single source of truth for all routes.
import { createApp } from '../server.js';
import { injectSpeedInsights } from '@vercel/speed-insights';

const app = createApp();

// Initialize Vercel Speed Insights
injectSpeedInsights();

export default function handler(req, res) {
  // Vercel rewrites forward the original route in a reserved query parameter.
  // This preserves /health, /api/auth/*, /api/portal/* and /api/exams/*
  // without changing server.js or the frontend API endpoints.
  const url = new URL(req.url || '/', 'http://localhost');
  const encodedRoute = req.query?.__police_path ?? url.searchParams.get('__police_path');
  const route = Array.isArray(encodedRoute) ? encodedRoute[0] : encodedRoute;

  if (typeof route === 'string' && route.length) {
    const safeRoute = route.replace(/^\/+/, '');
    if (safeRoute !== 'health' && !/^api\/[a-zA-Z0-9_./-]+$/.test(safeRoute)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid route' }));
      return;
    }
    url.searchParams.delete('__police_path');
    req.url = `/${safeRoute}${url.search}`;
  }

  return app(req, res);
}
