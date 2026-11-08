const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1); // behind Render's proxy: req.ip = real client IP (needed for rate limiting)
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apiKey = process.env.GROQ_API_KEY;

// ==================================================
// Web Push (VAPID) — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars on Render.
// ==================================================
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:hamma@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
    console.warn("⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are missing! Push notifications will not work.");
}

// ==================================================
// Firebase Admin SDK initialization
// FIREBASE_SERVICE_ACCOUNT must be the full service account JSON (as one string) in env vars
// ==================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT is missing! Admin actions will fail.");
} else {
    admin.initializeApp({
        credential: admin.credential.cert(
            JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        )
    });
}

const db = admin.apps.length ? admin.firestore() : null;

// ==================================================
// Email verification (6-digit codes)
// Requires SMTP env vars: EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS
// (e.g. a Gmail App Password, or a service like Resend/Brevo/Mailgun SMTP)
// ==================================================
let mailer = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    mailer = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: Number(process.env.EMAIL_PORT) || 587,
        secure: Number(process.env.EMAIL_PORT) === 465,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });
} else {
    console.warn("⚠️ Email SMTP env vars are missing! Verification emails will not be sent.");
}

const verificationCodes = new Map(); // email -> { code, expiresAt }

function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post('/api/send-verification-code', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!mailer) return res.status(500).json({ success: false, message: 'Email service is not configured on the server.' });

    const code = generateCode();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes
    verificationCodes.set(email, { code, expiresAt });

    try {
        await mailer.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
            to: email,
            subject: 'Your Hamma Chat verification code',
            text: `Your verification code is: ${code}\nIt expires in 10 minutes.`,
            html: `<p>Your verification code is:</p><h2 style="letter-spacing:6px;">${code}</h2><p>It expires in 10 minutes.</p>`
        });
        res.json({ success: true });
    } catch (e) {
        console.error("Failed to send verification email:", e.message);
        res.status(500).json({ success: false, message: 'Failed to send verification email.' });
    }
});

app.post('/api/verify-code', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, message: 'Email and code are required.' });

    const entry = verificationCodes.get(email);
    if (!entry) return res.status(400).json({ success: false, message: 'No code was sent to this email, or it already expired.' });
    if (Date.now() > entry.expiresAt) {
        verificationCodes.delete(email);
        return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' });
    }
    if (entry.code !== String(code).trim()) {
        return res.status(400).json({ success: false, message: 'Incorrect code.' });
    }

    verificationCodes.delete(email);

    // Mark the Firebase account as verified, if it exists
    try {
        if (db) {
            const userRecord = await admin.auth().getUserByEmail(email);
            await admin.auth().updateUser(userRecord.uid, { emailVerified: true });
        }
    } catch (e) {
        console.warn("Could not mark Firebase user as verified:", e.message);
    }

    res.json({ success: true });
});

// ==================================================
// Verifies a Firebase ID token and returns the caller's effective role.
// role is one of: "admin", "moderator", or null (regular user / invalid token)
// The owner accounts are always treated as "admin".
// ==================================================
const OWNER_NAMES = ["hamma", "hamma admin", "othmani hiba"];
// Owners are identified by Firebase UID (a display name can be copied, a UID can't).
// Set OWNER_UIDS on Render as a comma-separated list. Until it's set, the old
// name-based check stays active as a fallback so nobody gets locked out.
const OWNER_UIDS = (process.env.OWNER_UIDS || '').split(',').map(x => x.trim()).filter(Boolean);
if (!OWNER_UIDS.length) console.warn("⚠️ OWNER_UIDS is not set — falling back to name-based owner check (spoofable). Set OWNER_UIDS in your environment.");
function isOwnerIdentity(uid, name) {
    if (OWNER_UIDS.length) return OWNER_UIDS.includes(uid);
    return !!name && OWNER_NAMES.includes(String(name).toLowerCase());
}

async function verifyRole(idToken) {
    if (!idToken || !db) return { ok: false, role: null };
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        const userDoc = await db.collection('users').doc(decoded.uid).get();
        const dbRole = userDoc.exists ? userDoc.data().role : null;
        const isOwner = isOwnerIdentity(decoded.uid, decoded.name);

        let role = null;
        if (isOwner || dbRole === "admin") role = "admin";
        else if (dbRole === "moderator") role = "moderator";

        return { ok: role !== null, role, uid: decoded.uid, name: decoded.name, isOwner };
    } catch (e) {
        console.error("Token verification failed:", e.message);
        return { ok: false, role: null };
    }
}

// Backwards-compatible helper: true if the caller is admin OR moderator
async function verifyAdmin(idToken) {
    const { ok, role, uid, name } = await verifyRole(idToken);
    return { ok, role, uid, name };
}

// Verifies a Firebase ID token for ANY logged-in user (no role required) —
// used by the friend-request system, which guests can't take part in
// since it needs a persistent account.
async function verifyUser(idToken) {
    if (!idToken || !db) return { ok: false };
    try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        if (!decoded.name) return { ok: false };
        return { ok: true, uid: decoded.uid, name: decoded.name };
    } catch (e) {
        return { ok: false };
    }
}

// Exact-match lookup (by username or displayName) — used for both role
// checks and the friend-search feature.
async function findUserByUsername(username) {
    if (!username || !db) return null;
    try {
        let snap = await db.collection('users').where('username', '==', username).limit(1).get();
        if (snap.empty) snap = await db.collection('users').where('displayName', '==', username).limit(1).get();
        if (snap.empty) return null;
        const data = snap.docs[0].data();
        return { uid: snap.docs[0].id, username: data.username || data.displayName, lastSeen: data.lastSeen || null };
    } catch (e) {
        console.error("User lookup failed:", e.message);
        return null;
    }
}

// Sends a web push notification to a username's saved subscription (if any).
// Silently does nothing if push isn't configured or the user never subscribed.
async function sendPushToUser(username, payload) {
    if (!db || !VAPID_PUBLIC_KEY) return;
    try {
        let snap = await db.collection('users').where('username', '==', username).limit(1).get();
        if (snap.empty) snap = await db.collection('users').where('displayName', '==', username).limit(1).get();
        if (snap.empty) return;
        const sub = snap.docs[0].data().pushSubscription;
        if (!sub) return;
        await webpush.sendNotification(sub, JSON.stringify(payload)).catch(err => {
            if (err.statusCode === 410 || err.statusCode === 404) {
                // Subscription expired or was revoked by the browser — clean it up
                snap.docs[0].ref.update({ pushSubscription: admin.firestore.FieldValue.delete() }).catch(() => {});
            } else {
                console.error('Push send failed:', err.message);
            }
        });
    } catch (e) {
        console.error('sendPushToUser failed:', e.message);
    }
}

// Save a push subscription for the logged-in user (called from the browser
// after they grant notification permission).
app.post('/api/save-push-subscription', async (req, res) => {
    const { idToken, subscription } = req.body;
    const me = await verifyUser(idToken);
    if (!me.ok || !subscription || !db) return res.status(401).json({ ok: false });
    try {
        await db.collection('users').doc(me.uid).set({ pushSubscription: subscription }, { merge: true });
        res.json({ ok: true });
    } catch (e) {
        console.error("Saving push subscription failed:", e.message);
        res.status(500).json({ ok: false });
    }
});

app.get('/vapid-public-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY || '' });
});

// Looks up the role of a chat username (by Firestore `username`/`displayName` field),
// so staff-protection rules (e.g. "admins can't ban other admins") can be enforced
// even though the chat itself only knows people by their display name.
async function getRoleByUsername(username) {
    if (!username) return null;
    if (!OWNER_UIDS.length && OWNER_NAMES.includes(username.toLowerCase())) return "admin";
    if (!db) return null;
    try {
        let snap = await db.collection('users').where('username', '==', username).limit(1).get();
        if (snap.empty) snap = await db.collection('users').where('displayName', '==', username).limit(1).get();
        if (snap.empty) return null;
        if (OWNER_UIDS.includes(snap.docs[0].id)) return "admin";
        const role = snap.docs[0].data().role;
        return role === "admin" ? "admin" : (role === "moderator" ? "moderator" : "user");
    } catch (e) {
        console.error("Role lookup failed:", e.message);
        return null;
    }
}

