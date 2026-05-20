import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const graphVersion = process.env.META_GRAPH_VERSION || "v23.0";
const statusLabels = new Set(["new", "in_progress", "ai_active", "handoff", "closed"]);
const channelLabels = new Set(["facebook", "whatsapp"]);
const memoryDb = { conversations: [], messages: [] };

export async function handler(event) {
  try {
    const method = event.httpMethod || "GET";
    const path = normalizePath(event.path || "/");

    if (path === "/webhooks/meta" && method === "GET") {
      return verifyWebhook(event);
    }

    if (path === "/webhooks/meta" && method === "POST") {
      const rawBody = getRawBody(event);
      if (!verifyMetaSignature(event.headers || {}, rawBody)) {
        return json(401, { error: "Invalid Meta signature" });
      }
      return await handleMetaWebhook(rawBody);
    }

    if (path.startsWith("/api/")) {
      return await handleApi(event, method, path);
    }

    return json(404, { error: "Route not found" });
  } catch (error) {
    console.error(error);
    return json(500, { error: "Internal server error" });
  }
}

async function handleApi(event, method, path) {
  if (path === "/api/storage" && method === "GET") {
    const store = await getBlobStore();
    const db = await readDb();
    return json(200, {
      provider: store ? "netlify-blobs" : "memory",
      persistent: Boolean(store),
      conversations: db.conversations.length,
      messages: db.messages.length
    });
  }

  if (path === "/api/conversations" && method === "GET") {
    const db = await readDb();
    const channel = event.queryStringParameters?.channel || "";
    const conversations = db.conversations
      .filter((item) => !channel || item.channel === channel)
      .map((item) => ({
        ...item,
        lastMessage: db.messages.filter((msg) => msg.conversationId === item.id).at(-1) || null
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return json(200, { conversations });
  }

  const conversationMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch && method === "GET") {
    const db = await readDb();
    const conversation = db.conversations.find((item) => item.id === conversationMatch[1]);
    if (!conversation) return json(404, { error: "Conversation not found" });
    return json(200, {
      conversation,
      messages: db.messages.filter((msg) => msg.conversationId === conversation.id)
    });
  }

  if (conversationMatch && method === "PATCH") {
    const patch = readJson(event);
    const db = await readDb();
    const conversation = db.conversations.find((item) => item.id === conversationMatch[1]);
    if (!conversation) return json(404, { error: "Conversation not found" });
    if (typeof patch.aiEnabled === "boolean") conversation.aiEnabled = patch.aiEnabled;
    if (patch.status && statusLabels.has(patch.status)) conversation.status = patch.status;
    conversation.updatedAt = new Date().toISOString();
    await writeDb(db);
    return json(200, { conversation });
  }

  const replyMatch = path.match(/^\/api\/conversations\/([^/]+)\/reply$/);
  if (replyMatch && method === "POST") {
    const body = readJson(event);
    const db = await readDb();
    const conversation = db.conversations.find((item) => item.id === replyMatch[1]);
    if (!conversation) return json(404, { error: "Conversation not found" });

    const text = String(body.text || "").trim();
    if (!text) return json(400, { error: "Reply text is required" });

    const sendResult = await sendChannelMessage(conversation, text);
    if (!sendResult.ok) {
      return json(502, {
        error: "Message was not sent",
        details: sendResult.error
      });
    }
    addMessage(db, conversation, {
      direction: "out",
      sender: "operator",
      text,
      externalId: `local-${randomUUID()}`
    });
    conversation.status = "in_progress";
    conversation.aiEnabled = false;
    await writeDb(db);
    return json(200, { conversation });
  }

  if (path === "/api/simulate" && method === "POST") {
    const body = readJson(event);
    const channel = channelLabels.has(body.channel) ? body.channel : "facebook";
    await processInbound({
      channel,
      userId: body.userId || "demo-user",
      userName: body.userName || "Demo Client",
      text: body.text || "Hello",
      externalId: `demo-${Date.now()}`
    });
    return json(200, { ok: true });
  }

  return json(404, { error: "API route not found" });
}

function verifyWebhook(event) {
  const params = event.queryStringParameters || {};
  if (params["hub.mode"] === "subscribe" && params["hub.verify_token"] === process.env.META_VERIFY_TOKEN) {
    return text(200, params["hub.challenge"] || "");
  }
  return text(403, "Forbidden");
}

async function handleMetaWebhook(rawBody) {
  const payload = rawBody ? JSON.parse(rawBody) : {};
  const object = payload.object;

  if (object === "page") {
    for (const entry of payload.entry || []) {
      for (const item of entry.messaging || []) {
        const messageText = item.message?.text;
        const userId = item.sender?.id;
        if (messageText && userId) {
          await processInbound({
            channel: "facebook",
            userId,
            userName: `Facebook ${userId}`,
            text: messageText,
            externalId: item.message.mid
          });
        }
      }
    }
  }

  if (object === "whatsapp_business_account") {
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contact = value.contacts?.[0];
        for (const message of value.messages || []) {
          const messageText = message.text?.body;
          if (messageText && message.from) {
            await processInbound({
              channel: "whatsapp",
              userId: message.from,
              userName: contact?.profile?.name || `WhatsApp ${message.from}`,
              text: messageText,
              externalId: message.id
            });
          }
        }
      }
    }
  }

  return json(200, { ok: true });
}

