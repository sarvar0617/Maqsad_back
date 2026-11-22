// Sends transactional e-mail (account verification) through the Resend HTTP API — no SMTP, so it works on
// hosts that block mail ports. Without RESEND_API_KEY the message is only logged, which is enough locally.

const RESEND_URL = 'https://api.resend.com/emails'

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// The verification e-mail, in Uzbek and English (the app's two languages).
export function verificationEmail({ name, link }) {
  const safeName = escapeHtml(name)
  const safeLink = escapeHtml(link)
  return {
    subject: 'Maqsad: emailingizni tasdiqlang / Confirm your email',
    text: `Salom, ${name}!\n\nMaqsad akkauntingizni faollashtirish uchun quyidagi havolani oching (24 soat amal qiladi):\n${link}\n\nAgar siz ro'yxatdan o'tmagan bo'lsangiz, bu xatni e'tiborsiz qoldiring.\n\n---\nHi ${name}, open the link above within 24 hours to confirm your Maqsad account. If you did not sign up, ignore this email.`,
    html: `<!doctype html><html><body style="margin:0;background:#f4f5fb;font-family:Arial,Helvetica,sans-serif;color:#1d1f33">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:20px;font-weight:bold;color:#5b3fd6">Maqsad</td></tr>
<tr><td style="padding-top:16px;font-size:16px;line-height:1.5">Salom, ${safeName}!<br>Akkauntingizni faollashtirish uchun emailingizni tasdiqlang.</td></tr>
<tr><td style="padding:24px 0"><a href="${safeLink}" style="display:inline-block;background:#6d4cff;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">Emailni tasdiqlash</a></td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#5c6070">Havola 24 soat amal qiladi. Agar siz ro'yxatdan o'tmagan bo'lsangiz, bu xatni e'tiborsiz qoldiring.<br><br>Hi ${safeName}, tap the button within 24 hours to confirm your Maqsad account. If you did not sign up, ignore this email.</td></tr>
<tr><td style="padding-top:16px;font-size:12px;color:#8a8ea0;word-break:break-all">${safeLink}</td></tr>
</table></td></tr></table></body></html>`,
  }
}

// Returns send(to, { subject, html, text }) -> Promise<void>; throws when the provider refuses the message.
export function createMailer({ apiKey, from, fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!apiKey) {
    return {
      configured: false,
      async send(to, message) {
        log.warn(`[mail] RESEND_API_KEY is not set; not sending "${message.subject}" to ${to}. Text:\n${message.text}`)
      },
    }
  }
  return {
    configured: true,
    async send(to, { subject, html, text }) {
      const response = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Resend answered ${response.status}: ${body.slice(0, 300)}`)
      }
    },
  }
}
