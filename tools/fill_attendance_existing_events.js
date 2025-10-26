// Fill attendance records for existing events named "Attendance Test 1".."Attendance Test 6"
// This script will only insert Attendance documents; it will NOT create events or students.

const mongoose = require('mongoose');

const MONGO_URI = "mongodb+srv://studentbiometric:studentbio123@attendance.yxnsnof.mongodb.net/ATTENDANCE";

const StudentsSchema = new mongoose.Schema({ FID: Number, "STUDENT NO": String, NAME: String, EMAIL: String }, { collection: 'students' });
const EventSchema = new mongoose.Schema({ name: String, date: String }, { collection: 'events' });
const AttendanceSchema = new mongoose.Schema({ event_id: String, event_name: String, fingerprintID: Number, name: String, timeIn: Date, timeOut: Date }, { collection: 'attendance' });

async function main() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const Students = mongoose.model('StudentsFill', StudentsSchema);
  const Event = mongoose.model('EventFill', EventSchema);
  const Attendance = mongoose.model('AttendanceFill', AttendanceSchema);

  const students = await Students.find().lean();
  if (!students || students.length === 0) {
    console.error('No students found - aborting.');
    process.exit(1);
  }

  const summary = [];

  for (let i = 1; i <= 6; i++) {
    const evName = `Attendance Test ${i}`;
    const ev = await Event.findOne({ name: evName }).lean();
    if (!ev) { console.log(`Event not found: ${evName} - skipping`); continue; }
    const evId = String(ev._id);
    let inserted = 0, partial = 0, skipped = 0;

    for (const s of students) {
      const exists = await Attendance.findOne({ event_id: evId, fingerprintID: s.FID });
      if (exists) { skipped++; continue; }

      // Decide: present (in+out), partial (in only), absent (no doc)
      const r = Math.random();
      if (r < 0.65) {
        // present
        const day = new Date(ev.date + 'T00:00:00');
        const inMin = 8*60 + Math.floor(Math.random()*60);
        const timeIn = new Date(day.getTime() + inMin*60000);
        const outMin = inMin + 4*60 + Math.floor(Math.random()*120);
        const timeOut = new Date(day.getTime() + outMin*60000);
        await Attendance.create({ event_id: evId, event_name: ev.name, fingerprintID: s.FID, name: s.NAME, timeIn, timeOut });
        inserted++;
      } else if (r < 0.85) {
        // partial
        const day = new Date(ev.date + 'T00:00:00');
        const inMin = 8*60 + Math.floor(Math.random()*180);
        const timeIn = new Date(day.getTime() + inMin*60000);
        await Attendance.create({ event_id: evId, event_name: ev.name, fingerprintID: s.FID, name: s.NAME, timeIn });
        partial++;
      } else {
        // absent - do nothing
      }
    }

    summary.push({ event: evName, inserted, partial, skipped });
    console.log(`Event ${evName}: inserted=${inserted}, partial=${partial}, skipped=${skipped}`);
  }

  console.table(summary);
  await mongoose.disconnect();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
