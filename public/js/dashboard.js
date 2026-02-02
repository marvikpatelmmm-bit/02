// --- STATE ---
let activeTaskId = null;
let activeTaskStartTime = null;
let activeTaskAccumulated = 0;
let activeTaskDuration = 0; // minutes
let timerInterval = null;
let currentUser = null;
let showGlobalTasks = false;

// --- INIT ---
document.addEventListener('DOMContentLoaded', async () => {
    await checkAuth();
    loadTasks();
    initSSE();
    loadLeaderboard();
});

async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        if (res.status === 401) window.location.href = '/';
        currentUser = await res.json();
        document.getElementById('userGreeting').textContent = `Hi, ${currentUser.name}`;
    } catch (e) {
        window.location.href = '/';
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
});

function toggleTaskView() {
    showGlobalTasks = document.getElementById('globalTaskToggle').checked;
    const planBtn = document.getElementById('planBtn');
    if (showGlobalTasks) {
        planBtn.style.display = 'none';
    } else {
        planBtn.style.display = 'block';
    }
    loadTasks();
}

// --- TASKS ---
async function loadTasks() {
    const endpoint = showGlobalTasks ? '/api/tasks/today?all=true' : '/api/tasks/today';
    const res = await fetch(endpoint);
    const tasks = await res.json();
    const list = document.getElementById('taskList');
    list.innerHTML = '';

    let hasActiveForMe = false;

    if (tasks.length === 0) {
        list.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 20px;">No tasks found.</div>`;
        return;
    }

    tasks.forEach(task => {
        const isMyTask = task.user_id === currentUser.id;
        
        if (isMyTask && task.status === 'in_progress') {
            setupActiveTask(task);
            hasActiveForMe = true;
        }

        const div = document.createElement('div');
        div.className = `task-card ${task.subject ? task.subject.toLowerCase() : ''} ${task.status}`;
        
        // Logic for Action Button
        let actionBtn = '';
        if (isMyTask) {
            if (task.status === 'pending' || task.status === 'paused') {
                actionBtn = `<button class="btn btn-primary" style="font-size:0.8rem; padding:5px 10px;" onclick="startTask(${task.id})">${task.status === 'paused' ? 'Resume' : 'Start'}</button>`;
            } else if (task.status === 'in_progress') {
                actionBtn = `<button class="btn btn-warning" style="font-size:0.8rem; padding:5px 10px;" onclick="pauseTask()">Pause</button>`;
            } else if (task.status.includes('completed')) {
                const totalMins = task.actual_minutes || 0;
                actionBtn = `<span style="font-size: 0.8rem">Done (${totalMins}m)</span>`;
            }
        } else {
            // Viewing other's task
            actionBtn = `<span style="font-size: 0.75rem; color: var(--text-muted);">${task.user_name}</span>`;
        }

        const subjectLabel = task.subject || 'General';
        
        div.innerHTML = `
            <div class="task-info">
                <span style="font-size: 0.7rem; text-transform: uppercase; color: var(--text-muted);">${subjectLabel}</span>
                <h4>${task.task_name}</h4>
                <div class="task-meta">Est: ${task.estimated_minutes} mins ${task.status === 'paused' ? '(Paused)' : ''}</div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:5px;">
                ${actionBtn}
            </div>
        `;
        list.appendChild(div);
    });

    if (!hasActiveForMe) clearActiveTaskUI();
}

// --- TIMER LOGIC ---
function setupActiveTask(task) {
    activeTaskId = task.id;
    activeTaskStartTime = new Date(task.started_at);
    activeTaskDuration = task.estimated_minutes;
    activeTaskAccumulated = task.accumulated_minutes || 0;

    document.getElementById('noActiveTask').style.display = 'none';
    document.getElementById('activeTaskDisplay').style.display = 'block';
    document.getElementById('currentSubject').textContent = task.subject;
    document.getElementById('currentTaskName').textContent = task.task_name;

    if (timerInterval) clearInterval(timerInterval);
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
    if (!activeTaskStartTime) return;
    const now = new Date();
    const diffMs = now - activeTaskStartTime;
    const sessionSeconds = Math.floor(diffMs / 1000);
    
    // Total elapsed = Accumulated + Current Session
    const totalSeconds = (activeTaskAccumulated * 60) + sessionSeconds;
    
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    document.getElementById('timer').textContent = 
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    // Progress bar
    const totalEstSeconds = activeTaskDuration * 60;
    const pct = Math.min((totalSeconds / totalEstSeconds) * 100, 100);
    document.getElementById('timerProgress').style.width = `${pct}%`;
    
    if (minutes > activeTaskDuration) {
        document.getElementById('timer').style.color = 'var(--error-red)';
    } else {
        document.getElementById('timer').style.color = 'var(--accent-blue)';
    }
}

function clearActiveTaskUI() {
    activeTaskId = null;
    activeTaskStartTime = null;
    if (timerInterval) clearInterval(timerInterval);
    document.getElementById('noActiveTask').style.display = 'block';
    document.getElementById('activeTaskDisplay').style.display = 'none';
}

async function startTask(id) {
    // Backend handles stopping current task automatically now
    await fetch(`/api/tasks/${id}/start`, { method: 'POST' });
    loadTasks(); 
}

