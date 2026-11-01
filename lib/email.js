const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const nodemailer = require('nodemailer');

const mode = process.env.EMAIL_MODE || 'smtp';
if (!['smtp', 'preview'].includes(mode)) {
  throw new Error('EMAIL_MODE must be smtp or preview');
}
if (mode === 'preview' && process.env.NODE_ENV === 'production') {
  throw new Error('Use EMAIL_MODE=smtp in production; preview never delivers email');
}

const fromEmail = process.env.FROM_EMAIL || (mode === 'preview'
  ? 'Kris Kringle <no-reply@example.test>' : undefined);

let transporter;
if (mode === 'preview') {
  const directory = path.resolve(process.env.EMAIL_PREVIEW_DIR || '.local/emails');
  const transport = nodemailer.createTransport({ jsonTransport: true });
  transporter = {
    async sendMail(options) {
      const result = await transport.sendMail(options);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const basename = path.join(directory, `${Date.now()}-${randomUUID()}`);
      fs.writeFileSync(`${basename}.json`, result.message, { mode: 0o600 });
      fs.writeFileSync(`${basename}.html`, options.html || '', { mode: 0o600 });
      console.log(`Email preview saved: ${basename}.html`);
      return result;
    },
    close() { transport.close(); },
  };
} else {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    requireTLS: true,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

module.exports = { transporter, fromEmail };