async function processInbound({ channel, userId, userName, text: inboundText, externalId }) {
  const db = await readDb();
  const conversation = getOrCreateConversation(db, { channel, userId, userName });
  addMessage(db, conversation, {
    direction: "in",
    sender: "client",
    text: inboundText,
    externalId
  });

  if (conversation.status === "closed") {
    await writeDb(db);
    return;
  }

  if (conversation.aiEnabled && conversation.status !== "handoff") {
    conversation.status = "ai_active";
    const messages = db.messages.filter((msg) => msg.conversationId === conversation.id);
    const aiReply = await buildAiReply(messages);
    const needsHuman = shouldHandoff(inboundText);

    if (needsHuman) {
      const handoffText = "I will pass this conversation to a human operator for a more accurate answer.";
      conversation.status = "handoff";
      conversation.aiEnabled = false;
      await sendChannelMessage(conversation, handoffText);
      addMessage(db, conversation, {
        direction: "out",
        sender: "ai",
        text: handoffText,
        externalId: `ai-${randomUUID()}`
      });
    } else {
      await sendChannelMessage(conversation, aiReply);
      addMessage(db, conversation, {
        direction: "out",
        sender: "ai",
        text: aiReply,
        externalId: `ai-${randomUUID()}`
      });
    }
  }

  await writeDb(db);
}

function getOrCreateConversation(db, { channel, userId, userName }) {
  const now = new Date().toISOString();
  let conversation = db.conversations.find((item) => item.channel === channel && item.userId === userId);
  if (!conversation) {
    conversation = {
      id: randomUUID(),
      channel,
      userId,
      userName,
      status: "new",
      aiEnabled: true,
      createdAt: now,
      updatedAt: now
    };
    db.conversations.push(conversation);
  }
  conversation.userName = userName || conversation.userName;
  conversation.updatedAt = now;
  return conversation;
}

function addMessage(db, conversation, message) {
  const now = new Date().toISOString();
  db.messages.push({
    id: randomUUID(),
    conversationId: conversation.id,
    channel: conversation.channel,
    createdAt: now,
    ...message
  });
  conversation.updatedAt = now;
}

async function buildAiReply(messages) {
  const lastMessage = messages.at(-1)?.text || "";
  if (!process.env.OPENAI_API_KEY) {
    return `AI demo reply: I received "${lastMessage}". Please share a few more details.`;
  }

  const history = messages.slice(-12).map((message) => ({
    role: message.direction === "in" ? "user" : "assistant",
    content: message.text
  }));

  const result = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: process.env.AI_SYSTEM_PROMPT || "You are a helpful support agent." },
        ...history
      ],
      temperature: 0.3
    })
  });

  if (!result.ok) {
    const errorText = await result.text();
    console.error("OpenAI error", result.status, errorText);
    return `OpenAI error ${result.status}. Check Netlify logs and environment variables.`;
  }

  const data = await result.json();
  return data.choices?.[0]?.message?.content?.trim() || "Please share a few more details.";
}

