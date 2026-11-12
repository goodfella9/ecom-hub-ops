// Actions attached to a support draft. When Brian approves a reply, the Hub runs the chosen actions in Shopify
// FIRST and only sends the email if every action succeeded, so customers are never told about something that didn't happen.
import { admin, getStore, shopGraphQL, StoreError } from "./hub.ts";
import { MailError, sendNew } from "./gmail.ts";

type Item = { title: string; price: number; qty?: number; variant_id?: string; notes?: string };
export type Action = {
  id: string;
  when?: string | null; // exact CHOOSE option text this action belongs to; null/empty = runs whenever the reply is sent
  type: "invoice" | "cancel_refund" | "refund_items" | "replacement" | "tag_order" | "notify_team" | "upgrade_shipping";
  order?: string; // order name, e.g. "18778" or "AG61318"
  email?: string; // invoice recipient
  items?: Item[] | { title: string; qty?: number; variant_id?: string }[];
  amount?: number; // refund_items: refund a fixed amount instead of specific items
  tags?: string[];
  to?: string; subject?: string; body?: string; // notify_team
  note?: string;
  message?: string; // custom message on the Shopify invoice email
  restock?: boolean;
  title?: string; // upgrade_shipping: new shipping method name as ShipStation should see it, e.g. "UPS 2nd Day Air"
  extra?: number; // upgrade_shipping: amount the customer pays on top of what they already paid for shipping
  shipping?: number; // invoice: shipping charge on the invoice (omit = free shipping)
  digital?: boolean; // invoice: true when nothing ships (fees, upgrades)
  summary?: string;
};

const money = (n: number) => `$${n.toFixed(2)}`;

export function describe(a: Action): string {
  switch (a.type) {
    case "invoice": {
      const items = (a.items as Item[] ?? []);
      const total = items.reduce((s, i) => s + Number(i.price ?? 0) * (i.qty ?? 1), 0);
      const ship = a.digital ? "" : a.shipping ? ` + ${money(Number(a.shipping))} shipping` : " + free shipping";
      return `Create a ${money(total)}${ship} invoice (${items.map((i) => `${i.qty && i.qty > 1 ? `${i.qty}× ` : ""}${i.title}`).join(", ")}) and email it to ${a.email}${a.digital ? "" : ". Once paid it becomes a normal order that ships"}`;
    }
    case "refund_items": {
      const items = a.items as { title: string; qty?: number }[] | undefined;
      return a.amount ? `Refund ${money(Number(a.amount))} on order ${a.order} to the original payment method (order stays open)` : `Refund ${items?.map((i) => `${i.qty ?? 1}× ${i.title}`).join(", ")} on order ${a.order} to the original payment method (order stays open)`;
    }
    case "cancel_refund": return `Cancel order ${a.order} and refund it in full to the original payment method${a.restock === false ? "" : " (restock items)"}`;
    case "replacement": {
      const items = a.items as { title: string; qty?: number }[] | undefined;
      return `Create a free ($0) replacement order for ${items?.length ? items.map((i) => `${i.qty ?? 1}× ${i.title}`).join(", ") : "everything"} from order ${a.order}, shipping to the same address`;
    }
    case "tag_order": return `Tag order ${a.order}: ${(a.tags ?? []).join(", ")}`;
    case "notify_team": return `Email ${a.to}: "${a.subject}"`;
    case "upgrade_shipping": return `Change order ${a.order}'s shipping to "${a.title}"${a.extra ? ` and have Shopify email the customer a ${money(Number(a.extra))} payment link for the difference` : " at no charge"}`;
  }
}

export function validate(a: Action): string | null {
  if (!a.id || !a.type) return "Each action needs an id and a type.";
  if (a.type === "invoice") {
    if (!a.email || !/@/.test(a.email)) return "invoice needs the customer's email.";
    const items = a.items as Item[] | undefined;
    if (!items?.length || items.some((i) => !i.title || (!i.variant_id && !(Number(i.price) >= 0)))) return "invoice needs items with a title and either a catalog variant_id or a price.";
  }
  if ((a.type === "cancel_refund" || a.type === "refund_items" || a.type === "replacement" || a.type === "tag_order") && !a.order) return `${a.type} needs the order name.`;
  if (a.type === "refund_items" && !(Number(a.amount) > 0) && !(a.items as any[] | undefined)?.length) return "refund_items needs items or an amount.";
  if (a.type === "tag_order" && !a.tags?.length) return "tag_order needs tags.";
  if (a.type === "upgrade_shipping" && (!a.order || !a.title || !(Number(a.extra ?? 0) >= 0))) return "upgrade_shipping needs order, title and extra (0 or more).";
  if (a.type === "notify_team" && (!a.to || !a.subject || !a.body)) return "notify_team needs to, subject and body.";
  if (a.type === "notify_team" && /@(gmail|yahoo|hotmail|aol|icloud|outlook)\./i.test(a.to ?? "")) return "notify_team is for internal team addresses only.";
  return null;
}

