import http from 'node:http';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';

/**
 * Faux Stripe pour les tests (l'API réelle n'est pas joignable depuis l'environnement de développement).
 * Reproduit ce que Sonikc utilise : Checkout, remboursements, virements et reprises, comptes Express,
 * webhooks signés comme Stripe. Pages /pay/… et /onboard/… : les écrans de paiement et d'activation.
 * Un test réel contre Stripe (mode test) tourne en plus sur GitHub.
 */

type Obj = Record<string, unknown>;
export type FakeStripe = {
  url: string;
  close(): Promise<void>;
  state: { sessions: Map<string, Obj>; transfers: Obj[]; reversals: Obj[]; refunds: Obj[]; accounts: Map<string, Obj>; events: Obj[] };
  pay(sessionId: string, opts?: { cardCountry?: string; webhook?: boolean }): Promise<Obj>;
  expire(sessionId: string): Promise<void>;
  activate(accountId: string): void;
  replay(eventId: string, opts?: { tamper?: boolean; oldTimestamp?: boolean }): Promise<number>;
  refundFromDashboard(paymentIntentId: string): Promise<void>;
  /** Fait échouer la prochaine requête dont le chemin correspond (panne de Stripe simulée). */
  failNext(path: RegExp, status?: number, opts?: { afterSuccess?: boolean }): void;
  clearFailures(): void;
  /** Retarde la prochaine requête dont le chemin correspond (appel lent à Stripe). */
  delayNext(path: RegExp, ms: number): void;
  /** Comme Stripe juste après un paiement : frais pas encore disponibles pendant n lectures. */
  feeLate(reads: number): void;
  /** Abonnements (Stripe Billing) : modifier ou terminer comme le ferait Stripe, avec l'événement signé. */
  updateSubscription(id: string, patch: { status?: string; price?: string; cancel_at_period_end?: boolean }): Promise<number>;
  deleteSubscription(id: string): Promise<number>;
  billing: { customers: Map<string, Obj>; prices: Map<string, Obj>; products: Map<string, Obj>; subscriptions: Map<string, Obj>; taxRates: Obj[]; portalConfigs: Obj[] };
  /** Envoie un événement signé quelconque (litiges…). */
  emitEvent(type: string, object: Obj): Promise<number>;
};

