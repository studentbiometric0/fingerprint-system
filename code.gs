const TEMPLATE_DOC_ID = '1hBPGuj5BmwH9smHpDyScUXU8hrqOXwIOn0EfZWjHFDE'; // put your Slides file ID here
const OUTPUT_FOLDER_ID = '1EvS6R9BunsAebJeIzPFPQ2ZlOw_i2aNC'; // folder ID only (optional)

function getApiKey() {
  return PropertiesService.getScriptProperties().getProperty('GAS_API_KEY') || '';
}

// Helper: set the script property (run once from editor to set key)
function setApiKey() {
  PropertiesService.getScriptProperties().setProperty('GAS_API_KEY', 'ECEStudentbiometric123');
  Logger.log('GAS_API_KEY set (hidden).');
}

// Utility: parse JSON body or form-encoded 'payload'
function parseIncoming(e) {
  try {
    if (e.postData && e.postData.contents) {
      try {
        return JSON.parse(e.postData.contents);
      } catch (err) {}
    }
    if (e.parameter && e.parameter.payload) {
      try {
        return JSON.parse(e.parameter.payload);
      } catch (err) {}
    }
    const fallback = {};
    if (e.parameter) {
      if (e.parameter.eventId) fallback.eventId = e.parameter.eventId;
      if (e.parameter.eventName) fallback.eventName = e.parameter.eventName;
      if (e.parameter.participants) {
        try {
          fallback.participants = JSON.parse(e.parameter.participants);
        } catch (err) {
          fallback.participants = [];
        }
      }
      if (e.parameter.eventDate) fallback.eventDate = e.parameter.eventDate;
      if (e.parameter.date) fallback.date = e.parameter.date;
    }
    return fallback;
  } catch (err) {
    Logger.log('parseIncoming error: ' + err);
    return {};
  }
}

// Ensure we have a Slides template File object - if missing, create a fallback Slides presentation
function ensureTemplateFile() {
  try {
    return DriveApp.getFileById(TEMPLATE_DOC_ID);
  } catch (err) {
    Logger.log('Template not found or inaccessible: ' + err + '. Creating fallback Slides template.');

    // Create a minimal slides presentation and add placeholder text boxes
    const pres = SlidesApp.create('AutoTemplate - Certificate');
    const slides = pres.getSlides();
    let s = slides.length ? slides[0] : pres.appendSlide(SlidesApp.PredefinedLayout.BLANK);

    try { s.insertTextBox('{{NAME}}').setLeft(50).setTop(80); } catch (e) {}
    try { s.insertTextBox('{{EVENT_NAME}}').setLeft(50).setTop(160); } catch (e) {}
    try { s.insertTextBox('{{DATE}}').setLeft(50).setTop(240); } catch (e) {}
    try { s.insertTextBox('{{DATE_LONG}}').setLeft(50).setTop(320); } catch (e) {}

    return DriveApp.getFileById(pres.getId());
  }
}

// Format helpers

