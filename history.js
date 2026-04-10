import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getFirestore, collection, query, orderBy, getDocs, where, Timestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyDCJ0gtztRQJbw3COslmZwkQkki54YLLZQ",
    authDomain: "thesis-compost-bin.firebaseapp.com",
    databaseURL: "https://thesis-compost-bin-default-rtdb.asia-southeast1.firebasedatabase.app/",
    projectId: "thesis-compost-bin",
    storageBucket: "thesis-compost-bin.firebasestorage.app",
    messagingSenderId: "814443216380",
    appId: "1:814443216380:web:22aaabcdf86615254c4679"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const fs = getFirestore(app);

// declare var Chart: any; // Removed TS syntax

let historyCharts = { temp: null, moisture: null, gas: null };
let lastSeenTimestamp = 0;
let currentView = 'daily'; // 'daily' or 'hourly'
let chartData = {
    daily: { labels: [], t: [], m: [], g: [] },
    hourly: { labels: [], t: [], m: [], g: [] }
};

function startConnectionCheck() {
    // Listen to device status
    onValue(ref(db, 'DeviceStatus/lastSeen'), (snapshot) => {
        lastSeenTimestamp = snapshot.val() || 0;
        updateStatusDot();
    });

    // Periodic check
    setInterval(updateStatusDot, 5000);
}

function updateStatusDot() {
    const now = Date.now();
    const isOnline = (now - lastSeenTimestamp) < 30000;
    const dot = document.getElementById('status-dot');
    if (dot) dot.className = isOnline ? 'dot-online' : 'dot-offline';
}

let currentLogCategory = 'all';