async function pauseTask() {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/pause`, { method: 'POST' });
    loadTasks();
}

async function completeTask() {
    if (!activeTaskId) return;
    await fetch(`/api/tasks/${activeTaskId}/complete`, { method: 'POST' });
    loadTasks();
}

// --- PLANNING MODAL ---
function openPlanModal() {
    document.getElementById('planModal').classList.add('show');
    const container = document.getElementById('planRows');
    if (container.children.length === 0) addPlanRow();
}

function addPlanRow() {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.innerHTML = `
        <input type="text" placeholder="Task Name" class="p-name">
        <select class="p-subject">
            <option value="Maths">Maths</option>
            <option value="Physics">Physics</option>
            <option value="Chemistry">Chemistry</option>
        </select>
        <input type="number" placeholder="Mins" class="p-time" value="60">
        <button class="remove-row" onclick="this.parentElement.remove()">×</button>
    `;
    document.getElementById('planRows').appendChild(row);
}

async function savePlan() {
    const rows = document.querySelectorAll('.task-row');
    const tasks = [];
    rows.forEach(row => {
        const name = row.querySelector('.p-name').value;
        const subject = row.querySelector('.p-subject').value;
        const mins = row.querySelector('.p-time').value;
        if (name && mins) {
            tasks.push({ task_name: name, subject: subject, estimated_minutes: mins });
        }
    });

    await fetch('/api/tasks/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks })
    });
    
    closeModal('planModal');
    loadTasks();
}

// --- END DAY ---
function openEndDayModal() {
    document.getElementById('endDayModal').classList.add('show');
}

async function submitSummary() {
    const data = {
        maths: document.getElementById('sumMath').value || 0,
        physics: document.getElementById('sumPhy').value || 0,
        chemistry: document.getElementById('sumChem').value || 0,
        topics: document.getElementById('sumTopics').value,
        hours: document.getElementById('sumHours').value || 0,
        notes: document.getElementById('sumNotes').value,
        rating: document.getElementById('sumRating').value
    };

    const res = await fetch('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    if (res.ok) {
        alert('Good job today! Get some rest.');
        closeModal('endDayModal');
    } else {
        alert('Error saving summary.');
    }
}

function closeModal(id) {
    document.getElementById(id).classList.remove('show');
}

// --- REALTIME (SSE) ---
function initSSE() {
    const evtSource = new EventSource('/api/stream');
    evtSource.onmessage = (event) => {
        const users = JSON.parse(event.data);
        renderFeed(users);
    };
}

function renderFeed(users) {
    const container = document.getElementById('liveFeed');
    container.innerHTML = '';
    
    users.forEach(user => {
        const div = document.createElement('div');
        const isActive = !!user.task_name;
        
        div.className = `user-card ${isActive ? 'active-user' : ''}`;
        
        let statusHtml = '';
        if (isActive) {
            // Calculate progress for feed
            const startedAt = new Date(user.started_at);
            const now = new Date();
            const sessionMins = Math.max(0, (now - startedAt) / 60000);
            const totalMins = (user.accumulated_minutes || 0) + sessionMins;
            const estMins = user.estimated_minutes;
            const pct = Math.min((totalMins / estMins) * 100, 100);
            
            statusHtml = `
                <div>
                    <div style="font-weight: bold; color: var(--accent-blue)">${user.task_name}</div>
                    <div style="font-size: 0.8rem; margin-bottom: 4px;">${user.subject}</div>
                    
                    <div class="feed-progress-bg">
                        <div class="feed-progress-fill" style="width: ${pct}%"></div>
                    </div>
                    <div style="font-size: 0.75rem; text-align: right; color: var(--text-secondary);">
                        ${Math.round(totalMins)}/${estMins} min
                    </div>
                </div>
            `;
        } else {
            statusHtml = `<div style="color: var(--text-muted); font-style: italic;">Taking a break</div>`;
        }

        div.innerHTML = `
            <div class="status-dot" style="background: ${isActive ? 'var(--success-green)' : '#555'}"></div>
            <div style="flex-grow: 1;">
                <div style="display:flex; justify-content:space-between; margin-bottom: 5px;">
                    <strong>${user.name}</strong>
                    <span style="font-size: 0.7rem; background: rgba(255,255,255,0.1); padding: 2px 5px; border-radius: 4px;">✅ ${user.completed_today}</span>
                </div>
                ${statusHtml}
            </div>
        `;
        container.appendChild(div);
    });
}

// --- LEADERBOARD ---
async function loadLeaderboard() {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const list = document.getElementById('leaderboardList');
    list.innerHTML = '';
    
    data.slice(0, 5).forEach((u, i) => {
        const div = document.createElement('div');
        div.style.padding = '8px 0';
        div.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; font-size: 0.9rem;">
                <span>#${i+1} <strong>${u.name}</strong></span>
                <span>🔥 ${u.current_streak}</span>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-secondary);">
                ${u.total_tasks} Tasks (${u.ontime_tasks} On-time)
            </div>
        `;
        list.appendChild(div);
    });
}

function showLeaderboard() {
    alert("Full Leaderboard Page coming in V2! Check the sidebar for top stats.");
}