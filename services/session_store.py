import sqlite3
import json
import time
import os

DB_PATH = "/root/agent-hub/data/sessions.db"

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT,
            agent TEXT,
            workspace TEXT,
            created_at REAL,
            updated_at REAL
        )
    """)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            role TEXT,
            content TEXT,
            agent TEXT,
            timestamp REAL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
    """)
    cols = [r[1] for r in cursor.execute("PRAGMA table_info(messages)")]
    if "model" not in cols:
        cursor.execute("ALTER TABLE messages ADD COLUMN model TEXT")
    if "tokens" not in cols:
        cursor.execute("ALTER TABLE messages ADD COLUMN tokens INTEGER")
    conn.commit()
    conn.close()

def list_sessions():
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, title, agent, workspace, created_at, updated_at FROM sessions ORDER BY updated_at DESC")
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            "id": r[0],
            "title": r[1],
            "agent": r[2],
            "workspace": r[3],
            "created_at": r[4],
            "updated_at": r[5]
        }
        for r in rows
    ]

def get_session(session_id: str):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT id, title, agent, workspace, created_at, updated_at FROM sessions WHERE id = ?", (session_id,))
    session_row = cursor.fetchone()
    if not session_row:
        conn.close()
        return None
    cursor.execute("SELECT role, content, agent, timestamp, model, tokens FROM messages WHERE session_id = ? ORDER BY id ASC", (session_id,))
    msg_rows = cursor.fetchall()
    conn.close()
    return {
        "id": session_row[0],
        "title": session_row[1],
        "agent": session_row[2],
        "workspace": session_row[3],
        "created_at": session_row[4],
        "updated_at": session_row[5],
        "messages": [
            {
                "role": m[0],
                "content": m[1],
                "agent": m[2],
                "timestamp": m[3],
                "model": m[4],
                "tokens": m[5]
            }
            for m in msg_rows
        ]
    }

def create_session(session_id: str, title: str, agent: str, workspace: str):
    init_db()
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO sessions (id, title, agent, workspace, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (session_id, title, agent, workspace, now, now)
    )
    conn.commit()
    conn.close()

def add_message(session_id: str, role: str, content: str, agent: str, model: str = None, tokens: int = None):
    init_db()
    now = time.time()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO messages (session_id, role, content, agent, timestamp, model, tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (session_id, role, content, agent, now, model, tokens)
    )
    cursor.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id))
    conn.commit()
    conn.close()

def update_session_title(session_id: str, title: str):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, session_id))
    conn.commit()
    conn.close()

def delete_session(session_id: str):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
    cursor.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    conn.commit()
    conn.close()

