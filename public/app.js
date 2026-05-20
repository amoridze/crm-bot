const list = document.querySelector("#conversationList");
const filters = [...document.querySelectorAll(".filters button")];
const refreshButton = document.querySelector("#refreshButton");
const emptyState = document.querySelector("#emptyState");
const panel = document.querySelector("#conversationPanel");
const messagesEl = document.querySelector("#messages");
const replyForm = document.querySelector("#replyForm");
const simulateForm = document.querySelector("#simulateForm");
const statusSelect = document.querySelector("#statusSelect");
const aiToggle = document.querySelector("#aiToggle");

const fields = {
  clientChannel: document.querySelector("#clientChannel"),
  clientName: document.querySelector("#clientName"),
  clientId: document.querySelector("#clientId"),
  cardChannel: document.querySelector("#cardChannel"),
  cardUser: document.querySelector("#cardUser"),
  cardUpdated: document.querySelector("#cardUpdated")
};

const statusText = {
  new: "Новый",
  in_progress: "В работе",
  ai_active: "Отвечает ИИ",
  handoff: "Передан оператору",
  closed: "Закрыт"
};

let activeChannel = "";
let conversations = [];
let activeId = "";
let activeConversation = null;

async function loadConversations() {
  const response = await fetch(`/api/conversations${activeChannel ? `?channel=${activeChannel}` : ""}`);
  const data = await response.json();
  conversations = data.conversations || [];
  renderList();
  if (activeId && conversations.some((item) => item.id === activeId)) {
    await openConversation(activeId);
  }
}

function renderList() {
  list.innerHTML = "";
  if (!conversations.length) {
    list.innerHTML = `<p class="muted">Диалогов пока нет.</p>`;
    return;
  }

  for (const conversation of conversations) {
    const button = document.createElement("button");
    button.className = `conversation-item ${conversation.id === activeId ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(conversation.userName)}</strong>
        <small>${conversation.channel} · ${statusText[conversation.status]}</small>
      </span>
      <em>${escapeHtml(conversation.lastMessage?.text || "")}</em>
    `;
    button.addEventListener("click", () => openConversation(conversation.id));
    list.append(button);
  }
}

async function openConversation(id) {
  activeId = id;
  const response = await fetch(`/api/conversations/${id}`);
  const data = await response.json();
  activeConversation = data.conversation;
  emptyState.hidden = true;
  panel.hidden = false;

  fields.clientChannel.textContent = activeConversation.channel;
  fields.clientName.textContent = activeConversation.userName;
  fields.clientId.textContent = activeConversation.userId;
  fields.cardChannel.textContent = activeConversation.channel;
  fields.cardUser.textContent = activeConversation.userId;
  fields.cardUpdated.textContent = new Date(activeConversation.updatedAt).toLocaleString("ru-RU");
  statusSelect.value = activeConversation.status;
  aiToggle.checked = activeConversation.aiEnabled;

  messagesEl.innerHTML = "";
  for (const message of data.messages) {
    const item = document.createElement("article");
    item.className = `message ${message.direction}`;
    item.innerHTML = `
      <p>${escapeHtml(message.text)}</p>
      <span>${message.sender} · ${new Date(message.createdAt).toLocaleString("ru-RU")}</span>
    `;
    messagesEl.append(item);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  renderList();
}

async function patchConversation(patch) {
  if (!activeConversation) return;
  await fetch(`/api/conversations/${activeConversation.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  await loadConversations();
}

filters.forEach((button) => {
  button.addEventListener("click", async () => {
    activeChannel = button.dataset.channel;
    filters.forEach((item) => item.classList.toggle("active", item === button));
    await loadConversations();
  });
});

refreshButton.addEventListener("click", loadConversations);
statusSelect.addEventListener("change", () => patchConversation({ status: statusSelect.value }));
aiToggle.addEventListener("change", () => patchConversation({ aiEnabled: aiToggle.checked }));

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = new FormData(replyForm).get("text").trim();
  if (!text || !activeConversation) return;
  const response = await fetch(`/api/conversations/${activeConversation.id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Reply failed" }));
    alert(`${error.error || "Reply failed"}\n${error.details || ""}`.trim());
    return;
  }
  replyForm.reset();
  await loadConversations();
});

simulateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(simulateForm));
  await fetch("/api/simulate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  await loadConversations();
});

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadConversations();
setInterval(loadConversations, 7000);
