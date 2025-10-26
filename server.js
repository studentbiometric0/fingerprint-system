// ================== SETUP ==================
require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();

// Middleware (ensure these run before any routes so req.body is parsed)
app.use(cors());
app.use(bodyParser.json());
// also accept urlencoded bodies in case the client sends form-encoded data
app.use(bodyParser.urlencoded({ extended: true }));

// Debug middleware: log PUT /events requests to help diagnose empty body issues
app.use((req, res, next) => {
  try {
    if (req.method === 'PUT' && req.path && req.path.startsWith('/events')) {
      console.log('DEBUG incoming PUT', req.path, 'body:', req.body);
    }
  } catch (e) { /* ignore logging errors */ }
  next();
});

// Bulk upload students via CSV string sent in JSON { csv: "..." }
// Frontend reads the CSV file and posts its text to this endpoint.
app.post('/students/bulk', async (req, res) => {
	try {
		const { csv } = req.body || {};
		if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'CSV content required in request body as { csv: "..." }' });

		// Simple CSV parser that supports quoted fields with commas and newlines
		function parseCSV(text) {
			const rows = [];
			let cur = '';
			let row = [];
			let inQuotes = false;
			for (let i = 0; i < text.length; i++) {
				const ch = text[i];
				if (ch === '"') {
					// peek next char for escaped quote
					if (inQuotes && text[i+1] === '"') { cur += '"'; i++; continue; }
					inQuotes = !inQuotes;
					continue;
				}
				if (ch === ',' && !inQuotes) {
					row.push(cur);
					cur = '';
					continue;
				}
				if ((ch === '\n' || ch === '\r') && !inQuotes) {
					if (cur !== '' || row.length > 0) {
						row.push(cur);
						rows.push(row);
						row = [];
						cur = '';
					}
					// skip consecutive newlines/carriage returns
					while (i+1 < text.length && (text[i+1] === '\n' || text[i+1] === '\r')) i++;
					continue;
				}
				cur += ch;
			}
			if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
			return rows;
		}

		const rows = parseCSV(csv.trim());
		if (!rows || rows.length < 2) return res.status(400).json({ error: 'CSV must include a header row and at least one data row' });
		const header = rows[0].map(h => String(h || '').trim());
		const normalizedHeader = header.map(h => String(h || '').toUpperCase());

		// expected columns (case-insensitive): FID, STUDENT NO, NAME, SEX, YR AND SEC, EMAIL
		function colIndex(names) {
			for (const n of names) {
				const idx = normalizedHeader.indexOf(String(n || '').toUpperCase());
				if (idx !== -1) return idx;
			}
			return -1;
		}

		const idxFID = colIndex(['FID','FINGERPRINT ID','ID']);
		const idxStudentNo = colIndex(['STUDENT NO','STUDENT_NO','STUDENTNO','STUDENTNUMBER']);
		const idxName = colIndex(['NAME','FULL NAME','STUDENT NAME']);
		const idxSex = colIndex(['SEX','GENDER']);
		const idxYrSec = colIndex(['YR AND SEC','YR_AND_SEC','YEAR AND SECTION','YEAR/SECTION']);
		const idxEmail = colIndex(['EMAIL','E-MAIL','EMAIL ADDRESS']);

		// require at least FID and NAME and STUDENT NO and EMAIL and YR AND SEC and SEX
		const missing = [];
		if (idxFID === -1) missing.push('FID');
		if (idxStudentNo === -1) missing.push('STUDENT NO');
		if (idxName === -1) missing.push('NAME');
		if (idxSex === -1) missing.push('SEX');
		if (idxYrSec === -1) missing.push('YR AND SEC');
		if (idxEmail === -1) missing.push('EMAIL');
		if (missing.length) return res.status(400).json({ error: 'Missing required columns: ' + missing.join(', ') });

		const summary = { total: 0, inserted: 0, skipped: 0, errors: [] };
		const toInsert = [];
		for (let r = 1; r < rows.length; r++) {
			const row = rows[r];
			if (!row || row.length === 0) continue;
			summary.total++;
			const rawFID = (row[idxFID] || '').toString().trim();
			const rawStudentNo = (row[idxStudentNo] || '').toString().trim();
			const rawName = (row[idxName] || '').toString().trim();
			const rawSex = (row[idxSex] || '').toString().trim();
			const rawYrSec = (row[idxYrSec] || '').toString().trim();
			const rawEmail = (row[idxEmail] || '').toString().trim();

			if (!rawFID || !rawStudentNo || !rawName) {
				summary.skipped++; summary.errors.push({ row: r+1, error: 'Missing required field (FID, STUDENT NO, or NAME)' });
				continue;
			}
			const fidNum = Number(rawFID);
			if (isNaN(fidNum)) {
				summary.skipped++; summary.errors.push({ row: r+1, error: 'FID must be numeric' });
				continue;
			}

			// Check duplicates by FID or STUDENT NO
			// We'll skip duplicates and report them
			// Use direct DB queries per-row to avoid complex upsert logic for now
			/* eslint-disable no-await-in-loop */
			const existing = await Students.findOne({ $or: [{ FID: fidNum }, { 'STUDENT NO': rawStudentNo }] });
			if (existing) {
				summary.skipped++; summary.errors.push({ row: r+1, error: 'Duplicate by FID or STUDENT NO' });
				continue;
			}
			toInsert.push({ FID: fidNum, 'STUDENT NO': rawStudentNo, NAME: rawName, SEX: rawSex, 'YR AND SEC': rawYrSec, EMAIL: rawEmail });
		}

		if (toInsert.length) {
			try {
				const inserted = await Students.insertMany(toInsert, { ordered: false });
				summary.inserted = Array.isArray(inserted) ? inserted.length : 0;
			} catch (e) {
				// insertion error - capture and continue
				console.error('/students/bulk insertMany error', e);
				// best effort: count inserted via success property if available
				if (e && e.insertedCount) summary.inserted = e.insertedCount;
				summary.errors.push({ error: 'Failed to insert some records', details: e.message || String(e) });
			}
		}

		return res.json({ summary });
	} catch (err) {
		console.error('/students/bulk error', err);
		return res.status(500).json({ error: err.message });
	}
});
// ================== ROUTES ==================
// Update event details
app.put("/events/:id", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body || Object.keys(body).length === 0) {
      console.error('PUT /events/:id empty body');
      return res.status(400).json({ error: 'Request body is required and must be JSON.' });
    }
    const { name, date, timeStart, timeEnd, participants } = body;
    // Log incoming data for debugging
    console.log('PUT /events/:id', req.params.id, body);
    // Build updateFields from whatever was provided (partial updates allowed)
    const updateFields = {};
    if (typeof name !== 'undefined') updateFields.name = name;
    if (typeof date !== 'undefined') updateFields.date = date;
    if (typeof timeStart !== 'undefined') updateFields.timeStart = timeStart;
    if (typeof timeEnd !== 'undefined') updateFields.timeEnd = timeEnd;
    if (typeof participants !== 'undefined') {
      // Normalize participants: accept legacy array or new object
      let normalized = { sections: [], students: [] };
      if (Array.isArray(participants)) {
        normalized.sections = participants;
      } else if (participants && typeof participants === 'object') {
        normalized.sections = Array.isArray(participants.sections) ? participants.sections : [];
        normalized.students = Array.isArray(participants.students) ? participants.students : [];
      }
      updateFields.participants = normalized;
    }
    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }
    const updated = await Event.findByIdAndUpdate(
      req.params.id,
      updateFields,
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Event not found." });
    res.json({
      _id: updated._id,
      name: updated.name,
      date: updated.date,
      timeStart: updated.timeStart,
      timeEnd: updated.timeEnd,
      participants: updated.participants,
      createdAt: updated.createdAt
    });
  } catch (err) {
    console.error('PUT /events/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete event
app.delete("/events/:id", async (req, res) => {
  try {
    const deleted = await Event.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Event not found." });
    res.json({ message: "Event deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve static files from Public directory
app.use(express.static(path.join(__dirname, "public")));

// Serve index.html at root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ================= DATABASE CONNECTION =================
mongoose
  .connect(
    "mongodb+srv://studentbiometric:studentbio123@attendance.yxnsnof.mongodb.net/ATTENDANCE",
    { useNewUrlParser: true, useUnifiedTopology: true }
  )
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ================= SCHEMAS =================
// Users collection (for login)
// Note: we add optional fields for MFA code hash and expiry so pre-seeded users
// can receive a 6-digit code and verify it. There is no registration endpoint.
const UserSchema = new mongoose.Schema({
	email: { type: String, required: true, unique: true },
	password: { type: String, required: true }, // In production, hash passwords!
	// temporary fields for code-based login
	mfaHash: { type: String },
	mfaExpires: { type: Date }
});
const User = mongoose.model("User", UserSchema, "users");

// Students collection
const StudentsSchema = new mongoose.Schema({
  "FID": Number,
  "STUDENT NO": String,
  "NAME": String,
  "SEX": String,
  "YR AND SEC": String,
  "EMAIL": String,
});

StudentsSchema.pre('save', function(next) {
  if (this["STUDENT NO"] && typeof this["STUDENT NO"] === "object") {
    const val = Object.values(this["STUDENT NO"])[0];
    this["STUDENT NO"] = val;
  }
  next();
});
const Students = mongoose.model("Students", StudentsSchema, "students");

// Events collection
const EventSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    date: { type: String, required: true },
    timeStart: { type: String },
    timeEnd: { type: String },
  participants: { type: mongoose.Schema.Types.Mixed, default: [] },
  active: { type: Boolean, default: false },
  },
  { timestamps: true }
);
const Event = mongoose.model("Event", EventSchema, "events");

// Attendance schema
// event_id will store the event._id (string) for a stable reference.
// Keep event_name for backward compatibility with older records that used event.name.
const AttendanceSchema = new mongoose.Schema({
  event_id: { type: String, required: true }, // stores event._id as string
  event_name: { type: String }, // legacy/human-readable name
  fingerprintID: Number,
  name: String,
  timeIn: { type: Date },
  timeOut: { type: Date },
	// Certificate send status: null/undefined when not attempted, 'Sent' when successfully sent, 'Error' for failures
	certStatus: { type: String, default: null },
});
const Attendance = mongoose.model("Attendance", AttendanceSchema, "attendance");

// Helper: POST JSON to an external URL (http or https)
const { URL } = require('url');
const http = require('http');
const https = require('https');
function postJsonToUrl(targetUrl, data, timeout = 20000, maxRedirects = 5) {
  // This helper sends application/x-www-form-urlencoded with a single field 'payload' containing JSON.
  // Apps Script's doPost will read it from e.parameter.payload. We follow redirects up to maxRedirects.
  return new Promise((resolve, reject) => {
    try {
      const payloadJson = JSON.stringify(data || {});
      const form = `payload=${encodeURIComponent(payloadJson)}` + (data && data.apiKey ? `&apiKey=${encodeURIComponent(data.apiKey)}` : '');

      const doRequest = (urlStr, redirectsLeft) => {
        const urlObj = new URL(urlStr);
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
          path: urlObj.pathname + (urlObj.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(form),
            'User-Agent': 'Node.js/1.0'
          },
          timeout
        };
        const client = urlObj.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => body += chunk);
          res.on('end', async () => {
            // handle redirects
							if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
							if (redirectsLeft > 0) {
								const nextUrl = new URL(res.headers.location, urlStr).toString();
								return doRequest(nextUrl, redirectsLeft - 1);
							}
							return resolve({ statusCode: res.statusCode, headers: res.headers, body });
						}
            const contentType = (res.headers['content-type'] || '').toLowerCase();
            let parsed = body;
            if (contentType.includes('application/json')) {
              try { parsed = JSON.parse(body); } catch (e) { /* keep string */ }
            }
            return resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
          });
        });
        req.on('error', (err) => reject(err));
        req.write(form);
        req.end();
      };
      doRequest(targetUrl, maxRedirects);
    } catch (err) { reject(err); }
  });
}


