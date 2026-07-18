// Telemetry Dashboard logic

let socket = null;
let reconnectTimer = null;
const eventsList = document.getElementById('eventsList');
const connectionStatusIndicator = document.getElementById('connectionStatusIndicator');
const connectionStatusText = document.getElementById('connectionStatusText');
const backendLabel = document.getElementById('backendLabel');

// Waveform canvas setup
const canvas = document.getElementById('waveformCanvas');
const ctx = canvas.getContext('2d');
let animationFrameId = null;
let currentWaveform = new Array(128).fill(0);
let targetWaveform = new Array(128).fill(0);

// Resize canvas properly
function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Render loop for smooth waveform transition
function drawWaveform() {
    const width = canvas.width / window.devicePixelRatio;
    const height = canvas.height / window.devicePixelRatio;
    ctx.clearRect(0, 0, width, height);

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Interpolate waveform for smooth animation
    ctx.beginPath();
    ctx.strokeStyle = 'var(--accent-cyan)';
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 15;
    ctx.shadowColor = 'var(--accent-cyan)';

    const step = width / (currentWaveform.length - 1);
    for (let i = 0; i < currentWaveform.length; i++) {
        // Linear interpolation towards target
        currentWaveform[i] += (targetWaveform[i] - currentWaveform[i]) * 0.15;
        
        // Scale and center the value (assuming normal accel peak ±2g)
        const val = currentWaveform[i];
        const y = (height / 2) - (val * (height / 4.5));
        const x = i * step;

        if (i === 0) {
            ctx.moveTo(x, y);
        } else {
            ctx.lineTo(x, y);
        }
    }
    ctx.stroke();
    ctx.shadowBlur = 0; // reset

    // Decay the target back to ambient noise over time
    for (let i = 0; i < targetWaveform.length; i++) {
        // Normal road vibration simulation
        const ambientNoise = (Math.sin(Date.now() * 0.01 + i * 0.2) * 0.05) + (Math.random() - 0.5) * 0.02;
        targetWaveform[i] += (ambientNoise - targetWaveform[i]) * 0.02;
    }

    animationFrameId = requestAnimationFrame(drawWaveform);
}
drawWaveform();

// Connect WebSocket
function connect() {
    clearTimeout(reconnectTimer);
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws/dashboard`;
    
    connectionStatusIndicator.className = 'status-indicator connecting';
    connectionStatusText.textContent = 'CONNECTING TO PIPELINE...';
    
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        connectionStatusIndicator.className = 'status-indicator online';
        connectionStatusText.textContent = 'PIPELINE LOGGING ACTIVE';
        setHopStatus('hop3', 'active online-status', 'Online (CPU/NPU)');
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handlePipelineEvent(data);
        } catch (e) {
            console.error('Error parsing event payload', e);
        }
    };

    socket.onclose = () => {
        connectionStatusIndicator.className = 'status-indicator';
        connectionStatusText.textContent = 'PIPELINE DISCONNECTED';
        setHopStatus('hop3', '', 'Offline');
        setHopStatus('hop1', '', 'Awaiting Trigger');
        setHopStatus('hop2', '', 'Listening...');
        setHopStatus('hop4', '', 'Idle');
        setHopStatus('hop5', '', 'Offline');
        // Retry
        reconnectTimer = setTimeout(connect, 3000);
    };
}

function setHopStatus(hopId, classes, label) {
    const el = document.getElementById(hopId);
    if (!el) return;
    el.className = `hop-node ${classes}`;
    const badge = el.querySelector('.badge');
    if (badge) badge.textContent = label;
}

function pulseHop(hopId) {
    const el = document.getElementById(hopId);
    if (!el) return;
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 800);
}

function handlePipelineEvent(data) {
    if (data.kind === 'hop') {
        const hop = data.hop;
        const label = data.label || '';
        
        if (hop === 2) {
            setHopStatus('hop1', 'active', 'Peak Triggered');
            pulseHop('hop1');
            setHopStatus('hop2', 'active', label);
            pulseHop('hop2');
            document.getElementById('connector-1-2').classList.add('active');
        } else if (hop === 3) {
            setHopStatus('hop3', 'active online-status', `Inferred: ${label}`);
            pulseHop('hop3');
            document.getElementById('connector-2-3').classList.add('active');
            if (data.backend) backendLabel.textContent = `Backend: ${data.backend.toUpperCase()}`;
            if (data.waveform) {
                targetWaveform = [...data.waveform];
            }
        } else if (hop === 4) {
            const isOffline = data.offline || false;
            if (isOffline) {
                setHopStatus('hop4', 'active', 'Offline — Queued');
            } else {
                setHopStatus('hop4', 'active online-status', label);
                pulseHop('hop4');
            }
            document.getElementById('connector-3-4').classList.add('active');
        }
    } else if (data.kind === 'event') {
        // Event classified successfully
        addEventToList(data);
        
        // Temporarily light up Hop 5 to show delivery to frontend
        setHopStatus('hop5', 'active online-status', 'Map Pin Placed');
        pulseHop('hop5');
        document.getElementById('connector-4-5').classList.add('active');
        setTimeout(() => {
            setHopStatus('hop5', '', 'Offline');
            document.getElementById('connector-4-5').classList.remove('active');
        }, 3000);
    }
}

function addEventToList(evt) {
    // Remove empty placeholder row if present
    const emptyRow = eventsList.querySelector('.empty-row');
    if (emptyRow) emptyRow.remove();

    const tr = document.createElement('tr');
    
    const timeStr = new Date(evt.ts * 1000).toLocaleTimeString();
    const severityVal = parseFloat(evt.severity).toFixed(1);
    const sevPercent = Math.min(100, Math.max(0, evt.severity * 10));
    
    // Determine severity fill color
    let barColor = 'var(--accent-emerald)';
    if (evt.severity > 7) barColor = 'var(--accent-rose)';
    else if (evt.severity > 4) barColor = 'var(--accent-amber)';

    tr.innerHTML = `
        <td class="mono">${timeStr}</td>
        <td><span class="class-badge ${evt.road_class}">${evt.road_class.replace('_', ' ')}</span></td>
        <td>
            <div class="sev-bar-bg">
                <div class="sev-bar-fill" style="width: ${sevPercent}%; background: ${barColor};"></div>
            </div>
            <span class="mono">${severityVal}</span>
        </td>
        <td class="mono">${evt.device_id}</td>
        <td class="mono" style="font-size: 0.75rem">${parseFloat(evt.lat).toFixed(4)}, ${parseFloat(evt.lng).toFixed(4)}</td>
        <td class="mono">${evt.glass_ms ? `${evt.glass_ms}ms` : '-'}</td>
    `;

    eventsList.insertBefore(tr, eventsList.firstChild);

    // Keep only last 10 events
    while (eventsList.children.length > 10) {
        eventsList.lastChild.remove();
    }
}

// Initialize connection
connect();
