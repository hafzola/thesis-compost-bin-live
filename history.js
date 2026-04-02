import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getFirestore, collection, query, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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

async function loadFullHistory() {
    const btn = document.getElementById('btn-open-history');
    if (btn) btn.innerText = "Loading History...";
    try {
        console.log("Fetching history from Firestore...");
        const qSnap = await getDocs(query(collection(fs, "hourly_history"), orderBy("timestamp", "asc")));
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
                time: jsDate.toLocaleString(),
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
        const labels = [], tAvg = [], mAvg = [], gAvg = [];
        const sortedDates = Object.keys(dailyAgg).sort();
        console.log(`Found ${sortedDates.length} unique dates.`);

        sortedDates.forEach(day => {
            if (dailyAgg[day].c > 0) {
                labels.push(new Date(day).toLocaleDateString([], { month: 'short', day: 'numeric' }));
                tAvg.push(dailyAgg[day].t / dailyAgg[day].c);
                mAvg.push(dailyAgg[day].m / dailyAgg[day].c);
                gAvg.push(dailyAgg[day].g / dailyAgg[day].c);
            }
        });

        renderHistoryCharts(labels, tAvg, mAvg, gAvg);

        const hourlyBtn = document.getElementById('btn-export-hourly-csv');
        if (hourlyBtn) {
            hourlyBtn.onclick = () => {
                let csvContent = "data:text/csv;charset=utf-8,Timestamp,Temperature (C),Moisture (%),Gas Level\n";
                rawLogs.forEach(log => {
                    csvContent += `"${log.time}",${log.temp.toFixed(2)},${log.moisture.toFixed(2)},${log.gas}\n`;
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
                downloadCSV(csvContent, `daily_summary_${new Date().toISOString().split('T')[0]}.csv`);
            };
        }

    } catch (e) { 
        console.error("History Load Error: ", e); 
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

function renderHistoryCharts(labels, t, m, g) {
    if (typeof Chart === 'undefined') {
        console.error("Chart.js is not loaded yet.");
        return;
    }
    
    const histConfig = (label, color, data) => ({
        type: 'line',
        data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color + '22', fill: true, pointRadius: 4 }] },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
    
    if (historyCharts.temp) {
        historyCharts.temp.destroy();
        historyCharts.moisture.destroy();
        historyCharts.gas.destroy();
    }

    historyCharts.temp = new Chart(document.getElementById('histTempChart'), histConfig('Avg Temp', '#bc4749', t));
    historyCharts.moisture = new Chart(document.getElementById('histMoistureChart'), histConfig('Avg Moisture', '#2d6a4f', m));
    historyCharts.gas = new Chart(document.getElementById('histGasChart'), histConfig('Avg Gas', '#ffb703', g));
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        startConnectionCheck();
        loadFullHistory();
    } else {
        window.location.href = 'login.html';
    }
});

document.getElementById('btn-close-history').onclick = () => {
    window.location.href = 'dashboard.html';
};
document.getElementById('logout-btn').onclick = () => signOut(auth);
