import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue, set, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getFirestore, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

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

let charts = { temp: null, moisture: null, gas: null };
let compostTimerInterval = null; 

function initCharts() {
    const chartConfig = (label, color) => ({
        type: 'line',
        data: { 
            labels: [], 
            datasets: [{ 
                label: label, 
                data: [], 
                borderColor: color, 
                backgroundColor: color + '11', 
                fill: true, 
                tension: 0.4, 
                pointRadius: 2 
            }] 
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            animation: false,
            plugins: { legend: { display: false } },
            scales: { 
                x: { display: true, ticks: { maxTicksLimit: 5 } },
                y: { beginAtZero: true }
            }
        }
    });

    charts.temp = new Chart(document.getElementById('tempChart'), chartConfig('Temp (°C)', '#bc4749'));
    charts.moisture = new Chart(document.getElementById('moistureChart'), chartConfig('Moisture (%)', '#2d6a4f'));
    charts.gas = new Chart(document.getElementById('gasChart'), chartConfig('Gas (ppm)', '#ffb703'));
}

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('dashboard-screen').style.display = 'block';
        initCharts();
        startDashboard();
    } else {
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('dashboard-screen').style.display = 'none';
    }
});

document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
        await signInWithEmailAndPassword(auth, document.getElementById('email').value, document.getElementById('password').value);
    } catch (err) {
        document.getElementById('auth-error').innerText = "Invalid credentials.";
    }
};

document.getElementById('logout-btn').onclick = () => signOut(auth);

