import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

let _transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: config.email.smtp.host,
    port: config.email.smtp.port,
    secure: config.email.smtp.port === 465, // 465 = SMTPS, 587 = STARTTLS
    auth: {
      user: config.email.smtp.user,
      pass: config.email.smtp.pass,
    },
  });
  return _transporter;
};

// Pulls the email address out of an RFC 5322 "Name <addr@example.com>" string.
// If the input has no angle brackets, treats the whole string as the address.
const extractAddress = (rfc822: string): string => {
  const m = rfc822.match(/<([^>]+)>\s*$/);
  return (m?.[1] ?? rfc822).trim();
};

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  // Optional override of the From DISPLAY NAME. The email address is always
  // taken from SMTP_FROM — Gmail SMTP refuses to send From: addresses other
  // than the authenticated user or a verified send-as alias, so we never
  // try to change it from here. When provided, the header becomes
  // `<senderName> <address-from-SMTP_FROM>`. When omitted, SMTP_FROM is used
  // verbatim (preserving any display name baked into the env var).
  senderName?: string;
  // Optional Reply-To address. When set, customer replies route here instead
  // of the From address. Use for customer-facing sends where the merchant
  // wants replies to land in a support/customer-service inbox.
  replyTo?: string;
}

export const sendMail = async (input: SendMailInput): Promise<{ messageId: string }> => {
  const from = input.senderName
    ? { name: input.senderName, address: extractAddress(config.email.smtp.from) }
    : config.email.smtp.from;
  const info = await getTransporter().sendMail({
    from,
    replyTo: input.replyTo,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    headers: input.headers,
  });
  return { messageId: info.messageId };
};
