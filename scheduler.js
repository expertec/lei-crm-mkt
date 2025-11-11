// scheduler.js - Motor de automatizaciones para CRM (secuencias + helper enviarMensaje)

import { getWhatsAppSock } from './whatsappService.js';
import * as Q from './queue.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

// =============== TASK LOCK ===============
// Evita que se ejecute el mismo job en paralelo (por si el cron se empalma)
const _taskLocks = new Map();

async function withTaskLock(taskName, timeoutMinutes = 5, fn) {
  const now = Date.now();
  const existing = _taskLocks.get(taskName);

  if (existing && now - existing < timeoutMinutes * 60 * 1000) {
    console.log(`[withTaskLock] ${taskName} ya se está ejecutando, skip.`);
    return 0;
  }

  _taskLocks.set(taskName, now);
  try {
    return await fn();
  } finally {
    _taskLocks.delete(taskName);
  }
}

// =============== TELÉFONOS / PLACEHOLDERS ===============

function toE164(num, defaultCountry = 'MX') {
  const raw = String(num || '').replace(/\D/g, '');
  if (!raw) return '';

  const p = parsePhoneNumberFromString(raw, defaultCountry);
  if (p && p.isValid()) return p.number;

  if (/^\d{10}$/.test(raw)) return `+52${raw}`;
  if (/^\d{11,15}$/.test(raw) && raw.startsWith('521')) return `+${raw}`;
  if (/^\d{11,15}$/.test(raw) && raw.startsWith('52')) return `+${raw}`;

  return `+${raw}`;
}

function normalizePhoneForWA(phone) {
  let num = String(phone || '').replace(/\D/g, '');
  if (num.length === 12 && num.startsWith('52') && !num.startsWith('521')) {
    return '521' + num.slice(2);
  }
  if (num.length === 10) return '521' + num;
  return num;
}

function e164ToJid(e164) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return `${normalizePhoneForWA(digits)}@s.whatsapp.net`;
}

function firstName(n = '') {
  return String(n).trim().split(/\s+/)[0] || '';
}

function replacePlaceholders(template, leadData) {
  const str = String(template || '');
  return str.replace(/\{\{(\w+)\}\}/g, (_, field) => {
    const value = leadData?.[field] || '';
    if (field === 'nombre') return firstName(value);
    return value;
  });
}

// =============== ENVÍO POR WHATSAPP (GENÉRICO) ===============
// Útil si en algún punto quieres disparar mensajes desde otras automatizaciones
// reutilizando mismo formato que tus secuencias.

export async function enviarMensaje(lead, mensaje) {
  try {
    const sock = getWhatsAppSock();
    if (!sock) {
      console.warn('[enviarMensaje] Socket de WhatsApp no disponible');
      return;
    }

    const e164 = toE164(lead.telefono || lead.phone || lead.whatsapp);
    if (!e164) {
      console.warn('[enviarMensaje] Lead sin teléfono válido', { lead });
      return;
    }

    const jid = e164ToJid(e164);
    const tipo = (mensaje?.type || 'texto').toLowerCase();
    const contenido = mensaje?.contenido || '';

    switch (tipo) {
      case 'texto': {
        const text = replacePlaceholders(contenido, lead).trim();
        if (text) {
          await sock.sendMessage(jid, { text, linkPreview: false });
        }
        break;
      }

      case 'formulario': {
        const raw = String(contenido || '');
        const text = raw
          .replace('{{telefono}}', e164.replace(/\D/g, ''))
          .replace('{{nombre}}', encodeURIComponent(lead.nombre || ''))
          .replace(/\r?\n/g, ' ')
          .trim();
        if (text) {
          await sock.sendMessage(jid, { text, linkPreview: false });
        }
        break;
      }

      case 'audio': {
        const audioUrl = replacePlaceholders(contenido, lead).trim();
        if (audioUrl) {
          await sock.sendMessage(jid, { audio: { url: audioUrl }, ptt: true });
        }
        break;
      }

      case 'imagen': {
        const url = replacePlaceholders(contenido, lead).trim();
        if (url) {
          await sock.sendMessage(jid, { image: { url } });
        }
        break;
      }

      case 'video': {
        const url = replacePlaceholders(contenido, lead).trim();
        if (url) {
          await sock.sendMessage(jid, { video: { url } });
        }
        break;
      }

      default:
        console.warn('[enviarMensaje] Tipo desconocido:', mensaje?.type);
    }
  } catch (err) {
    console.error('[enviarMensaje] Error al enviar mensaje:', err);
  }
}

// =============== SECUENCIAS (COLA) ===============
// Aquí conectamos el CRON con la cola de secuencias definida en queue.js

export async function processSequences(options = {}) {
  const { batchSize = 200 } = options;

  return withTaskLock('processSequences', 5, async () => {
    const fn =
      typeof Q.processDueSequenceJobs === 'function'
        ? Q.processDueSequenceJobs
        : (typeof Q.processQueue === 'function'
            ? Q.processQueue
            : null);

    if (!fn) {
      console.warn('⚠️ No hay función de proceso de cola exportada desde queue.js');
      return 0;
    }

    try {
      const processed = await fn({ batchSize });
      console.log(`✅ processSequences: ${processed} jobs procesados`);
      return processed;
    } catch (err) {
      console.error('❌ Error en processSequences:', err);
      return 0;
    }
  });
}