// Convert parseable dates (YYYY-MM-DD or JS-recognizable date string) to "Month Day, Year"
// If unparseable, returns the original string
function formatMonthDayYear(dateStr) {
  if (!dateStr) return '';
  // Try YYYY-MM-DD first
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  let d = null;
  if (m) {
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    const tmp = new Date(dateStr);
    if (!isNaN(tmp.getTime())) d = tmp;
  }
  if (!d || isNaN(d.getTime())) return String(dateStr);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${monthNames[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// Return ordinal suffix like 1st, 2nd, 3rd, 4th
function ordinalSuffix(n) {
  n = Number(n);
  if (isNaN(n)) return String(n);
  const v = n % 100;
  if (v >= 11 && v <= 13) return n + 'th';
  switch (n % 10) {
    case 1: return n + 'st';
    case 2: return n + 'nd';
    case 3: return n + 'rd';
    default: return n + 'th';
  }
}

// Convert parseable dates to ordinal long form: "13th Day of October, 2025"
function formatDateOrdinal(dateStr) {
  if (!dateStr) return '';
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  let d = null;
  if (m) {
    d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    const tmp = new Date(dateStr);
    if (!isNaN(tmp.getTime())) d = tmp;
  }
  if (!d || isNaN(d.getTime())) return String(dateStr);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = d.getDate();
  const monthName = monthNames[d.getMonth()];
  const year = d.getFullYear();
  return `${ordinalSuffix(day)} Day of ${monthName}, ${year}`;
}

// Convert "Last, First, MI." -> "First MI. Last", or return trimmed name if not in that form
function formatNameForCert(name) {
  if (!name || typeof name !== 'string') return name;
  const parts = name.split(',');
  if (parts.length < 2) return name.trim();
  const last = parts[0].trim();
  const first = parts[1].trim();
  const mi = parts[2] ? parts[2].trim() : '';
  return `${first} ${mi} ${last}`.replace(/\s+/g, ' ').trim();
}

function doPost(e) {
  try {
    const raw = parseIncoming(e) || {};
    const incomingKey = raw.apiKey || (e.parameter && e.parameter.apiKey) || '';

    Logger.log('doPost incomingKey present: ' + (incomingKey ? 'yes' : 'no'));
    Logger.log('doPost preview: ' + JSON.stringify({
      eventId: raw.eventId,
      eventName: raw.eventName,
      participantsCount: Array.isArray(raw.participants) ? raw.participants.length : 0
    }));

    if (incomingKey !== getApiKey()) {
      Logger.log('Unauthorized call - apiKey mismatch');
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'Unauthorized', status: 401 }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const eventName = raw.eventName || 'Event';
    const participants = Array.isArray(raw.participants) ? raw.participants : [];
    // Debug: log incoming event name and first participant's EVENT_NAME to help verify payload
    try { Logger.log('GAS doPost incoming eventName:', eventName); } catch (e) {}
    try { Logger.log('GAS doPost participants count:', participants.length); } catch (e) {}
    try { Logger.log('GAS doPost first participant EVENT_NAME:', participants[0] && (participants[0].EVENT_NAME || participants[0]['EVENT NAME'] || participants[0].eventName)); } catch (e) {}
    const eventDate = raw.eventDate || raw.date || '';

    // Get template file (Slides). If missing, create fallback.
    let templateFile;
    try {
      templateFile = ensureTemplateFile();
    } catch (err) {
      Logger.log('Failed to retrieve/create template: ' + err);
      return ContentService
        .createTextOutput(JSON.stringify({ error: 'Template unavailable', status: 500 }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Safe get of output folder
    let outputFolder = null;
    if (OUTPUT_FOLDER_ID) {
      try {
        outputFolder = DriveApp.getFolderById(OUTPUT_FOLDER_ID);
      } catch (err) {
        Logger.log('Output folder inaccessible: ' + err);
        outputFolder = null;
      }
    }

    const results = [];

    participants.forEach(p => {
      try {
            // We'll create a copy of the Slides template after resolving the event name so the
            // copied file name reflects the DB-resolved event. The presentation object (pres)
            // and the replacement helper are created after that.

        // Prepare commonly used values (fallbacks included)
        const nameVal = p.NAME || p.name || p['FULL NAME'] || p['Full Name'] || '';
        const eventVal = p.EVENT_NAME || p['EVENT NAME'] || p.eventName || eventName;

        // Date handling: prefer participant date, then event-level date
        const rawDateVal = p.DATE || p.Date || p.DATE_LONG || eventDate || '';
        const dateMonthDayYear = formatMonthDayYear(rawDateVal);

        // Build a safe copy of participant data and populate common fields
        const copy = Object.assign({}, p);

        // Normalize name for printing
        const certName = formatNameForCert(nameVal);
        copy.NAME = certName;
        copy['FULL NAME'] = certName;
        copy['Full Name'] = certName;

        // Ensure the participant carries the resolved event name so templates, filenames and
        // emails consistently reflect the DB-provided event name.
        copy.EVENT_NAME = copy.EVENT_NAME || eventVal;
        copy['EVENT NAME'] = copy['EVENT NAME'] || eventVal;
        copy.eventName = copy.eventName || eventVal;

  // Map dates:
  // - {{DATE}} will be "Month Day, Year" (e.g., "October 17, 2025")
  // - {{DATE_LONG}} will be the ordinal long form: "13th Day of October, 2025"
  // - Also populate other common date keys so templates can use any of them
  copy.DATE = dateMonthDayYear;
  copy.Date = dateMonthDayYear;
  const dateOrdinal = formatDateOrdinal(rawDateVal);
  copy.DATE_LONG = dateOrdinal || dateMonthDayYear; // ordinal long form preferred
  copy['Event Date'] = dateMonthDayYear;
  // Also set DATE_VERBAL to the ordinal long form for backward compatibility
  copy.DATE_VERBAL = copy.DATE_VERBAL || dateOrdinal || rawDateVal;

        // Now create the Slides copy using the resolved event name
        const copyFile = templateFile.makeCopy(`Cert-${copy.EVENT_NAME}-${p['STUDENT NO'] || p.FID || 'unknown'}`);
        const copyId = copyFile.getId();
        // Open presentation by id and replace placeholders across all slides
        const pres = SlidesApp.openById(copyId);

        // Replacement helper - gracefully handles undefined
        function replaceSafe(keyVariants, value) {
          if (typeof value === 'undefined' || value === null) value = '';
          keyVariants.forEach(k => {
            try {
              pres.replaceAllText(k, String(value));
            } catch (e) {
              Logger.log('replaceAllText failed for ' + k + ': ' + e);
            }
          });
        }

        // Replace name variants
        replaceSafe(['{{NAME}}', '{{Full Name}}', '{{FULL NAME}}', '{{full name}}', '{{name}}'], copy.NAME);

        // Replace event name variants
        replaceSafe(['{{EVENT_NAME}}', '{{EVENT NAME}}', '{{Event Name}}', '{{eventName}}', '{{event_name}}'], copy.EVENT_NAME);

  // Replace date placeholders ({{DATE}} is Month Day, Year; {{DATE_LONG}} is ordinal long form)
        replaceSafe(['{{DATE}}', '{{Date}}', '{{date}}', '{{DATE_VERBAL}}', '{{date_verbal}}'], copy.DATE);
        replaceSafe(['{{DATE_LONG}}', '{{Date}}', '{{Event Date}}', '{{DATE_LONG}}'], copy.DATE_LONG);

        // Persist the changes before exporting
        try {
          pres.saveAndClose();
        } catch (saveErr) {
          Logger.log('pres.saveAndClose() failed: ' + saveErr);
        }

        Utilities.sleep(3000);

        // Move to output folder if available
        if (outputFolder) {
          try {
            outputFolder.addFile(copyFile);
            try {
              const root = DriveApp.getRootFolder();
              root.removeFile(copyFile);
            } catch (remErr) {
              Logger.log('Could not remove copy from root folder: ' + remErr);
            }
          } catch (err) {
            Logger.log('addFile error: ' + err);
          }
        }

        // Export as PDF
        let pdf;
        try {
          pdf = DriveApp.getFileById(copyId).getAs(MimeType.PDF).setName(copyFile.getName() + '.pdf');
        } catch (pdfErr) {
          Logger.log('PDF export failed first attempt: ' + pdfErr);
          Utilities.sleep(1500);
          try {
            pdf = DriveApp.getFileById(copyId).getAs(MimeType.PDF).setName(copyFile.getName() + '.pdf');
          } catch (pdfErr2) {
            Logger.log('PDF export failed second attempt: ' + pdfErr2);
            results.push({
              studentNo: p['STUDENT NO'] || null,
              email: p.EMAIL || null,
              status: 'error',
              message: 'PDF export failed: ' + String(pdfErr2)
            });
            return;
          }
        }

        // Send email if present
        if (p.EMAIL) {
          try {
            MailApp.sendEmail({
              to: p.EMAIL,
              subject: `Certificate - ${copy.EVENT_NAME}`,
              body: `Hello ${certName || ''},\n\nAttached is your certificate for ${copy.EVENT_NAME}.\n\nRegards.`,
              attachments: [pdf]
            });
          } catch (mailErr) {
            Logger.log('MailApp error for ' + p.EMAIL + ': ' + mailErr);
            results.push({
              studentNo: p['STUDENT NO'] || null,
              email: p.EMAIL || null,
              status: 'error',
              message: 'Mail error: ' + String(mailErr)
            });
            return;
          }
        }

        results.push({
          studentNo: p['STUDENT NO'] || null,
          email: p.EMAIL || null,
          status: 'sent'
        });

      } catch (innerErr) {
        Logger.log('participant processing error: ' + innerErr);
        results.push({
          studentNo: p['STUDENT NO'] || null,
          email: p.EMAIL || null,
          status: 'error',
          message: String(innerErr)
        });
      }
    });

    // Return success JSON
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, results: results }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('doPost top-level error: ' + err);
    return ContentService
      .createTextOutput(JSON.stringify({ error: String(err), status: 500 }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