async function findOrder(storeKey: string, name: string) {
  const s = await getStore(storeKey);
  const clean = name.replace(/^#/, "").trim();
  for (const q of [`name:#${clean}`, `name:${clean}`]) {
    const r = await shopGraphQL(s, `query($q:String!){ orders(first:1, query:$q){ nodes{ id name email cancelledAt displayFinancialStatus
      customer{ id } shippingAddress{ firstName lastName company address1 address2 city provinceCode countryCodeV2 zip phone }
      lineItems(first:50){ nodes{ id title variantTitle quantity variant{ id } customAttributes{ key value } } } } } }`, { q });
    const o = r?.data?.orders?.nodes?.[0];
    if (o && o.name.replace(/^#/, "") === clean) return { s, o };
  }
  throw new StoreError(`Couldn't find order ${name} in ${s.name}.`);
}

const errs = (r: any, key: string) => {
  const e = [...(r?.errors ?? []), ...(r?.data?.[key]?.userErrors ?? []), ...(r?.data?.[key]?.orderCancelUserErrors ?? [])];
  return e.length ? e.map((x: any) => x.message).join("; ") : null;
};

async function run(storeKey: string, a: Action): Promise<string> {
  const s = await getStore(storeKey);
  if (a.type === "invoice") {
    const items = a.items as Item[];
    const { data: c } = { data: (await shopGraphQL(s, `query($q:String!){ customers(first:1, query:$q){ nodes{ id } } }`, { q: `email:${a.email}` }))?.data?.customers?.nodes?.[0] };
    const create = await shopGraphQL(s, `mutation($input: DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder{ id name invoiceUrl } userErrors{ message } } }`, {
      input: {
        email: a.email,
        ...(c?.id ? { purchasingEntity: { customerId: c.id } } : {}),
        lineItems: items.map((i) => i.variant_id
          ? { variantId: i.variant_id, quantity: i.qty ?? 1, ...(i.notes ? { customAttributes: [{ key: "Design notes", value: i.notes }] } : {}) }
          : { title: i.title, originalUnitPrice: Number(i.price), quantity: i.qty ?? 1, requiresShipping: !a.digital, ...(a.digital ? { taxable: false } : {}), ...(i.notes ? { customAttributes: [{ key: "Design notes", value: i.notes }] } : {}) }),
        ...(a.digital ? {} : { shippingLine: { title: a.shipping ? "Shipping" : "Free shipping", priceWithCurrency: { amount: Number(a.shipping ?? 0), currencyCode: "USD" } } }),
        note: a.note ?? "Created from the Hub support inbox",
        tags: ["hub-invoice"],
      },
    });
    const e1 = errs(create, "draftOrderCreate");
    const d = create?.data?.draftOrderCreate?.draftOrder;
    if (e1 || !d) throw new StoreError(`Invoice not created: ${e1 ?? "no draft order returned"}`);
    const send = await shopGraphQL(s, `mutation($id: ID!, $email: EmailInput){ draftOrderInvoiceSend(id:$id, email:$email){ draftOrder{ invoiceSentAt } userErrors{ message } } }`, {
      id: d.id, email: { to: a.email, ...(a.message ? { customMessage: a.message } : {}) },
    });
    const e2 = errs(send, "draftOrderInvoiceSend");
    if (e2) throw new StoreError(`Draft ${d.name} was created but the invoice email failed: ${e2}`);
    return `Invoice ${d.name} emailed to ${a.email} (${d.invoiceUrl})`;
  }
  if (a.type === "cancel_refund") {
    const { o } = await findOrder(storeKey, a.order!);
    if (o.cancelledAt) return `Order ${o.name} was already cancelled`;
    const r = await shopGraphQL(s, `mutation($id: ID!, $note: String, $restock: Boolean!){ orderCancel(orderId:$id, reason: CUSTOMER, refundMethod:{ originalPaymentMethodsRefund: true }, restock:$restock, notifyCustomer:false, staffNote:$note){ job{ id } orderCancelUserErrors{ message } userErrors{ message } } }`, {
      id: o.id, note: (a.note ?? "Cancelled + refunded from the Hub support inbox").slice(0, 250), restock: a.restock !== false,
    });
    const e = errs(r, "orderCancel");
    if (e) throw new StoreError(`Order ${o.name} not cancelled: ${e}`);
    return `Order ${o.name} cancelled and fully refunded`;
  }
  if (a.type === "refund_items") {
    const { o } = await findOrder(storeKey, a.order!);
    let refundLineItems: { lineItemId: string; quantity: number; restockType: string }[] = [];
    let transactions: any[] = [];
    if (Number(a.amount) > 0) {
      const tx = await shopGraphQL(s, `query($id: ID!){ order(id:$id){ transactions(first:20){ id kind status gateway amountSet{ shopMoney{ amount currencyCode } } } } }`, { id: o.id });
      const parent = (tx?.data?.order?.transactions ?? []).find((t: any) => t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"));
      if (!parent) throw new StoreError(`No captured payment found on ${o.name} to refund against.`);
      transactions = [{ orderId: o.id, parentId: parent.id, amount: Number(a.amount), gateway: parent.gateway, kind: "REFUND" }];
    } else {
      for (const w of a.items as { title: string; qty?: number }[]) {
        const l = o.lineItems.nodes.find((l: any) => `${l.title} ${l.variantTitle ?? ""}`.toLowerCase().includes(w.title.toLowerCase()));
        if (!l) throw new StoreError(`No item matching "${w.title}" on ${o.name}.`);
        refundLineItems.push({ lineItemId: l.id, quantity: Math.min(w.qty ?? 1, l.quantity), restockType: "NO_RESTOCK" });
      }
      const sug = await shopGraphQL(s, `query($id: ID!, $li: [RefundLineItemInput!]){ order(id:$id){ suggestedRefund(refundLineItems:$li){ amountSet{ shopMoney{ amount } } suggestedTransactions{ gateway kind parentTransaction{ id } amountSet{ shopMoney{ amount } } } } } }`, { id: o.id, li: refundLineItems.map(({ lineItemId, quantity }) => ({ lineItemId, quantity })) });
      const st = sug?.data?.order?.suggestedRefund?.suggestedTransactions ?? [];
      if (!st.length) throw new StoreError(`Shopify couldn't work out a refund for those items on ${o.name}.`);
      transactions = st.map((t: any) => ({ orderId: o.id, parentId: t.parentTransaction?.id, amount: Number(t.amountSet.shopMoney.amount), gateway: t.gateway, kind: "REFUND" }));
    }
    const r = await shopGraphQL(s, `mutation($input: RefundInput!){ refundCreate(input:$input){ refund{ totalRefundedSet{ shopMoney{ amount } } } userErrors{ message } } }`, {
      input: { orderId: o.id, refundLineItems, transactions, notify: false, note: (a.note ?? "Partial refund from the Hub support inbox").slice(0, 250) },
    });
    const e = errs(r, "refundCreate");
    if (e) throw new StoreError(`Refund on ${o.name} failed: ${e}`);
    return `Refunded ${money(Number(r?.data?.refundCreate?.refund?.totalRefundedSet?.shopMoney?.amount ?? 0))} on ${o.name}`;
  }
  if (a.type === "replacement") {
    const { o } = await findOrder(storeKey, a.order!);
    const want = a.items as { title: string; qty?: number; variant_id?: string }[] | undefined;
    const direct = (want ?? []).filter((w) => w.variant_id).map((w) => ({ variantId: w.variant_id!, quantity: w.qty ?? 1 }));
    const fromOrder = want?.length && direct.length === want.length ? [] : o.lineItems.nodes.filter((l: any) => l.variant?.id).flatMap((l: any) => {
      if (!want?.length) return [{ variantId: l.variant.id, quantity: l.quantity, customAttributes: l.customAttributes }];
      const m = want.find((w) => !w.variant_id && `${l.title} ${l.variantTitle ?? ""}`.toLowerCase().includes(w.title.toLowerCase()));
      return m ? [{ variantId: l.variant.id, quantity: m.qty ?? 1, customAttributes: l.customAttributes }] : [];
    });
    const lines = [...direct, ...fromOrder];
    if (!lines.length) throw new StoreError(`No matching items on ${o.name} to replace.`);
    const sa = o.shippingAddress;
    const create = await shopGraphQL(s, `mutation($input: DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder{ id name } userErrors{ message } } }`, {
      input: {
        ...(o.customer?.id ? { purchasingEntity: { customerId: o.customer.id } } : {}),
        email: o.email,
        lineItems: lines,
        appliedDiscount: { title: "Replacement", value: 100, valueType: "PERCENTAGE" },
        shippingLine: { title: "Replacement - free shipping", priceWithCurrency: { amount: 0, currencyCode: "USD" } },
        ...(sa ? { shippingAddress: { firstName: sa.firstName, lastName: sa.lastName, company: sa.company, address1: sa.address1, address2: sa.address2, city: sa.city, provinceCode: sa.provinceCode, countryCode: sa.countryCodeV2, zip: sa.zip, phone: sa.phone } } : {}),
        tags: ["replacement", "hub-replacement", ...(storeKey === "cmp" ? ["proof_accepted"] : [])],
        note: `Replacement for ${o.name}. ${a.note ?? ""}`.trim(),
      },
    });
    const e1 = errs(create, "draftOrderCreate");
    const d = create?.data?.draftOrderCreate?.draftOrder;
    if (e1 || !d) throw new StoreError(`Replacement not created: ${e1 ?? "no draft returned"}`);
    const done = await shopGraphQL(s, `mutation($id: ID!){ draftOrderComplete(id:$id){ draftOrder{ order{ name } } userErrors{ message } } }`, { id: d.id });
    const e2 = errs(done, "draftOrderComplete");
    if (e2) throw new StoreError(`Replacement draft ${d.name} created but not completed: ${e2}`);
    return `Replacement order ${done?.data?.draftOrderComplete?.draftOrder?.order?.name ?? d.name} created for ${o.name}`;
  }
  if (a.type === "tag_order") {
    const { o } = await findOrder(storeKey, a.order!);
    const r = await shopGraphQL(s, `mutation($id: ID!, $tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }`, { id: o.id, tags: a.tags });
    const e = errs(r, "tagsAdd");
    if (e) throw new StoreError(`Tags not added to ${o.name}: ${e}`);
    return `Tagged ${o.name}: ${a.tags!.join(", ")}`;
  }
  if (a.type === "upgrade_shipping") {
    const { o } = await findOrder(storeKey, a.order!);
    const begin = await shopGraphQL(s, `mutation($id: ID!){ orderEditBegin(id:$id){ calculatedOrder{ id shippingLines{ id title stagedStatus price{ shopMoney{ amount currencyCode } } } } userErrors{ message } } }`, { id: o.id });
    const e0 = errs(begin, "orderEditBegin");
    const calc = begin?.data?.orderEditBegin?.calculatedOrder;
    if (e0 || !calc) throw new StoreError(`Couldn't open order ${o.name} for editing: ${e0 ?? "no edit session"}`);
    const lines = (calc.shippingLines ?? []).filter((l: any) => l.stagedStatus !== "REMOVED");
    if (lines.some((l: any) => l.title === a.title)) return `Order ${o.name} already ships ${a.title}`;
    const paid = lines.reduce((t: number, l: any) => t + Number(l.price?.shopMoney?.amount ?? 0), 0);
    const currency = lines[0]?.price?.shopMoney?.currencyCode ?? "USD";
    for (const l of lines) {
      const r = await shopGraphQL(s, `mutation($id: ID!, $sl: ID!){ orderEditRemoveShippingLine(id:$id, shippingLineId:$sl){ userErrors{ message } } }`, { id: calc.id, sl: l.id });
      const e = errs(r, "orderEditRemoveShippingLine");
      if (e) throw new StoreError(`Couldn't remove the old shipping on ${o.name}: ${e}`);
    }
    const price = Math.round((paid + Number(a.extra ?? 0)) * 100) / 100;
    const add = await shopGraphQL(s, `mutation($id: ID!, $sl: OrderEditAddShippingLineInput!){ orderEditAddShippingLine(id:$id, shippingLine:$sl){ userErrors{ message } } }`, { id: calc.id, sl: { title: a.title, price: { amount: price, currencyCode: currency } } });
    const e1 = errs(add, "orderEditAddShippingLine");
    if (e1) throw new StoreError(`Couldn't add ${a.title} to ${o.name}: ${e1}`);
    const commit = await shopGraphQL(s, `mutation($id: ID!, $notify: Boolean, $note: String){ orderEditCommit(id:$id, notifyCustomer:$notify, staffNote:$note){ order{ name totalOutstandingSet{ shopMoney{ amount } } } userErrors{ message } } }`, {
      id: calc.id, notify: Number(a.extra ?? 0) > 0, note: (a.note ?? `Shipping changed to ${a.title} from the Hub support inbox`).slice(0, 250),
    });
    const e2 = errs(commit, "orderEditCommit");
    if (e2) throw new StoreError(`Shipping change on ${o.name} wasn't saved: ${e2}`);
    const owed = Number(commit?.data?.orderEditCommit?.order?.totalOutstandingSet?.shopMoney?.amount ?? 0);
    return `Order ${o.name} now ships ${a.title}${owed > 0 ? `; Shopify emailed the customer a ${money(owed)} payment link` : ""}`;
  }
  if (a.type === "notify_team") {
    const { data: st } = await admin.from("stores").select("name,support_email").eq("key", storeKey).maybeSingle();
    if (!st?.support_email) throw new MailError("No support mailbox for this store.");
    await sendNew(st.support_email, st.name, a.to!, a.subject!, a.body!);
    return `Emailed ${a.to}: ${a.subject}`;
  }
  throw new StoreError(`Unknown action type ${(a as Action).type}`);
}

// Run the draft's actions that apply (always-run ones + the options Brian picked). Each action runs once:
// results are recorded on the ticket, so a retry after a failure skips what already succeeded.
export async function runTicketActions(ticketId: string, chosen: string[], actor: string) {
  const { data: t } = await admin.from("tickets").select("store_key,draft_actions,action_log").eq("id", ticketId).maybeSingle();
  if (!t) throw new StoreError("No such ticket.");
  const all = (t.draft_actions ?? []) as Action[];
  const log = (t.action_log ?? []) as { id: string; ok: boolean; result: string; at: string }[];
  const todo = all.filter((a) => !a.when || chosen.includes(a.id));
  const results: string[] = [];
  for (const a of todo) {
    if (log.some((l) => l.id === a.id && l.ok)) continue;
    try {
      const result = await run(t.store_key, a);
      log.push({ id: a.id, ok: true, result, at: new Date().toISOString() });
      results.push(result);
      await admin.from("audit_log").insert({ store_key: t.store_key, actor, action: `ticket_${a.type}`, summary: result, status: "applied", ref: ticketId });
    } catch (e) {
      const msg = (e as Error).message;
      log.push({ id: a.id, ok: false, result: msg, at: new Date().toISOString() });
      await admin.from("tickets").update({ action_log: log }).eq("id", ticketId);
      await admin.from("audit_log").insert({ store_key: t.store_key, actor, action: `ticket_${a.type}`, summary: msg, status: "failed", ref: ticketId });
      throw new StoreError(`Nothing was emailed. This action failed: ${describe(a)}. ${msg}`);
    }
  }
  await admin.from("tickets").update({ action_log: log }).eq("id", ticketId);
  return results;
}

export function prepareActions(actions: Action[] | undefined, store: string): { actions: Action[]; error: string | null } {
  const out: Action[] = [];
  // Ids must be unique across the ticket's whole history: runTicketActions skips any id already logged as done,
  // so reusing "a1" on a second batch silently skipped that action.
  const batch = Date.now().toString(36);
  for (const [i, a] of (actions ?? []).entries()) {
    const withId = { ...a, id: a.id || `${batch}-${i + 1}` };
    const err = validate(withId);
    if (err) return { actions: [], error: err };
    out.push({ ...withId, summary: describe(withId) });
  }
  void store;
  return { actions: out, error: null };
}

// Actions a scheduled run may perform without Brian (inbox_reply): billing at catalog/quoted prices and internal notices.
export const AUTO_OK = new Set(["invoice", "tag_order", "notify_team"]);
// On a ticket Brian handed to Claude with a written instruction (status for_claude), that instruction is the approval,
// so every action type is allowed there.
export const ALL_ACTIONS = new Set(["invoice", "cancel_refund", "refund_items", "replacement", "tag_order", "notify_team", "upgrade_shipping"]);