// ================= ROUTES =================
// Login endpoint
// Register endpoint (for creating users)
app.post("/register", async (req, res) => {
	// Registration is disabled: only pre-seeded users in the database are allowed to log in.
	console.warn('/register attempted but registration is disabled');
	return res.status(403).json({ error: 'Registration disabled. Only pre-seeded users may log in.' });
});

// Send a one-time 6-digit code to a pre-seeded user (no registration allowed)
app.post('/send-code', async (req, res) => {
	try {
		const { email } = req.body || {};
		if (!email) return res.status(400).json({ error: 'Email is required' });
		const raw = String(email).trim();
		const normalized = raw.toLowerCase();

		// find user (exact then case-insensitive fallback)
		let user = await User.findOne({ email: normalized });
		if (!user) user = await User.findOne({ email: new RegExp(`^${raw.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}$`, 'i') });
		if (!user) return res.status(401).json({ error: 'Email not recognized' });

			// require SMTP config (validate and attempt a small inference for Gmail users)
			let smtpHost = process.env.SMTP_HOST;
			const smtpUser = process.env.SMTP_USER;
			const smtpPass = process.env.SMTP_PASS;
			const smtpPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
			const smtpSecure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

			// Basic validation: SMTP_USER and SMTP_PASS are required. If SMTP_HOST looks like an email address
			// (common misconfiguration), surface a clear error rather than attempting DNS on it.
			if (!smtpUser || !smtpPass) {
				console.error('/send-code: SMTP_USER or SMTP_PASS not configured in env');
				return res.status(500).json({ error: 'SMTP credentials missing on server (check SMTP_USER and SMTP_PASS in .env)' });
			}

			if (!smtpHost) {
				// try to infer a sensible default for common providers (gmail)
				const maybeUser = String(smtpUser || '').toLowerCase();
				if (maybeUser.endsWith('@gmail.com')) {
					smtpHost = 'smtp.gmail.com';
				}
			}

			if (!smtpHost) {
				console.error('/send-code: SMTP_HOST not configured in env');
				return res.status(500).json({ error: 'SMTP_HOST not configured on server (set SMTP_HOST in .env, e.g. smtp.gmail.com)' });
			}

			if (String(smtpHost).includes('@')) {
				console.error('/send-code: SMTP_HOST appears to be an email address ->', smtpHost);
				return res.status(500).json({ error: 'SMTP_HOST appears to be an email address. Set SMTP_HOST to your SMTP server host (e.g. smtp.gmail.com) not an email.' });
			}

		// generate 6-digit code
		const code = String(Math.floor(100000 + Math.random() * 900000));
		const hashed = await bcrypt.hash(code, 10);
		user.mfaHash = hashed;
		user.mfaExpires = new Date(Date.now() + (10 * 60 * 1000)); // 10 minutes
		await user.save();

		// send email
		const transporter = nodemailer.createTransport({ host: smtpHost, port: smtpPort || 587, secure: smtpSecure, auth: { user: smtpUser, pass: smtpPass } });
		const mailOpts = {
			from: process.env.SMTP_FROM || smtpUser,
			to: user.email,
			subject: process.env.SEND_CODE_SUBJECT || 'Your login code',
			text: `Your login code is ${code}. It expires in 10 minutes.`,
			html: `<p>Your login code is <strong>${code}</strong>. It expires in 10 minutes.</p>`
		};
			// Development bypass: when NODE_ENV=development and DEV_EMAIL_LOG=true, do not attempt SMTP send.
			const devLogEnabled = (process.env.NODE_ENV === 'development' && (process.env.DEV_EMAIL_LOG || '').toLowerCase() === 'true');
			if (devLogEnabled) {
				console.log(`/send-code (DEV_LOG) -> code for ${user.email}: [logged to server console]`);
				// Note: code itself is not included in the response for safety, but it is printed to server logs in dev mode.
				return res.json({ sent: true, dev: true, message: 'Code logged to server console (development mode)' });
			}

			try {
				await transporter.sendMail(mailOpts);
			} catch (e) {
				// Improve error message for common SMTP auth failures
				console.error('/send-code: failed to send email', e);
				if (e && (e.code === 'EAUTH' || e.responseCode === 535 || (e.response && /auth/i.test(String(e.response))))) {
					return res.status(500).json({ error: 'SMTP authentication failed. Check SMTP_USER and SMTP_PASS. If using Gmail, create an App Password or allow SMTP access: https://support.google.com/mail/?p=BadCredentials' });
				}
				return res.status(500).json({ error: 'Failed to send email. Check SMTP settings and network connectivity.' });
			}

			return res.json({ sent: true });
	} catch (err) {
		console.error('/send-code error', err);
		return res.status(500).json({ error: err.message });
	}
});

