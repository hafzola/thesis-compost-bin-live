import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import admin from "firebase-admin";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
if (admin.apps.length === 0) {
    admin.initializeApp({
        credential: admin.credential.cert(path.join(__dirname, "service-account.json")),
        databaseURL: "https://thesis-compost-bin-default-rtdb.asia-southeast1.firebasedatabase.app/"
    });
}

const db = admin.database();
const fs = admin.firestore();

// --- MONITORING LOGIC ---
let prevActuators = { motor: false, fan: false, pump: false };
let activeAlerts = { temp: false, moisture: false, gas: false };
let lastAlertTimes = { temp: 0, moisture: 0, gas: 0 };
let lastLoggedProcessStartTime = 0;
let lastLoggedHourKey = "";
let isInitialSync = true;
let deviceOnline = true;
let missedUpdates = 0;
let lastSeenTimestamp = 0;
const ALERT_COOLDOWN = 15 * 60 * 1000; // 15 minutes

const OPTIMAL_THRESHOLDS = {
    temp: 40,
    moisture: { min: 80, max: 100 },
    gas: 1500
};

async function logSystemEvent(type: string, message: string, category: string = 'activity') {
    try {
        await fs.collection("system_logs").add({
            type,
            message,
            category,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`[LOG] ${type}: ${message}`);
    } catch (err) {
        console.error("Failed to log event:", err);
    }
}

function checkSensorsAndActuators(s: any, ctrl: any) {
    const isAuto = ctrl.mode === 'AUTO';
    const actuatorCategory = isAuto ? 'alert' : 'activity';

    // 1. Check Actuators
    if (ctrl.motor !== prevActuators.motor) {
        const msg = isAuto ? `System automatically turned motor ${ctrl.motor ? 'ON' : 'OFF'}` : `Motor turned ${ctrl.motor ? 'ON' : 'OFF'}`;
        logSystemEvent('Motor', msg, actuatorCategory);
        prevActuators.motor = ctrl.motor;
    }
    if (ctrl.fan !== prevActuators.fan) {
        const msg = isAuto ? `System automatically turned fan ${ctrl.fan ? 'ON' : 'OFF'}` : `Fan turned ${ctrl.fan ? 'ON' : 'OFF'}`;
        logSystemEvent('Fan', msg, actuatorCategory);
        prevActuators.fan = ctrl.fan;
    }
    if (ctrl.pump !== prevActuators.pump) {
        const msg = isAuto ? `System automatically turned pump ${ctrl.pump ? 'ON' : 'OFF'}` : `Pump turned ${ctrl.pump ? 'ON' : 'OFF'}`;
        logSystemEvent('Pump', msg, actuatorCategory);
        prevActuators.pump = ctrl.pump;
    }

    // 2. Check Sensor Thresholds
    const now = Date.now();

    // Temperature
    if (s.temperature >= OPTIMAL_THRESHOLDS.temp) {
        if (!activeAlerts.temp && (now - lastAlertTimes.temp > ALERT_COOLDOWN)) {
            logSystemEvent('High Temp', `Temperature exceeded optimal range: ${s.temperature.toFixed(1)}°C`, 'alert');
            activeAlerts.temp = true;
            lastAlertTimes.temp = now;
        }
    } else if (activeAlerts.temp) {
        logSystemEvent('Temp Normal', `Temperature returned to optimal range: ${s.temperature.toFixed(1)}°C`, 'activity');
        activeAlerts.temp = false;
    }

    // Moisture
    const isMoistureOut = s.soilMoisturePercent < OPTIMAL_THRESHOLDS.moisture.min || s.soilMoisturePercent > OPTIMAL_THRESHOLDS.moisture.max;
    if (isMoistureOut) {
        if (!activeAlerts.moisture && (now - lastAlertTimes.moisture > ALERT_COOLDOWN)) {
            logSystemEvent('Moisture Alert', `Moisture out of optimal range: ${Math.round(s.soilMoisturePercent)}%`, 'alert');
            activeAlerts.moisture = true;
            lastAlertTimes.moisture = now;
        }
    } else if (activeAlerts.moisture) {
        logSystemEvent('Moisture Normal', `Moisture returned to optimal range: ${Math.round(s.soilMoisturePercent)}%`, 'activity');
        activeAlerts.moisture = false;
    }

    // Gas
    if (s.gasValue > OPTIMAL_THRESHOLDS.gas) {
        if (!activeAlerts.gas && (now - lastAlertTimes.gas > ALERT_COOLDOWN)) {
            logSystemEvent('Gas Alert', `Gas level exceeded optimal range: ${s.gasValue}`, 'alert');
            activeAlerts.gas = true;
            lastAlertTimes.gas = now;
        }
    } else if (activeAlerts.gas) {
        logSystemEvent('Gas Normal', `Gas level returned to optimal range: ${s.gasValue}`, 'activity');
        activeAlerts.gas = false;
    }
}

// Start monitoring
console.log("Starting background monitoring...");
db.ref('/').on('value', (snapshot) => {
    const data = snapshot.val();
    if (!data) return;

    const s = data.SensorData || { temperature: 0, soilMoisturePercent: 0, gasValue: 0 };
    const ctrl = data.Control || { mode: "AUTO", motor: false, pump: false, fan: false, startTime: 0 };
    const deviceStatus = data.DeviceStatus || { lastSeen: 0 };
    
    let rawLastSeen = deviceStatus.lastSeen || 0;
    // Handle seconds vs milliseconds (ESP32 often sends seconds)
    lastSeenTimestamp = rawLastSeen < 10000000000 ? rawLastSeen * 1000 : rawLastSeen;

    // Data received! Reset missed updates
    missedUpdates = 0;

    if (isInitialSync) {
        // Sync state without logging
        prevActuators = { motor: ctrl.motor, fan: ctrl.fan, pump: ctrl.pump };
        
        // Check alerts state
        const now = Date.now();
        if (s.temperature >= OPTIMAL_THRESHOLDS.temp) activeAlerts.temp = true;
        const isMoistureOut = s.soilMoisturePercent < OPTIMAL_THRESHOLDS.moisture.min || s.soilMoisturePercent > OPTIMAL_THRESHOLDS.moisture.max;
        if (isMoistureOut) activeAlerts.moisture = true;
        if (s.gasValue > OPTIMAL_THRESHOLDS.gas) activeAlerts.gas = true;
        
        if (ctrl.startTime > 0) {
            const elapsed = now - ctrl.startTime;
            const totalDuration = 28 * 24 * 60 * 60 * 1000;
            if ((elapsed / totalDuration) >= 1) lastLoggedProcessStartTime = ctrl.startTime;
        }

        isInitialSync = false;
        console.log("Initial sync complete. Monitoring active.");
        return;
    }

    checkSensorsAndActuators(s, ctrl);

    // 3. Check Hourly Logging
    const now = new Date();
    const hourKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}`;
    if (hourKey !== lastLoggedHourKey) {
        fs.collection("hourly_history").add({
            temperature: s.temperature,
            moisture: s.soilMoisturePercent,
            gasValue: s.gasValue,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        }).then(() => {
            console.log(`[LOG] Hourly history recorded: ${hourKey}`);
            lastLoggedHourKey = hourKey;
        }).catch(err => {
            console.error("Failed to log hourly history:", err);
        });
    }

    // 4. Check Process Completion
    if (ctrl.startTime > 0 && ctrl.startTime !== lastLoggedProcessStartTime) {
        const now = Date.now();
        const elapsed = now - ctrl.startTime;
        const totalDuration = 28 * 24 * 60 * 60 * 1000; // 28 days
        const percent = Math.min(100, (elapsed / totalDuration) * 100);

        if (percent >= 100) {
            logSystemEvent('Process Complete', 'Composting has reached 100% and finished successfully!', 'activity');
            lastLoggedProcessStartTime = ctrl.startTime;
        }
    }
});

// 4. Device Connection Heartbeat Check
setInterval(() => {
    missedUpdates++;
    const isActuallyOnline = missedUpdates < 5;

    if (deviceOnline && !isActuallyOnline) {
        logSystemEvent('Device Offline', 'The compost bin device has lost connection to the network.', 'alert');
        deviceOnline = false;
    } else if (!deviceOnline && isActuallyOnline) {
        logSystemEvent('Device Online', 'The compost bin device has reconnected to the network.', 'activity');
        deviceOnline = true;
    }
}, 10000); // Check every 10s

async function startServer() {
    const app = express();
    const PORT = 3000;

    // API routes
    app.get("/api/health", (req, res) => {
        res.json({ status: "ok" });
    });

    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
        try {
            const vite = await createViteServer({
                server: { middlewareMode: true },
                appType: "custom", // Changed from "spa" to "custom" for multi-page support
            });
            app.use(vite.middlewares);
            
            // Handle HTML files manually if needed, or let Vite handle them
            app.get(['/', '*.html'], async (req, res, next) => {
                const url = req.originalUrl || '/';
                try {
                    const template = await vite.transformIndexHtml(url, "");
                    res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
                } catch (e) {
                    vite.ssrFixStacktrace(e as Error);
                    next(e);
                }
            });
        } catch (err) {
            console.error("Failed to create Vite server:", err);
        }
    } else {
        const distPath = path.join(process.cwd(), 'dist');
        app.use(express.static(distPath));
        app.get('*', (req, res) => {
            res.sendFile(path.join(distPath, 'index.html'));
        });
    }

    app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

startServer();