function startDashboard() {
    const m1Input = document.getElementById('mix1');
    const m2Input = document.getElementById('mix2');
    const m3Input = document.getElementById('mix3');
    const preview = document.getElementById('interval-preview'); 
    const timerDisplay = document.getElementById('next-mix-timer');
    const timerContainer = document.getElementById('timer-container');
    const startBtn = document.getElementById('btn-start-compost');
    const progressFill = document.getElementById('progress-fill');
    
    let compostingStartTime = null;
    let lastChartUpdate = 0;
    let lastFirestoreLog = 0; 
    let cooldownTargets = { motor: 0, fan: 0, pump: 0 };

    [m1Input, m2Input, m3Input].forEach(select => {
        select.innerHTML = '';
        for (let i = 0; i < 24; i++) {
            let opt = document.createElement('option');
            opt.value = i; opt.innerText = `${i}:00`;
            select.appendChild(opt);
        }
    });

    setInterval(() => {
        const now = Date.now();
        const mode = document.getElementById('current-mode').innerText;
        ['motor', 'fan', 'pump'].forEach(key => {
            const btn = document.getElementById(`btn-${key}`);
            const remainingMs = (cooldownTargets[key] || 0) - now;
            if (mode === "MANUAL" && remainingMs > 0) {
                const totalSeconds = Math.floor(remainingMs / 1000);
                btn.innerText = `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`;
                btn.disabled = true;
            } else {
                btn.innerText = key.charAt(0).toUpperCase() + key.slice(1);
                btn.disabled = (mode === "AUTO");
            }
        });
    }, 1000);

    onValue(ref(db, '/'), (snapshot) => {
        const root = snapshot.val();
        if (!root) return;

        if (root.Cooldown) cooldownTargets = root.Cooldown;

        const mode = root.Control?.mode || "MANUAL";
        document.getElementById('current-mode').innerText = mode;
        const isAuto = (mode === "AUTO");
        document.getElementById('mode-auto').classList.toggle('active', isAuto);
        document.getElementById('mode-manual').classList.toggle('active', !isAuto);
        timerContainer.style.display = isAuto ? 'block' : 'none';

        // --- RESTORED: MIXING SCHEDULE & RTC TIMER ---
        if (root.MixSchedule) {
            const s1 = parseInt(root.MixSchedule.mix1);
            preview.innerText = `${s1}:00, ${(s1+8)%24}:00, ${(s1+16)%24}:00`;
            if (!m1Input.matches(':focus')) {
                m1Input.value = s1;
                m2Input.value = (s1 + 8) % 24;
                m3Input.value = (s1 + 16) % 24;
            }
            // RTC Countdown Logic
            if (isAuto && root.RTC) {
                const nowSecs = (root.RTC.hour * 3600) + (root.RTC.minute * 60) + root.RTC.second;
                const targets = [s1 * 3600, ((s1+8)%24) * 3600, ((s1+16)%24) * 3600].sort((a,b)=>a-b);
                let next = targets.find(t => t > nowSecs) || (targets[0] + 86400);
                let diff = next - nowSecs;
                timerDisplay.innerText = `${Math.floor(diff/3600)}h ${Math.floor((diff%3600)/60)}m ${diff%60}s`;
            }
        }

        if (root.SensorData) {
            const t = root.SensorData.temperature || 0;
            const m = root.SensorData.soilMoisturePercent || 0;
            const g = root.SensorData.gasValue || 0;
            
            document.getElementById('temp-val').innerText = t.toFixed(1);
            document.getElementById('soil-val').innerText = Math.round(m);
            document.getElementById('gas-val').innerText = g;

            const now = Date.now();
            if (now - lastChartUpdate > 5000) {
                const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const dataMap = { temp: t, moisture: m, gas: g };
                Object.keys(charts).forEach(key => {
                    const chart = charts[key];
                    if (chart) {
                        chart.data.labels.push(timeLabel);
                        chart.data.datasets[0].data.push(dataMap[key]);
                        if (chart.data.labels.length > 20) {
                            chart.data.labels.shift();
                            chart.data.datasets[0].data.shift();
                        }
                        chart.update('none'); 
                    }
                });
                lastChartUpdate = now;
            }

            if (now - lastFirestoreLog > 600000) {
                addDoc(collection(fs, "sensor_history"), { temperature: t, moisture: m, gas: g, timestamp: serverTimestamp() });
                lastFirestoreLog = now;
            }
        }

        if (root.Process?.startTime) {
            compostingStartTime = root.Process.startTime;
            startBtn.innerText = "Stop Composting";
            startBtn.style.backgroundColor = "#bc4749";
            document.getElementById('progress-container').style.display = 'block';
            if (compostTimerInterval) clearInterval(compostTimerInterval);
            compostTimerInterval = setInterval(() => {
                const diff = Date.now() - compostingStartTime;
                const d = Math.floor(diff / (24 * 60 * 60 * 1000));
                const h = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                const m = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
                const s = Math.floor((diff % (60 * 1000)) / 1000);
                document.getElementById('time-elapsed').innerText = `Elapsed: ${d}d ${h}h ${m}m ${s}s`;
                const progress = Math.min(100, (diff / (28 * 24 * 60 * 60 * 1000)) * 100);
                progressFill.style.width = `${progress}%`;
                document.getElementById('percent-text').innerText = `${progress.toFixed(2)}% Complete`;
            }, 1000);
        } else {
            compostingStartTime = null;
            startBtn.innerText = "Start Composting";
            startBtn.style.backgroundColor = "#2d6a4f";
            document.getElementById('progress-container').style.display = 'none';
        }
    });

    document.getElementById('mode-auto').onclick = () => set(ref(db, 'Control/mode'), "AUTO");
    document.getElementById('mode-manual').onclick = () => set(ref(db, 'Control/mode'), "MANUAL");
    startBtn.onclick = () => set(ref(db, 'Process/startTime'), compostingStartTime ? null : Date.now());
    
    // --- RESTORED: UPDATE SCHEDULE SAVE BUTTON ---
    document.getElementById('update-schedule').onclick = () => {
        const val = parseInt(m1Input.value);
        update(ref(db, 'MixSchedule'), { 
            mix1: val, 
            mix2: (val + 8) % 24, 
            mix3: (val + 16) % 24 
        }).then(() => alert("Schedule Synchronized!"));
    };

    const triggerAction = (key, runTimeMs, cooldownMins) => {
        const targetCooldown = Date.now() + (cooldownMins * 60 * 1000);
        update(ref(db, 'Control'), { [key]: true });
        set(ref(db, `Cooldown/${key}`), targetCooldown);
        setTimeout(() => update(ref(db, 'Control'), { [key]: false }), runTimeMs);
    };

    document.getElementById('btn-motor').onclick = () => triggerAction('motor', 30000, 15);
    document.getElementById('btn-fan').onclick = () => triggerAction('fan', 30000, 15);
    document.getElementById('btn-pump').onclick = () => triggerAction('pump', 5000, 15);
}