// Verify the 6-digit code and return a JWT
app.post('/verify-code', async (req, res) => {
	try {
		const { email, code } = req.body || {};
		if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });
		const raw = String(email).trim();
		const normalized = raw.toLowerCase();

		let user = await User.findOne({ email: normalized });
		if (!user) user = await User.findOne({ email: new RegExp(`^${raw.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')}$`, 'i') });
		if (!user || !user.mfaHash || !user.mfaExpires) return res.status(401).json({ error: 'Invalid or expired code' });
		if (new Date() > new Date(user.mfaExpires)) return res.status(401).json({ error: 'Code expired' });

		const ok = await bcrypt.compare(String(code), user.mfaHash);
		if (!ok) return res.status(401).json({ error: 'Invalid code' });

		// clear mfa fields and issue token
		user.mfaHash = undefined;
		user.mfaExpires = undefined;
		await user.save();

		try {
			const secret = process.env.JWT_SECRET || 'dev-secret';
			const token = jwt.sign({ sub: user._id, email: user.email }, secret, { expiresIn: '8h' });
			return res.json({ token });
		} catch (e) {
			console.warn('/verify-code: failed to sign JWT, returning demo token', e);
			return res.json({ token: 'demo-token' });
		}
	} catch (err) {
		console.error('/verify-code error', err);
		return res.status(500).json({ error: err.message });
	}
});

