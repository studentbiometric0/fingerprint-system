// Ensure Chart.js is loaded before running
window.addEventListener('DOMContentLoaded', function() {
  function runDonut() {
    // If the page already has an inline implementation, skip this file to avoid duplicate charts
    if (window._attendanceSectionInlineExists) return;
    try {
      if (window._attendanceSectionDonutInitialized) return; // already initialized elsewhere
      if (typeof Chart === 'undefined') {
        setTimeout(runDonut, 100);
        return;
      }
    // We'll compute the latest event from the backend and render its per-section breakdown
    var attendanceSectionColors = ['#9c27b0','#2196f3','#f48fb1','#26a69a','#ffd54f','#66bb6a','#00bcd4'];
    function renderAttendanceSectionDonut(eventName, labels, data) {
      try {
        var canvas = document.getElementById('attendanceSectionDonutChart');
        if (!canvas) return;
        // prevent double-init on same canvas
        if (canvas._chartInitialized && window.attendanceSectionDonutChart) {
          try { window.attendanceSectionDonutChart.destroy(); } catch(e){}
        }
        var ctx = canvas.getContext('2d');
        if (window.attendanceSectionDonutChart && typeof window.attendanceSectionDonutChart.destroy === 'function') {
          window.attendanceSectionDonutChart.destroy();
        }
        window.attendanceSectionDonutChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: labels,
          datasets: [{
            data: data,
            backgroundColor: attendanceSectionColors.slice(0, labels.length),
            borderWidth: 2,
            borderColor: '#fff',
            hoverOffset: 8
          }]
        },
        options: {
          cutout: '70%',
          plugins: {
            legend: { display: false },
            tooltip: { enabled: true }
          }
        }
      });
        // Update total
        var total = data.reduce((a,b)=>a+b,0);
        var totalEl = document.getElementById('attendanceSectionTotal');
        if (totalEl) totalEl.textContent = total;
        var labelEl = document.getElementById('attendanceSectionEventLabel');
        if (labelEl) labelEl.textContent = eventName;
        canvas._chartInitialized = true;
        window._attendanceSectionDonutInitialized = true;
      } catch (err) {
        console && console.error && console.error('attendance donut render error', err);
      }
    }
    // Instead of using a select, fetch the latest event and render only that event's breakdown
    (async function fetchAndRenderLatest() {
      try {
        const [eventsRes, logsRes, studentsRes] = await Promise.all([fetch('/events'), fetch('/logs'), fetch('/students')]);
        const events = await eventsRes.json();
        const logs = await logsRes.json();
        const students = await studentsRes.json();
        if (!Array.isArray(events) || events.length === 0) return;
        // Find latest event by date, fallback to last in list
        const eventsWithDates = events.slice().filter(e => e && e.date).sort((a,b)=> Date.parse(b.date) - Date.parse(a.date));
        const latest = eventsWithDates.length ? eventsWithDates[0] : events[events.length - 1];
        const eventName = latest.name || latest._id || 'Latest Event';
        // Determine sections
        const sections = Array.from(new Set(students.map(s => s['YR AND SEC']).filter(Boolean)));
        const labels = sections.map(s => s);
        // compute attendance counts per section for this event
        const data = sections.map(sec => {
          const fids = students.filter(st => st['YR AND SEC'] === sec).map(st => String(st.FID));
          const attendees = new Set(logs.filter(l => (String(l.event_id) === String(latest._id) || l.event_id === latest.name || l.event_name === latest.name) && l.timeIn && fids.includes(String(l.fingerprintID))).map(l => l.fingerprintID));
          return attendees.size;
        });
        renderAttendanceSectionDonut(eventName, labels, data);
      } catch (err) {
        console && console.error && console.error('attendance donut fetch/render error', err);
      }
    })();
    } catch (err) {
      console && console.error && console.error('attendance donut init error', err);
    }
  }
  runDonut();
});
