import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sign } from '@galabet/fair';
import nodemailer, { type Transporter } from 'nodemailer';
import { CONFIG, type Config } from '../config';

export interface Notification {
  operatorId: string;
  event: 'run.passed' | 'run.failed' | 'entry.revoked' | 'entry.restored' | 'dispute.filed';
  detail: Record<string, unknown>;
}

/**
 * Tells operators what happened to them. Two channels, both optional:
 * - webhookUrl from their well-known file: POST { event, operatorId, detail, at }, signed with the
 *   notary key in X-Galabet-Signature so they can prove it came from us.
 * - contact email through SMTP_URL when configured.
 * Failures are logged, never thrown: notifications must not break the operation that caused them.
 */
@Injectable()
export class NotifyService {
  private readonly log = new Logger(NotifyService.name);
  private mailer?: Transporter;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    if (config.SMTP_URL) this.mailer = nodemailer.createTransport(config.SMTP_URL);
  }

  async send(n: Notification, target: { webhookUrl?: string | null; email?: string | null }) {
    // `id` is unique per delivery attempt set: store it and ignore a repeat.
    const payload = { id: randomUUID(), event: n.event, operatorId: n.operatorId, detail: n.detail, at: new Date().toISOString() };
    await Promise.allSettled([this.webhook(target.webhookUrl, payload), this.email(target.email, n)]);
  }

  private async webhook(url: string | null | undefined, payload: Record<string, unknown>) {
    if (!url) return;
    const body = canonicalJson(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'galabet-fair-notify/1.0' };
    if (/^[0-9a-f]{128}$/.test(this.config.NOTARY_SIGNING_KEY)) headers['x-galabet-signature'] = await sign(body, this.config.NOTARY_SIGNING_KEY);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) this.log.warn(`webhook ${url} -> ${res.status}`);
    } catch (e) {
      this.log.warn(`webhook ${url} failed: ${String(e)}`);
    }
  }

  private async email(to: string | null | undefined, n: Notification) {
    if (!to || !this.mailer) return;
    const subject: Record<Notification['event'], string> = {
      'run.passed': 'Galabet Fair: your conformance run passed',
      'run.failed': 'Galabet Fair: your conformance run failed',
      'entry.revoked': 'Galabet Fair: your registry entry was revoked',
      'entry.restored': 'Galabet Fair: your registry entry is active again',
      'dispute.filed': 'Galabet Fair: a dispute was filed against your domain',
    };
    try {
      await this.mailer.sendMail({
        from: this.config.MAIL_FROM,
        to,
        subject: subject[n.event],
        text: `${subject[n.event]}\n\nOperator: ${n.operatorId}\n\n${JSON.stringify(n.detail, null, 2)}\n\nhttps://galabets.org/registry/${n.operatorId}`,
      });
    } catch (e) {
      this.log.warn(`email to ${to} failed: ${String(e)}`);
    }
  }
}