// ==================================================
// Reports + audit log
// recentMessages keeps the last messages the SERVER saw, so a report uses the
// server's copy of who wrote what — a reporter can't invent a message.
// ==================================================
const recentMessages = new Map(); // msgId -> { user, msg, mediaType, at }
const reactionsByMsg = new Map(); // msgId -> Map(username -> emoji)  (one reaction per person per message)
const reactionLog = new Map();    // socket.id -> timestamps (anti-spam)
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
function reactionSummary(msgId) {
    const out = {};
    const m = reactionsByMsg.get(String(msgId));
    if (m) for (const [user, emoji] of m) (out[emoji] = out[emoji] || []).push(user);
    return out;
}
function rememberMessage(d) {
    if (!d || !d.id) return;
    recentMessages.set(String(d.id), { user: d.user, msg: String(d.msg || '').slice(0, 500), mediaType: d.mediaType || null, at: Date.now() });
    if (recentMessages.size > 300) {
        const oldest = recentMessages.keys().next().value;
        recentMessages.delete(oldest);
        reactionsByMsg.delete(oldest);
    }
}
const auditBuffer = [];
function audit(action, actor, target, details) {
    const e = { action, actor: actor || 'unknown', target: target || null, details: details || null, at: Date.now() };
    auditBuffer.unshift(e);
    if (auditBuffer.length > 200) auditBuffer.pop();
    if (db) db.collection('auditLog').add(e).catch(() => {});
}
const reportsMem = [];            // fallback when Firestore isn't available
const reportKeys = new Set();     // reporter|msgId -> one report per person per message
const reportLog = new Map();      // socket.id -> timestamps (anti report-spam)
const REPORT_REASONS = ['spam', 'harassment', 'hate', 'inappropriate', 'other'];

async function nameFromToken(idToken, claimed) {
    if (idToken && db) {
        try { return (await admin.auth().verifyIdToken(idToken)).name || null; } catch (e) { return null; }
    }
    return /^Guest_\d{4}$/.test(String(claimed || '')) ? claimed : null;
}

// ---- Avatars (emoji + colour). Names -> avatar, cached; persisted on users/{uid}.avatar ----
const AVATAR_EMOJIS = ["😀", "😎", "🤩", "😇", "🥳", "🤓", "😈", "🤖", "👻", "👽", "🦊", "🐱", "🐶", "🐼", "🦁", "🐸", "🐵", "🦄", "🔥", "⚡", "🌙", "🍀", "🎮", "🚀"];
const AVATAR_COLORS = ["#0a84ff", "#30d158", "#ff9f0a", "#ff453a", "#bf5af2", "#64d2ff", "#ff375f", "#ffd60a"];
const avatarCache = new Map(); // username -> {e,c} | null
const avatarCooldown = new Map();
function cleanAvatar(a) {
    if (!a || !AVATAR_EMOJIS.includes(a.e) || !AVATAR_COLORS.includes(a.c)) return null;
    return { e: a.e, c: a.c };
}
async function avatarFor(name) {
    if (!name) return null;
    if (avatarCache.has(name)) return avatarCache.get(name);
    let av = null;
    if (db && !/^Guest_\d{4}$/.test(name)) {
        try {
            let snap = await db.collection('users').where('username', '==', name).limit(1).get();
            if (snap.empty) snap = await db.collection('users').where('displayName', '==', name).limit(1).get();
            if (!snap.empty) av = cleanAvatar(snap.docs[0].data().avatar);
        } catch (e) {}
    }
    if (avatarCache.size > 2000) avatarCache.clear();
    avatarCache.set(name, av);
    return av;
}

// ---- Admin statistics: counted in memory, flushed to Firestore (stats/{YYYY-MM-DD}) every minute ----
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function newStat() {
    return {
        day: dayKey(), messages: 0, reports: 0, reactions: 0, media: 0, peak: 0,
        hours: new Array(24).fill(0), users: new Set(), top: new Map(),
        flushed: { messages: 0, reports: 0, reactions: 0, media: 0, hours: new Array(24).fill(0), users: new Set() }
    };
}
let stat = newStat();
function rollStat() {
    if (stat.day !== dayKey()) { const old = stat; stat = newStat(); flushStats(old); }
}
function statMessage(user, mediaType) {
    rollStat();
    stat.messages++;
    stat.hours[new Date().getUTCHours()]++;
    stat.users.add(user);
    stat.top.set(user, (stat.top.get(user) || 0) + 1);
    if (mediaType) stat.media++;
}
async function flushStats(s = stat) {
    if (!db) return;
    const FV = admin.firestore.FieldValue;
    const d = {}; let any = false;
    for (const k of ['messages', 'reports', 'reactions', 'media']) {
        const dl = s[k] - s.flushed[k];
        if (dl) { d[k] = FV.increment(dl); s.flushed[k] = s[k]; any = true; }
    }
    const hours = {};
    s.hours.forEach((v, i) => { const dl = v - s.flushed.hours[i]; if (dl) { hours[i] = FV.increment(dl); s.flushed.hours[i] = v; any = true; } });
    if (Object.keys(hours).length) d.hours = hours;
    const fresh = [...s.users].filter(u => !s.flushed.users.has(u)).slice(0, 400);
    if (fresh.length) { d.users = FV.arrayUnion(...fresh); fresh.forEach(u => s.flushed.users.add(u)); any = true; }
    if (!any) return;
    d.day = s.day;
    try { await db.collection('stats').doc(s.day).set(d, { merge: true }); }
    catch (e) { console.error('stats flush failed:', e.message); }
}
setInterval(() => { rollStat(); flushStats(); }, 60 * 1000);
process.on('SIGTERM', async () => { try { await flushStats(); } catch (e) {} process.exit(0); });

// ---- Rooms + 1-hour message history ----
// Fixed list of rooms (edit here to rename/add). Messages are kept for 1 hour only,
// in memory and (text only) in Firestore `chatHistory`, so a restart doesn't wipe the last hour.
const ROOMS = [
    { id: 'general', name: 'General', icon: '💬' },
    { id: 'gaming',  name: 'Gaming',  icon: '🎮' },
    { id: 'study',   name: 'Study',   icon: '📚' },
    { id: 'music',   name: 'Music',   icon: '🎵' }
];
const ROOM_IDS = ROOMS.map(r => r.id);
const HISTORY_MS = 60 * 60 * 1000;
const HISTORY_MAX = 150;          // per room
const MEDIA_KEEP_MAX = 60000;     // chars of media data we keep in history; bigger media becomes a placeholder
const history = new Map(ROOM_IDS.map(id => [id, []])); // room -> [{ data, at }]
const histDocId = (id) => String(id).replace(/[\/\s]/g, '_').slice(0, 100);

