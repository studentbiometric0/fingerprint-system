ENV VARS — fingerprint-system

This document lists the environment variables the server reads (or that are recommended) and how to set them for local testing.

Required/important variables

- JWT_SECRET (required in production)
  - Purpose: Secret used to sign JSON Web Tokens issued by `/verify-code`.
  - Example: JWT_SECRET=change_this_to_a_long_random_value
  - Notes: Keep secret; do not commit to git.

- SMTP_HOST, SMTP_USER, SMTP_PASS (required for email delivery)
  - Purpose: Credentials for an SMTP server used to send 6-digit login codes.
  - Example:
    - SMTP_HOST=smtp.gmail.com
    - SMTP_PORT=587
    - SMTP_USER=your-smtp-username
    - SMTP_PASS=your-smtp-password
    - SMTP_FROM=sender@yourdomain.com (optional; defaults to SMTP_USER)
  - Notes: If you don't configure SMTP, `/send-code` will return a 500 error instructing you to set SMTP vars.

- SMTP_PORT (optional)
  - Purpose: Port number (587 typical for STARTTLS, 465 for SSL/TLS).

- SMTP_SECURE (optional)
  - Purpose: 'true' if using SMTPS (port 465); otherwise 'false' for STARTTLS (587).
  - Example: SMTP_SECURE=false

- GAS_WEB_APP_URL and GAS_API_KEY (required for certificate sending)
  - Purpose: `server.js` forwards certificate payloads to a Google Apps Script web app; configure URL and API key used by that script.
  - Example:
    - GAS_WEB_APP_URL=https://script.google.com/macros/s/AKfycb.../exec
    - GAS_API_KEY=abcd1234

- TEMPLATE_DOC_ID and OUTPUT_FOLDER_ID (optional)
  - Purpose: IDs used by the GAS script to select template and output folder; defaults are present in code but you should set them for production.

Recommended/optional variables

- MONGODB_URI
  - Purpose: Recommended to move the database connection string out of `server.js` and into env.
  - Example: MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/ATTENDANCE
  - Note: `server.js` currently has a hard-coded connection string; if you set MONGODB_URI you'll need to update `server.js` to use it.

- PORT
  - Purpose: Port server listens on (default 5000).

- SEND_CODE_SUBJECT
  - Purpose: Custom subject line for the code email; defaults to 'Your login code'.

Security notes

- Never commit `.env` with real secrets. Add `.env` to your `.gitignore`.
- Use strong random values for `JWT_SECRET` (e.g., 32+ bytes base64 or hex).
- Rotate SMTP credentials if leaked.

PowerShell examples

- Create a `.env` file from the template (PowerShell):

```powershell
Copy-Item .env.example .env
# then open .env in an editor and fill values, or set values in environment for current session:
$env:JWT_SECRET = 'your_strong_secret_here'
$env:SMTP_HOST = 'smtp.example.com'
$env:SMTP_USER = 'user@example.com'
$env:SMTP_PASS = 'supersecret'
```

- Export a single variable for the current PowerShell session:

```powershell
$env:JWT_SECRET = 'my-secret-value'
```

- To run the server with environment variables set inline for one command (PowerShell):

```powershell
$env:JWT_SECRET='secret'; $env:SMTP_HOST='smtp.example.com'; $env:SMTP_USER='user'; $env:SMTP_PASS='pass'; node server.js
```

Troubleshooting

- If `/send-code` returns: "SMTP not configured on server" — check `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` are set.
- If emails do not arrive, test with a service like Mailtrap or Ethereal to confirm server-side sending.

If you want, I can:
- Update `server.js` to read `MONGODB_URI` from the environment (recommended), and add `dotenv`-backed fallback.
- Add a small script `scripts/seed-user.js` that creates a hashed user in the `users` collection.
- Add `express-rate-limit` to protect `/send-code` and `/verify-code`.