def get_usage_metrics(five_hour_budget: int = 200000, weekly_budget: int = 1500000, agent: str = None) -> dict:
    """
    Computes rolling 5-hour, 24-hour, and 7-day usage statistics, remaining quota,
    estimated window reset countdowns, and per-agent token breakdowns.
    Optionally filters by a specific agent (e.g. 'claude', 'antigravity', 'codex').
    """
    init_db()
    now = time.time()
    five_h_ago = now - (5 * 3600)
    one_d_ago = now - 86400
    seven_d_ago = now - (7 * 86400)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    agent_filter = agent.lower().strip() if agent and agent.lower().strip() != "all" else None

    # 1. Rolling 5-Hour Window
    if agent_filter:
        cursor.execute(
            "SELECT count(*), coalesce(sum(tokens), 0), min(timestamp) FROM messages WHERE timestamp >= ? AND agent = ?",
            (five_h_ago, agent_filter)
        )
    else:
        cursor.execute(
            "SELECT count(*), coalesce(sum(tokens), 0), min(timestamp) FROM messages WHERE timestamp >= ?",
            (five_h_ago,)
        )
    r5 = cursor.fetchone()
    msgs_5h = r5[0] or 0
    tokens_5h = r5[1] or 0
    oldest_5h_ts = r5[2]

    next_reset_sec = 0
    if oldest_5h_ts and msgs_5h > 0:
        next_reset_sec = max(0, int((oldest_5h_ts + 5 * 3600) - now))

    # Format reset time
    if next_reset_sec > 0:
        rh = next_reset_sec // 3600
        rm = (next_reset_sec % 3600) // 60
        next_reset_fmt = f"{rh}h {rm}m" if rh > 0 else f"{rm}m"
    else:
        next_reset_fmt = "Idle"

    # 5h breakdown by agent
    cursor.execute(
        "SELECT coalesce(agent, 'other'), count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ? GROUP BY agent",
        (five_h_ago,)
    )
    agent_5h = {row[0]: {"messages": row[1], "tokens": row[2]} for row in cursor.fetchall()}

    # 2. Rolling 24-Hour Window
    if agent_filter:
        cursor.execute(
            "SELECT count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ? AND agent = ?",
            (one_d_ago, agent_filter)
        )
    else:
        cursor.execute(
            "SELECT count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ?",
            (one_d_ago,)
        )
    r24 = cursor.fetchone()
    msgs_24h = r24[0] or 0
    tokens_24h = r24[1] or 0

    # 3. Rolling 7-Day Window
    if agent_filter:
        cursor.execute(
            "SELECT count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ? AND agent = ?",
            (seven_d_ago, agent_filter)
        )
    else:
        cursor.execute(
            "SELECT count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ?",
            (seven_d_ago,)
        )
    r7d = cursor.fetchone()
    msgs_7d = r7d[0] or 0
    tokens_7d = r7d[1] or 0

    # 7d breakdown by agent
    cursor.execute(
        "SELECT coalesce(agent, 'other'), count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ? GROUP BY agent",
        (seven_d_ago,)
    )
    agent_7d = {row[0]: {"messages": row[1], "tokens": row[2]} for row in cursor.fetchall()}

    # 7d daily series
    if agent_filter:
        cursor.execute(
            "SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch'), count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ? AND agent = ? GROUP BY strftime('%Y-%m-%d', timestamp, 'unixepoch') ORDER BY 1 ASC",
            (seven_d_ago, agent_filter)
        )
    else:
        cursor.execute(
            "SELECT strftime('%Y-%m-%d', timestamp, 'unixepoch'), count(*), coalesce(sum(tokens), 0) FROM messages WHERE timestamp >= ? GROUP BY strftime('%Y-%m-%d', timestamp, 'unixepoch') ORDER BY 1 ASC",
            (seven_d_ago,)
        )
    db_daily = {row[0]: {"messages": row[1], "tokens": row[2]} for row in cursor.fetchall()}

    # Fill full 7 calendar days
    import datetime
    daily_series = []
    for i in range(6, -1, -1):
        d_str = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=i)).strftime('%Y-%m-%d')
        day_data = db_daily.get(d_str, {"messages": 0, "tokens": 0})
        weekday_label = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=i)).strftime('%a')
        daily_series.append({
            "date": d_str,
            "day": weekday_label,
            "messages": day_data["messages"],
            "tokens": day_data["tokens"]
        })

    # 4. Lifetime Totals
    if agent_filter:
        cursor.execute("SELECT count(*), coalesce(sum(tokens), 0) FROM messages WHERE agent = ?", (agent_filter,))
    else:
        cursor.execute("SELECT count(*), coalesce(sum(tokens), 0) FROM messages")
    rtot = cursor.fetchone()
    cursor.execute("SELECT count(*) FROM sessions")
    rsess = cursor.fetchone()
    conn.close()

    total_tokens = rtot[1] or 0
    total_msgs = rtot[0] or 0
    total_sessions = rsess[0] or 0

    tokens_remaining_5h = max(0, five_hour_budget - tokens_5h)
    pct_5h = round((tokens_5h / five_hour_budget) * 100, 1) if five_hour_budget > 0 else 0.0

    tokens_remaining_7d = max(0, weekly_budget - tokens_7d)
    pct_7d = round((tokens_7d / weekly_budget) * 100, 1) if weekly_budget > 0 else 0.0

    return {
        "agent": agent_filter or "all",
        "window_5h": {
            "tokens_used": tokens_5h,
            "tokens_budget": five_hour_budget,
            "tokens_remaining": tokens_remaining_5h,
            "percent_used": pct_5h,
            "messages_count": msgs_5h,
            "next_reset_seconds": next_reset_sec,
            "next_reset_formatted": next_reset_fmt,
            "by_agent": agent_5h,
            "status": "exceeded" if pct_5h >= 100 else "heavy" if pct_5h >= 80 else "moderate" if pct_5h >= 50 else "healthy"
        },
        "window_24h": {
            "tokens_used": tokens_24h,
            "messages_count": msgs_24h
        },
        "window_7d": {
            "tokens_used": tokens_7d,
            "tokens_budget": weekly_budget,
            "tokens_remaining": tokens_remaining_7d,
            "percent_used": pct_7d,
            "messages_count": msgs_7d,
            "by_agent": agent_7d,
            "daily": daily_series,
            "status": "exceeded" if pct_7d >= 100 else "heavy" if pct_7d >= 80 else "moderate" if pct_7d >= 50 else "healthy"
        },
        "lifetime": {
            "total_tokens": total_tokens,
            "total_messages": total_msgs,
            "total_sessions": total_sessions
        },
        "timestamp": now
    }
