ENV VARS — fingerprint-system

This document lists the environment variables the server reads (or that are recommended) and how to set them for local testing.

Required/important variables

- JWT_SECRET (required in production)
  - Purpose: Secret used to sign JSON Web Tokens issued by the `/login` endpoint.
  - Example: JWT_SECRET=change_this_to_a_long_random_value
  - Notes: Keep secret; do not commit to git. Use a strong, random value in production.

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

Security notes

- Never commit `.env` with real secrets. Add `.env` to your `.gitignore`.
- Use strong random values for `JWT_SECRET` (e.g., 32+ bytes base64 or hex).

PowerShell examples

- Export a single variable for the current PowerShell session:

```powershell
$env:JWT_SECRET = 'my-secret-value'
```

- To run the server with environment variables set inline for one command (PowerShell):

```powershell
$env:JWT_SECRET='secret'; node server.js
```

Notes

- Email sending (SMTP/Mailtrap/SendGrid) has been removed from this codebase per the requested simplification. The server now supports only simple email/password authentication with `/login` which validates against the Users collection in MongoDB and returns a JWT.

If you want, I can:
- Update `server.js` to read `MONGODB_URI` from the environment (recommended), and add `dotenv`-backed fallback.
- Add a small script `scripts/seed-user.js` that creates a hashed user in the `users` collection.