// Disable the old /login route to avoid confusion; clients should use /send-code and /verify-code
app.post('/login', (req, res) => {
	return res.status(400).json({ error: 'Legacy login disabled. Use /send-code then /verify-code for code-based login.' });
});
// Update student details
app.put("/students/:fid", async (req, res) => {
  try {
    const fid = parseInt(req.params.fid, 10);
    const { FID, "STUDENT NO": STUDENT_NO, NAME, SEX, "YR AND SEC": YR_AND_SEC, EMAIL } = req.body;
    if (!FID || !STUDENT_NO || !NAME || !SEX || !YR_AND_SEC || !EMAIL) {
      return res.status(400).json({ error: "All fields are required." });
    }
    // Check for duplicates (excluding current student)
    const duplicate = await Students.findOne({
      $or: [
        { FID },
        { "STUDENT NO": STUDENT_NO },
        { NAME }
      ],
      FID: { $ne: fid }
    });
    if (duplicate) {
      let msg = "Duplicate record: ";
      if (duplicate.FID === FID) msg += "Fingerprint ID already exists. ";
      if (duplicate["STUDENT NO"] === STUDENT_NO) msg += "Student Number already exists. ";
      if (duplicate.NAME === NAME) msg += "Name already exists.";
      return res.status(409).json({ error: msg.trim() });
    }
    // Update student
    const updated = await Students.findOneAndUpdate(
      { FID: fid },
      { FID, "STUDENT NO": STUDENT_NO, NAME, SEX, "YR AND SEC": YR_AND_SEC, EMAIL },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Student not found." });
    res.json({ message: "Student updated successfully.", student: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete student
app.delete("/students/:fid", async (req, res) => {
  try {
    const fid = parseInt(req.params.fid, 10);
    const deleted = await Students.findOneAndDelete({ FID: fid });
    if (!deleted) return res.status(404).json({ error: "Student not found." });
    res.json({ message: "Student deleted successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Enroll new student
app.post("/students", async (req, res) => {
  try {
    const { FID, "STUDENT NO": STUDENT_NO, NAME, SEX, "YR AND SEC": YR_AND_SEC, EMAIL } = req.body;
    if (!FID || !STUDENT_NO || !NAME || !SEX || !YR_AND_SEC || !EMAIL) {
      return res.status(400).json({ error: "All fields are required." });
    }
    // Check for duplicates
    const duplicate = await Students.findOne({
      $or: [
        { FID },
        { "STUDENT NO": STUDENT_NO },
        { NAME }
      ]
    });
    if (duplicate) {
      let msg = "Duplicate record: ";
      if (duplicate.FID === FID) msg += "Fingerprint ID already exists. ";
      if (duplicate["STUDENT NO"] === STUDENT_NO) msg += "Student Number already exists. ";
      if (duplicate.NAME === NAME) msg += "Name already exists.";
      return res.status(409).json({ error: msg.trim() });
    }
    // Save new student
    const student = new Students({ FID, "STUDENT NO": STUDENT_NO, NAME, SEX, "YR AND SEC": YR_AND_SEC, EMAIL });
    await student.save();
    res.status(201).json({ message: "Student enrolled successfully.", student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create event
app.post("/events", async (req, res) => {
  try {
    let { name, date, timeStart, timeEnd, participants } = req.body;
    // Normalize participants: accept either legacy array or new object { sections: [], students: [] }
    let normalized = { sections: [], students: [] };
    if (Array.isArray(participants)) {
      // legacy array: treat as sections if strings like 'ALL' or contains non-student patterns
      normalized.sections = participants;
    } else if (participants && typeof participants === 'object') {
      normalized.sections = Array.isArray(participants.sections) ? participants.sections : [];
      normalized.students = Array.isArray(participants.students) ? participants.students : [];
    }
    if (!name || !date || !timeStart || !timeEnd || (normalized.sections.length === 0 && normalized.students.length === 0)) {
      return res.status(400).json({ error: "Event name, date, time range, and participants are required" });
    }
    date = String(date); // Ensure date is stored as string
    const event = await Event.create({ name, date, timeStart, timeEnd, participants: normalized });
    res.status(201).json({
      _id: event._id,
      name: event.name,
      date: event.date,
      timeStart: event.timeStart,
      timeEnd: event.timeEnd,
      participants: event.participants,
      createdAt: event.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all events
app.get("/events", async (req, res) => {
  try {
    const events = await Event.find().sort({ createdAt: -1 });
    // Ensure all fields are returned for frontend compatibility
    const result = events.map(ev => ({
      _id: ev._id,
      name: ev.name,
      date: ev.date,
      timeStart: ev.timeStart,
      timeEnd: ev.timeEnd,
      participants: ev.participants,
      active: !!ev.active,
      createdAt: ev.createdAt
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get latest event
app.get("/latest-event", async (req, res) => {
  try {
    const latestEvent = await Event.findOne().sort({ createdAt: -1 });
    if (!latestEvent) return res.status(404).json({ error: "No events found" });
    res.json(latestEvent);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activate an event (mark as the active event -> only one active event at a time)
app.post('/events/:id/activate', async (req, res) => {
  try {
    const ev = await Event.findById(req.params.id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    // Clear any previously active event(s)
    await Event.updateMany({ active: true }, { $set: { active: false } });
    ev.active = true;
    await ev.save();
    res.json({ message: 'Event activated', event: ev });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get currently active event (if any)
app.get('/events/active', async (req, res) => {
  try {
    const active = await Event.findOne({ active: true });
    if (!active) return res.status(404).json({ error: 'No active event' });
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ESP32 log endpoint
app.post("/esp-log", async (req, res) => {
  try {
    // Accept fingerprintID, optional eventId, optional type ("Time-In" / "Time-Out"), and optional timestamp.
    const { fingerprintID, eventId, type, timestamp } = req.body || {};
    // fingerprintID is required
    if (typeof fingerprintID === 'undefined' || fingerprintID === null) {
      return res.status(400).json({ error: "fingerprintID is required" });
    }
    // Lookup student by FID
    const student = await Students.findOne({ FID: fingerprintID });
    if (!student) return res.status(404).json({ error: "Student not found" });

    // Determine which event to use: prefer provided eventId; otherwise prefer the dashboard-selected active event.
    // If no active event exists, fall back to the latest-created event.
    let event = null;
    if (eventId) {
      event = await Event.findById(eventId);
      if (!event) return res.status(404).json({ error: "Event not found for provided eventId" });
      console.log('ESP log: using provided eventId', eventId, '->', event.name);
    } else {
      // Try to find the active event set by the dashboard
      event = await Event.findOne({ active: true });
      if (event) {
        console.log('ESP log: no eventId provided, using active event ->', event.name, '(id:', event._id, ')');
      } else {
        // Fall back to the latest-created event if no active event is set
        event = await Event.findOne().sort({ createdAt: -1 });
        if (event) {
          console.log('ESP log: no active event set, falling back to latest-created event ->', event.name, '(id:', event._id, ')');
        } else {
          return res.status(404).json({ error: "No events found. Cannot log attendance." });
        }
      }
    }

  // Use event._id as the canonical event_id in attendance documents
  const eventIdStr = String(event._id);
  const eventName = event.name; // keep human-readable name for compatibility

    // Prepare a small event summary to return to clients (so devices know which event was used)
    const eventSummary = {
      _id: event._id,
      name: event.name,
      date: event.date,
      timeStart: event.timeStart,
      timeEnd: event.timeEnd
    };

    // Log which event was used for easier debugging
    console.log('ESP log for FID=' + fingerprintID + ' -> event: ' + eventName + ' (id: ' + event._id + ')', 'type:', type);

    // --- PARTICIPANT VALIDATION ---
    // Normalize stored participants into { sections: [], students: [] }
    const rawParts = event.participants || [];
    const parts = { sections: [], students: [] };
    if (Array.isArray(rawParts)) {
      parts.students = rawParts;
    } else if (rawParts && typeof rawParts === 'object') {
      parts.sections = Array.isArray(rawParts.sections) ? rawParts.sections : [];
      parts.students = Array.isArray(rawParts.students) ? rawParts.students : [];
    }

    // Helper: determine whether the student is included in participants
    const isParticipant = (() => {
      const studStudentNo = student["STUDENT NO"] ? String(student["STUDENT NO"]).toLowerCase() : '';
      const studYRSEC = student["YR AND SEC"] ? String(student["YR AND SEC"]).toLowerCase() : '';
      const studFID = (typeof student.FID !== 'undefined' && student.FID !== null) ? String(student.FID) : '';
      const studName = student["NAME"] ? String(student["NAME"]).toLowerCase() : '';

      // Check explicit students array
      for (const s of parts.students) {
        if (s == null) continue;
        if (typeof s === 'number' || (!isNaN(Number(s)) && String(s).trim() !== '')) {
          // numeric might be FID or student no
          const sval = String(s).trim();
          if (sval === studFID || sval === studStudentNo) return true;
        } else if (typeof s === 'string') {
          const low = s.toLowerCase().trim();
          if (!low) continue;
          if (low === studName || low === studStudentNo || low === studFID) return true;
        } else if (typeof s === 'object') {
          if (s.FID && String(s.FID) === studFID) return true;
          if (s['STUDENT NO'] && String(s['STUDENT NO']).toLowerCase() === studStudentNo) return true;
        }
      }

      // Check sections (allow 'ALL')
      for (const sec of parts.sections) {
        if (!sec) continue;
        const low = String(sec).toLowerCase().trim();
        if (low === 'all' || low === studYRSEC) return true;
      }

      return false;
    })();

    if (!isParticipant) {
      // Student is not listed for this event — reject the log attempt
      return res.status(403).json({ error: 'Student is not listed as a participant for this event.' });
    }

    // Normalize type if provided
    const normType = (type && typeof type === 'string') ? type.trim().toLowerCase() : null; // 'time-in' or 'time-out'

    // Check for existing attendance record for this event and fingerprintID
    // Prefer records linked by event._id; fall back to legacy records stored by name.
    let record = await Attendance.findOne({ event_id: eventIdStr, fingerprintID });
    if (!record) {
      record = await Attendance.findOne({ event_name: eventName, fingerprintID });
    }

    // If type explicitly requests Time-In
    if (normType === 'time-in' || normType === 'timein' || normType === 'time in') {
      if (!record) {
        // Create a new Time-In record
        record = new Attendance({
          event_id: eventIdStr,
          event_name: eventName,
          fingerprintID,
          name: student["NAME"],
          timeIn: new Date(),
        });
        await record.save();
        return res.status(201).json({ message: "Time-In logged", record, event: eventSummary });
      }
      // If a record already exists, do NOT set timeOut when a Time-In is posted. Inform the caller.
      return res.status(200).json({ message: "Time Log already exists", record, event: eventSummary });
    }

    // If type explicitly requests Time-Out
    if (normType === 'time-out' || normType === 'timeout' || normType === 'time out') {
      if (!record) {
        // Do not create new record on Time-Out attempts; require a prior Time-In
        return res.status(404).json({ error: "No Time-In record found for this fingerprint. Cannot log Time-Out.", event: eventSummary });
      }
      if (!record.timeOut) {
        // ensure event_id/event_name are present in older records
        record.event_id = record.event_id || eventIdStr;
        record.event_name = record.event_name || eventName;
        record.timeOut = new Date();
        await record.save();
        return res.status(201).json({ message: "Time-Out logged", record, event: eventSummary });
      }
      return res.status(200).json({ message: "Time-Out already logged", record, event: eventSummary });
    }

    // Backwards-compatible behavior when type is not provided:
    // - If no record -> create timeIn
    // - If record exists and no timeOut -> set timeOut
    // - If both present -> inform already logged
    if (!record) {
      // First log: create record with timeIn
      record = new Attendance({
        event_id: eventIdStr,
        event_name: eventName,
        fingerprintID,
        name: student["NAME"],
        timeIn: new Date(),
      });
      await record.save();
      return res.status(201).json({ message: "Time-In logged", record, event: eventSummary });
    }

    if (!record.timeOut) {
      // Second log: update record with timeOut
  // ensure event_id/event_name are present in older records
  record.event_id = record.event_id || eventIdStr;
  record.event_name = record.event_name || eventName;
  record.timeOut = new Date();
  await record.save();
      return res.status(201).json({ message: "Time-Out logged", record, event: eventSummary });
    }

    // Already has timeIn and timeOut
    return res.status(200).json({ message: "Already logged Time-In and Time-Out", record, event: eventSummary });
  } catch (err) {
    console.error('/esp-log error', err);
    return res.status(500).json({ error: err.message });
  }
});

// Get logs for a specific event
app.get("/logs", async (req, res) => {
  try {
    const { eventId } = req.query;
    let logs;
    if (!eventId) {
      // Return all logs for all events
      logs = await Attendance.find({}).sort({ timeIn: -1 });
      return res.json(logs);
    }
  // Try to resolve the event by id. If not found, we will still attempt to query attendance by
  // the provided identifier (it may be a legacy event name or a different typed id stored in attendance docs).
  let event = null;
  try {
    event = await Event.findById(eventId);
  } catch (e) {
    // ignore parse errors; event will remain null
    console && console.error && console.error('logs: Event.findById error for', eventId, e.message || e);
  }

  // Build a tolerant query: try matching event_id stored as string, match event_name, and
  // also allow matching the provided eventId directly against event_name in case callers passed a name.
  const queries = [];
  if (event && event._id) {
    queries.push({ event_id: String(event._id) });
    queries.push({ event_name: event.name });
  }
  // Always attempt to match by the raw provided eventId as event_id (string)
  queries.push({ event_id: String(eventId) });
  // Also consider that older records may have event_name equal to the provided eventId
  queries.push({ event_name: String(eventId) });

  // Remove potential duplicates in the $or array
  const uniqueOr = [];
  const seen = new Set();
  for (const q of queries) {
    const key = JSON.stringify(q);
    if (!seen.has(key)) { seen.add(key); uniqueOr.push(q); }
  }

  logs = await Attendance.find({ $or: uniqueOr }).sort({ timeIn: -1 });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all students
app.get("/students", async (req, res) => {
  try {
    const students = await Students.find();
    const fixed = students.map(s => {
      const obj = s.toObject();
      if (obj["STUDENT NO"] && typeof obj["STUDENT NO"] === "object") {
        const val = Object.values(obj["STUDENT NO"])[0];
        obj["STUDENT NO"] = val;
      }
      return obj;
    });
    res.json(fixed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send certificates (forwards to Google Apps Script Web App)
app.post('/send-certs', async (req, res) => {
  try {
    // Log incoming body for debugging
    console.log('/send-certs incoming body type:', typeof req.body, 'body:', req.body);
    const rawBody = req.body || {};
    let { eventId, eventName, participants } = rawBody;

    // Try to recover participants from common form-encoded shapes if it's missing
    // 1) participants may be sent as a JSON string
    if (typeof participants === 'string') {
      try { participants = JSON.parse(participants); } catch (e) { /* leave as string */ }
    }

    // 2) participants may be provided via fields named 'participants[]' (bodyParser already converts repeated fields to arrays)
    if ((!participants || participants === '') && rawBody['participants[]']) {
      participants = rawBody['participants[]'];
      // try to parse each element if they are JSON strings
      if (Array.isArray(participants)) {
        participants = participants.map(p => { if (typeof p === 'string') { try { return JSON.parse(p); } catch(e){ return p; } } return p; });
      } else if (typeof participants === 'string') {
        try { participants = JSON.parse(participants); } catch(e) { participants = [participants]; }
      }
    }

    // 3) reconstruct from keys like participants[0][NAME]=..., participants[0]=... or participants[0]["NAME"]
    if ((!participants || participants === '') && Object.keys(rawBody).some(k => k.startsWith('participants['))) {
      const constructed = [];
      for (const key of Object.keys(rawBody)) {
        const m = key.match(/^participants\[(\d+)\](?:\[(.+)\])?$/);
        if (!m) continue;
        const idx = Number(m[1]);
        const prop = m[2];
        constructed[idx] = constructed[idx] || {};
        if (typeof rawBody[key] === 'string') {
          // try parse inner JSON
          try {
            constructed[idx][prop || '_value'] = JSON.parse(rawBody[key]);
          } catch (e) {
            constructed[idx][prop || '_value'] = rawBody[key];
          }
        } else {
          constructed[idx][prop || '_value'] = rawBody[key];
        }
      }
      // normalize objects that used '_value' for scalar entries
      participants = constructed.map(x => {
        if (!x) return x;
        const keys = Object.keys(x);
        if (keys.length === 1 && keys[0] === '_value') return x._value;
        return x;
      }).filter(Boolean);
    }

    // 4) If participants is still an object with numeric keys (e.g., { '0': {...}, '1': {...} }), turn into array
    if (participants && !Array.isArray(participants) && typeof participants === 'object') {
      const keys = Object.keys(participants);
      if (keys.length && keys.every(k => /^\d+$/.test(k))) {
        participants = keys.sort((a,b)=>Number(a)-Number(b)).map(k => participants[k]);
      }
    }

    // 5) If participants is a single object, wrap it into an array
    if (participants && !Array.isArray(participants) && typeof participants === 'object') {
      participants = [participants];
    }

    // Final validation. If something's missing, attempt to recover from DB before failing.
    // Accept single participant objects/strings by wrapping into an array.
    if (participants && !Array.isArray(participants) && typeof participants === 'object') participants = [participants];
    if (participants && !Array.isArray(participants) && (typeof participants === 'string' || typeof participants === 'number')) participants = [{ NAME: String(participants) }];

    // Require at least one of eventId or eventName; we'll attempt to resolve the missing one.
    if ((!eventId && !eventName) || !Array.isArray(participants)) {
      // continue into recovery below
    }

    // If participants is an empty array, treat as missing and attempt recovery below
    if (Array.isArray(participants) && participants.length === 0) {
      // continue into recovery below
    }

    // At this point, if either eventId/eventName or participants are missing/invalid, attempt recovery
    if (!eventId || !eventName || !Array.isArray(participants) || participants.length === 0) {
      console.warn('/send-certs missing fields, attempting recovery from DB', { eventId, eventName, participantsType: Array.isArray(participants) ? 'array' : typeof participants });

      // If eventId is missing but eventName is provided, try to find the event by name.
      let resolvedEvent = null;
      try {
        if (eventId) {
          resolvedEvent = await Event.findById(eventId);
        }
        if (!resolvedEvent && eventName) {
          resolvedEvent = await Event.findOne({ name: eventName });
          if (resolvedEvent) eventId = String(resolvedEvent._id);
        }
      } catch (e) { /* ignore lookup errors */ }

      // If we still don't have eventId but resolvedEvent exists, set it
      if (!eventId && resolvedEvent && resolvedEvent._id) eventId = String(resolvedEvent._id);

      // If participants is not an array, attempt to derive participants from the Event document
      if (!Array.isArray(participants) && resolvedEvent) {
        const rawParts = resolvedEvent.participants || [];
        const derived = [];
        // If participants is structured ({ sections: [], students: [] })
        if (rawParts && typeof rawParts === 'object' && (Array.isArray(rawParts.sections) || Array.isArray(rawParts.students))) {
          // If students array present, use that
          if (Array.isArray(rawParts.students) && rawParts.students.length) {
            for (const s of rawParts.students) {
              if (typeof s === 'object') derived.push(s);
              else if (s) derived.push({ NAME: String(s) });
            }
          }
          // If sections are listed, try to expand to students by year & sec
          if (Array.isArray(rawParts.sections) && rawParts.sections.length) {
            try {
              const sections = rawParts.sections.map(x => String(x).trim()).filter(Boolean);
              // If 'ALL' present -> include all students
              if (sections.some(s => String(s).toLowerCase() === 'all')) {
                const all = await Students.find();
                all.forEach(s => derived.push({ FID: s.FID, 'STUDENT NO': s['STUDENT NO'], NAME: s['NAME'], EMAIL: s['EMAIL'] }));
                
              } else {
                const matched = await Students.find({ 'YR AND SEC': { $in: sections } });
                matched.forEach(s => derived.push({ FID: s.FID, 'STUDENT NO': s['STUDENT NO'], NAME: s['NAME'], EMAIL: s['EMAIL'] }));
              }
            } catch (e) { /* ignore DB expansion errors */ }
          }
        } else if (Array.isArray(rawParts)) {
          // legacy array stored in events: treat entries as student identifiers or strings
          for (const s of rawParts) {
            if (s && typeof s === 'object') derived.push(s);
            else if (s) derived.push({ NAME: String(s) });
          }
        }

        if (derived.length) participants = derived;
      }

      // If participants still not found, attempt to derive from attendance logs for the event
      if (!Array.isArray(participants) || participants.length === 0) {
        try {
          // attempt to fetch attendance records referencing this event
          const q = [];
          if (eventId) q.push({ event_id: String(eventId) });
          if (eventName) q.push({ event_name: String(eventName) });
          if (q.length) {
            const logs = await Attendance.find({ $or: q }).limit(1000);
            const byFID = new Map();
            for (const l of logs) {
              if (typeof l.fingerprintID !== 'undefined' && l.fingerprintID !== null) {
                const key = String(l.fingerprintID);
                if (!byFID.has(key)) byFID.set(key, { FID: l.fingerprintID, NAME: l.name });
Two
              } else if (l.name) {
                const key = l.name.toLowerCase();
                if (!byFID.has(key)) byFID.set(key, { NAME: l.name });
              }
            }
            if (byFID.size) {
section
              participants = Array.from(byFID.values());
            }
          }
        } catch (e) { /* ignore attendance lookup errors */ }
      }

      // If we still don't have the required fields, return 400 (with helpful sample)
      if (!eventId && !eventName) {
        console.error('/send-certs bad request after recovery attempts - missing event identifier', { eventId, eventName, rawKeys: Object.keys(rawBody).slice(0,50) });
        return res.status(400).json({ error: 'Either eventId or eventName is required (could not recover from DB)', received: { eventId, eventName, rawBodySample: Object.keys(rawBody).slice(0,50) } });
      }
      if (!Array.isArray(participants) || participants.length === 0) {
        console.error('/send-certs bad request after recovery attempts - no participants', { eventId, eventName, participantsType: Array.isArray(participants) ? 'array' : typeof participants, rawKeys: Object.keys(rawBody).slice(0,50) });
        return res.status(400).json({ error: 'participants[] are required (could not derive from event or logs)', received: { eventId, eventName, participantsType: Array.isArray(participants) ? 'array' : typeof participants, rawBodySample: Object.keys(rawBody).slice(0,50) } });
      }
    }
    const gasUrl = process.env.GAS_WEB_APP_URL;
    const apiKey = process.env.GAS_API_KEY;
    if (!gasUrl || !apiKey) return res.status(500).json({ error: 'GAS config missing on server' });

		// Enrich participants with DATE and resolved event name from DB (if available)
		let eventDate = '';
		try {
			const ev = await Event.findById(eventId);
			if (ev) {
				if (ev.date) eventDate = ev.date;
				// Ensure eventName reflects the actual event record used for logs
				if ((!eventName || eventName === '') && ev.name) {
					eventName = ev.name;
				}
			}
		} catch (e) { /* ignore, leave eventDate/eventName as-is */ }

// --- START: MODIFIED DATE HELPERS ---

    // helpers: parse and format date variants
    function getMonthName(mIdx) {
      return ['January','February','March','April','May','June','July','August','September','October','November','December'][mIdx] || '';
    }
    function ordinalSuffix(n) {
      const s = ["th","st","nd","rd"], v = n % 100;
      return n + (s[(v-20)%10] || s[v] || s[0]);
    }
    
    // Removed numberToWords and titleCaseWords as they are no longer needed for your format

    function deriveDateVariants(dateStr) {
      // accept YYYY-MM-DD or other parseable strings
      if (!dateStr) return { DATE_SIMPLE: '', DATE_LONG: '' };
      let d = null;
      // try YYYY-MM-DD
      const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        // Note: Month is 0-indexed in JS Date (0=Jan, 11=Dec)
        d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      } else {
        const tmp = new Date(dateStr);
        if (!isNaN(tmp.getTime())) d = tmp;
      }
      if (!d || isNaN(d.getTime())) return { DATE_SIMPLE: dateStr, DATE_LONG: dateStr };
      
      const day = d.getDate();
      const monthName = getMonthName(d.getMonth());
      const year = d.getFullYear();
  
      // Format 1: "Month Day, Year" (e.g., "October 17, 2025")
      const DATE_SIMPLE = `${monthName} ${day}, ${year}`;
      
      // Format 2: "Xth Day of Month, Year" (e.g., "17th Day of October, 2025")
      const DATE_LONG_ORDINAL = `${ordinalSuffix(day)} Day of ${monthName}, ${year}`;

      return { DATE_SIMPLE: DATE_SIMPLE, DATE_LONG: DATE_LONG_ORDINAL };
    }
// --- END: MODIFIED DATE HELPERS ---

    // Populate missing emails from Students collection where possible
    const allStudents = await Students.find();
    const studentByFID = {};
    const studentByNo = {};
    allStudents.forEach(s => {
      const obj = s.toObject ? s.toObject() : s;
      if (typeof obj.FID !== 'undefined') studentByFID[String(obj.FID)] = obj;
      if (obj['STUDENT NO']) studentByNo[String(obj['STUDENT NO']).toLowerCase()] = obj;
    });

    function formatNameForCert(name) {
      // Converts 'Last, First, MI.' to 'First MI. Last'
      if (!name || typeof name !== 'string') return name;
      const parts = name.split(',');
      if (parts.length < 2) return name.trim();
      const last = parts[0].trim();
      const first = parts[1].trim();
      const mi = parts[2] ? parts[2].trim() : '';
      return `${first} ${mi} ${last}`.replace(/\s+/g, ' ').trim();
    }

    const enriched = (participants || []).map(p => {
      const nameVal = (p && (p.NAME || p.name || p['FULL NAME'] || p['Full Name'])) || '';
      const rawDateVal = p && (p.DATE || p.Date || eventDate) || eventDate || '';
      const evNameVal = eventName || '';
      const copy = Object.assign({}, p);
      
// --- START: MODIFIED DATE ASSIGNMENT ---
      const { DATE_SIMPLE, DATE_LONG } = deriveDateVariants(rawDateVal);
      
      // fill EMAIL if missing: try by FID then STUDENT NO
      if (!copy.EMAIL || copy.EMAIL === '') {
        try {
          const byF = copy.FID ? studentByFID[String(copy.FID)] : null;
          const byNo = copy['STUDENT NO'] ? studentByNo[String(copy['STUDENT NO']).toLowerCase()] : null;
          const found = byF || byNo || null;
          if (found && found.EMAIL) copy.EMAIL = found.EMAIL;
        } catch (e) { /* ignore */ }
      }
      // common variants for templates
      const certName = formatNameForCert(nameVal);
      copy.NAME = certName;
      copy['FULL NAME'] = certName;
      copy['Full Name'] = certName;
      
      copy.EVENT_NAME = copy.EVENT_NAME || evNameVal;
      copy['EVENT NAME'] = copy['EVENT NAME'] || evNameVal;
      copy.eventName = copy.eventName || evNameVal;
      
      // Assign formats to the *exact* keys code.gs will look for
      
      // For {{DATE}}: "Month Day, Year"
      copy.DATE = DATE_SIMPLE || rawDateVal;
      copy.Date = DATE_SIMPLE || rawDateVal;
      copy['Event Date'] = DATE_SIMPLE || rawDateVal;
      
      // For {{DATE_LONG}}: "Xth Day of Month, Year"
      copy.DATE_LONG = DATE_LONG || rawDateVal;
      copy.DATE_VERBAL = DATE_LONG || rawDateVal; // Also assign to verbal as a fallback
// --- END: MODIFIED DATE ASSIGNMENT ---

      return copy;
    });

    // Build form payload expected by GAS script
    const payload = {
      apiKey,
      templateId: process.env.TEMPLATE_DOC_ID || '1hBPGuj5BmwH9smHpDyScUXU8hrqOXwIOn0EfZWjHFDE',
      outputFolderId: process.env.OUTPUT_FOLDER_ID || '1EvS6R9BunsAebJeIzPFPQ2ZlOw_i2aNC',
      eventId,
      eventName,
      participants: enriched
    };

    // Log a brief preview for debugging (do not log participant emails in production)
    try { console.log('/send-certs forwarding to GAS', { to: gasUrl, eventId, eventName, participantsCount: (enriched || []).length }); } catch(e){}
    const result = await postJsonToUrl(gasUrl, payload);

		// If GAS returned an HTML page (authorization/consent/login), log a warning but continue.
		// Some GAS deployments return HTML pages but still process the payload; do not short-circuit marking.
		let rawHtmlSnippet = null;
		if (result && result.statusCode && typeof result.body === 'string' && result.body.trim().startsWith('<!DOCTYPE')) {
			const m = result.body.match(/<title[^>]*>([^<]*)<\/title>/i);
			const title = m ? (m[1] || '').trim() : 'HTML response from GAS';
			console.warn('/send-certs: GAS returned HTML response instead of JSON or text:', title);
			rawHtmlSnippet = result.body.slice(0, 200);
			// continue to attempt marking attendance below even if GAS returned HTML
		}

		// After forwarding to GAS, if the call looks successful, update attendance records
		// to mark certificates as sent so the dashboard can reflect accurate counts.
		try {
			const statusCode = result && result.statusCode ? Number(result.statusCode) : (result && result.body && result.body.status ? Number(result.body.status) : 0);
			// Treat any non-error response from postJsonToUrl as a forwarded attempt and try to mark attendance.
			// This is intentionally permissive because some GAS endpoints return HTML or non-2xx codes
			// while still processing the payload. We still include gasResponse and statusCode in the reply.
			const shouldAttemptMark = Array.isArray(enriched) && enriched.length && !!result;
			let totalMarked = 0;
			if (shouldAttemptMark) {
				// Build update promises for participants that include an identifiable key
				const updates = enriched.map(p => {
					try {
						if (typeof p.FID !== 'undefined' && p.FID !== null && String(p.FID).trim() !== '') {
							// update by fingerprintID and event_id
							return Attendance.updateMany({ event_id: String(eventId), fingerprintID: Number(p.FID) }, { $set: { certStatus: 'Sent' } }).exec();
						}
						if (p.NAME) {
							return Attendance.updateMany({ event_id: String(eventId), name: p.NAME }, { $set: { certStatus: 'Sent' } }).exec();
						}
						// fallback: no reliable identifier -> noop promise
						return Promise.resolve({ acknowledged: true, modifiedCount: 0 });
					} catch (e) { return Promise.resolve({ acknowledged: false, modifiedCount: 0 }); }
				});
						const results = await Promise.all(updates);
						totalMarked = results.reduce((acc, r) => acc + (r && (r.modifiedCount || r.nModified || 0)), 0);
			}
					// include info about how many attendance records were marked
					const responsePayload = { forwarded: true, gasResponse: result, markedAttendance: totalMarked };
					if (rawHtmlSnippet) responsePayload.rawHtmlSnippet = rawHtmlSnippet;
					// If GAS returned a non-2xx status, include a warning but still respond 200 so clients refresh UI
					if (statusCode < 200 || statusCode >= 300) responsePayload.warning = 'GAS returned non-2xx status: ' + statusCode;
					return res.status(200).json(responsePayload);
		} catch (e) {
			// if marking fails, still return the GAS response but include a warning
			console && console.error && console.error('/send-certs: marking attendance certStatus failed', e);
			return res.status(200).json({ forwarded: true, gasResponse: result, markedAttendance: 0, warning: 'Failed to update attendance certStatus' });
		}
  } catch (err) {
    console.error('/send-certs error', err);
    res.status(500).json({ error: err.message });
  }
});

// ================= SERVER =================
const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