function shouldHandoff(inboundText) {
  const textToCheck = inboundText.toLowerCase();
  return [
    "оператор",
    "человек",
    "жалоба",
    "возврат",
    "договор",
    "юрист",
    "медицина",
    "кредит",
    "operator",
    "human",
    "complaint",
    "refund",
    "contract",
    "lawyer",
    "medical",
    "credit",
    "account-specific",
    "human operator"
  ].some((word) => textToCheck.includes(word));
}

async function sendChannelMessage(conversation, messageText) {
  if (conversation.channel === "facebook") {
    if (!process.env.FB_PAGE_ACCESS_TOKEN) {
      return { ok: false, error: "FB_PAGE_ACCESS_TOKEN is missing" };
    }
    return await postMeta(`https://graph.facebook.com/${graphVersion}/me/messages?access_token=${process.env.FB_PAGE_ACCESS_TOKEN}`, {
      recipient: { id: conversation.userId },
      messaging_type: "RESPONSE",
      message: { text: messageText }
    });
  }

  if (conversation.channel === "whatsapp") {
    if (!process.env.WHATSAPP_ACCESS_TOKEN) {
      return { ok: false, error: "WHATSAPP_ACCESS_TOKEN is missing" };
    }
    if (!process.env.WHATSAPP_PHONE_NUMBER_ID) {
      return { ok: false, error: "WHATSAPP_PHONE_NUMBER_ID is missing" };
    }
    return await postMeta(`https://graph.facebook.com/${graphVersion}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: conversation.userId,
      type: "text",
      text: { body: messageText, preview_url: false }
    }, process.env.WHATSAPP_ACCESS_TOKEN);
  }

  return { ok: false, error: `Unsupported channel: ${conversation.channel}` };
}

async function postMeta(url, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const result = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!result.ok) {
    const errorText = await result.text();
    console.error("Meta send error", result.status, errorText);
    return { ok: false, error: `Meta error ${result.status}: ${errorText}` };
  }
  return { ok: true, data: await result.json().catch(() => ({})) };
}

async function readDb() {
  const store = await getBlobStore();
  if (!store) return memoryDb;

  const db = await store.get("db", { type: "json" });
  if (db?.conversations && db?.messages) return db;

  const emptyDb = { conversations: [], messages: [] };
  await store.setJSON("db", emptyDb);
  return emptyDb;
}

async function writeDb(db) {
  const store = await getBlobStore();
  if (!store) {
    memoryDb.conversations = db.conversations;
    memoryDb.messages = db.messages;
    return;
  }
  await store.setJSON("db", db);
}

async function getBlobStore() {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore("crm-db");
  } catch (error) {
    if (process.env.NETLIFY) {
      throw new Error(`Persistent dialog storage is unavailable: ${error.message}`);
    }
    console.warn("Netlify Blobs unavailable, using in-memory storage.", error.message);
    return null;
  }
}

function verifyMetaSignature(headers, rawBody) {
  if (!process.env.META_APP_SECRET) return true;
  const signature = getHeader(headers, "x-hub-signature-256");
  if (!signature?.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", process.env.META_APP_SECRET)
    .update(rawBody || "", "utf8")
    .digest("hex");
  const actual = signature.slice("sha256=".length);

  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function getHeader(headers, name) {
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key ? headers[key] : "";
}

function normalizePath(path) {
  return path
    .replace(/^\/\.netlify\/functions\/crm/, "")
    .replace(/\/$/, "") || "/";
}

function readJson(event) {
  const rawBody = getRawBody(event);
  return rawBody ? JSON.parse(rawBody) : {};
}

function getRawBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
}

function text(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    body
  };
}