function pruneHistory() {
    const cut = Date.now() - HISTORY_MS;
    for (const [room, arr] of history) {
        const i = arr.findIndex(e => e.at >= cut);
        history.set(room, (i === -1 ? [] : arr.slice(i)).slice(-HISTORY_MAX));
    }
}
function storeHistory(data) {
    const copy = Object.assign({}, data);
    delete copy.senderId;
    if (copy.mediaType && copy.mediaType !== 'sticker' && String(copy.mediaUrl || '').length > MEDIA_KEEP_MAX) {
        copy.mediaType = null; copy.mediaUrl = null; copy.msg = '📎 Media (too large to keep in history)';
    }
    const arr = history.get(copy.room) || [];
    arr.push({ data: copy, at: Date.now() });
    history.set(copy.room, arr.slice(-HISTORY_MAX));
    if (db && !copy.mediaType) {
        db.collection('chatHistory').doc(histDocId(copy.id))
            .set({ data: JSON.parse(JSON.stringify(copy)), room: copy.room, at: Date.now() })
            .catch(() => {});
    }
}
function removeFromHistory(msgId) {
    for (const [room, arr] of history) history.set(room, arr.filter(e => String(e.data.id) !== String(msgId)));
    if (db) db.collection('chatHistory').doc(histDocId(msgId)).delete().catch(() => {});
}
function editInHistory(msgId, newText) {
    for (const arr of history.values()) arr.forEach(e => { if (String(e.data.id) === String(msgId)) e.data.msg = newText; });
    if (db) db.collection('chatHistory').doc(histDocId(msgId)).update({ 'data.msg': newText }).catch(() => {});
}
async function purgeHistoryDocs(olderThan) {
    if (!db) return;
    try {
        for (let i = 0; i < 5; i++) {
            const q = olderThan ? db.collection('chatHistory').where('at', '<', olderThan) : db.collection('chatHistory');
            const snap = await q.limit(400).get();
            if (snap.empty) break;
            const batch = db.batch();
            snap.docs.forEach(d => batch.delete(d.ref));
            await batch.commit();
            if (snap.size < 400) break;
        }
    } catch (e) { console.error('history purge failed:', e.message); }
}
function clearAllHistory() {
    for (const id of ROOM_IDS) history.set(id, []);
    purgeHistoryDocs(null);
}
async function loadHistory() {
    if (!db) return;
    try {
        const snap = await db.collection('chatHistory').where('at', '>', Date.now() - HISTORY_MS).orderBy('at', 'asc').limit(600).get();
        snap.docs.forEach(d => {
            const x = d.data();
            if (!x || !x.data || !history.has(x.room)) return;
            history.get(x.room).push({ data: x.data, at: x.at });
            rememberMessage(x.data); // so reports still work on messages from before a restart
        });
        pruneHistory();
        console.log('📜 chat history loaded from Firestore');
    } catch (e) { console.error('history load failed:', e.message); }
}
setInterval(pruneHistory, 60 * 1000);
setInterval(() => purgeHistoryDocs(Date.now() - HISTORY_MS), 10 * 60 * 1000);
setTimeout(loadHistory, 1500);

function sendHistory(socket, room) {
    pruneHistory();
    const items = (history.get(room) || []).map(e => e.data);
    socket.emit('chat-history', { room, messages: items });
    items.forEach(m => {
        const r = reactionSummary(m.id);
        if (Object.keys(r).length) socket.emit('reaction-update', { msgId: String(m.id), reactions: r });
    });
}

// Push to people who were replied to / @mentioned and aren't looking at that room right now
function isViewingRoom(username, room) {
    for (const [sid, uname] of socketUsers.entries()) {
        if (uname !== username) continue;
        const s = io.sockets.sockets.get(sid);
        if (s && s.data && s.data.room === room) return true;
    }
    return false;
}
function notifyMentions(d) {
    try {
        const targets = new Set();
        if (d.replyTo && d.replyTo.user) targets.add(String(d.replyTo.user));
        const re = /@([\w.\-]{2,30})/g; let m;
        while ((m = re.exec(String(d.msg || '')))) targets.add(m[1]);
        targets.delete(d.user);
        const text = d.mediaType ? '[media]' : String(d.msg || '');
        [...targets].filter(t => !/^Guest_\d{4}$/.test(t)).slice(0, 3).forEach(t => {
            if (isViewingRoom(t, d.room)) return;
            const room = ROOMS.find(r => r.id === d.room);
            sendPushToUser(t, {
                title: `${d.user} in ${room ? room.name : 'chat'}`,
                body: text.length > 100 ? text.slice(0, 97) + '…' : text,
                tag: `mention-${t}`, url: '/'
            });
        });
    } catch (e) { console.error('notifyMentions failed:', e.message); }
}

// ==================================================
// AI endpoint (/api/gemini → Groq). Every call costs money, so it is protected:
//  • must be logged in (Firebase ID token in the Authorization header)
//  • per-IP, per-user (per minute + per day) and a global daily cap (circuit breaker)
//  • prompt length and answer length are capped
// Tune with env vars: AI_PER_MIN, AI_PER_DAY, AI_GLOBAL_PER_DAY
// ==================================================
const AI_PER_MIN = Number(process.env.AI_PER_MIN) || 6;
const AI_PER_DAY = Number(process.env.AI_PER_DAY) || 60;
const AI_GLOBAL_PER_DAY = Number(process.env.AI_GLOBAL_PER_DAY) || 1000;
const AI_MAX_PROMPT = 2000;
const aiIpLog = new Map(), aiUserMin = new Map(), aiUserDay = new Map();
let aiGlobal = { day: dayKey(), n: 0 };
function hitLimit(map, key, windowMs, max) {
    const now = Date.now();
    const arr = (map.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { map.set(key, arr); return true; }
    arr.push(now); map.set(key, arr);
    return false;
}
setInterval(() => {
    const now = Date.now();
    for (const [m, win] of [[aiIpLog, 60000], [aiUserMin, 60000], [aiUserDay, 86400000]]) {
        for (const [k, arr] of m) { if (!arr.length || now - arr[arr.length - 1] > win) m.delete(k); }
    }
}, 10 * 60 * 1000);

app.post('/api/gemini', async (req, res) => {
    if (!apiKey) return res.status(503).json({ reply: 'The AI assistant is not available right now.' });
    // 1) cheap IP limit first, so token verification can't be spammed
    if (hitLimit(aiIpLog, req.ip, 60000, 30)) return res.status(429).json({ reply: '⏳ Too many requests — try again in a minute.' });
    // 2) login required
    const authz = String(req.headers.authorization || '');
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : null;
    if (!token || !db) return res.status(401).json({ reply: '🔒 Please log in to use the AI assistant.' });
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(token); }
    catch (e) { return res.status(401).json({ reply: '🔒 Your session expired — please log in again.' }); }
    if (decoded.name && blockedUsers.has(decoded.name)) return res.status(403).json({ reply: 'You are banned.' });
    // 3) input validation (free for us, so it doesn't count against the user's quota)
    const prompt = req.body && typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ reply: 'Please type a question.' });
    if (prompt.length > AI_MAX_PROMPT) return res.status(400).json({ reply: `Your question is too long (max ${AI_MAX_PROMPT} characters).` });
    // 4) per-user limits
    if (hitLimit(aiUserMin, decoded.uid, 60000, AI_PER_MIN)) return res.status(429).json({ reply: `⏳ Slow down — max ${AI_PER_MIN} AI questions per minute.` });
    if (hitLimit(aiUserDay, decoded.uid, 86400000, AI_PER_DAY)) return res.status(429).json({ reply: `You reached today's limit of ${AI_PER_DAY} AI questions. Come back tomorrow.` });
    // 5) global daily circuit breaker
    if (aiGlobal.day !== dayKey()) aiGlobal = { day: dayKey(), n: 0 };
    if (aiGlobal.n >= AI_GLOBAL_PER_DAY) return res.status(503).json({ reply: 'The AI assistant reached its daily limit. Try again tomorrow.' });
    aiGlobal.n++;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
        const apiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'openai/gpt-oss-20b',
                max_completion_tokens: 800,
                messages: [{ role: 'user', content: prompt }]
            })
        });
        const data = await apiResponse.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            res.json({ reply: data.choices[0].message.content });
        } else {
            console.error('Groq error:', data.error ? data.error.message : 'invalid response');
            res.status(502).json({ reply: 'The AI had a problem answering. Please try again.' });
        }
    } catch (error) {
        console.error('AI fetch failed:', error.message);
        res.status(502).json({ reply: 'The AI is not reachable right now. Please try again.' });
    } finally {
        clearTimeout(timer);
    }
});

// ==================================================
// Moderation state: timed mutes, permanent bans, chat lock, pinned message
// ==================================================
const mutedUsers = new Map();     // username -> expiresAt (timestamp ms)
const muteTimers = new Map();     // username -> setTimeout handle
const blockedUsers = new Set();   // username -> permanently banned
const socketUsers = new Map();    // socket.id -> username
const usernameSockets = new Map(); // username -> Set of socket.id (supports multiple tabs/devices)
let onlineUsersCount = 0;

// -- DM helpers --------------------------------------------------
function addUsernameSocket(username, socketId) {
    if (!usernameSockets.has(username)) usernameSockets.set(username, new Set());
    usernameSockets.get(username).add(socketId);
}
function removeUsernameSocket(username, socketId) {
    const set = usernameSockets.get(username);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) usernameSockets.delete(username);
}
function isUserOnline(username) {
    return usernameSockets.has(username) && usernameSockets.get(username).size > 0;
}

