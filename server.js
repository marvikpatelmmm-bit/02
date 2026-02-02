const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database Setup
const DB_PATH = './jee_study.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        // Users
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            current_streak INTEGER DEFAULT 0
        )`);

        // Tasks
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            task_name TEXT NOT NULL,
            subject TEXT,
            estimated_minutes INTEGER NOT NULL,
            actual_minutes INTEGER,
            status TEXT DEFAULT 'pending',
            started_at DATETIME,
            completed_at DATETIME,
            task_date DATE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )`);

        // Daily Summaries
        db.run(`CREATE TABLE IF NOT EXISTS daily_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            summary_date DATE NOT NULL,
            maths_problems INTEGER DEFAULT 0,
            physics_problems INTEGER DEFAULT 0,
            chemistry_problems INTEGER DEFAULT 0,
            topics_covered TEXT,
            total_study_hours REAL DEFAULT 0,
            notes TEXT,
            self_rating INTEGER,
            ended_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            UNIQUE(user_id, summary_date)
        )`);

        // Active Sessions (For Real-time)
        db.run(`CREATE TABLE IF NOT EXISTS active_sessions (
            user_id INTEGER PRIMARY KEY,
            active_task_id INTEGER,
            last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id),
            FOREIGN KEY (active_task_id) REFERENCES tasks(id)
        )`);
    });
}

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'jee-secret-key-prod-123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// Auth Middleware
function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    next();
}

// --- API ROUTES ---

// Auth
app.post('/api/register', async (req, res) => {
    const { username, password, name } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password, name) VALUES (?, ?, ?)`, 
            [username, hashedPassword, name], 
            function(err) {
                if (err) return res.status(400).json({ error: 'Username already exists' });
                req.session.userId = this.lastID;
                req.session.name = name;
                res.json({ success: true, user: { id: this.lastID, name } });
            }
        );
    } catch (e) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            req.session.userId = user.id;
            req.session.name = user.name;
            res.json({ success: true, user: { id: user.id, name: user.name } });
        } else {
            res.status(400).json({ error: 'Invalid password' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ id: req.session.userId, name: req.session.name });
});

// Tasks
app.get('/api/tasks/today', requireAuth, (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    db.all(`SELECT * FROM tasks WHERE user_id = ? AND task_date = ? ORDER BY status DESC, created_at ASC`, 
        [req.session.userId, today], 
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

app.post('/api/tasks/batch', requireAuth, (req, res) => {
    const { tasks } = req.body; // Array of {task_name, subject, estimated_minutes}
    const today = new Date().toISOString().split('T')[0];
    const userId = req.session.userId;
    
    const stmt = db.prepare(`INSERT INTO tasks (user_id, task_name, subject, estimated_minutes, task_date) VALUES (?, ?, ?, ?, ?)`);
    
    db.serialize(() => {
        tasks.forEach(task => {
            stmt.run(userId, task.task_name, task.subject, task.estimated_minutes, today);
        });
        stmt.finalize();
        res.json({ success: true });
    });
});

app.post('/api/tasks/:id/start', requireAuth, (req, res) => {
    const taskId = req.params.id;
    const userId = req.session.userId;
    const now = new Date().toISOString();

    db.serialize(() => {
        // Stop any other active session for this user
        db.run(`DELETE FROM active_sessions WHERE user_id = ?`, [userId]);
        
        // Start task
        db.run(`UPDATE tasks SET status = 'in_progress', started_at = ? WHERE id = ? AND user_id = ?`, 
            [now, taskId, userId], 
            function(err) {
                if (err) return res.status(500).json({ error: err.message });
                
                // Create active session
                db.run(`INSERT INTO active_sessions (user_id, active_task_id, last_seen) VALUES (?, ?, ?)`,
                    [userId, taskId, now],
                    (err) => {
                        if (err) return res.status(500).json({ error: err.message });
                        res.json({ success: true, started_at: now });
                    }
                );
            }
        );
    });
});

app.post('/api/tasks/:id/complete', requireAuth, (req, res) => {
    const taskId = req.params.id;
    const userId = req.session.userId;
    const now = new Date().toISOString();

    db.get(`SELECT started_at, estimated_minutes FROM tasks WHERE id = ?`, [taskId], (err, task) => {
        if (err || !task) return res.status(404).json({ error: 'Task not found' });

        const startTime = new Date(task.started_at);
        const endTime = new Date();
        const actualMinutes = Math.round((endTime - startTime) / 60000);
        
        // Determine status (grace period of 5 mins)
        const status = actualMinutes <= (task.estimated_minutes + 5) ? 'completed_ontime' : 'completed_delayed';

        db.serialize(() => {
            db.run(`DELETE FROM active_sessions WHERE user_id = ?`, [userId]);
            db.run(`UPDATE tasks SET status = ?, completed_at = ?, actual_minutes = ? WHERE id = ?`, 
                [status, now, actualMinutes, taskId],
                (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, status, actualMinutes });
                }
            );
        });
    });
});

app.post('/api/summary', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const today = new Date().toISOString().split('T')[0];
    const data = req.body;

    db.run(`INSERT INTO daily_summaries 
        (user_id, summary_date, maths_problems, physics_problems, chemistry_problems, topics_covered, total_study_hours, notes, self_rating)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, today, data.maths, data.physics, data.chemistry, data.topics, data.hours, data.notes, data.rating],
        function(err) {
            if (err) return res.status(500).json({ error: 'Summary already submitted for today' });
            
            // Update streak (simplified logic)
            db.run(`UPDATE users SET current_streak = current_streak + 1 WHERE id = ?`, [userId]);
            res.json({ success: true });
        }
    );
});

// Stats & Leaderboard
app.get('/api/leaderboard', requireAuth, (req, res) => {
    const query = `
        SELECT 
            u.name, 
            u.current_streak,
            COUNT(t.id) as total_tasks,
            SUM(CASE WHEN t.status = 'completed_ontime' THEN 1 ELSE 0 END) as ontime_tasks,
            ROUND(AVG(ds.total_study_hours), 1) as avg_hours
        FROM users u
        LEFT JOIN tasks t ON u.id = t.user_id AND t.status IN ('completed_ontime', 'completed_delayed')
        LEFT JOIN daily_summaries ds ON u.id = ds.user_id
        GROUP BY u.id
        ORDER BY total_tasks DESC
    `;
    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// SSE Stream
app.get('/api/stream', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendUpdate = () => {
        const query = `
            SELECT 
                u.id, u.name, 
                t.task_name, t.subject, t.started_at, t.estimated_minutes,
                (SELECT COUNT(*) FROM tasks WHERE user_id = u.id AND status LIKE 'completed%' AND task_date = DATE('now')) as completed_today
            FROM users u
            LEFT JOIN active_sessions as_sess ON u.id = as_sess.user_id
            LEFT JOIN tasks t ON as_sess.active_task_id = t.id
        `;
        
        db.all(query, [], (err, rows) => {
            if (!err) {
                res.write(`data: ${JSON.stringify(rows)}\n\n`);
            }
        });
    };

    // Send immediately
    sendUpdate();

    // Send every 5 seconds
    const interval = setInterval(sendUpdate, 5000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

// Serve Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});