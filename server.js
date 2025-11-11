// server.js - CORE CRM CITAS + WHATSAPP
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { admin, db } from './firebaseAdmin.js';
import {
  connectToWhatsApp,
  getLatestQR,
  getConnectionStatus,
  sendMessageToLead,
  getSessionPhone,
  sendAudioMessage,
  sendVideoNote,
} from './whatsappService.js';

import { processSequences } from './scheduler.js';

dotenv.config();

// ================ FFmpeg ================
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ================ App base ================
const app = express();
const port = process.env.PORT || 3001;
const upload = multer({ dest: path.resolve('./uploads') });

// ================ Middlewares globales ================
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// ================ Helpers de teléfono ================
function toE164(num, defaultCountry = 'MX') {
  const raw = String(num || '').replace(/\D/g, '');
  if (!raw) return '';

  const parsed = parsePhoneNumberFromString(raw, defaultCountry);
  if (parsed && parsed.isValid()) return parsed.number;

  // fallback básicos MX
  if (/^\d{10}$/.test(raw)) return `+52${raw}`;
  if (/^\d{11,15}$/.test(raw) && raw.startsWith('521')) return `+${raw}`;
  if (/^\d{11,15}$/.test(raw) && raw.startsWith('52')) return `+${raw}`;

  return `+${raw}`;
}

function e164ToLeadId(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

// ================ Rutas base ================

// Ping
app.get('/', (_req, res) => {
  res.json({ message: 'Servidor CRM WhatsApp activo 🚀' });
});

// Estado de WhatsApp + QR
app.get('/api/whatsapp/status', (_req, res) => {
  res.json({
    status: getConnectionStatus(),
    qr: getLatestQR(),
  });
});

// Número conectado
app.get('/api/whatsapp/number', (_req, res) => {
  const phone = getSessionPhone();
  if (phone) return res.json({ phone });
  return res.status(503).json({ error: 'WhatsApp no conectado' });
});

// Enviar mensaje manual a un lead (por ID de lead en Firestore)
app.post('/api/whatsapp/send-message', async (req, res) => {
  try {
    const { leadId, message } = req.body;
    if (!leadId || !message) {
      return res.status(400).json({ error: 'Faltan leadId o message' });
    }

    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const data = leadSnap.data() || {};
    const rawPhone = data.telefono || data.phone || data.whatsapp;
    if (!rawPhone) {
      return res.status(400).json({ error: 'Lead sin teléfono registrado' });
    }

    const phone = toE164(rawPhone);
    const result = await sendMessageToLead(phone, message);

    // Actualiza último mensaje
    await leadSnap.ref.set(
      {
        lastMessageAt: new Date(),
        unreadCount: admin.firestore.FieldValue.increment(0),
      },
      { merge: true }
    );

    return res.json({ ok: true, result });
  } catch (error) {
    console.error('/api/whatsapp/send-message error:', error);
    return res.status(500).json({ error: error.message || String(error) });
  }
});

// Enviar audio (nota o audio normal) subiendo archivo
app.post('/api/whatsapp/send-audio', upload.single('audio'), async (req, res) => {
  const { phone, forwarded, ptt } = req.body;

  if (!phone || !req.file) {
    return res.status(400).json({ success: false, error: 'Faltan phone o archivo' });
  }

  const normalizedPhone = toE164(phone);
  const uploadPath = req.file.path;
  const m4aPath = `${uploadPath}.m4a`;

  try {
    // Convertir a m4a/mp4 compatible
    await new Promise((resolve, reject) => {
      ffmpeg(uploadPath)
        .outputOptions(['-c:a aac', '-vn'])
        .toFormat('mp4')
        .save(m4aPath)
        .on('end', resolve)
        .on('error', reject);
    });

    await sendAudioMessage(normalizedPhone, m4aPath, {
      ptt: String(ptt).toLowerCase() === 'true' || ptt === true,
      forwarded: String(forwarded).toLowerCase() === 'true' || forwarded === true,
    });

    try {
      fs.unlinkSync(uploadPath);
    } catch {}
    try {
      fs.unlinkSync(m4aPath);
    } catch {}

    return res.json({ success: true });
  } catch (error) {
    console.error('/api/whatsapp/send-audio error:', error);
    try {
      fs.unlinkSync(uploadPath);
    } catch {}
    try {
      fs.unlinkSync(m4aPath);
    } catch {}

    return res.status(500).json({ success: false, error: error.message || String(error) });
  }
});

// Enviar Video Note (PTV)
app.post('/api/whatsapp/send-video-note', async (req, res) => {
  try {
    const { phone, url, seconds } = req.body || {};
    if (!phone || !url) {
      return res.status(400).json({ ok: false, error: 'Faltan phone y url' });
    }

    const normalizedPhone = toE164(phone);
    await sendVideoNote(
      normalizedPhone,
      url,
      Number.isFinite(+seconds) ? +seconds : null
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error('/api/whatsapp/send-video-note error:', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// Marcar mensajes como leídos para un lead
app.post('/api/whatsapp/mark-read', async (req, res) => {
  try {
    const { leadId } = req.body;
    if (!leadId) {
      return res.status(400).json({ error: 'Falta leadId' });
    }

    await db.collection('leads').doc(leadId).set(
      { unreadCount: 0 },
      { merge: true }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('/api/whatsapp/mark-read error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// (Opcional inmediato para tu CRM de citas)
// Aquí luego agregamos endpoints como:
// POST /api/appointments -> crea cita + agenda secuencias de recordatorio
// GET /api/appointments -> listar citas
// etc.

// ================ Arranque servidor + WhatsApp ================
app.listen(port, () => {
  console.log(`🚀 Servidor CRM WhatsApp escuchando en puerto ${port}`);
  connectToWhatsApp().catch((err) =>
    console.error('Error al conectar WhatsApp en startup:', err)
  );
});

// ================ CRON JOBS (solo secuencias) ================
cron.schedule('*/30 * * * * *', () => {
  console.log('⏱️ processSequences:', new Date().toISOString());
  processSequences().catch((err) =>
    console.error('Error en processSequences:', err)
  );
});

export default app;