// -- Basic rate limiting (anti-spam) ------------------------------
// Sliding window per socket: max MESSAGES within WINDOW_MS.
const RATE_LIMIT_MAX = 8;
const RATE_LIMIT_WINDOW_MS = 10000;
const rateLimitLog = new Map(); // socket.id -> array of timestamps

// -- DM presence (for "should we send a push?" decisions) ---------
// socket.id -> { partner: username|null, focused: boolean }
// A push is skipped only when the recipient has that EXACT conversation
// open AND their tab/app is in the foreground — same rule WhatsApp/Messenger
// use, so being merely "online" elsewhere no longer silences notifications.
const activeDMView = new Map();
function isUserActivelyViewingDM(username, partnerUsername) {
    const sockets = usernameSockets.get(username);
    if (!sockets) return false;
    for (const id of sockets) {
        const view = activeDMView.get(id);
        if (view && view.partner === partnerUsername && view.focused) return true;
    }
    return false;
}
function isRateLimited(socketId) {
    const now = Date.now();
    const arr = (rateLimitLog.get(socketId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    arr.push(now);
    rateLimitLog.set(socketId, arr);
    return arr.length > RATE_LIMIT_MAX;
}
let chatLocked = false;           // when true, only admins/mods can send messages
const pinnedByRoom = new Map();   // room -> { id, user, text }
const modClearCooldowns = new Map(); // uid -> next-allowed-timestamp (ms) for moderators clearing chat
const CLEAR_COOLDOWN_MS = 5 * 60 * 1000;
const modUnmuteCooldowns = new Map(); // uid -> next-allowed-timestamp (ms) for moderators unmuting someone
const UNMUTE_COOLDOWN_MS = 5 * 60 * 1000;

function getStatusLists() {
    // Clean up any expired mutes before broadcasting
    const now = Date.now();
    for (const [user, expiresAt] of mutedUsers.entries()) {
        if (expiresAt <= now) mutedUsers.delete(user);
    }
    return {
        muted: [...mutedUsers.entries()].map(([username, expiresAt]) => ({ username, expiresAt })),
        banned: [...blockedUsers],
        // The real source of truth for "online" — an actual live socket connection,
        // not a Firestore flag that mobile browsers often fail to clear on close/backgrounding.
        online: [...new Set(socketUsers.values())]
    };
}

function broadcastStatusLists() {
    io.emit('status-lists', getStatusLists());
}

function scheduleAutoUnmute(username, ms) {
    if (muteTimers.has(username)) clearTimeout(muteTimers.get(username));
    const timer = setTimeout(() => {
        mutedUsers.delete(username);
        muteTimers.delete(username);
        io.emit('system-msg', { text: `Mute expired for: ${username}`, kind: 'info' });
        broadcastStatusLists();
    }, ms);
    muteTimers.set(username, timer);
}

function performChatClear(by) {
    reactionsByMsg.clear();
    clearAllHistory();
    audit('clear-chat', by);
    pinnedByRoom.clear();
    io.emit('chat-cleared', { by: by || 'Admin' });
    for (const r of ROOMS) io.to(r.id).emit('pinned-message-update', pinnedByRoom.get(r.id) || null);
}

// Kicks every socket registered under this username (used on ban)
function kickUserSockets(username, reason) {
    for (const [socketId, uname] of socketUsers.entries()) {
        if (uname === username) {
            const s = io.sockets.sockets.get(socketId);
            if (s) {
                s.emit('you-are-banned', { reason });
                s.disconnect(true);
            }
            socketUsers.delete(socketId);
        }
    }
}

io.on('connection', (socket) => {
    socket.data.room = 'general';
    socket.join('general');
    socket.emit('rooms', ROOMS);
    onlineUsersCount++;
    rollStat(); if (onlineUsersCount > stat.peak) stat.peak = onlineUsersCount;
    io.emit('update-online', onlineUsersCount);

    // Send current state to the newly connected client
    socket.emit('status-lists', getStatusLists());
    socket.emit('chat-lock-status', { locked: chatLocked });
    socket.emit('pinned-message-update', pinnedByRoom.get('general') || null);

    // Client registers its username right after entering the chat,
    // so bans can be enforced immediately even for already-connected users
    socket.on('register-user', ({ username }) => {
        if (!username) return;
        if (blockedUsers.has(username)) {
            socket.emit('you-are-banned', { reason: 'You are banned from this chat.' });
            socket.disconnect(true);
            return;
        }
        socketUsers.set(socket.id, username);
        addUsernameSocket(username, socket.id);
        broadcastStatusLists();
    });

    // Fired when a logged-in user changes their username from the profile panel.
    // Without this, renaming was an easy way to escape an active mute/ban
    // (the moderation state is keyed by username), so we carry the
    // mute/ban status over from the old name to the new one.
    socket.on('rename-user', async ({ oldUsername, newUsername, idToken }) => {
        if (!oldUsername || !newUsername || oldUsername === newUsername) return;
        try {
            if (!idToken || !db) return; // require a logged-in user
            await admin.auth().verifyIdToken(idToken);
        } catch (e) {
            return; // invalid token, ignore silently
        }

        if (blockedUsers.has(oldUsername)) {
            blockedUsers.delete(oldUsername);
            blockedUsers.add(newUsername);
        }

        if (mutedUsers.has(oldUsername)) {
            const expiresAt = mutedUsers.get(oldUsername);
            mutedUsers.delete(oldUsername);
            mutedUsers.set(newUsername, expiresAt);
            const remainingMs = expiresAt - Date.now();
            if (remainingMs > 0) scheduleAutoUnmute(newUsername, remainingMs);
        }

        removeUsernameSocket(oldUsername, socket.id);
        socketUsers.set(socket.id, newUsername);
        addUsernameSocket(newUsername, socket.id);
        broadcastStatusLists();

        if (blockedUsers.has(newUsername)) {
            kickUserSockets(newUsername, 'You have been banned by an admin.');
        }
    });

    socket.on('chat-message', async (data) => {
        if (!data || typeof data !== 'object') return;
        if (isRateLimited(socket.id)) {
            return socket.emit('system-msg', { text: "You're sending messages too fast — slow down a bit.", kind: 'error' });
        }
        // Identity comes from the verified token (or the Guest_#### pattern), never from the
        // client-sent name — otherwise anyone could post as "Hamma" or dodge a mute/ban.
        let verifiedName = null;
        if (data.idToken && db) {
            try { verifiedName = (await admin.auth().verifyIdToken(data.idToken)).name || null; } catch (e) { verifiedName = null; }
        } else if (/^Guest_\d{4}$/.test(String(data.user || ''))) {
            verifiedName = data.user;
        }
        if (!verifiedName) {
            return socket.emit('system-msg', { text: 'Could not verify your identity — please log in again.', kind: 'error' });
        }
        const staffToken = data.idToken;
        data.user = verifiedName;
        delete data.idToken; // never broadcast Firebase tokens to the other clients
        data.avatar = await avatarFor(verifiedName); // server decides the avatar, not the client
        if (blockedUsers.has(data.user)) {
            return socket.emit('system-msg', { text: 'You are banned from sending messages.', kind: 'error' });
        }
        const expiresAt = mutedUsers.get(data.user);
        if (expiresAt && expiresAt > Date.now()) {
            const remaining = Math.ceil((expiresAt - Date.now()) / 60000);
            return socket.emit('system-msg', { text: `You are muted, try again in ${remaining} minute(s).`, kind: 'error' });
        }
        if (chatLocked) {
            const { ok } = await verifyAdmin(staffToken);
            if (!ok) {
                return socket.emit('system-msg', { text: 'Chat is currently locked by an admin.', kind: 'error' });
            }
        }
        data.room = ROOM_IDS.includes(socket.data.room) ? socket.data.room : 'general'; // room comes from the server, not the client
        rememberMessage(data);
        statMessage(data.user, data.mediaType);
        storeHistory(data);
        io.to(data.room).emit('chat-message', data);
        io.emit('room-ping', { room: data.room });
        notifyMentions(data);
    });

    // ---- Statistics (admins only) ----------------------------------
    socket.on('get-stats', async ({ idToken }) => {
        const { ok, role } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return;
        rollStat();
        await flushStats();
        let days = [], registered = null, openReports = reportsMem.filter(r => r.status === 'open').length;
        if (db) {
            try {
                const snap = await db.collection('stats').orderBy('day', 'desc').limit(7).get();
                days = snap.docs.map(d => {
                    const x = d.data();
                    return {
                        day: x.day || d.id, messages: x.messages || 0, users: (x.users || []).length,
                        reports: x.reports || 0, reactions: x.reactions || 0, media: x.media || 0,
                        hours: Array.from({ length: 24 }, (_, i) => (x.hours && x.hours[i]) || 0)
                    };
                }).reverse();
            } catch (e) { console.error('stats read failed:', e.message); }
            try { registered = (await db.collection('users').count().get()).data().count; } catch (e) {}
            try { openReports += (await db.collection('reports').where('status', '==', 'open').get()).size; } catch (e) {}
        }
        const doc = days.find(d => d.day === stat.day);
        const today = doc ? Object.assign({ peak: stat.peak }, doc)
            : { day: stat.day, messages: stat.messages, users: stat.users.size, reports: stat.reports, reactions: stat.reactions, media: stat.media, hours: stat.hours, peak: stat.peak };
        const dayAgo = Date.now() - 86400000, actions = {};
        auditBuffer.filter(a => a.at > dayAgo).forEach(a => { actions[a.action] = (actions[a.action] || 0) + 1; });
        const now = Date.now();
        socket.emit('stats-data', {
            today, days, online: usernameSockets.size, registered, openReports, actions, ownerUidsSet: OWNER_UIDS.length > 0,
            banned: blockedUsers.size, muted: [...mutedUsers.values()].filter(t => t > now).length,
            top: [...stat.top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        });
    });

    // ---- Avatars -------------------------------------------------
    socket.on('set-avatar', async ({ avatar, idToken }) => {
        const av = cleanAvatar(avatar);
        if (!av) return;
        const now = Date.now();
        if (now - (avatarCooldown.get(socket.id) || 0) < 1500) return;
        avatarCooldown.set(socket.id, now);
        let name = null, uid = null;
        if (idToken && db) {
            try { const d = await admin.auth().verifyIdToken(idToken); name = d.name || null; uid = d.uid; } catch (e) {}
        } else if (/^Guest_\d{4}$/.test(String(socketUsers.get(socket.id) || ''))) {
            name = socketUsers.get(socket.id);
        }
        if (!name) return;
        avatarCache.set(name, av);
        if (uid && db) db.collection('users').doc(uid).set({ avatar: av }, { merge: true }).catch(() => {});
        io.emit('avatar-update', { user: name, avatar: av });
    });

    socket.on('get-avatar', async ({ idToken }) => {
        const name = await nameFromToken(idToken, socketUsers.get(socket.id));
        if (!name) return;
        socket.emit('avatar-update', { user: name, avatar: await avatarFor(name) });
    });

    socket.on('get-avatars', async ({ names }) => {
        if (!Array.isArray(names)) return;
        const out = {};
        for (const n of names.slice(0, 60)) { if (typeof n === 'string') out[n] = await avatarFor(n); }
        socket.emit('avatars-bulk', out);
    });

    // ---- Rooms ---------------------------------------------------
    socket.on('join-room', ({ room }) => {
        if (!ROOM_IDS.includes(room)) return;
        if (socket.data.room !== room) {
            socket.leave(socket.data.room);
            socket.join(room);
            socket.data.room = room;
        }
        socket.emit('room-joined', { room });
        socket.emit('pinned-message-update', pinnedByRoom.get(room) || null);
        sendHistory(socket, room);
    });

    // ---- Reactions (one per person per message; same emoji again = remove) ----
    socket.on('react-message', async ({ msgId, emoji, idToken }) => {
        if (!ALLOWED_REACTIONS.includes(emoji) || msgId == null) return;
        const now = Date.now();
        const log = (reactionLog.get(socket.id) || []).filter(t => now - t < 10000);
        if (log.length >= 15) return;
        log.push(now); reactionLog.set(socket.id, log);

        const user = await nameFromToken(idToken, socketUsers.get(socket.id));
        if (!user) return;
        if (blockedUsers.has(user)) return;
        const exp = mutedUsers.get(user);
        if (exp && exp > now) return; // muted people can't react either
        const key = String(msgId);
        if (!recentMessages.has(key)) return; // only messages the server actually saw

        let m = reactionsByMsg.get(key);
        if (!m) { m = new Map(); reactionsByMsg.set(key, m); }
        if (m.get(user) === emoji) m.delete(user); else { m.set(user, emoji); rollStat(); stat.reactions++; }
        if (!m.size) reactionsByMsg.delete(key);
        io.emit('reaction-update', { msgId: key, reactions: reactionSummary(key) });
    });

    // ---- Reports -------------------------------------------------
    socket.on('report-message', async ({ msgId, reason, idToken }) => {
        const now = Date.now();
        const log = (reportLog.get(socket.id) || []).filter(t => now - t < 10 * 60 * 1000);
        if (log.length >= 5) return socket.emit('system-msg', { text: "You've sent too many reports — try again later.", kind: 'error' });
        const reporter = await nameFromToken(idToken, socketUsers.get(socket.id));
        if (!reporter) return socket.emit('system-msg', { text: 'Could not verify your identity.', kind: 'error' });
        const msg = recentMessages.get(String(msgId));
        if (!msg) return socket.emit('system-msg', { text: 'This message is too old to report.', kind: 'error' });
        if (msg.user === reporter) return socket.emit('system-msg', { text: "You can't report your own message.", kind: 'error' });
        const key = reporter + '|' + msgId;
        if (reportKeys.has(key)) return socket.emit('system-msg', { text: 'You already reported this message.', kind: 'info' });
        reportKeys.add(key);
        rollStat(); stat.reports++;
        log.push(now); reportLog.set(socket.id, log);

        const report = {
            msgId: String(msgId), reportedUser: msg.user, text: msg.mediaType ? `[${msg.mediaType}]` : msg.msg,
            reason: REPORT_REASONS.includes(reason) ? reason : 'other', reporter, status: 'open', createdAt: now
        };
        if (db) {
            try { await db.collection('reports').add(report); } catch (e) { reportsMem.unshift(report); }
        } else { reportsMem.unshift(report); }
        socket.emit('system-msg', { text: '✅ Report sent. Thank you — staff will review it.', kind: 'info' });
        io.emit('reports-changed'); // no content, staff clients refetch
    });

    socket.on('get-reports', async ({ idToken }) => {
        const { ok } = await verifyRole(idToken);
        if (!ok) return;
        let list = reportsMem.filter(r => r.status === 'open');
        if (db) {
            try {
                const snap = await db.collection('reports').where('status', '==', 'open').limit(100).get();
                list = list.concat(snap.docs.map(d => Object.assign({ id: d.id }, d.data())));
            } catch (e) { console.error('get-reports failed:', e.message); }
        }
        list.sort((a, b) => b.createdAt - a.createdAt);
        socket.emit('reports-list', list.slice(0, 100));
    });

    socket.on('resolve-report', async ({ reportId, action, idToken }) => {
        const { ok, name } = await verifyRole(idToken);
        if (!ok || !reportId) return;
        const status = action === 'dismiss' ? 'dismissed' : 'actioned';
        const mem = reportsMem.find(r => r.id === reportId || r.msgId === reportId);
        if (mem) mem.status = status;
        if (db) { try { await db.collection('reports').doc(String(reportId)).update({ status, resolvedBy: name || null, resolvedAt: Date.now() }); } catch (e) {} }
        audit('report-' + status, name, null, String(reportId));
        io.emit('reports-changed');
    });

    socket.on('get-audit-log', async ({ idToken }) => {
        const { ok, role } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return; // admins only
        let list = auditBuffer.slice(0, 100);
        if (db) {
            try {
                const snap = await db.collection('auditLog').orderBy('at', 'desc').limit(100).get();
                if (!snap.empty) list = snap.docs.map(d => d.data());
            } catch (e) {}
        }
        socket.emit('audit-log', list);
    });

    // Relay typing status to everyone else (Instagram-style "X is typing…" indicator)
    socket.on('typing', ({ username }) => {
        if (!username) return;
        socket.to(socket.data.room || 'general').emit('user-typing', { username });
    });

    socket.on('stop-typing', ({ username }) => {
        if (!username) return;
        socket.to(socket.data.room || 'general').emit('user-stop-typing', { username });
    });

    // Delete a message — the message's own sender can delete it, and so can
    // an admin or moderator (same staff tier that can already mute/pin).
    // Regular viewers are only told a message was "deleted by an admin" when staff did it
    // (never which admin/moderator), so the client can tell that apart from a self-delete.
    // Exception: only Hamma admin / Othmani Hiba (the owners) can delete another admin's message —
    // a regular admin/moderator can't touch what an admin wrote.
    socket.on('delete-message', async ({ msgId, idToken, messageSender }) => {
        const { role, name, isOwner } = await verifyRole(idToken);
        const isStaff = role === 'admin' || role === 'moderator';
        const isSelf = !!messageSender && !!name && messageSender.toLowerCase() === name.toLowerCase();

        if (!isSelf && !isStaff) {
            return socket.emit('system-msg', { text: 'You are not allowed to delete this message.', kind: 'error' });
        }

        if (!isSelf && isStaff && !isOwner) {
            const senderRole = await getRoleByUsername(messageSender);
            if (senderRole === 'admin') {
                return socket.emit('system-msg', { text: `🚫 Can't delete an admin's message.`, kind: 'error' });
            }
        }

        if (isStaff && !isSelf) audit('delete-message', name, messageSender, String(msgId));
        removeFromHistory(msgId);
        io.emit('delete-message', { msgId, staffDeleted: isStaff && !isSelf });
    });

    // Edit a message — self only (no staff override; editing someone else's
    // words isn't something even admins get to do). Same ephemeral trust
    // model as delete-message: the client tells us which message and who
    // sent it, we just confirm the requester's identity matches.
    socket.on('edit-message', async ({ msgId, idToken, messageSender, newText }) => {
        const { name } = await verifyRole(idToken);
        const isSelf = !!messageSender && !!name && messageSender.toLowerCase() === name.toLowerCase();
        if (!isSelf || !newText || !newText.trim()) return;
        if (isRateLimited(socket.id)) {
            return socket.emit('system-msg', { text: "You're doing that too fast — slow down a bit.", kind: 'error' });
        }

        editInHistory(msgId, newText.trim());
        io.emit('edit-message', { msgId, newText: newText.trim() });
    });

    // Timed mute (minutes: 5 / 15 / 30 / 60) — admins AND moderators are allowed
    socket.on('mute-user', async ({ username, idToken, minutes }) => {
        const { ok, role, name } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to mute users.', kind: 'error' });

        // Staff can't mute themselves — no self-mute loophole
        if (name && username && name.toLowerCase() === username.toLowerCase()) {
            return socket.emit('system-msg', { text: "🙃 You can't mute yourself.", kind: 'error' });
        }

        const allowedDurations = [5, 15, 30, 60];
        const duration = allowedDurations.includes(Number(minutes)) ? Number(minutes) : 5;
        const ms = duration * 60 * 1000;
        const expiresAt = Date.now() + ms;

        // 😂 A moderator trying to mute an admin gets muted themselves instead
        let target = username;
        let backfired = false;
        if (role === 'moderator') {
            const targetRole = await getRoleByUsername(username);
            if (targetRole === 'admin') {
                target = name;
                backfired = true;
            }
        }

        mutedUsers.set(target, expiresAt);
        audit('mute', name, target, duration + 'm' + (backfired ? ' (backfired)' : ''));
        scheduleAutoUnmute(target, ms);

        if (backfired) {
            io.emit('system-msg', { text: `😂 ${name} tried to mute an admin... and got muted instead for ${duration} minute(s)!`, kind: 'mute' });
        } else {
            io.emit('system-msg', { text: `🔇 ${target} has been muted for ${duration} minute(s).`, kind: 'mute' });
        }
        broadcastStatusLists();
    });

    // Unmuting a moderator is reserved for the owners (Hamma Admin / Othmani Hiba) —
    // a regular admin can't lift a moderator's mute.
    socket.on('unmute-user', async ({ username, idToken }) => {
        const { ok, role, uid, name } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unmute users.', kind: 'error' });

        if (role === 'moderator') {
            const now = Date.now();
            const nextAllowed = modUnmuteCooldowns.get(uid) || 0;
            if (now < nextAllowed) {
                const remainingMin = Math.ceil((nextAllowed - now) / 60000);
                return socket.emit('system-msg', { text: `⏳ You can unmute again in ~${remainingMin} minute(s).`, kind: 'error' });
            }
            modUnmuteCooldowns.set(uid, now + UNMUTE_COOLDOWN_MS);
        }

        mutedUsers.delete(username);
        audit('unmute', name, username);
        if (muteTimers.has(username)) {
            clearTimeout(muteTimers.get(username));
            muteTimers.delete(username);
        }
        io.emit('system-msg', { text: `🔊 ${username} has been unmuted.`, kind: 'info' });
        broadcastStatusLists();
    });

    // Permanent ban (admins only — moderators can only mute/pin)
    socket.on('block-user', async ({ username, idToken }) => {
        const { ok, role, name } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to ban users.', kind: 'error' });

        // Admins can't ban other admins — only mute them
        const targetRole = await getRoleByUsername(username);
        if (targetRole === 'admin') {
            return socket.emit('system-msg', { text: `🚫 Admins can't ban other admins. You can only mute ${username}.`, kind: 'error' });
        }

        blockedUsers.add(username);
        audit('ban', name, username);
        io.emit('system-msg', { text: `🚫 ${username} has been banned from the chat.`, kind: 'ban' });
        kickUserSockets(username, 'You have been banned by an admin.');
        broadcastStatusLists();
    });

    socket.on('unblock-user', async ({ username, idToken }) => {
        const { ok, role, name } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to unban users.', kind: 'error' });

        blockedUsers.delete(username);
        audit('unban', name, username);
        io.emit('system-msg', { text: `✅ ${username} has been unbanned.`, kind: 'info' });
        broadcastStatusLists();
    });

    // Clear the entire chat for everyone.
    // Admins can do this anytime. Moderators can too, but only once every 5 minutes.
    socket.on('clear-chat', async ({ idToken }) => {
        const { ok, role, name, uid } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to clear the chat.', kind: 'error' });

        if (role === 'admin') {
            performChatClear(name || 'Admin');
            socket.emit('clear-chat-result', { ok: true, nextAllowedAt: null });
            return;
        }

        // role === 'moderator'
        const now = Date.now();
        const nextAllowed = modClearCooldowns.get(uid) || 0;
        if (now < nextAllowed) {
            socket.emit('clear-chat-result', { ok: false, nextAllowedAt: nextAllowed });
            const remainingMin = Math.ceil((nextAllowed - now) / 60000);
            socket.emit('system-msg', { text: `⏳ You can clear the chat again in ~${remainingMin} minute(s).`, kind: 'error' });
            return;
        }

        modClearCooldowns.set(uid, now + CLEAR_COOLDOWN_MS);
        performChatClear(name || 'Moderator');
        socket.emit('clear-chat-result', { ok: true, nextAllowedAt: now + CLEAR_COOLDOWN_MS });
    });

    // Lets a moderator (or admin) find out their current clear-chat cooldown,
    // e.g. right after connecting/refreshing, so the button can show a live countdown.
    socket.on('get-clear-cooldown', async ({ idToken }) => {
        const { ok, role, uid } = await verifyRole(idToken);
        if (!ok) return;
        if (role === 'admin') return socket.emit('clear-cooldown-status', { nextAllowedAt: null });
        if (role === 'moderator') {
            const nextAllowed = modClearCooldowns.get(uid) || 0;
            return socket.emit('clear-cooldown-status', { nextAllowedAt: nextAllowed > Date.now() ? nextAllowed : null });
        }
    });

    // Lock / unlock the chat (admins only; while locked, only admins/mods can send)
    socket.on('lock-chat', async ({ idToken }) => {
        const { ok, role, name } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to lock the chat.', kind: 'error' });
        chatLocked = true;
        audit('lock-chat', name);
        io.emit('chat-lock-status', { locked: true });
        io.emit('system-msg', { text: '🔒 The chat has been locked by an admin.', kind: 'ban' });
    });

    socket.on('unlock-chat', async ({ idToken }) => {
        const { ok, role, name } = await verifyRole(idToken);
        if (!ok || role !== 'admin') return socket.emit('system-msg', { text: 'You are not allowed to unlock the chat.', kind: 'error' });
        chatLocked = false;
        audit('unlock-chat', name);
        io.emit('chat-lock-status', { locked: false });
        io.emit('system-msg', { text: '🔓 The chat has been unlocked.', kind: 'info' });
    });

    // Pin / unpin a message — admins AND moderators are allowed
    socket.on('pin-message', async ({ msgId, user, text, idToken }) => {
        const { ok } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to pin messages.', kind: 'error' });

        const room = socket.data.room || 'general';
        const pin = { id: String(msgId || '').slice(0, 60), user: String(user || '').slice(0, 40), text: String(text || '').slice(0, 300) };
        pinnedByRoom.set(room, pin); // pins are per room now
        io.to(room).emit('pinned-message-update', pin);
    });

    socket.on('unpin-message', async ({ idToken }) => {
        const { ok } = await verifyRole(idToken);
        if (!ok) return socket.emit('system-msg', { text: 'You are not allowed to unpin messages.', kind: 'error' });

        const room = socket.data.room || 'general';
        pinnedByRoom.delete(room);
        io.to(room).emit('pinned-message-update', null);
    });

    // ==================================================
    // Friend requests — search by exact username, send a request, and
    // accept/decline it. Persisted in Firestore (unlike the ephemeral
    // chat) so a pending request is still there next time you log in.
    // Guests can't use this — it needs a real account.
    // ==================================================
    socket.on('search-user', async ({ query, idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok) return socket.emit('search-user-result', { error: 'You need to be logged in to add friends.' });
        if (!query || !query.trim()) return socket.emit('search-user-result', { error: '' });
        const found = await findUserByUsername(query.trim());
        if (!found || found.username === me.name) {
            return socket.emit('search-user-result', { error: 'No user found with that username.' });
        }
        socket.emit('search-user-result', { username: found.username, online: isUserOnline(found.username) });
    });

    socket.on('send-friend-request', async ({ toUsername, idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok) return socket.emit('dm-system-msg', { text: 'You need to be logged in to add friends.', kind: 'error' });
        if (!toUsername || toUsername === me.name || !db) return;

        const target = await findUserByUsername(toUsername);
        if (!target) return socket.emit('dm-system-msg', { text: 'No user found with that username.', kind: 'error' });

        const forwardId = `${me.name}__${target.username}`;
        const reverseId = `${target.username}__${me.name}`;

        try {
            const [forwardSnap, reverseSnap] = await Promise.all([
                db.collection('friendRequests').doc(forwardId).get(),
                db.collection('friendRequests').doc(reverseId).get()
            ]);

            if (forwardSnap.exists && forwardSnap.data().status === 'accepted') {
                return socket.emit('dm-system-msg', { text: `You're already friends with ${target.username}.`, kind: 'info' });
            }
            if (forwardSnap.exists && forwardSnap.data().status === 'pending') {
                return socket.emit('dm-system-msg', { text: `You already sent a request to ${target.username}.`, kind: 'info' });
            }

            // They already sent YOU a request — accept it instead of creating a duplicate
            if (reverseSnap.exists && reverseSnap.data().status === 'pending') {
                await db.collection('friendRequests').doc(reverseId).update({ status: 'accepted' });
                notifyFriendResponse(target.username, me.name, 'accept');
                socket.emit('friend-request-response', { by: target.username, action: 'accept' });
                return;
            }

            await db.collection('friendRequests').doc(forwardId).set({
                from: me.name, to: target.username, status: 'pending', createdAt: Date.now()
            });

            const targetSockets = usernameSockets.get(target.username);
            if (targetSockets && targetSockets.size > 0) {
                targetSockets.forEach(id => io.to(id).emit('friend-request-received', { from: me.name }));
            } else {
                sendPushToUser(target.username, {
                    title: 'New friend request',
                    body: `${me.name} wants to be your friend on Hamma`,
                    tag: `friend-request-${me.name}`,
                    url: '/'
                });
            }
            socket.emit('dm-system-msg', { text: `Friend request sent to ${target.username}.`, kind: 'info' });
        } catch (e) {
            console.error("Friend request failed:", e.message);
        }
    });

    socket.on('get-friend-requests', async ({ idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !db) return socket.emit('friend-requests-list', []);
        try {
            const snap = await db.collection('friendRequests')
                .where('to', '==', me.name).where('status', '==', 'pending').get();
            socket.emit('friend-requests-list', snap.docs.map(d => ({ from: d.data().from })));
        } catch (e) {
            console.error("Fetching friend requests failed:", e.message);
            socket.emit('friend-requests-list', []);
        }
    });

    // Returns everyone you're mutually friends with (accepted, either direction)
    socket.on('get-friends', async ({ idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !db) return socket.emit('friends-list', []);
        try {
            const [sentSnap, receivedSnap] = await Promise.all([
                db.collection('friendRequests').where('from', '==', me.name).where('status', '==', 'accepted').get(),
                db.collection('friendRequests').where('to', '==', me.name).where('status', '==', 'accepted').get()
            ]);
            const friends = [
                ...sentSnap.docs.map(d => d.data().to),
                ...receivedSnap.docs.map(d => d.data().from)
            ];
            const results = await Promise.all(friends.map(async (username) => {
                const online = isUserOnline(username);
                let lastSeenMs = null;
                if (!online) {
                    const info = await findUserByUsername(username);
                    if (info && info.lastSeen && typeof info.lastSeen.toMillis === 'function') {
                        lastSeenMs = info.lastSeen.toMillis();
                    }
                }
                return { username, online, lastSeenMs };
            }));
            socket.emit('friends-list', results);
        } catch (e) {
            console.error("Fetching friends failed:", e.message);
            socket.emit('friends-list', []);
        }
    });

    socket.on('respond-friend-request', async ({ fromUsername, action, idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !db || !fromUsername) return;
        const reqId = `${fromUsername}__${me.name}`;
        try {
            if (action === 'accept') {
                await db.collection('friendRequests').doc(reqId).update({ status: 'accepted' });
            } else {
                await db.collection('friendRequests').doc(reqId).delete();
            }
            notifyFriendResponse(fromUsername, me.name, action === 'accept' ? 'accept' : 'decline');
        } catch (e) {
            console.error("Responding to friend request failed:", e.message);
        }
    });

    function notifyFriendResponse(toUsername, byUsername, action) {
        const targetSockets = usernameSockets.get(toUsername);
        if (targetSockets) {
            targetSockets.forEach(id => io.to(id).emit('friend-request-response', { by: byUsername, action }));
        }
    }

    // ==================================================
    // Direct messages (DM) — private 1-to-1 chat between two users.
    // Persisted in Firestore (unlike the global chat, which stays live-only
    // by request) so history survives reconnects and page reloads.
    // ==================================================
    socket.on('dm-message', async ({ to, text, idToken, mediaType, mediaUrl }) => {
        const from = socketUsers.get(socket.id);
        const hasText = !!text && !!text.trim();
        const hasMedia = !!mediaType && !!mediaUrl;
        if (!from || !to || (!hasText && !hasMedia)) return;
        if (isRateLimited(socket.id)) {
            return socket.emit('dm-system-msg', { text: "You're sending messages too fast — slow down a bit.", kind: 'error' });
        }
        if (blockedUsers.has(from)) {
            return socket.emit('dm-system-msg', { text: 'You are banned from sending messages.', kind: 'error' });
        }
        const expiresAt = mutedUsers.get(from);
        if (expiresAt && expiresAt > Date.now()) {
            const remaining = Math.ceil((expiresAt - Date.now()) / 60000);
            return socket.emit('dm-system-msg', { text: `You are muted, try again in ${remaining} minute(s).`, kind: 'error' });
        }

        const payload = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            from,
            to,
            text: hasText ? text.trim() : '',
            timestamp: Date.now(),
            read: false
        };
        if (hasMedia) {
            payload.mediaType = mediaType;
            payload.mediaUrl = mediaUrl;
        }

        // Deliver to every open tab/device the recipient has
        const targetSockets = usernameSockets.get(to);
        if (targetSockets && targetSockets.size > 0) {
            targetSockets.forEach(id => io.to(id).emit('dm-message', payload));
        } else if (!db) {
            socket.emit('dm-system-msg', { text: `${to} is offline right now — they won't see this message.`, kind: 'error' });
        }

        // Push notification: sent whenever they're NOT actively looking at
        // this exact conversation in the foreground — same rule big chat
        // apps use, so it fires even if they're "online" but on another
        // screen, another tab, or the app is backgrounded.
        if (!isUserActivelyViewingDM(to, from)) {
            sendPushToUser(to, {
                title: from,
                body: hasMedia ? `Sent ${mediaType === 'audio' ? 'a voice message' : mediaType === 'video' ? 'a video' : 'a photo'}` :
                    (payload.text.length > 120 ? payload.text.slice(0, 117) + '…' : payload.text),
                tag: `dm-${from}`,
                url: '/'
            });
        }

        // Echo back to the sender's own open tabs so their UI updates too
        const senderSockets = usernameSockets.get(from);
        if (senderSockets) senderSockets.forEach(id => io.to(id).emit('dm-message', payload));

        // Persist — only once we can confirm the sender's real identity via
        // their ID token (keeps guest chatter out of permanent storage)
        if (db && idToken) {
            const me = await verifyUser(idToken);
            if (me.ok && me.name === from) {
                const convId = [from, to].sort().join('__');
                const doc = { id: payload.id, from, to, text: payload.text, timestamp: payload.timestamp, read: false };
                if (hasMedia) { doc.mediaType = mediaType; doc.mediaUrl = mediaUrl; }
                db.collection('directMessages').doc(convId).collection('messages').add(doc)
                    .catch(e => console.error('DM persist failed:', e.message));
            }
        }
    });

    // Delete a DM message — sender only, removes it for both sides.
    socket.on('dm-delete-message', async ({ withUsername, msgId, idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !withUsername || !msgId || !db) return;
        const convId = [me.name, withUsername].sort().join('__');
        try {
            const snap = await db.collection('directMessages').doc(convId).collection('messages')
                .where('id', '==', msgId).limit(1).get();
            if (!snap.empty && snap.docs[0].data().from === me.name) {
                await snap.docs[0].ref.delete();
            } else {
                return; // not found, or not the owner — don't notify either side
            }
        } catch (e) {
            console.error('DM message delete failed:', e.message);
            return;
        }

        const targetSockets = usernameSockets.get(withUsername);
        if (targetSockets) targetSockets.forEach(id => io.to(id).emit('dm-message-deleted', { msgId, by: me.name }));
        const senderSockets = usernameSockets.get(me.name);
        if (senderSockets) senderSockets.forEach(id => io.to(id).emit('dm-message-deleted', { msgId, by: me.name }));
    });

    // Edit a DM message — self only, updates Firestore and tells both sides live.
    socket.on('dm-edit-message', async ({ withUsername, msgId, idToken, newText }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !withUsername || !msgId || !newText || !newText.trim() || !db) return;
        if (isRateLimited(socket.id)) {
            return socket.emit('dm-system-msg', { text: "You're doing that too fast — slow down a bit.", kind: 'error' });
        }
        const convId = [me.name, withUsername].sort().join('__');
        const trimmed = newText.trim();
        try {
            const snap = await db.collection('directMessages').doc(convId).collection('messages')
                .where('id', '==', msgId).limit(1).get();
            if (snap.empty || snap.docs[0].data().from !== me.name) return;
            await snap.docs[0].ref.update({ text: trimmed, edited: true });
        } catch (e) {
            console.error('DM message edit failed:', e.message);
            return;
        }

        const payload = { msgId, newText: trimmed, by: me.name };
        const targetSockets = usernameSockets.get(withUsername);
        if (targetSockets) targetSockets.forEach(id => io.to(id).emit('dm-message-edited', payload));
        const senderSockets = usernameSockets.get(me.name);
        if (senderSockets) senderSockets.forEach(id => io.to(id).emit('dm-message-edited', payload));
    });

    // Marks every unread message FROM `withUsername` TO me as read, and lets
    // the sender know (so their UI can flip ✓ to ✓✓).
    socket.on('dm-mark-read', async ({ withUsername, idToken }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !withUsername || !db) return;
        const convId = [me.name, withUsername].sort().join('__');
        try {
            const snap = await db.collection('directMessages').doc(convId).collection('messages')
                .where('to', '==', me.name).where('read', '==', false).get();
            if (snap.empty) return;
            const batch = db.batch();
            snap.docs.forEach(d => batch.update(d.ref, { read: true }));
            await batch.commit();

            const targetSockets = usernameSockets.get(withUsername);
            if (targetSockets) targetSockets.forEach(id => io.to(id).emit('dm-read-receipt', { by: me.name }));
        } catch (e) {
            console.error('Marking DM as read failed:', e.message);
        }
    });

    // Loads the last page of a DM conversation (or an older page, via `before`)
    socket.on('get-dm-history', async ({ withUsername, idToken, before }) => {
        const me = await verifyUser(idToken);
        if (!me.ok || !withUsername || !db) {
            return socket.emit('dm-history', { withUsername, messages: [], hasMore: false });
        }
        const convId = [me.name, withUsername].sort().join('__');
        try {
            let q = db.collection('directMessages').doc(convId).collection('messages')
                .orderBy('timestamp', 'desc').limit(30);
            if (before) q = q.where('timestamp', '<', before);
            const snap = await q.get();
            const messages = snap.docs.map(d => d.data()).reverse();
            socket.emit('dm-history', { withUsername, messages, hasMore: snap.size === 30 });
        } catch (e) {
            console.error('DM history fetch failed:', e.message);
            socket.emit('dm-history', { withUsername, messages: [], hasMore: false });
        }
    });

    // Tells the server which DM conversation (if any) this tab currently
    // has open, and whether it's in the foreground — used only to decide
    // whether a push notification should fire (see isUserActivelyViewingDM).
    socket.on('dm-view-open', ({ withUsername }) => {
        if (!withUsername) return;
        activeDMView.set(socket.id, { partner: withUsername, focused: true });
    });
    socket.on('dm-view-close', () => {
        activeDMView.set(socket.id, { partner: null, focused: true });
    });
    socket.on('dm-visibility', ({ focused }) => {
        const cur = activeDMView.get(socket.id) || { partner: null };
        activeDMView.set(socket.id, { partner: cur.partner, focused: !!focused });
    });

    socket.on('dm-typing', ({ to }) => {
        const from = socketUsers.get(socket.id);
        if (!from || !to) return;
        const targetSockets = usernameSockets.get(to);
        if (targetSockets) targetSockets.forEach(id => io.to(id).emit('dm-typing', { from }));
    });

    socket.on('dm-stop-typing', ({ to }) => {
        const from = socketUsers.get(socket.id);
        if (!from || !to) return;
        const targetSockets = usernameSockets.get(to);
        if (targetSockets) targetSockets.forEach(id => io.to(id).emit('dm-stop-typing', { from }));
    });

    socket.on('disconnect', () => {
        const username = socketUsers.get(socket.id);
        if (username) removeUsernameSocket(username, socket.id);
        socketUsers.delete(socket.id);
        rateLimitLog.delete(socket.id);
        reactionLog.delete(socket.id);
        avatarCooldown.delete(socket.id);
        reportLog.delete(socket.id);
        activeDMView.delete(socket.id);
        onlineUsersCount = Math.max(0, onlineUsersCount - 1);
        io.emit('update-online', onlineUsersCount);
        broadcastStatusLists();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
