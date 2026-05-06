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

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export const sendMail = async (input: SendMailInput): Promise<{ messageId: string }> => {
  const info = await getTransporter().sendMail({
    from: config.email.smtp.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    headers: input.headers,
  });
  return { messageId: info.messageId };
};