const id = (p: string) => `${p}_test_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;

/** a[b][0][c]=v → { a: { b: [ { c: v } ] } } (encodage des requêtes du SDK Stripe). */
export function parseForm(body: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const parts = k.replace(/\]/g, '').split('[');
    let cur: Obj | unknown[] = out;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      const key = /^\d+$/.test(p) && Array.isArray(cur) ? Number(p) : p;
      const c = cur as Record<string | number, unknown>;
      if (last) c[key] = v;
      else { c[key] ??= nextIsIndex ? [] : {}; cur = c[key] as Obj; }
    });
  }
  return out;
}

export async function startFakeStripe(opts: { port?: number; webhookSecret: string; webhook: (payload: string, signature: string) => Promise<number> }): Promise<FakeStripe> {
  const sessions = new Map<string, Obj>();
  const accounts = new Map<string, Obj>();
  const charges = new Map<string, Obj>();
  const intents = new Map<string, Obj>();
  const transfers: Obj[] = [], reversals: Obj[] = [], refunds: Obj[] = [], events: Obj[] = [];
  const idem = new Map<string, unknown>();
  const customers = new Map<string, Obj>(), prices = new Map<string, Obj>(), products = new Map<string, Obj>(), subscriptions = new Map<string, Obj>();
  const taxRates: Obj[] = [], portalConfigs: Obj[] = [];
  const nowS = () => Math.floor(Date.now() / 1000);
  const subView = (sub: Obj) => {
    const price = prices.get(sub._price as string)!;
    const end = (sub._period_end as number);
    return { ...Object.fromEntries(Object.entries(sub).filter(([k]) => !k.startsWith('_'))),
      items: { object: 'list', data: [{ id: `si_${(sub.id as string).slice(4)}`, object: 'subscription_item', price, quantity: 1, current_period_end: end }] } };
  };
  const createSubscription = (customer: string, priceId: string, data: Obj) => {
    const trial = Number((data as { trial_period_days?: string }).trial_period_days ?? 0);
    const price = prices.get(priceId)!;
    const period = (price.recurring as Obj).interval === 'year' ? 365 * 86400 : 30 * 86400;
    const sub: Obj = { id: id('sub'), object: 'subscription', customer, status: trial ? 'trialing' : 'active', cancel_at_period_end: false,
      trial_start: trial ? nowS() : null, trial_end: trial ? nowS() + trial * 86400 : null, metadata: (data.metadata as Obj) ?? {},
      _price: priceId, _period_end: nowS() + (trial ? trial * 86400 : period) };
    subscriptions.set(sub.id as string, sub);
    return sub;
  };
  const failures: { path: RegExp; status: number; afterSuccess: boolean }[] = [];
  const delays: { path: RegExp; ms: number }[] = [];
  let feeLateReads = 0;
  const feeObj = (ch: Obj) => (feeLateReads > 0 ? (feeLateReads--, null) : { id: id('txn'), object: 'balance_transaction', fee: ch._fee });
  let base = '';

  const sign = (payload: string, timestamp?: number) =>
    Stripe.webhooks.generateTestHeaderString({ payload, secret: opts.webhookSecret, timestamp });
  async function emit(type: string, object: Obj) {
    const ev = { id: id('evt'), object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object }, livemode: false };
    events.push(ev);
    const payload = JSON.stringify(ev);
    return opts.webhook(payload, sign(payload));
  }

  function expandSession(s: Obj, expand: string[]) {
    const out = { ...s };
    if (s.payment_intent && expand.some((e) => e.startsWith('payment_intent'))) {
      const pi = { ...intents.get(s.payment_intent as string)! };
      if (expand.some((e) => e.startsWith('payment_intent.latest_charge'))) {
        const ch = { ...charges.get(pi.latest_charge as string)! };
        if (expand.includes('payment_intent.latest_charge.balance_transaction')) ch.balance_transaction = feeObj(ch);
        pi.latest_charge = ch;
      }
      out.payment_intent = pi;
    }
    return out;
  }

  async function pay(sessionId: string, o: { cardCountry?: string; webhook?: boolean } = {}) {
    const s = sessions.get(sessionId);
    if (!s) throw new Error('session inconnue');
    if (s.status !== 'open') return s;
    if (s.mode === 'subscription') {
      const li = (s.line_items as Obj[])[0];
      const sub = createSubscription(s.customer as string, li.price as string, (s.subscription_data as Obj) ?? {});
      Object.assign(s, { status: 'complete', payment_status: sub.status === 'trialing' ? 'no_payment_required' : 'paid', subscription: sub.id });
      if (o.webhook !== false) {
        await emit('checkout.session.completed', { ...Object.fromEntries(Object.entries(s).filter(([k]) => !['line_items', 'subscription_data', 'payment_intent_data'].includes(k))) });
        await emit('customer.subscription.created', subView(sub));
      }
      return s;
    }
    const amount = s.amount_total as number;
    const ch = { id: id('ch'), object: 'charge', amount, amount_refunded: 0, currency: 'eur', payment_intent: '', refunded: false,
      payment_method_details: { type: 'card', card: { country: o.cardCountry ?? 'FR' } }, _fee: Math.round(amount * 0.015) + 25 };
    const pi = { id: id('pi'), object: 'payment_intent', amount, currency: 'eur', status: 'succeeded', latest_charge: ch.id,
      metadata: (s.payment_intent_data as Obj | undefined)?.metadata ?? {}, transfer_group: (s.payment_intent_data as Obj | undefined)?.transfer_group };
    ch.payment_intent = pi.id;
    charges.set(ch.id, ch); intents.set(pi.id, pi);
    Object.assign(s, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
    if (o.webhook !== false) await emit('checkout.session.completed', { ...s });
    return s;
  }

  async function refund(piId: string, fromDashboard = false) {
    const pi = intents.get(piId);
    if (!pi) return { status: 404, body: { error: { message: 'No such payment_intent' } } };
    const ch = charges.get(pi.latest_charge as string)!;
    if (ch.refunded) return { status: 400, body: { error: { message: 'Charge already refunded', code: 'charge_already_refunded' } } };
    Object.assign(ch, { refunded: true, amount_refunded: ch.amount });
    const re = { id: id('re'), object: 'refund', amount: ch.amount, payment_intent: piId, charge: ch.id, status: 'succeeded' };
    refunds.push({ ...re, fromDashboard });
    // Comme Stripe : l'événement arrive après la réponse.
    setTimeout(() => { emit('charge.refunded', { ...ch }).catch(() => {}); }, 50);
    return { status: 200, body: re };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    try {
      // ── Écrans (navigateur) ──
      let m = /^\/pay\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const s = sessions.get(m[1]);
        if (!s) return send(404, '<h1>Session inconnue</h1>');
        if (req.method === 'POST') {
          await pay(m[1], { cardCountry: new URLSearchParams(raw).get('country') ?? 'FR' });
          return send(303, '', { location: s.success_url as string });
        }
        const items = ((s.line_items as Obj[]) ?? []).map((li) => {
          if (!li.price_data) {
            const pr = prices.get(li.price as string)!;
            return `<li>${products.get(pr.product as string)?.name ?? 'Abonnement'} (${pr.lookup_key}) — ${(Number(pr.unit_amount) / 100).toFixed(2)} €</li>`;
          }
          const pd = li.price_data as Obj;
          return `<li>${(pd.product_data as Obj).name} — ${(Number(pd.unit_amount) / 100).toFixed(2)} €</li>`;
        }).join('');
        return send(200, `<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width"><title>Paiement test</title>
          <body style="font-family:sans-serif;max-width:420px;margin:40px auto"><h1>Faux paiement Stripe (test)</h1><ul>${items}</ul>
          <p>Total : <strong data-testid="fake-total">${(Number(s.amount_total) / 100).toFixed(2)} €</strong></p><p>${s.customer_email}</p>
          <form method="post"><label>Pays de la carte <select name="country"><option>FR</option><option>DE</option><option>BE</option><option>US</option></select></label>
          <button type="submit">Payer</button></form><a href="${s.cancel_url}">Annuler</a></body></html>`);
      }
      m = /^\/portal\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const sub = [...subscriptions.values()].find((x) => x.customer === m![1] && x.status !== 'canceled');
        if (req.method === 'POST') {
          const f = new URLSearchParams(raw);
          if (sub && f.get('price')) await updateSubscription(sub.id as string, { price: f.get('price')! });
          if (sub && f.get('cancel')) await updateSubscription(sub.id as string, { cancel_at_period_end: true });
          return send(303, '', { location: url.searchParams.get('return') ?? '/' });
        }
        const options = [...prices.values()].filter((p) => p.active && p.lookup_key)
          .map((p) => `<button name="price" value="${p.id}">Passer à ${p.lookup_key}</button>`).join(' ');
        return send(200, `<!doctype html><html lang="fr"><title>Portail test</title><body><h1>Faux portail Stripe</h1>
          <p data-testid="portal-current">${sub ? `${prices.get(sub._price as string)?.lookup_key} (${sub.status})` : 'aucun abonnement'}</p>
          <form method="post">${options} <button name="cancel" value="1">Résilier</button></form></body></html>`);
      }
      m = /^\/onboard\/([^/]+)$/.exec(url.pathname);
      if (m) {
        if (req.method === 'POST') { activate(m[1]); return send(303, '', { location: url.searchParams.get('return') ?? '/' }); }
        return send(200, `<!doctype html><html lang="fr"><title>Activation test</title><body><h1>Faux formulaire Stripe Express</h1>
          <form method="post"><button type="submit">Valider mes informations</button></form></body></html>`);
      }

      // ── API ──
      const d = delays.findIndex((x) => x.path.test(url.pathname) && req.method === 'POST');
      if (d >= 0) { const [delay] = delays.splice(d, 1); await new Promise((r) => setTimeout(r, delay.ms)); }
      // Panne simulée : erreur avant traitement, ou traitement fait mais réponse perdue (afterSuccess).
      const f = failures.findIndex((x) => x.path.test(url.pathname));
      let loseResponse = false;
      if (f >= 0) {
        const [fail] = failures.splice(f, 1);
        if (!fail.afterSuccess) return send(fail.status, { error: { type: 'api_error', message: 'fake-stripe: panne simulée' } });
        loseResponse = true;
      }
      const key = req.headers['idempotency-key'] as string | undefined;
      if (key && req.method === 'POST' && idem.has(`${url.pathname}|${key}`)) {
        if (loseResponse) return send(500, { error: { type: 'api_error', message: 'fake-stripe: réponse perdue' } });
        return send(200, idem.get(`${url.pathname}|${key}`));
      }
      const body = req.method === 'POST' ? parseForm(raw) : {};
      const expand = [...url.searchParams].filter(([k]) => k.startsWith('expand')).map(([, v]) => v).concat((body.expand as string[]) ?? []);
      const ok = (o: unknown) => {
        if (key && req.method === 'POST') idem.set(`${url.pathname}|${key}`, o);
        if (loseResponse) return send(500, { error: { type: 'api_error', message: 'fake-stripe: réponse perdue' } });
        send(200, o);
      };

      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const items = (body.line_items as Obj[]) ?? [];
        if (body.mode === 'subscription') {
          if (!customers.has(body.customer as string)) return send(400, { error: { message: 'No such customer' } });
          if (items.some((li) => !prices.has(li.price as string))) return send(400, { error: { message: 'No such price' } });
        }
        const total = items.reduce((a, li) => a + Number(li.price_data ? (li.price_data as Obj).unit_amount : prices.get(li.price as string)!.unit_amount) * Number(li.quantity ?? 1), 0);
        const s: Obj = { id: id('cs'), object: 'checkout.session', status: 'open', payment_status: 'unpaid', amount_total: total, currency: 'eur',
          customer_email: body.customer_email, metadata: body.metadata ?? {}, payment_intent: null, success_url: body.success_url, cancel_url: body.cancel_url,
          expires_at: Number(body.expires_at), line_items: items, payment_intent_data: body.payment_intent_data, client_reference_id: body.client_reference_id,
          mode: body.mode ?? 'payment', customer: body.customer ?? null, subscription: null, subscription_data: body.subscription_data };
        s.url = `${base}/pay/${s.id}`;
        sessions.set(s.id as string, s);
        const { line_items: _l, payment_intent_data: _p, subscription_data: _sd, ...pub } = s;
        return ok(pub);
      }
      m = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const s = sessions.get(m[1]);
        if (!s) return send(404, { error: { message: 'No such checkout.session' } });
        const { line_items: _l, payment_intent_data: _p, subscription_data: _sd, ...pub } = expandSession(s, expand);
        return send(200, pub);
      }
      // ── Billing ──
      if (req.method === 'POST' && url.pathname === '/v1/customers') {
        const c = { id: id('cus'), object: 'customer', email: body.email, metadata: body.metadata ?? {} };
        customers.set(c.id, c);
        return ok(c);
      }
      if (url.pathname === '/v1/products') {
        if (req.method === 'GET') return send(200, { object: 'list', data: [...products.values()], has_more: false });
        const pr = { id: id('prod'), object: 'product', name: body.name, active: true, metadata: body.metadata ?? {} };
        products.set(pr.id, pr);
        return ok(pr);
      }
      if (url.pathname === '/v1/prices') {
        if (req.method === 'GET') {
          const keys = [...url.searchParams].filter(([k]) => k.startsWith('lookup_keys')).map(([, v]) => v);
          return send(200, { object: 'list', has_more: false, data: [...prices.values()].filter((p) => p.active && (!keys.length || keys.includes(p.lookup_key as string))) });
        }
        if (body.transfer_lookup_key === 'true') for (const p of prices.values()) if (p.lookup_key === body.lookup_key) p.lookup_key = null;
        const pr = { id: id('price'), object: 'price', active: true, currency: body.currency, unit_amount: Number(body.unit_amount), product: body.product,
          tax_behavior: body.tax_behavior, recurring: { interval: (body.recurring as Obj)?.interval }, lookup_key: body.lookup_key ?? null, metadata: body.metadata ?? {} };
        prices.set(pr.id, pr);
        return ok(pr);
      }
      if (url.pathname === '/v1/tax_rates') {
        if (req.method === 'GET') return send(200, { object: 'list', data: taxRates, has_more: false });
        const t = { id: id('txr'), object: 'tax_rate', active: true, display_name: body.display_name, percentage: Number(body.percentage),
          inclusive: body.inclusive === 'true', country: body.country, metadata: body.metadata ?? {} };
        taxRates.push(t);
        return ok(t);
      }
      m = /^\/v1\/subscriptions\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'DELETE' && m) {
        const sub = subscriptions.get(m[1]);
        if (!sub) return send(404, { error: { message: 'No such subscription' } });
        sub.status = 'canceled';
        setTimeout(() => { emit('customer.subscription.deleted', subView(sub)).catch(() => {}); }, 20);
        return send(200, subView(sub));
      }
      if (req.method === 'GET' && m) {
        const sub = subscriptions.get(m[1]);
        return sub ? send(200, subView(sub)) : send(404, { error: { message: 'No such subscription' } });
      }
      if (url.pathname === '/v1/billing_portal/configurations') {
        if (req.method === 'GET') return send(200, { object: 'list', data: portalConfigs, has_more: false });
        const cfg = { id: id('bpc'), object: 'billing_portal.configuration', active: true, features: body.features, metadata: body.metadata ?? {} };
        portalConfigs.push(cfg);
        return ok(cfg);
      }
      if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
        if (!customers.has(body.customer as string)) return send(400, { error: { message: 'No such customer' } });
        return ok({ id: id('bps'), object: 'billing_portal.session', url: `${base}/portal/${body.customer}?return=${encodeURIComponent(body.return_url as string)}` });
      }
      m = /^\/v1\/charges\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const ch = charges.get(m[1]);
        if (!ch) return send(404, { error: { message: 'No such charge' } });
        return send(200, { ...ch, balance_transaction: expand.includes('balance_transaction') ? feeObj(ch) : null });
      }
      if (req.method === 'POST' && url.pathname === '/v1/refunds') {
        const r = await refund(body.payment_intent as string);
        return r.status === 200 ? ok(r.body) : send(r.status, r.body);
      }
      if (req.method === 'POST' && url.pathname === '/v1/transfers') {
        const acct = accounts.get(body.destination as string);
        if (!acct || (acct.capabilities as Obj).transfers !== 'active') return send(400, { error: { message: 'Destination account cannot receive transfers' } });
        if (!(Number(body.amount) > 0)) return send(400, { error: { message: 'Invalid amount' } });
        const t = { id: id('tr'), object: 'transfer', amount: Number(body.amount), currency: body.currency, destination: body.destination,
          transfer_group: body.transfer_group, source_transaction: body.source_transaction ?? null, metadata: body.metadata ?? {}, reversed: false, amount_reversed: 0 };
        transfers.push(t);
        return ok(t);
      }
      if (req.method === 'GET' && url.pathname === '/v1/transfers') {
        const group = url.searchParams.get('transfer_group');
        return send(200, { object: 'list', has_more: false, data: transfers.filter((t) => !group || t.transfer_group === group) });
      }
      m = /^\/v1\/transfers\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const t = transfers.find((x) => x.id === m![1]);
        return t ? send(200, t) : send(404, { error: { message: 'No such transfer' } });
      }
      m = /^\/v1\/transfers\/([^/]+)\/reversals$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const t = transfers.find((x) => x.id === m![1]);
        if (!t) return send(404, { error: { message: 'No such transfer' } });
        if (t.reversed) return send(400, { error: { message: 'Transfer already reversed' } });
        t.reversed = true;
        t.amount_reversed = t.amount;
        const r = { id: id('trr'), object: 'transfer_reversal', amount: t.amount, transfer: t.id };
        reversals.push(r);
        return ok(r);
      }
      if (req.method === 'POST' && url.pathname === '/v1/accounts') {
        // Comme Stripe pour cette plateforme : l'ancien « type » est refusé, il faut les propriétés de contrôle avec Stripe porteur du risque.
        const ctl = body.controller as { losses?: { payments?: string } } | undefined;
        if (body.type || ctl?.losses?.payments !== 'stripe') {
          return send(400, { error: { type: 'invalid_request_error', message: 'Use controller properties with losses collected by Stripe.' } });
        }
        const a = { id: id('acct').replace('acct_test_', 'acct_'), object: 'account', controller: body.controller, country: body.country, details_submitted: false,
          payouts_enabled: false, charges_enabled: false, capabilities: { transfers: 'inactive', card_payments: 'inactive' }, metadata: body.metadata ?? {} };
        accounts.set(a.id, a);
        return ok(a);
      }
      m = /^\/v1\/accounts\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const a = accounts.get(m[1]);
        return a ? send(200, a) : send(404, { error: { message: 'No such account' } });
      }
      if (req.method === 'POST' && url.pathname === '/v1/account_links') {
        return ok({ object: 'account_link', url: `${base}/onboard/${body.account}?return=${encodeURIComponent(body.return_url as string)}`, expires_at: 0 });
      }
      // ── Aides de test ──
      if (url.pathname === '/__test/state') return send(200, { transfers, reversals, refunds, accounts: [...accounts.values()], events: events.length });
      return send(404, { error: { message: `fake-stripe: ${req.method} ${url.pathname} non géré` } });
    } catch (e) {
      return send(500, { error: { message: (e as Error).message } });
    }
  });

  async function updateSubscription(subId: string, patch: { status?: string; price?: string; cancel_at_period_end?: boolean }) {
    const sub = subscriptions.get(subId)!;
    if (patch.price) sub._price = patch.price;
    if (patch.status) sub.status = patch.status;
    if (patch.cancel_at_period_end !== undefined) sub.cancel_at_period_end = patch.cancel_at_period_end;
    return emit('customer.subscription.updated', subView(sub));
  }

  function activate(acctId: string) {
    const a = accounts.get(acctId);
    if (a) Object.assign(a, { details_submitted: true, payouts_enabled: true, charges_enabled: true, capabilities: { transfers: 'active', card_payments: 'active' } });
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url: base,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    state: { sessions, transfers, reversals, refunds, accounts, events },
    pay,
    async expire(sessionId) {
      const s = sessions.get(sessionId)!;
      s.status = 'expired';
      await emit('checkout.session.expired', { ...s });
    },
    activate,
    async replay(eventId, o = {}) {
      const ev = events.find((e) => e.id === eventId)!;
      let payload = JSON.stringify(ev);
      const sig = sign(payload, o.oldTimestamp ? Math.floor(Date.now() / 1000) - 3600 : undefined);
      if (o.tamper) payload = payload.replace('"livemode":false', '"livemode":true');
      return opts.webhook(payload, sig);
    },
    async refundFromDashboard(piId) { await refund(piId, true); },
    clearFailures() { failures.length = 0; delays.length = 0; feeLateReads = 0; },
    feeLate(reads) { feeLateReads = reads; },
    updateSubscription,
    async deleteSubscription(subId) {
      const sub = subscriptions.get(subId)!;
      sub.status = 'canceled';
      return emit('customer.subscription.deleted', subView(sub));
    },
    billing: { customers, prices, products, subscriptions, taxRates, portalConfigs },
    delayNext(path, ms) { delays.push({ path, ms }); },
    failNext(path, status = 500, o = {}) { failures.push({ path, status, afterSuccess: Boolean(o.afterSuccess) }); },
    emitEvent: (type, object) => emit(type, object),
  };
}

// Lancement autonome (recette navigateur) : webhooks envoyés à l'app.
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.env.WEBHOOK_URL ?? 'http://localhost:3100/api/stripe/webhook';
  const f = await startFakeStripe({
    port: Number(process.env.FAKE_STRIPE_PORT ?? 54430),
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_fake',
    webhook: async (payload, signature) => (await fetch(target, { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': signature } })).status,
  });
  console.log(`faux Stripe sur ${f.url}`);
}
