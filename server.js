import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';

dotenv.config();
const app = express();
app.use(express.json());

const allow = (process.env.CORS_ORIGIN || '').split(',').map(s=>s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allow.length===0 || allow.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

const db = await open({ filename: './data/bookings.sqlite', driver: sqlite3.Database });
await db.exec(`
CREATE TABLE IF NOT EXISTS bookings(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 role TEXT NOT NULL,
 student_number TEXT,
 company TEXT,
 name TEXT,
 phone TEXT,
 email TEXT,
 field TEXT,
 date TEXT NOT NULL,
 start_time TEXT NOT NULL,
 end_time TEXT NOT NULL,
 participants INTEGER,
 reason TEXT,
 status TEXT NOT NULL DEFAULT 'pending',
 approval_token TEXT,
 invoice_json TEXT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_slot ON bookings(date, start_time);
`);

const OPEN = 9;
const CLOSE = 17;
const HOURS = Array.from({length: CLOSE-OPEN}, (_,i)=>String(OPEN+i).padStart(2,'0')+':00');

function buildMailer(){
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || 'false') === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS }
    });
  }
  return null;
}
const mailer = buildMailer();

function nextHour(hhmm){ const h = Number(hhmm.slice(0,2)); return String(h+1).padStart(2,'0')+':00'; }
const PUBLIC_BASE = process.env.PUBLIC_BASE || '';

app.get('/health', (req,res)=> res.json({ ok:true }));

app.get('/availability', async (req,res)=>{
  const { date } = req.query;
  if (!date || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return res.status(400).json({ error:'Invalid or missing date (YYYY-MM-DD)' });
  const taken = await db.all(`SELECT start_time FROM bookings WHERE date=? AND status IN ('pending','approved')`, date);
  const set = new Set(taken.map(r=>r.start_time));
  const free = HOURS.filter(h=>!set.has(h)).map(start => ({ start, end: nextHour(start) }));
  res.json({ date, slots: free });
});

app.post('/book', async (req,res)=>{
  try{
    const {
      role, studentNumber, company, name, phone, email, field,
      date, startTimes = [], participants, reason, acceptedTerms, invoice = {}
    } = req.body || {};

    if (!['student','staff','uni','external'].includes(role)) throw new Error('role');
    if (role==='student' && !studentNumber) throw new Error('studentNumber');
    if (role==='external' && !company) throw new Error('company');
    if (!name || !phone || !email) throw new Error('contact');
    if (!date || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) throw new Error('date');
    if (!Array.isArray(startTimes) || startTimes.length===0) throw new Error('time');
    if (!acceptedTerms) throw new Error('terms');

    const placeholders = startTimes.map(()=>'?').join(',');
    const conflicts = await db.all(`SELECT start_time FROM bookings WHERE date=? AND start_time IN (${placeholders})`, date, ...startTimes);
    if (conflicts.length) return res.status(409).json({ error:'Time slot already booked' });

    const token = crypto.randomBytes(20).toString('hex');
    const createdAt = new Date().toISOString();
    let lastID = null;

    for (const startTime of startTimes){
      const endTime = nextHour(startTime);
      const r = await db.run(
        `INSERT INTO bookings(role, student_number, company, name, phone, email, field, date, start_time, end_time, participants, reason, status, approval_token, invoice_json, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`,
        role, studentNumber||null, company||null, name, phone, email, field||null, date, startTime, endTime,
        participants||null, reason||'', token, JSON.stringify(invoice||{}), createdAt
      );
      lastID = r.lastID;
    }

    const to = process.env.NOTIFY_TO;
    if (mailer && to){
      const approveUrl = `${PUBLIC_BASE || 'https://'+(req.headers.host||'')}/approve/${token}`;
      const rejectUrl  = `${PUBLIC_BASE || 'https://'+(req.headers.host||'')}/reject/${token}`;
      const subject = `New booking request: ${date} ${startTimes.join(', ')} — ${name}`;
      const html = `
        <h2>New Studio Booking (pending)</h2>
        <ul>
          <li><b>Role:</b> ${role}${studentNumber?` (#${studentNumber})`:''}${company?` (${company})`:''}</li>
          <li><b>Date:</b> ${date}</li>
          <li><b>Time(s):</b> ${startTimes.join(', ')}</li>
          <li><b>Name:</b> ${name}</li>
          <li><b>Phone:</b> ${phone}</li>
          <li><b>Email:</b> ${email}</li>
          ${field?`<li><b>Field:</b> ${field}</li>`:''}
          ${reason?`<li><b>Reason:</b> ${reason}</li>`:''}
        </ul>
        <p>
          <a href="${approveUrl}" style="padding:10px 14px;background:#0a0;color:#fff;border-radius:8px;text-decoration:none">Approve</a>
          &nbsp;&nbsp;
          <a href="${rejectUrl}" style="padding:10px 14px;background:#900;color:#fff;border-radius:8px;text-decoration:none">Reject</a>
        </p>
      `;
      try{ await mailer.sendMail({ from: process.env.SMTP_USER||process.env.GMAIL_USER||'no-reply@studio', to, subject, html }); } catch {}
    }

    res.json({ ok:true, id:lastID, token });
  }catch(e){
    res.status(400).json({ error: e.message || 'Invalid payload' });
  }
});

app.get('/approve/:token', async (req,res)=>{
  const { token } = req.params;
  const r = await db.run(`UPDATE bookings SET status='approved' WHERE approval_token=?`, token);
  if (!r.changes) return res.status(404).send('<h2>Not found</h2>');
  res.send('<h2>Approved ✅</h2><p>This booking is now confirmed.</p>');
});
app.get('/reject/:token', async (req,res)=>{
  const { token } = req.params;
  const r = await db.run(`UPDATE bookings SET status='rejected' WHERE approval_token=?`, token);
  if (!r.changes) return res.status(404).send('<h2>Not found</h2>');
  res.send('<h2>Rejected ❌</h2><p>This booking has been declined.</p>');
});

const port = process.env.PORT || 10000;
app.listen(port, ()=> console.log('Studio booking API on :' + port));