async function loadFullHistory() {
    const startInput = document.getElementById('start-date');
    const endInput = document.getElementById('end-date');
    
    // Default to last 28 days if not set
    if (!startInput.value || !endInput.value) {
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 28);
        startInput.value = start.toISOString().split('T')[0];
        endInput.value = end.toISOString().split('T')[0];
    }

    const startDate = new Date(startInput.value);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(endInput.value);
    endDate.setHours(23, 59, 59, 999);

    const applyBtn = document.getElementById('btn-apply-filter');
    if (applyBtn) applyBtn.innerText = "Loading...";
    
    try {
        console.log(`Fetching history from ${startDate} to ${endDate}...`);
        
        const q = query(
            collection(fs, "hourly_history"), 
            where("timestamp", ">=", Timestamp.fromDate(startDate)),
            where("timestamp", "<=", Timestamp.fromDate(endDate)),
            orderBy("timestamp", "asc")
        );
        
        const qSnap = await getDocs(q);
        console.log(`Fetched ${qSnap.size} documents.`);
        
        const dailyAgg = {};
        const rawLogs = []; 
        
        qSnap.forEach(doc => {
            const d = doc.data();
            if (!d.timestamp || typeof d.timestamp.toDate !== 'function') {
                console.warn("Document missing timestamp or toDate() not available:", doc.id);
                return;
            }
            
            const temp = Number(d.temperature);
            const moist = Number(d.moisture);
            const gas = Number(d.gasValue || 0);

            if (!Number.isFinite(temp) || !Number.isFinite(moist) || !Number.isFinite(gas)) {
                console.warn("Document has invalid numeric values:", doc.id);
                return;
            }
            
            const jsDate = d.timestamp.toDate();
            const dateKey = jsDate.toISOString().split('T')[0];
            
            rawLogs.push({
                timestamp: jsDate,
                timeStr: jsDate.toLocaleString(),
                temp: temp,
                moisture: moist,
                gas: gas
            });

            if (!dailyAgg[dateKey]) dailyAgg[dateKey] = { t: 0, m: 0, g: 0, c: 0 };
            dailyAgg[dateKey].t += temp;
            dailyAgg[dateKey].m += moist;
            dailyAgg[dateKey].g += gas;
            dailyAgg[dateKey].c++;
        });

        console.log("Daily aggregation complete:", dailyAgg);
        const dailyLabels = [], dailyT = [], dailyM = [], dailyG = [];
        const sortedDates = Object.keys(dailyAgg).sort();
        console.log(`Found ${sortedDates.length} unique dates.`);

        sortedDates.forEach(day => {
            if (dailyAgg[day].c > 0) {
                dailyLabels.push(new Date(day).toLocaleDateString([], { month: 'short', day: 'numeric' }));
                dailyT.push(dailyAgg[day].t / dailyAgg[day].c);
                dailyM.push(dailyAgg[day].m / dailyAgg[day].c);
                dailyG.push(dailyAgg[day].g / dailyAgg[day].c);
            }
        });

        // Prepare Hourly Data
        const hourlyLabels = [], hourlyT = [], hourlyM = [], hourlyG = [];
        // Sort raw logs by timestamp
        rawLogs.sort((a, b) => a.timestamp - b.timestamp);
        rawLogs.forEach(log => {
            const date = log.timestamp;
            hourlyLabels.push(date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.getHours() + ':00');
            hourlyT.push(log.temp);
            hourlyM.push(log.moisture);
            hourlyG.push(log.gas);
        });

        chartData.daily = { labels: dailyLabels, t: dailyT, m: dailyM, g: dailyG };
        chartData.hourly = { labels: hourlyLabels, t: hourlyT, m: hourlyM, g: hourlyG };

        updateView(currentView);
        await loadSystemLogs(startDate, endDate, currentLogCategory);

        const hourlyBtn = document.getElementById('btn-export-hourly-csv');
        if (hourlyBtn) {
            hourlyBtn.onclick = () => {
                let csvContent = "data:text/csv;charset=utf-8,Timestamp,Temperature (C),Moisture (%),Gas Level\n";
                rawLogs.forEach(log => {
                    csvContent += `"${log.timeStr}",${log.temp.toFixed(2)},${log.moisture.toFixed(2)},${log.gas}\n`;
                });
                downloadCSV(csvContent, `hourly_logs_${new Date().toISOString().split('T')[0]}.csv`);
            };
        }

        const dailyBtn = document.getElementById('btn-export-csv');
        if (dailyBtn) {
            dailyBtn.onclick = () => {
                let csvContent = "data:text/csv;charset=utf-8,Date,Avg Temp (C),Avg Moisture (%),Avg Gas\n";
                sortedDates.forEach(date => {
                    csvContent += `${date},${(dailyAgg[date].t / dailyAgg[date].c).toFixed(2)},${(dailyAgg[date].m / dailyAgg[date].c).toFixed(2)},${(dailyAgg[date].g / dailyAgg[date].c).toFixed(2)}\n`;
                });
                downloadCSV(csvContent, `daily_summary_${startInput.value}_to_${endInput.value}.csv`);
            };
        }

        if (applyBtn) applyBtn.innerText = "Apply Filter";

    } catch (e) { 
        console.error("History Load Error: ", e); 
        if (applyBtn) applyBtn.innerText = "Apply Filter";
    }
}

async function loadSystemLogs(startDate, endDate, category = 'all') {
    const logsContainer = document.getElementById('history-logs-container');
    if (!logsContainer) return;

    try {
        let q;
        if (category === 'all') {
            q = query(
                collection(fs, "system_logs"),
                where("timestamp", ">=", Timestamp.fromDate(startDate)),
                where("timestamp", "<=", Timestamp.fromDate(endDate)),
                orderBy("timestamp", "desc")
            );
        } else {
            q = query(
                collection(fs, "system_logs"),
                where("timestamp", ">=", Timestamp.fromDate(startDate)),
                where("timestamp", "<=", Timestamp.fromDate(endDate)),
                where("category", "==", category),
                orderBy("timestamp", "desc")
            );
        }

        const qSnap = await getDocs(q);
        let html = '';

        if (qSnap.empty) {
            html = '<p class="hint">No logs found for this period.</p>';
        } else {
            qSnap.forEach(doc => {
                const data = doc.data();
                const time = data.timestamp ? data.timestamp.toDate().toLocaleString() : '...';
                html += `
                    <div style="padding: 10px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: flex-start; gap: 15px;">
                        <div style="flex-grow: 1;">
                            <div style="font-weight: bold; color: ${data.category === 'alert' ? '#bc4749' : '#2d6a4f'}; margin-bottom: 4px;">
                                ${data.type}
                            </div>
                            <div style="color: #555; font-size: 0.9rem;">${data.message}</div>
                        </div>
                        <div style="font-size: 0.75rem; color: #888; white-space: nowrap;">${time}</div>
                    </div>
                `;
            });
        }
        logsContainer.innerHTML = html;
    } catch (err) {
        console.error("Failed to load system logs:", err);
        logsContainer.innerHTML = '<p class="hint" style="color: #bc4749;">Error loading logs.</p>';
    }
}

