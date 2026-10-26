# Police API — Render starter

Minimal Node.js API for checking that Render can deploy and serve the project.
**This starter does not connect to Supabase or Google Sheets and does not implement authentication.**

## Deploy

1. Create a separate GitHub repository (`police-api`).
2. Upload the files from this archive into the repository root (not an extra folder).
3. In Render, create a new **Web Service** connected to that repository.
4. Set Language: **Node**, branch: **main**, build command: `npm install`, start command: `npm start`, health check path: `/health`.
5. Choose the **Free** instance if available for the workspace.
6. Open `https://<service-name>.onrender.com/health` and confirm `{"ok":true,"service":"police-api"}`.

## Security

Do not commit Supabase secret/service_role keys, database passwords, WS session tokens or Google service account credentials. Add secrets only in Render's environment variables when implementing the real backend. This project intentionally has no privileged routes.