function downloadCSV(csvString, fileName) {
    // Remove the data URI prefix if it was passed in
    const cleanContent = csvString.replace(/^data:text\/csv;charset=utf-8,/, '');
    const blob = new Blob([cleanContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", fileName);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function updateView(view) {
    currentView = view;
    const data = chartData[view];
    const suffix = view === 'daily' ? '(Daily Average)' : '(Hourly Log)';
    
    document.getElementById('title-temp').innerText = `🌡️ Temperature ${suffix}`;
    document.getElementById('title-moisture').innerText = `💧 Moisture ${suffix}`;
    document.getElementById('title-gas').innerText = `💨 Gas ${suffix}`;
    
    document.getElementById('btn-view-daily').classList.toggle('active', view === 'daily');
    document.getElementById('btn-view-hourly').classList.toggle('active', view === 'hourly');
    
    renderHistoryCharts(data.labels, data.t, data.m, data.g);
}

document.getElementById('btn-view-daily').onclick = () => updateView('daily');
document.getElementById('btn-view-hourly').onclick = () => updateView('hourly');
document.getElementById('btn-apply-filter').onclick = () => loadFullHistory();

function renderHistoryCharts(labels, t, m, g) {
    if (typeof Chart === 'undefined') {
        console.error("Chart.js is not loaded yet.");
        return;
    }
    
    const histConfig = (label, color, data, min, max) => ({
        type: 'line',
        data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '22', fill: true, pointRadius: 4 }] },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                y: {
                    min: min,
                    max: max,
                    beginAtZero: min === 0
                }
            }
        }
    });
    
    if (historyCharts.temp) {
        historyCharts.temp.destroy();
        historyCharts.moisture.destroy();
        historyCharts.gas.destroy();
    }

    historyCharts.temp = new Chart(document.getElementById('histTempChart'), histConfig('Avg Temp', '#bc4749', t, 25, 45));
    historyCharts.moisture = new Chart(document.getElementById('histMoistureChart'), histConfig('Avg Moisture', '#2d6a4f', m, 0, 100));
    historyCharts.gas = new Chart(document.getElementById('histGasChart'), histConfig('Avg Gas', '#ffb703', g, 0, 2000));
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        startConnectionCheck();
        
        // Handle category filter buttons
        const logFilterBtns = document.querySelectorAll('.log-filter-btn');
        logFilterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                logFilterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentLogCategory = btn.dataset.category;
                
                const startInput = document.getElementById('start-date');
                const endInput = document.getElementById('end-date');
                const start = new Date(startInput.value);
                start.setHours(0,0,0,0);
                const end = new Date(endInput.value);
                end.setHours(23, 59, 59, 999);
                
                loadSystemLogs(start, end, currentLogCategory);
            });
        });

        // Handle initial anchor from dashboard
        const hash = window.location.hash;
        if (hash === '#alerts') {
            currentLogCategory = 'alert';
            logFilterBtns.forEach(b => b.classList.remove('active'));
            document.querySelector('[data-category="alert"]').classList.add('active');
        } else if (hash === '#activity') {
            currentLogCategory = 'activity';
            logFilterBtns.forEach(b => b.classList.remove('active'));
            document.querySelector('[data-category="activity"]').classList.add('active');
        }

        loadFullHistory();
    } else {
        window.location.href = 'login.html';
    }
});

document.getElementById('btn-close-history').onclick = () => {
    window.location.href = 'dashboard.html';
};
document.getElementById('logout-btn').onclick = () => signOut(auth);
